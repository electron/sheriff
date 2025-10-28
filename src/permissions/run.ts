import chalk from 'chalk';
import crypto from 'crypto';
import fs from 'fs-extra';
import Joi from 'joi';
import yml from 'js-yaml';
import _queue from 'queue';

import { graphyOctokit, getOctokit } from '../octokit.js';
import { memoize, IS_DRY_RUN } from '../helpers.js';
import { GetResponseDataTypeFromEndpointMethod } from '@octokit/types';
import { MessageBuilder } from '../MessageBuilder.js';
import { plugins } from './plugins/index.js';
import {
  PERMISSIONS_FILE_ORG,
  PERMISSIONS_FILE_PATH,
  PERMISSIONS_FILE_REPO,
  PERMISSIONS_FILE_REF,
  PERMISSIONS_FILE_LOCAL_PATH,
} from '../constants.js';
import {
  OrganizationConfig,
  PermissionsConfig,
  RepoSettings,
  RepositoryConfig,
  Ruleset,
  SheriffAccessLevel,
  TeamConfig,
} from './types.js';
import { gitHubPermissionsToSheriffLevel, sheriffLevelToGitHubLevel } from './level-converters.js';
import { fileURLToPath } from 'url';
import { getDifferenceWithGithubRuleset, rulesetToGithub } from './ruleset.js';
import { components } from '@octokit/openapi-types';
import { isDeepStrictEqual } from 'util';

const queue = _queue as unknown as typeof _queue.default;

const GLITCHED_REPO_HASHES = [
  'd9a1eb0cd63e7509c90828354e18d54a8d616c80ecdc6ded8972a4f788540859',
  '02bbdc6c7234919718640b8ea2bbfd6b928a6b6b6673f3cf1c47b014ec862fba',
  'bc413d15c3f36be3440c26fad745619ec92effe583ce26849e7f7d5ad8f80465',
];

console.warn('Dry Run?:', chalk[IS_DRY_RUN ? 'green' : 'red'](`${IS_DRY_RUN}`));

const loadCurrentConfig = async () => {
  if (fs.existsSync('config.yml'))
    return yml.safeLoad(fs.readFileSync('config.yml', 'utf8')) as PermissionsConfig;
  if (fs.existsSync('config.yaml'))
    return yml.safeLoad(fs.readFileSync('config.yaml', 'utf8')) as PermissionsConfig;
  if (PERMISSIONS_FILE_LOCAL_PATH && fs.existsSync(PERMISSIONS_FILE_LOCAL_PATH)) {
    return yml.safeLoad(fs.readFileSync(PERMISSIONS_FILE_LOCAL_PATH, 'utf8')) as PermissionsConfig;
  }
  if (!PERMISSIONS_FILE_ORG) {
    throw new Error('Missing PERMISSIONS_FILE_ORG env var');
  }

  const octokit = await getOctokit(PERMISSIONS_FILE_ORG);
  const contents = await octokit.repos.getContent({
    owner: PERMISSIONS_FILE_ORG,
    repo: PERMISSIONS_FILE_REPO,
    path: PERMISSIONS_FILE_PATH,
    ref: PERMISSIONS_FILE_REF,
  });
  if (Array.isArray(contents.data)) throw new Error('Invalid config file');

  return yml.safeLoad(
    // @ts-ignore - Octokit fails to type properties of ReposGetContentsResponse correctly.
    Buffer.from(contents.data.content || '', contents.data.encoding as any).toString('utf8'),
  ) as PermissionsConfig;
};

const validateConfigFast = async (config: PermissionsConfig): Promise<OrganizationConfig[]> => {
  const orgConfigs = Array.isArray(config) ? config : [config];
  for (const orgConfig of orgConfigs) {
    if (!orgConfig || typeof orgConfig !== 'object' || !orgConfig.teams) continue;

    // Support formation prop
    orgConfig.teams = orgConfig.teams.map((team) => {
      const anyTeam = team as any;
      if (anyTeam.formation) {
        const formationTeams = orgConfig.teams.filter((t) => anyTeam.formation.includes(t.name));
        const maintainers = new Set(
          formationTeams.reduce<string[]>((all, team) => [...all, ...team.maintainers], []),
        );
        const members = new Set(
          formationTeams.reduce<string[]>((all, team) => [...all, ...team.members], []),
        );
        for (const maintainer of maintainers) {
          members.delete(maintainer);
        }
        return {
          name: team.name,
          displayName: team.displayName,
          gsuite: team.gsuite,
          slack: team.slack,
          maintainers: [...maintainers],
          members: [...members],
        };
      }
      return team;
    });
  }

  for (const orgConfig of orgConfigs) {
    if (!orgConfig || typeof orgConfig !== 'object' || !orgConfig.teams) continue;

    // Support reference prop
    orgConfig.teams = orgConfig.teams.map((team) => {
      const anyTeam = team as any;
      if (anyTeam.reference) {
        const [referencedOrgName, referencedTeamName] = anyTeam.reference.split('/');
        const referencedOrg = orgConfigs.find((org) => org.organization === referencedOrgName);
        // This will error out later
        if (!referencedOrg) return team;
        const referencedTeam = referencedOrg.teams.find((t) => t.name === referencedTeamName);
        // This will also error out later
        if (!referencedTeam) return team;

        return {
          name: team.name,
          displayName: referencedTeam.displayName,
          gsuite: referencedTeam.gsuite,
          slack: referencedTeam.slack,
          maintainers: [...referencedTeam.maintainers],
          members: [...referencedTeam.members],
        };
      }
      return team;
    });
  }

  const rulesetValidator = Joi.object({
    name: Joi.string().min(1).required(),
    target: Joi.string().valid('branch', 'tag').required(),
    enforcement: Joi.string().valid('disabled', 'active', 'evaluate').optional(),
    bypass: Joi.object({
      teams: Joi.array().items(Joi.string().min(1)).optional(),
      apps: Joi.array().items(Joi.number().integer().min(1)).optional(),
    }).optional(),
    ref_name: Joi.object({
      include: Joi.array().items(Joi.string().min(1)).required(),
      exclude: Joi.array().items(Joi.string().min(1)).optional(),
    }).required(),
    rules: Joi.array()
      .items(
        Joi.string().valid(
          'restrict_creation',
          'restrict_update',
          'restrict_deletion',
          'require_linear_history',
          'require_signed_commits',
          'restrict_force_push',
        ),
      )
      .min(1)
      .optional(),
    require_pull_request: Joi.alternatives(
      Joi.object({
        dismiss_stale_reviews_on_push: Joi.boolean(),
        require_code_owner_review: Joi.boolean(),
        require_last_push_approval: Joi.boolean(),
        required_approving_review_count: Joi.number().integer().greater(0),
        required_review_thread_resolution: Joi.boolean(),
        allowed_merge_methods: Joi.array()
          .items(Joi.string().valid('merge', 'squash', 'rebase'))
          .min(1)
          .optional(),
      }),
    ).optional(),
    require_status_checks: Joi.array()
      .items(
        Joi.object({
          context: Joi.string().min(1).required(),
          app_id: Joi.number().integer().greater(0).required(),
        }),
      )
      .min(1)
      .optional(),
  });

  // Ensure the object looks right
  const schema = Joi.array()
    .items(
      Joi.object({
        organization: Joi.string().min(1).required(),
        repository_defaults: Joi.object({
          has_wiki: Joi.boolean().required(),
          forks_need_actions_approval: Joi.boolean().optional(),
        }).required(),
        teams: Joi.array()
          .items({
            name: Joi.string().min(1).required(),
            displayName: Joi.string().min(1).optional(),
            parent: Joi.string().min(1).optional(),
            secret: Joi.bool().optional(),
            members: Joi.array().items(Joi.string().min(1)).min(0).required(),
            maintainers: Joi.array().items(Joi.string().min(1)).min(1).required(),
            gsuite: Joi.object({
              privacy: Joi.string().valid('internal', 'external').required(),
            }).optional(),
            slack: Joi.string().min(1).allow(true).allow(false).optional(),
          })
          .required(),
        repositories: Joi.array()
          .items({
            name: Joi.string().min(1).required(),
            teams: Joi.object()
              .pattern(
                Joi.string(),
                Joi.string().valid('read', 'triage', 'write', 'maintain', 'admin'),
              )
              .optional(),
            external_collaborators: Joi.object()
              .pattern(
                Joi.string().min(1),
                Joi.string().valid('read', 'triage', 'write', 'maintain', 'admin'),
              )
              .optional(),
            settings: Joi.object({
              has_wiki: Joi.boolean(),
              forks_need_actions_approval: Joi.boolean().optional(),
            }).optional(),
            visibility: Joi.string().valid('public', 'private').optional(),
            properties: Joi.object()
              .pattern(
                Joi.string(),
                Joi.alternatives(Joi.string(), Joi.array().items(Joi.string())),
              )
              .optional(),
            trustedPublisherBranches: Joi.array().items(Joi.string().min(1)).optional(),
            heroku: Joi.object({
              app_name: Joi.string().min(1).required(),
              team_name: Joi.string().min(1).required(),
              access: Joi.array().items(Joi.string().min(1)).optional(),
            }).optional(),
            rulesets: Joi.array()
              .items(Joi.alternatives(Joi.string().min(1), rulesetValidator))
              .min(1)
              .optional(),
          })
          .required(),
        common_rulesets: Joi.array().items(rulesetValidator).min(1).optional(),
        customProperties: Joi.array()
          .items(
            Joi.object({
              property_name: Joi.string().min(1).required(),
              value_type: Joi.string().valid('string', 'single_select', 'multi_select').required(),
              required: Joi.boolean().optional(),
              default_value: Joi.alternatives(
                Joi.string(),
                Joi.array().items(Joi.string()),
              ).optional(),
              description: Joi.string().optional(),
              allowed_values: Joi.array().items(Joi.string().min(1)).optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .required();
  await schema.validateAsync(orgConfigs);

  for (const orgConfig of orgConfigs) {
    for (const team of orgConfig.teams) {
      if (
        new Set([...team.members, ...team.maintainers]).size !==
        team.members.length + team.maintainers.length
      ) {
        throw new Error(
          `Team "${team.name}" in the teams config for "${orgConfig.organization}" appears to have a crossover between members and maintainers.  Users should appear in at most one section`,
        );
      }
      const parentTeam = team.parent && orgConfig.teams.find((t) => t.name === team.parent);
      if (team.parent && !parentTeam) {
        throw new Error(
          `Team "${team.name}" for "${orgConfig.organization}" has a parent team of "${team.parent}" but that team does not appear to exist`,
        );
      }
      if (team.parent && team.secret) {
        throw new Error(
          `Team "${team.name}" for "${orgConfig.organization}" is marked as secret but it has a parent team, this is not allowed by GitHub`,
        );
      }
      if (team.gsuite && !team.displayName) {
        throw new Error(
          `Team "${team.name}" for "${orgConfig.organization}" has a gsuite config but no displayName, this is required`,
        );
      }
      if (parentTeam) {
        let parentRef: TeamConfig | undefined = parentTeam;
        const visited = [team.name];
        while (parentRef) {
          if (visited.includes(parentRef.name)) {
            throw new Error(
              `Team "${team.name}" for "${
                orgConfig.organization
              }" has a circular parent reference that eventually loops back to itself.  Path: ${[
                ...visited,
                parentRef.name,
              ]
                .map((n) => `"${n}"`)
                .join(' --> ')}`,
            );
          }
          visited.push(parentRef.name);
          if (parentRef.secret) {
            throw new Error(
              `Team "${team.name}" for "${orgConfig.organization}" has a parent team "${parentRef.name}" that is marked as secret, this is not allowed by GitHub`,
            );
          }
          parentRef =
            (parentRef.parent && orgConfig.teams.find((t) => t.name === parentRef!.parent)) ||
            undefined;
        }
      }
    }

    const seenTeams = new Set<string>();
    for (const team of orgConfig.teams) {
      if (seenTeams.has(team.name)) {
        throw new Error(
          `Team "${team.name}" appears multiple times in the config for "${orgConfig.organization}", it should only appear once`,
        );
      }
      seenTeams.add(team.name);
    }

    const seenRepos = new Set<string>();
    for (const repo of orgConfig.repositories) {
      if (seenRepos.has(repo.name)) {
        throw new Error(
          `Repository "${repo.name}" appears multiple times in the config for "${orgConfig.organization}", it should only appear once`,
        );
      }
      seenRepos.add(repo.name);
    }

    if (orgConfig.customProperties?.length) {
      for (const customProp of orgConfig.customProperties) {
        if (customProp.allowed_values) {
          if (customProp.value_type === 'string') {
            throw new Error(
              `Custom property "${customProp.property_name}" has type "string" but specifies allowed_values. allowed_values should only be used with single_select or multi_select types.`,
            );
          }
          if (customProp.allowed_values.length === 0) {
            throw new Error(
              `Custom property "${customProp.property_name}" has an empty allowed_values array. Select types must have at least one allowed value.`,
            );
          }
        }

        if (
          (customProp.value_type === 'single_select' || customProp.value_type === 'multi_select') &&
          (!customProp.allowed_values || customProp.allowed_values.length === 0)
        ) {
          throw new Error(
            `Custom property "${customProp.property_name}" has type "${customProp.value_type}" but does not specify allowed_values. Select types require at least one allowed value.`,
          );
        }

        if (customProp.default_value !== undefined) {
          if (customProp.value_type === 'single_select') {
            if (Array.isArray(customProp.default_value)) {
              throw new Error(
                `Custom property "${customProp.property_name}" has type "single_select" but default_value is an array. single_select default_value must be a string.`,
              );
            }
            if (
              customProp.allowed_values &&
              !customProp.allowed_values.includes(customProp.default_value as string)
            ) {
              throw new Error(
                `Custom property "${customProp.property_name}" has default_value "${
                  customProp.default_value
                }" which is not in allowed_values: ${customProp.allowed_values.join(', ')}`,
              );
            }
          } else if (customProp.value_type === 'multi_select') {
            if (!Array.isArray(customProp.default_value)) {
              throw new Error(
                `Custom property "${customProp.property_name}" has type "multi_select" but default_value is not an array. multi_select default_value must be an array of strings.`,
              );
            }
            if (customProp.allowed_values) {
              for (const val of customProp.default_value) {
                if (!customProp.allowed_values.includes(val)) {
                  throw new Error(
                    `Custom property "${
                      customProp.property_name
                    }" has default_value containing "${val}" which is not in allowed_values: ${customProp.allowed_values.join(
                      ', ',
                    )}`,
                  );
                }
              }
            }
          } else if (customProp.value_type === 'string') {
            if (Array.isArray(customProp.default_value)) {
              throw new Error(
                `Custom property "${customProp.property_name}" has type "string" but default_value is an array. string type default_value must be a string.`,
              );
            }
          }
        }
      }

      for (const repo of orgConfig.repositories) {
        for (const customProp of orgConfig.customProperties) {
          if (
            customProp.required &&
            (!repo.properties || !repo.properties.hasOwnProperty(customProp.property_name)) &&
            !customProp.default_value
          ) {
            throw new Error(
              `Repository "${repo.name}" in "${orgConfig.organization}" is missing required property "${customProp.property_name}"`,
            );
          }

          const propValue = repo.properties?.[customProp.property_name];

          if (!propValue) continue;

          if (customProp.value_type === 'single_select') {
            const value = propValue;
            if (Array.isArray(value)) {
              throw new Error(
                `Invalid value ${JSON.stringify(value)} for property "${
                  customProp.property_name
                }" on repository "${
                  repo.name
                }", found an array, expected a single value from: ${customProp.allowed_values?.join(
                  ', ',
                )}`,
              );
            }
            if (!customProp.allowed_values?.includes(value)) {
              throw new Error(
                `Invalid value "${value}" for property "${
                  customProp.property_name
                }" on repository "${repo.name}". Allowed values: ${customProp.allowed_values?.join(
                  ', ',
                )}`,
              );
            }
          } else if (customProp.value_type === 'multi_select') {
            const values = propValue;
            if (!Array.isArray(values)) {
              throw new Error(
                `Invalid value ${JSON.stringify(values)} for property "${
                  customProp.property_name
                }" on repository "${
                  repo.name
                }", found an array, expected an of values from: ${customProp.allowed_values?.join(
                  ', ',
                )}`,
              );
            }
            for (const value of values) {
              if (!customProp.allowed_values?.includes(value)) {
                throw new Error(
                  `Invalid value "${value}" for property "${
                    customProp.property_name
                  }" on repository "${
                    repo.name
                  }". Allowed values: ${customProp.allowed_values?.join(', ')}`,
                );
              }
            }
          } else if (customProp.value_type === 'string') {
            if (Array.isArray(propValue)) {
              throw new Error(
                `Property "${customProp.property_name}" on repository "${repo.name}" has type "string" but value is an array. Use a single string value instead.`,
              );
            }
          }
        }
      }
    }

    for (const repo of orgConfig.repositories) {
      for (const team in repo.teams) {
        if (!orgConfig.teams.find((t) => t.name === team))
          throw new Error(
            `Team "${team}" assigned to "${repo.name}" does not exist in the "teams" config for "${orgConfig.organization}"`,
          );
      }

      if (repo.heroku && repo.heroku.access) {
        for (const user of repo.heroku.access) {
          if (user.startsWith('team:')) {
            if (!orgConfig.teams.find((t) => t.name === user.slice('team:'.length))) {
              throw new Error(
                `Team "${user}" assigned to heroku for "${repo.name}" does not exist in the "teams" config for "${orgConfig.organization}"`,
              );
            }
          }
        }
      }

      if (repo.rulesets) {
        const newRulesets = repo.rulesets.map((ruleset) => {
          if (typeof ruleset === 'string') {
            const mappedRuleset = orgConfig.common_rulesets?.find(
              (common) => common.name === ruleset,
            );
            if (!mappedRuleset) {
              throw new Error(
                `Ruleset "${ruleset}" assigned to repo "${repo.name}" does not exist in the "common_rulesets" config for "${orgConfig.organization}"`,
              );
            }
            return mappedRuleset;
          }
          return ruleset;
        });

        if (newRulesets.length !== new Set(newRulesets.map((r) => r.name)).size) {
          throw new Error(
            `Rulesets for repo "${repo.name}" have a duplicate name, names of rulesets must be unique for a given repo`,
          );
        }

        for (const ruleset of newRulesets) {
          if (ruleset.bypass && !ruleset.bypass.apps && !ruleset.bypass.teams) {
            throw new Error(
              `Ruleset "${ruleset.name}" for repo "${repo.name}" has bypass set but no teams or apps, either remove the bypass setting or provide a apps or teams block`,
            );
          }

          if (ruleset.bypass?.teams) {
            for (const team of ruleset.bypass?.teams) {
              if (!orgConfig.teams.some((t) => t.name === team)) {
                throw new Error(
                  `Ruleset "${ruleset.name}" for repo "${repo.name}" has bypass team "${team}" but that team does not appear to exist, create it in this config first`,
                );
              }
            }
          }

          if (ruleset.rules) {
            if (ruleset.rules.length !== new Set(ruleset.rules).size) {
              throw new Error(
                `Ruleset "${ruleset.name}" for repo "${repo.name}" has duplicate rule configured, please remove the duplicate rule in the rules block`,
              );
            }
          }
        }

        repo.rulesets = newRulesets;
      }
    }
  }

  return orgConfigs;
};

export const getValidatedConfig = async () => {
  const config = await loadCurrentConfig();
  return await validateConfigFast(config);
};

async function main() {
  const rawConfig = await loadCurrentConfig();
  const orgConfigs = await validateConfigFast(rawConfig);

  for (const config of orgConfigs) {
    const builder = MessageBuilder.create();
    const builderLengthAtStart = builder.length();

    console.info(
      chalk.bold(`Processing organization "${chalk.cyan(config.organization)}" configuration:`),
    );
    const allRepos = await listAllOrgRepos(config);
    const allTeams = await listAllTeams(config);

    const octokit = await getOctokit(config.organization);

    if (config.customProperties && config.customProperties.length > 0) {
      console.info(chalk.bold('Syncing custom property definitions...'));

      const existingProperties = (
        await octokit.orgs.getAllCustomProperties({
          org: config.organization,
        })
      ).data;

      for (const customProp of config.customProperties) {
        const existing = existingProperties.find(
          (p) => p.property_name === customProp.property_name,
        );

        const propertyPayload: components['schemas']['custom-property-set-payload'] & {
          custom_property_name: string;
        } = {
          custom_property_name: customProp.property_name,
          value_type: customProp.value_type,
          required: customProp.required || false,
        };

        if (customProp.description) {
          propertyPayload.description = customProp.description;
        }

        if (customProp.default_value !== undefined) {
          propertyPayload.default_value = customProp.default_value;
        }

        if (
          customProp.allowed_values &&
          (customProp.value_type === 'single_select' || customProp.value_type === 'multi_select')
        ) {
          propertyPayload.allowed_values = customProp.allowed_values;
        }

        if (!existing) {
          console.info(
            chalk.green('Creating custom property'),
            chalk.cyan(customProp.property_name),
            'with type',
            chalk.cyan(customProp.value_type),
          );
          builder.addContext(
            `:label: Creating custom property \`${customProp.property_name}\` with type \`${customProp.value_type}\``,
          );

          if (!IS_DRY_RUN) {
            await octokit.orgs.createOrUpdateCustomProperty({
              org: config.organization,
              ...propertyPayload,
            });
          }
        } else {
          const needsUpdate =
            existing.value_type !== customProp.value_type ||
            existing.required !== (customProp.required || false) ||
            existing.description !== customProp.description ||
            !isDeepStrictEqual(existing.default_value, customProp.default_value) ||
            !isDeepStrictEqual(existing.allowed_values, customProp.allowed_values);

          if (needsUpdate) {
            console.info(
              chalk.yellow('Updating custom property'),
              chalk.cyan(customProp.property_name),
            );
            builder.addContext(
              `:label: :pencil2: Updating custom property \`${customProp.property_name}\` with type \`${customProp.value_type}\``,
            );

            if (!IS_DRY_RUN) {
              await octokit.orgs.createOrUpdateCustomProperty({
                org: config.organization,
                ...propertyPayload,
              });
            }
          }
        }
      }

      for (const existing of existingProperties) {
        if (!config.customProperties.some((p) => p.property_name === existing.property_name)) {
          console.info(chalk.red('Deleting custom property'), chalk.cyan(existing.property_name));
          builder.addContext(
            `:label: :github-cross: Deleting custom property \`${existing.property_name}\` as it is not in config`,
          );

          if (!IS_DRY_RUN) {
            await octokit.orgs.removeCustomProperty({
              org: config.organization,
              custom_property_name: existing.property_name,
            });
          }
        }
      }
    }

    const allUsers = await listAllOrgMembersAndOwners(config);
    const usersNeedingInvite: string[] = [];
    for (const team of config.teams) {
      for (const person of [...team.members, ...team.maintainers]) {
        if (!allUsers.find((u) => u.login === person)) {
          usersNeedingInvite.push(person);
        }
      }
    }

    if (usersNeedingInvite.length) {
      const pendingInvites = await octokit.orgs.listPendingInvitations({
        org: config.organization,
      });
      for (const userNeedingInvite of usersNeedingInvite) {
        if (!pendingInvites.data.find((invite) => invite.login === userNeedingInvite)) {
          let userId: number;
          try {
            const githubUserInfo = await octokit.users.getByUsername({
              username: userNeedingInvite,
            });
            // Ensure case is correct in config file
            if (githubUserInfo.data.login !== userNeedingInvite) {
              builder.addCritical(
                `User "${userNeedingInvite}" not in "${config.organization}" organization and does not match name found on GitHub "${githubUserInfo.data.login}"`,
              );
              console.error(
                chalk.red('ERROR'),
                `User "${chalk.cyan(userNeedingInvite)}" not in "${
                  config.organization
                }" organization  and does not match name found on GitHub`,
                chalk.yellow(githubUserInfo.data.login),
              );
              if (!IS_DRY_RUN) await builder.send();
              return;
            }

            userId = githubUserInfo.data.id;
          } catch {
            builder.addCritical(
              `User "${userNeedingInvite}" not in "${config.organization}" organization and could not be found on GitHub`,
            );
            console.error(
              chalk.red('ERROR'),
              `User not in "${config.organization}" organization and could not be found on GitHub`,
              chalk.cyan(userNeedingInvite),
            );
            if (!IS_DRY_RUN) await builder.send();
            return;
          }

          builder.addContext(
            `:blob-wave: Inviting user \`${userNeedingInvite}\` to the \`${config.organization}\` org as they are listed in a team but not invited yet`,
          );
          console.info(
            `${chalk.green('Inviting')} user ${chalk.cyan(
              userNeedingInvite,
            )} to be a member of the ${chalk.cyan(config.organization)} organization`,
          );
          if (!IS_DRY_RUN) {
            await octokit.orgs.createInvitation({
              org: config.organization,
              invitee_id: userId,
              role: 'direct_member',
            });
          }
        }
      }
    }

    const missingConfigRepos = allRepos.filter(
      (r) => !config.repositories.find((repo) => repo.name === r.name),
    );
    for (const missingConfigRepo of missingConfigRepos) {
      builder.addWarning(`Missing explicit config for repo \`${missingConfigRepo.name}\``);
      console.info(
        chalk.yellow('WARNING:'),
        'Missing explicit config for repo',
        chalk.cyan(missingConfigRepo.name),
        'default to no granted permissions',
      );
      config.repositories.push({
        name: missingConfigRepo.name,
        teams: {},
        external_collaborators: {},
        visibility: 'current',
      });
    }

    if (missingConfigRepos.length) builder.divide();

    const reposNotInTargetOrg = config.repositories.filter(
      (r) => !allRepos.find((repo) => r.name === repo.name),
    );
    for (const repoNotInTargetOrg of reposNotInTargetOrg) {
      builder.addWarning(
        `Repository in config is not in the target org: ${repoNotInTargetOrg.name} it will be created`,
      );
      console.error(
        chalk.yellow('WARNING:'),
        'Repository in config is not in the target org:',
        chalk.cyan(repoNotInTargetOrg.name),
      );
    }

    const missingConfigTeams = allTeams.filter(
      (t) => !config.teams.find((team) => team.name === t.name),
    );
    for (const missingConfigTeam of missingConfigTeams) {
      builder.addCritical(`Deleting Team: \`${missingConfigTeam.name}\``);
      console.info(chalk.red('Deleting Team'), chalk.cyan(missingConfigTeam.name));
      if (!IS_DRY_RUN) {
        await octokit.teams.deleteInOrg({
          team_slug: missingConfigTeam.slug,
          org: config.organization,
        });
      }
    }

    if (missingConfigTeams.length) builder.divide();

    for (const team of config.teams) {
      for (const plugin of plugins) {
        await plugin.handleTeam?.(team, builder);
      }
      await checkTeam(builder, config, team, usersNeedingInvite);
    }

    const reposToCheck: RepositoryConfig[] = [];

    for (const repo of config.repositories) {
      let octoRepo = allRepos.find((r) => repo.name === r.name);
      if (!octoRepo) {
        if (!IS_DRY_RUN) {
          octoRepo = (
            await octokit.repos.createInOrg({
              org: config.organization,
              name: repo.name,
              has_wiki: false,
              visibility: repo.visibility === 'current' ? undefined : repo.visibility,
            })
          ).data as GetResponseDataTypeFromEndpointMethod<typeof octokit.repos.listForOrg>[0];
        } else {
          break;
        }
        listAllOrgRepos.invalidate();
      }
      // If it is archived we can not update permissions but it should still
      // be in our config in case it becomes un-archived
      if (!octoRepo.archived) {
        reposToCheck.push(repo);
      } else {
        // Even archived repos need to have the plugins run on them
        for (const plugin of plugins) {
          await plugin.handleRepo?.(repo, config.teams, config.organization, builder);
        }
      }
    }

    const q = queue({
      concurrency: 8,
      autostart: false,
    });

    for (const repo of reposToCheck) {
      q.push(() => preloadRepositoryMetadata(config, repo));
    }

    await new Promise<void>((resolve, reject) => {
      q.start((err) => {
        if (err) return reject(err);

        resolve();
      });
    });

    for (const repo of reposToCheck) {
      await checkRepository(builder, config, repo);

      for (const plugin of plugins) {
        await plugin.handleRepo?.(repo, config.teams, config.organization, builder);
      }
    }

    if (builder.length() > builderLengthAtStart) {
      console.info(' ');
      const org = await octokit.orgs.get({
        org: config.organization,
      });
      builder.unshiftBlock({
        type: 'context',
        elements: [
          {
            type: 'image',
            image_url: `https://github.com/${encodeURIComponent(config.organization)}.png`,
            alt_text: `${org.data.name}`,
          },
          {
            type: 'mrkdwn',
            text: `*${org.data.name} Org*`,
          },
        ],
      });
    } else {
      console.info(` - No changes\n`);
    }

    if (!IS_DRY_RUN) await builder.send();
  }
}

const listAllOrgOwners = memoize(
  async (config: OrganizationConfig) => {
    const octokit = await getOctokit(config.organization);
    return octokit.paginate(octokit.orgs.listMembers, {
      org: config.organization,
      role: 'admin',
    });
  },
  (config) => config.organization,
);

const listAllOrgMembersAndOwners = memoize(
  async (config: OrganizationConfig) => {
    const octokit = await getOctokit(config.organization);
    return octokit.paginate(octokit.orgs.listMembers, {
      org: config.organization,
    });
  },
  (config) => config.organization,
);

const listAllTeams = memoize(
  async (config: OrganizationConfig) => {
    const octokit = await getOctokit(config.organization);
    return octokit.paginate(octokit.teams.list, {
      org: config.organization,
      headers: {
        Accept: 'application/vnd.github.hellcat-preview+json',
      },
    });
  },
  (config) => config.organization,
);

const listAllOrgRepos = memoize(
  async (config: OrganizationConfig) => {
    const octokit = await getOctokit(config.organization);
    const repos = await octokit.paginate(octokit.repos.listForOrg, {
      org: config.organization,
    });

    const securityRepoPattern = /^[\w]+-ghsa-[A-Za-z0-9-]{4}-[A-Za-z0-9-]{4}-[A-Za-z0-9-]{4}$/;
    return repos.filter((r) => {
      const isSecurityAdvisory = securityRepoPattern.test(r.name);
      const isGlitchedRepo = GLITCHED_REPO_HASHES.includes(
        crypto.createHash('SHA256').update(r.name).digest('hex'),
      );

      return !(isGlitchedRepo || isSecurityAdvisory);
    });
  },
  (config) => config.organization,
);

const computeRepoSettings = (config: OrganizationConfig, repo: RepositoryConfig): RepoSettings => {
  const keyOrDefault = <K extends keyof RepoSettings>(key: K): RepoSettings[K] => {
    if (!repo.settings) return config.repository_defaults[key];
    if (typeof repo.settings[key] === 'undefined') return config.repository_defaults[key];
    return repo.settings[key]!;
  };

  return {
    has_wiki: keyOrDefault('has_wiki'),
    forks_need_actions_approval: keyOrDefault('forks_need_actions_approval'),
  };
};

async function findTeamByName(
  builder: MessageBuilder,
  config: OrganizationConfig,
  teamName: string,
): Promise<GetResponseDataTypeFromEndpointMethod<typeof octokit.teams.list>[0]> {
  const octokit = await getOctokit(config.organization);
  const allTeams = await listAllTeams(config);
  const matchingTeams = allTeams.filter((team) => team.name === teamName);
  if (matchingTeams.length > 1)
    throw new Error(`Found more than one team whose name matches: ${teamName}`);
  if (matchingTeams.length === 0) {
    // Create team
    builder.addContext(`:tada: Creating team with name \`${teamName}\` as it did not exist`);
    console.info(
      chalk.green('Creating Team'),
      'with name',
      chalk.cyan(teamName),
      'as it did not exist',
    );
    if (IS_DRY_RUN) {
      allTeams.push({
        id: -1,
        name: teamName,
      } as any);
    } else {
      listAllTeams.invalidate();
      await octokit.teams.create({
        org: config.organization,
        name: teamName,
      });
    }
    return await findTeamByName(builder, config, teamName);
  }
  return matchingTeams[0];
}

async function checkTeam(
  builder: MessageBuilder,
  config: OrganizationConfig,
  team: TeamConfig,
  usersNeedingInvite: string[],
) {
  const octoTeam = await findTeamByName(builder, config, team.name);
  const orgOwners = await listAllOrgOwners(config);
  const octokit = await getOctokit(config.organization);

  const proposedPrivacy = team.secret ? 'secret' : 'closed';
  if (octoTeam.privacy !== proposedPrivacy) {
    // Update privacy
    builder.addContext(
      `:sleuth_or_spy: Updating Team Privacy for \`${octoTeam.name}\` from \`${octoTeam.privacy}\` :arrow_right: \`${proposedPrivacy}\``,
    );
    console.info(
      chalk.yellow('Updating Team Privacy'),
      'for',
      chalk.cyan(octoTeam.name),
      'from',
      chalk.magenta(octoTeam.privacy || 'unknown'),
      'to',
      chalk.magenta(proposedPrivacy),
    );
    if (!IS_DRY_RUN)
      await octokit.teams.updateInOrg({
        name: team.name,
        team_slug: octoTeam.slug,
        org: config.organization,
        privacy: proposedPrivacy,
      });
  }

  if (team.parent && (!octoTeam.parent || (octoTeam.parent as any).name !== team.parent)) {
    // Update parent
    builder.addContext(
      `:family: Updating Team Parent for \`${octoTeam.name}\` from \`${
        octoTeam.parent ? (octoTeam.parent as any).name : '__ROOT__'
      }\` :arrow_right: \`${team.parent}\``,
    );
    console.info(
      chalk.yellow('Updating Team Parent'),
      'for',
      chalk.cyan(octoTeam.name),
      'from',
      chalk.magenta(octoTeam.parent ? (octoTeam.parent as any).name : '__ROOT__'),
      'to',
      chalk.magenta(team.parent),
    );
    if (!IS_DRY_RUN)
      await octokit.teams.updateInOrg({
        name: team.name,
        team_slug: octoTeam.slug,
        org: config.organization,
        parent_team_id: (await findTeamByName(builder, config, team.parent)).id,
        mediaType: {
          previews: ['hellcat-preview'],
        },
      });
  }

  let currentMembers: { id: number; login: string }[] = [];
  let currentMaintainers: { id: number; login: string }[] = [];
  if (IS_DRY_RUN && octoTeam.id === -1) {
    // Dry run with a team that has not been made yet
    // Assume empty team
  } else {
    const query = `
    query GetDirectTeamMembers ($org: String!, $team: String!, $role: TeamMemberRole!) { 
      organization (login: $org) {
        team (slug: $team) {
          members (membership: IMMEDIATE, first: 100, role: $role) {
            nodes {
              login
              id
            }
          }
        }
      }
    }
    `;
    const gql = await graphyOctokit(config.organization);
    const [memberRes, maintainerRes] = await Promise.all([
      gql(query, {
        org: config.organization,
        team: octoTeam.slug,
        role: 'MEMBER',
        // team_node_id: octoTeam.node_id,
      }) as any,
      gql(query, {
        org: config.organization,
        team: octoTeam.slug,
        role: 'MAINTAINER',
      }) as any,
    ]);
    currentMembers = memberRes.organization.team.members.nodes as Array<{
      id: number;
      login: string;
    }>;
    currentMaintainers = maintainerRes.organization.team.members.nodes as Array<{
      id: number;
      login: string;
    }>;
  }

  for (const currentMaintainer of currentMaintainers) {
    // Current maintainer should not be a maintainer according to the config
    // NOTE: Here we exclude org owners as they are always reported as a maintainer
    if (
      !team.maintainers.includes(currentMaintainer.login) &&
      !(
        orgOwners.find((owner) => owner.login === currentMaintainer.login) &&
        team.members.includes(currentMaintainer.login)
      )
    ) {
      // It is possible that this "maintainer" should be a "member", let's check that now and try deal with it
      if (team.members.includes(currentMaintainer.login)) {
        // Ah ha, we were right, let's suggest demotion
        builder.addContext(
          `:arrow_heading_down: Demoting \`${currentMaintainer.login}\` to member of \`${team.name}\``,
        );
        console.info(
          chalk.yellow('Demoting'),
          chalk.cyan(currentMaintainer.login),
          'to member of',
          chalk.cyan(team.name),
        );
        if (!IS_DRY_RUN)
          await octokit.teams.addOrUpdateMembershipForUserInOrg({
            team_slug: octoTeam.slug,
            org: config.organization,
            username: currentMaintainer.login,
            role: 'member',
          });
      } else {
        // Looks like this user is currently a maintainer and shouldn't even be part of this team, let's suggest eviction
        builder.addContext(
          `:skull_and_crossbones: Evicting \`${currentMaintainer.login}\` out of \`${team.name}\``,
        );
        console.info(
          chalk.red('Evicting'),
          chalk.cyan(currentMaintainer.login),
          'out of',
          chalk.cyan(team.name),
        );
        if (!IS_DRY_RUN)
          await octokit.teams.removeMembershipForUserInOrg({
            team_slug: octoTeam.slug,
            org: config.organization,
            username: currentMaintainer.login,
          });
      }
    }
  }

  for (const supposedMaintainer of team.maintainers) {
    // If the user has a pending invite to the org we should skip over their team membership
    // as we can't actually add them till they accept the invite
    if (usersNeedingInvite.includes(supposedMaintainer)) continue;

    // Maintainer according to the config is not currently a maintainer but should be
    if (
      !currentMaintainers.find(
        (currentMaintainer) => currentMaintainer.login === supposedMaintainer,
      )
    ) {
      // It is possible that this supposed maintainer is currently a "member" and needs to be upgrades, let's check that now and try deal with it
      if (currentMembers.find((member) => member.login === supposedMaintainer)) {
        // Ah ha, we were right, let's suggest promotion
        builder.addContext(
          `:arrow_heading_up: Promoting \`${supposedMaintainer}\` to maintainer of \`${team.name}\``,
        );
        console.info(
          chalk.green('Promoting'),
          chalk.cyan(supposedMaintainer),
          'to maintainer of',
          chalk.cyan(team.name),
        );
        if (!IS_DRY_RUN)
          await octokit.teams.addOrUpdateMembershipForUserInOrg({
            team_slug: octoTeam.slug,
            org: config.organization,
            username: supposedMaintainer,
            role: 'maintainer',
          });
      } else {
        // Looks like this user isn't currently part of this team at all, let's suggest addition with Super Powers
        builder.addContext(
          `:new: :crown: Adding \`${supposedMaintainer}\` as a maintainer of \`${team.name}\``,
        );
        console.info(
          chalk.green('Adding'),
          chalk.cyan(supposedMaintainer),
          'as a maintainer of',
          chalk.cyan(team.name),
        );
        if (!IS_DRY_RUN)
          await octokit.teams.addOrUpdateMembershipForUserInOrg({
            team_slug: octoTeam.slug,
            org: config.organization,
            username: supposedMaintainer,
            role: 'maintainer',
          });
      }
    }
  }

  for (const currentMember of currentMembers) {
    // Current member should not be a member according to the config
    if (!team.members.includes(currentMember.login)) {
      // It is possible that this "member" should be "maintainer", this would have been handled above as a missing
      // maintainer so we should ignore that case here, but to be sure we don't double-handle we still need to check
      if (team.maintainers.includes(currentMember.login)) {
        // Ignore this case as per above
      } else {
        // Looks like this member should not be in this team at all, let's suggest eviction
        builder.addContext(
          `:skull_and_crossbones: Evicting \`${currentMember.login}\` out of \`${team.name}\``,
        );
        console.info(
          chalk.red('Evicting'),
          chalk.cyan(currentMember.login),
          'out of',
          chalk.cyan(team.name),
        );
        if (!IS_DRY_RUN)
          await octokit.teams.removeMembershipForUserInOrg({
            team_slug: octoTeam.slug,
            org: config.organization,
            username: currentMember.login,
          });
      }
    }
  }

  for (const supposedMember of team.members) {
    // If the user has a pending invite to the org we should skip over their team membership
    // as we can't actually add them till they accept the invite
    if (usersNeedingInvite.includes(supposedMember)) continue;

    // Member according to the config is not currently a member but should be
    if (!currentMembers.find((currentMember) => currentMember.login === supposedMember)) {
      // It's possible that this user is an org admin and currently registered as a "maintainer" due to a quirk in the GitHub API
      if (
        orgOwners.find((owner) => owner.login === supposedMember) &&
        currentMaintainers.find((currentMaintainer) => currentMaintainer.login === supposedMember)
      ) {
        // Ok, so this user is in a good state, they appear as a maintainer and there's nothing we can do about that because
        // org owners rule the whole world.
      } else {
        // Now it's possible that this user is already a maintainer and needs to be demoted, this would have been handled above
        // but to be sure we don't double-handle we still need to check here
        if (
          currentMaintainers.find((currentMaintainer) => currentMaintainer.login === supposedMember)
        ) {
          // Ignore this case as per above
        } else {
          // Looks like this user isn't currently part of this team at all, let's suggest addition
          builder.addContext(`:new: Adding \`${supposedMember}\` as a member of \`${team.name}\``);
          console.info(
            chalk.green('Adding'),
            chalk.cyan(supposedMember),
            'as a member of',
            chalk.cyan(team.name),
          );
          if (!IS_DRY_RUN)
            await octokit.teams.addOrUpdateMembershipForUserInOrg({
              team_slug: octoTeam.slug,
              org: config.organization,
              username: supposedMember,
              role: 'member',
            });
        }
      }
    }
  }
}

type ResolveType<T extends Promise<any>> = T extends Promise<infer V> ? V : never;

const metadata = new Map<
  RepositoryConfig,
  ResolveType<ReturnType<typeof loadRepositoryMetadata>>
>();
async function loadRepositoryMetadata(config: OrganizationConfig, repo: RepositoryConfig) {
  const octokit = await getOctokit(config.organization);
  const [currentTeams, currentInvites, currentCollaborators, currentRulesets] = await Promise.all([
    octokit.paginate(octokit.repos.listTeams, {
      owner: config.organization,
      repo: repo.name,
    }),
    octokit.paginate(octokit.repos.listInvitations, {
      owner: config.organization,
      repo: repo.name,
    }),
    octokit.paginate(octokit.repos.listCollaborators, {
      owner: config.organization,
      repo: repo.name,
      affiliation: 'direct',
    }),
    repo.rulesets
      ? octokit
          .paginate(octokit.repos.getRepoRulesets, {
            repo: repo.name,
            owner: config.organization,
          })
          .then((all) => {
            return Promise.all(
              all
                .filter((ruleset) => ruleset.source_type === 'Repository')
                .map(
                  async (ruleset) =>
                    (
                      await octokit.repos.getRepoRuleset({
                        repo: repo.name,
                        owner: config.organization,
                        ruleset_id: ruleset.id,
                      })
                    ).data,
                ),
            );
          })
      : Promise.resolve(null),
  ]);

  return { currentTeams, currentInvites, currentCollaborators, currentRulesets };
}

async function preloadRepositoryMetadata(config: OrganizationConfig, repo: RepositoryConfig) {
  if (metadata.has(repo)) return;

  metadata.set(repo, await loadRepositoryMetadata(config, repo));
}

async function checkRepository(
  builder: MessageBuilder,
  config: OrganizationConfig,
  repo: RepositoryConfig,
) {
  const { currentTeams, currentInvites, currentCollaborators, currentRulesets } =
    metadata.get(repo)!;

  for (const currentTeam of currentTeams) {
    // Current team should not be on this repo according to the config
    if (!Object.keys(repo.teams || {}).includes(currentTeam.name)) {
      // Blast them to oblivion
      builder.addContext(
        `:fire: Removing \`${currentTeam.name}\` team from repo \`${
          repo.name
        }\` used to have \`${gitHubPermissionsToSheriffLevel(currentTeam.permissions!)}\``,
      );
      console.info(
        chalk.red('Removing'),
        chalk.cyan(currentTeam.name),
        'team from repo',
        chalk.cyan(repo.name),
        'used to have',
        chalk.magenta(gitHubPermissionsToSheriffLevel(currentTeam.permissions!)),
      );
      if (!IS_DRY_RUN) {
        const octokit = await getOctokit(config.organization);
        await octokit.teams.removeRepoInOrg({
          team_slug: currentTeam.slug,
          org: config.organization,
          owner: config.organization,
          repo: repo.name,
        });
      }
    } else {
      // It's supposed to be here, let's check the permission level is ok
      const currentLevel = gitHubPermissionsToSheriffLevel(currentTeam.permissions!);
      const supposedLevel = repo.teams![currentTeam.name];
      if (currentLevel !== supposedLevel) {
        // Looks like the permission level isn't quite right, let's suggest we update that
        builder.addContext(
          `:arrows_counterclockwise: Changing \`${currentTeam.name}\` team in repo \`${repo.name}\` from access level \`${currentLevel}\` :arrow_right: \`${supposedLevel}\``,
        );
        console.info(
          chalk.yellow('Changing'),
          chalk.cyan(currentTeam.name),
          'team in repo',
          chalk.cyan(repo.name),
          'from access level',
          chalk.magenta(currentLevel),
          'to',
          chalk.magenta(supposedLevel),
        );
        if (!IS_DRY_RUN) {
          const octokit = await getOctokit(config.organization);
          await octokit.teams.addOrUpdateRepoPermissionsInOrg({
            team_slug: currentTeam.slug,
            org: config.organization,
            owner: config.organization,
            repo: repo.name,
            permission: sheriffLevelToGitHubLevel(supposedLevel),
          });
        }
      }
    }
  }

  for (const supposedTeamName of Object.keys(repo.teams || {})) {
    // Supposed team is not currently on the repo and should be added
    if (!currentTeams.find((currentTeam) => currentTeam.name === supposedTeamName)) {
      // Hm, let's suggest we add this team at the right access level
      builder.addContext(
        `:heavy_plus_sign: Adding \`${supposedTeamName}\` team to repo \`${
          repo.name
        }\` at base access level \`${repo.teams![supposedTeamName]}\``,
      );
      console.info(
        chalk.green('Adding'),
        chalk.cyan(supposedTeamName),
        'team to repo',
        chalk.cyan(repo.name),
        'at base access level',
        chalk.magenta(repo.teams![supposedTeamName]),
      );
      if (!IS_DRY_RUN) {
        const octokit = await getOctokit(config.organization);
        await octokit.teams.addOrUpdateRepoPermissionsInOrg({
          owner: config.organization,
          repo: repo.name,
          permission: sheriffLevelToGitHubLevel(repo.teams![supposedTeamName]),
          org: config.organization,
          team_slug: (await findTeamByName(builder, config, supposedTeamName)).slug,
        });
      }
    }
  }

  for (const currentInvite of currentInvites) {
    const invitee = currentInvite.invitee!;
    // Current invitee should not be on this repo according to the config
    if (!Object.keys(repo.external_collaborators || {}).includes(invitee.login)) {
      // Blast them to oblivion
      builder.addContext(
        `:fire: Removing Invite for \`${invitee.login}\` from repo \`${repo.name}\` would have had \`${currentInvite.permissions}\``,
      );
      console.info(
        chalk.red('Removing Invite'),
        chalk.cyan(invitee.login),
        'from repo',
        chalk.cyan(repo.name),
        'would have had',
        chalk.magenta(currentInvite.permissions),
      );
      if (!IS_DRY_RUN) {
        const octokit = await getOctokit(config.organization);
        await octokit.repos.deleteInvitation({
          owner: config.organization,
          repo: repo.name,
          invitation_id: currentInvite.id,
        });
      }
    } else {
      // They're supposed to be here, let's check the permission level is ok
      const currentLevel = currentInvite.permissions as SheriffAccessLevel;
      const supposedLevel = repo.external_collaborators![invitee.login];
      if (currentLevel !== supposedLevel) {
        // Looks like the permission level isn't quite right, let's suggest we update that
        builder.addContext(
          `:arrows_counterclockwise: Changing invite for \`${invitee.login}\` in repo \`${repo.name}\` from access level \`${currentLevel}\` :arrow_right: \`${supposedLevel}\``,
        );
        console.info(
          chalk.yellow('Changing Invite'),
          chalk.cyan(invitee.login),
          'in repo',
          chalk.cyan(repo.name),
          'from access level',
          chalk.magenta(currentLevel),
          'to',
          chalk.magenta(supposedLevel),
        );
        if (!IS_DRY_RUN) {
          const octokit = await getOctokit(config.organization);
          await octokit.repos.updateInvitation({
            owner: config.organization,
            repo: repo.name,
            invitation_id: currentInvite.id,
            permissions: supposedLevel,
          });
        }
      }
    }
  }

  for (const currentCollaborator of currentCollaborators) {
    // Current collaborator should not be on this repo according to the config
    if (!Object.keys(repo.external_collaborators || {}).includes(currentCollaborator.login)) {
      // Blast them to oblivion
      builder.addContext(
        `:fire: Removing Collaborator \`${currentCollaborator.login}\` from repo \`${
          repo.name
        }\` used to have \`${gitHubPermissionsToSheriffLevel(currentCollaborator.permissions!)}\``,
      );
      console.info(
        chalk.red('Removing Collaborator'),
        chalk.cyan(currentCollaborator.login),
        'from repo',
        chalk.cyan(repo.name),
        'used to have',
        chalk.magenta(gitHubPermissionsToSheriffLevel(currentCollaborator.permissions!)),
      );
      if (!IS_DRY_RUN) {
        const octokit = await getOctokit(config.organization);
        await octokit.repos.removeCollaborator({
          owner: config.organization,
          repo: repo.name,
          username: currentCollaborator.login,
        });
      }
    } else {
      // They're supposed to be here, let's check the permission level is ok
      const currentLevel = gitHubPermissionsToSheriffLevel(currentCollaborator.permissions!);
      const supposedLevel = repo.external_collaborators![currentCollaborator.login];
      if (currentLevel !== supposedLevel) {
        // Looks like the permission level isn't quite right, let's suggest we update that
        builder.addContext(
          `:arrows_counterclockwise: Changing Collaborator \`${currentCollaborator.login}\` in repo \`${repo.name}\` from access level \`${currentLevel}\` :arrow_right: \`${supposedLevel}\``,
        );
        console.info(
          chalk.yellow('Changing Collaborator'),
          chalk.cyan(currentCollaborator.login),
          'in repo',
          chalk.cyan(repo.name),
          'from access level',
          chalk.magenta(currentLevel),
          'to',
          chalk.magenta(supposedLevel),
        );
        if (!IS_DRY_RUN) {
          const octokit = await getOctokit(config.organization);
          await octokit.repos.addCollaborator({
            owner: config.organization,
            repo: repo.name,
            username: currentCollaborator.login,
            permission: sheriffLevelToGitHubLevel(supposedLevel),
          });
        }
      }
    }
  }

  const octoRepo = (await listAllOrgRepos(config)).find((r) => repo.name === r.name)!;
  const computedSettings = computeRepoSettings(config, repo);
  let update = false;
  update = update || octoRepo.has_wiki !== computedSettings.has_wiki;

  if (update) {
    builder.addContext(`:speak_no_evil: Updating repostiory settings for \`${octoRepo.name}\``);
    console.info(chalk.yellow('Updating repository settings for'), chalk.cyan(octoRepo.name));
    if (!IS_DRY_RUN) {
      const octokit = await getOctokit(config.organization);
      await octokit.repos.update({
        owner: config.organization,
        repo: octoRepo.name,
        has_wiki: computedSettings.has_wiki,
      });
    }
  }

  if (computedSettings.forks_need_actions_approval && repo.visibility !== 'private') {
    const octokit = await getOctokit(config.organization);

    // Check current setting first
    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval',
      {
        owner: config.organization,
        repo: repo.name,
      },
    );
    const currentSetting = response.data as { approval_policy: string };

    if (currentSetting?.approval_policy !== 'all_external_contributors') {
      builder.addContext(
        `:lock: Setting fork PR contributor approval to require all external contributors for \`${repo.name}\``,
      );
      console.info(
        chalk.yellow(
          'Setting fork PR contributor approval to require all external contributors for',
        ),
        chalk.cyan(repo.name),
      );
      if (!IS_DRY_RUN) {
        await octokit.request(
          'PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval',
          {
            owner: config.organization,
            repo: repo.name,
            approval_policy: 'all_external_contributors',
          },
        );
      }
    }
  }

  const repoVisibility = repo.visibility || 'public';
  // Failsafe to ensure renamed repos do not change their visibility status
  if (repoVisibility !== 'current') {
    const shouldBePrivate = repoVisibility === 'private';
    if (octoRepo.private !== shouldBePrivate) {
      if (octoRepo.stargazers_count === undefined || octoRepo.stargazers_count >= 100) {
        builder.addCritical(
          `:octagonal_sign: Aborting repository visibility update for \`${octoRepo.name}\` to \`${repoVisibility}\` as repo has \`${octoRepo.stargazers_count}\` stargazers`,
        );
        console.error(
          chalk.red('Aborting repository visibility update for'),
          chalk.cyan(octoRepo.name),
          'to',
          chalk.magenta(repoVisibility),
          'as repo has',
          chalk.yellow(`${octoRepo.stargazers_count}`),
          'stargazers',
        );
      } else {
        builder.addContext(
          `:ninja: Updating repository visibility for \`${octoRepo.name}\` to \`${repoVisibility}\``,
        );
        console.info(
          chalk.yellow('Updating repository visibility for'),
          chalk.cyan(octoRepo.name),
          'to',
          chalk.magenta(repoVisibility),
        );
        if (!IS_DRY_RUN) {
          const octokit = await getOctokit(config.organization);
          await octokit.repos.update({
            owner: config.organization,
            repo: octoRepo.name,
            private: shouldBePrivate,
          });
        }
      }
    }
  }

  for (const supposedCollaboratorName of Object.keys(repo.external_collaborators || {})) {
    // Supposed collaborator is not currently in the repo and should be added
    if (
      !currentCollaborators.find(
        (currentCollaborator) => currentCollaborator.login === supposedCollaboratorName,
      ) &&
      !currentInvites.find(
        (currentInvite) => currentInvite.invitee!.login === supposedCollaboratorName,
      )
    ) {
      // Hm, let's suggest we add this collaborator at the right access level
      builder.addContext(
        `:heavy_plus_sign: Adding Collaborator \`${supposedCollaboratorName}\` to repo \`${
          repo.name
        }\` at base access level \`${repo.external_collaborators![supposedCollaboratorName]}\``,
      );
      console.info(
        chalk.green('Adding Collaborator'),
        chalk.cyan(supposedCollaboratorName),
        'to repo',
        chalk.cyan(repo.name),
        'at base access level',
        chalk.magenta(repo.external_collaborators![supposedCollaboratorName]),
      );
      if (!IS_DRY_RUN) {
        const octokit = await getOctokit(config.organization);
        await octokit.repos.addCollaborator({
          owner: config.organization,
          repo: repo.name,
          username: supposedCollaboratorName,
          permission: sheriffLevelToGitHubLevel(
            repo.external_collaborators![supposedCollaboratorName],
          ),
        });
      }
    }
  }

  if (repo.properties) {
    const octokit = await getOctokit(config.organization);
    const props = await octokit.repos.getCustomPropertiesValues({
      owner: config.organization,
      repo: repo.name,
    });

    const sortProps = (a: { property_name: string }, b: { property_name: string }) =>
      a.property_name.localeCompare(b.property_name);
    const mappedProperties = Object.entries(repo.properties).map(([key, value]) => ({
      property_name: key,
      value: Array.isArray(value) ? value : (value as string | null),
    }));
    for (const orgProp of config.customProperties || []) {
      if (
        orgProp.default_value &&
        !mappedProperties.some((m) => m.property_name === orgProp.property_name)
      ) {
        // If we have an org prop with a default value but not explicitly defined just augment it to account for the default when diffing
        mappedProperties.push({
          property_name: orgProp.property_name,
          value: orgProp.default_value,
        });
      }
    }
    mappedProperties.sort(sortProps);
    props.data.sort(sortProps);
    if (JSON.stringify(props.data) !== JSON.stringify(mappedProperties)) {
      console.info(
        chalk.green('Updating Repository Properties'),
        chalk.cyan(repo.name),
        'setting to',
        chalk.cyan(JSON.stringify(repo.properties, null, 2)),
      );
      builder.addContext(
        `:label: :synchronize: Syncing properties for repo \`${
          repo.name
        }\` values \`${mappedProperties.map((p) => `${p.property_name}=${p.value}`).join(', ')}\``,
      );

      if (!IS_DRY_RUN) {
        await octokit.orgs.createOrUpdateCustomPropertiesValuesForRepos({
          org: config.organization,
          repository_names: [repo.name],
          properties: mappedProperties,
        });
      }
    }
  }

  if (repo.rulesets && currentRulesets) {
    const expectedRulesets = repo.rulesets as Ruleset[];
    const octokit = await getOctokit(config.organization);

    const rulesetsToAdd: Ruleset[] = [];

    // Figure out which rulesets we do not have at all
    for (const ruleset of expectedRulesets) {
      if (!currentRulesets.some((r) => r.name === ruleset.name)) {
        rulesetsToAdd.push(ruleset);
      }
    }

    for (const ruleset of currentRulesets) {
      const expectedRuleset = expectedRulesets.find((r) => r.name === ruleset.name);
      // If we should not have this ruleset, nuke it
      if (!expectedRuleset) {
        console.info(
          chalk.red('Removing Ruleset'),
          chalk.cyan(ruleset.name),
          'from repo',
          chalk.cyan(repo.name),
          "as it's not in the config",
        );
        builder.addContext(
          `:gavel: :fire: Removing Ruleset \`${ruleset.name}\` from repo \`${repo.name}\` as it\'s not in the config`,
        );

        if (!IS_DRY_RUN) {
          await octokit.repos.deleteRepoRuleset({
            repo: repo.name,
            owner: config.organization,
            ruleset_id: ruleset.id,
          });
        }
        continue;
      }

      // If we should have this ruleset, let's make sure the settings are the same
      // to do that we generate the theoretical github ruleset blob and just
      // compare them deeply. We need this to add them anyway, so let's generate it
      // in a helper to de-dupe this logic.
      const allTeams = await listAllTeams(config);
      const githubFormattedRuleset = rulesetToGithub(expectedRuleset, allTeams);
      const difference = getDifferenceWithGithubRuleset(githubFormattedRuleset, ruleset, true);
      if (difference) {
        builder.addContext(
          `:gavel: :arrows_clockwise: Updating Ruleset \`${ruleset.name}\` in repo \`${repo.name}\` as we\'ve detected changes\n\n\`\`\`\n${difference}\n\`\`\`\n`,
        );
        console.info(
          chalk.yellow('Updating Ruleset'),
          chalk.cyan(ruleset.name),
          'in repo',
          chalk.cyan(repo.name),
          "as we've detected changes",
        );
        console.info(getDifferenceWithGithubRuleset(githubFormattedRuleset, ruleset, false));

        if (!IS_DRY_RUN) {
          await octokit.repos.updateRepoRuleset({
            repo: repo.name,
            owner: config.organization,
            ruleset_id: ruleset.id,
            ...githubFormattedRuleset,
          });
        }
      }
    }

    for (const ruleset of rulesetsToAdd) {
      const allTeams = await listAllTeams(config);
      const githubFormattedRuleset = rulesetToGithub(ruleset, allTeams);

      builder.addContext(
        `:gavel: :new: Creating Ruleset \`${ruleset.name}\` in repo \`${
          repo.name
        }\` as it does not exist\n\n\`\`\`\n${getDifferenceWithGithubRuleset(
          githubFormattedRuleset,
          null,
          true,
        )}\n\`\`\`\n`,
      );
      console.info(
        chalk.green('Creating Ruleset'),
        chalk.cyan(ruleset.name),
        'in repo',
        chalk.cyan(repo.name),
        'as it does not exist',
      );
      console.info(getDifferenceWithGithubRuleset(githubFormattedRuleset, null, false));

      if (!IS_DRY_RUN) {
        await octokit.repos.createRepoRuleset({
          repo: repo.name,
          owner: config.organization,
          ...githubFormattedRuleset,
        });
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
