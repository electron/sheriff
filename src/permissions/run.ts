import chalk from 'chalk';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as Joi from 'joi';
import * as yml from 'js-yaml';

import { TeamConfig } from './plugins/Plugin';

import { octokit } from '../octokit';
import { memoize, IS_DRY_RUN } from '../helpers';
import {
  OrgsListMembersResponseItem,
  TeamsListResponseItem,
  ReposListTeamsResponseItem,
  TeamsListMembersResponseItem,
  ReposListCollaboratorsResponseItem,
  ReposListCollaboratorsResponseItemPermissions,
  ReposGetResponse,
} from '@octokit/rest';
import { MessageBuilder } from '../MessageBuilder';
import { plugins } from './plugins';

const GLITCHED_REPO_HASHES = [
  'd9a1eb0cd63e7509c90828354e18d54a8d616c80ecdc6ded8972a4f788540859',
  '02bbdc6c7234919718640b8ea2bbfd6b928a6b6b6673f3cf1c47b014ec862fba',
  'c0d21cf7d21c8e1e455489565f423585517812a9ec63382bd380193ae2a8af59',
  'bc413d15c3f36be3440c26fad745619ec92effe583ce26849e7f7d5ad8f80465',
];

console.warn('Dry Run?:', chalk[IS_DRY_RUN ? 'green' : 'red'](`${IS_DRY_RUN}`));

type AccessLevel = 'read' | 'write' | 'admin';
type GitHubAccessLevel = 'pull' | 'push' | 'admin';

const gitHubLevelToSheriffLevel = (gitHubLevel: GitHubAccessLevel): AccessLevel => {
  switch (gitHubLevel) {
    case 'pull':
      return 'read';
    case 'push':
      return 'write';
    case 'admin':
      return 'admin';
  }
  throw new Error(`Attempted to convert unknown github access level "${gitHubLevel}"`);
};

const sheriffLevelToGitHubLevel = (acessLevel: AccessLevel): GitHubAccessLevel => {
  switch (acessLevel) {
    case 'read':
      return 'pull';
    case 'write':
      return 'push';
    case 'admin':
      return 'admin';
  }
  throw new Error(`Attempted to convert unknown github access level "${acessLevel}"`);
};

const gitHubPermissionsToSheriffLevel = (
  gitHubPermissions: ReposListCollaboratorsResponseItemPermissions,
): AccessLevel => {
  if (gitHubPermissions.admin) return 'admin';
  if (gitHubPermissions.push) return 'write';
  if (gitHubPermissions.pull) return 'read';
  throw new Error(
    `Attempted to convert unhandleable github permissions object "${JSON.stringify(
      gitHubPermissions,
    )}"`,
  );
};

interface RepositoryConfig {
  name: string;
  /**
   * Map of team name to access level
   */
  teams: Record<string, AccessLevel>;
  /**
   * Map of username to access level
   */
  external_collaborators: Record<string, AccessLevel>;
  settings?: Partial<RepoSettings>;
}

interface RepoSettings {
  has_wiki: boolean;
}

interface PermissionsConfig {
  organization: string;
  repository_defaults: RepoSettings;
  teams: TeamConfig[];
  repositories: RepositoryConfig[];
}

const loadCurrentConfig = async () => {
  if (fs.existsSync('config.yml'))
    return yml.safeLoad(fs.readFileSync('config.yml', 'utf8')) as PermissionsConfig;
  if (!process.env.PERMISSIONS_FILE_ORG) {
    throw new Error('Missing PERMISSIONS_FILE_ORG env var');
  }

  const contents = await octokit.repos.getContents({
    owner: process.env.PERMISSIONS_FILE_ORG!,
    repo: process.env.PERMISSIONS_FILE_REPO || '.permissions',
    path: process.env.PERMISSIONS_FILE_PATH || 'config.yaml',
  });
  if (Array.isArray(contents.data)) throw new Error('Invalid config file');

  return yml.safeLoad(
    Buffer.from(contents.data.content || '', contents.data.encoding as any).toString('utf8'),
  ) as PermissionsConfig;
};

const validateConfigFast = async (config: PermissionsConfig) => {
  // Support formation prop
  config.teams = config.teams.map(team => {
    const anyTeam = team as any;
    if (anyTeam.formation) {
      const formationTeams = config.teams.filter(t => anyTeam.formation.includes(t.name));
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

  // Ensure the object looks right
  await Joi.validate(config, {
    organization: Joi.string()
      .min(1)
      .required(),
    repository_defaults: Joi.object({
      has_wiki: Joi.boolean().required(),
    }).required(),
    teams: Joi.array()
      .items({
        name: Joi.string()
          .min(1)
          .required(),
        displayName: Joi.string()
          .min(1)
          .optional(),
        parent: Joi.string()
          .min(1)
          .optional(),
        secret: Joi.bool().optional(),
        members: Joi.array()
          .items(Joi.string().min(1))
          .min(0)
          .required(),
        maintainers: Joi.array()
          .items(Joi.string().min(1))
          .min(1)
          .required(),
        gsuite: Joi.object({
          privacy: Joi.string()
            .only('internal', 'external')
            .required(),
        }).optional(),
        slack: Joi.string()
          .min(1)
          .allow(true)
          .optional(),
      })
      .required(),
    repositories: Joi.array()
      .items({
        name: Joi.string()
          .min(1)
          .required(),
        teams: Joi.object()
          .pattern(Joi.string(), Joi.string().only('read', 'write', 'admin'))
          .optional(),
        external_collaborators: Joi.object()
          .pattern(Joi.string().min(1), Joi.string().only('read', 'write', 'admin'))
          .optional(),
        settings: Joi.object({
          has_wiki: Joi.boolean(),
        }),
      })
      .required(),
  });

  for (const team of config.teams) {
    if (
      new Set([...team.members, ...team.maintainers]).size !==
      team.members.length + team.maintainers.length
    ) {
      throw new Error(
        `Team "${team.name}" in the teams config appears to have a crossover between members and maintainers.  Users should appear in at most one section`,
      );
    }
    const parentTeam = team.parent && config.teams.find(t => t.name === team.parent);
    if (team.parent && !parentTeam) {
      throw new Error(
        `Team "${team.name}" has a parent team of "${team.parent}" but that team does not appear to exist`,
      );
    }
    if (team.parent && team.secret) {
      throw new Error(
        `Team "${team.name}" is marked as secret but it has a parent team, this is not allowed by GitHub`,
      );
    }
    if (team.gsuite && !team.displayName) {
      throw new Error(
        `Team "${team.name}" has a gsuite config but no displayName, this is required`,
      );
    }
    if (parentTeam) {
      let parentRef: TeamConfig | undefined = parentTeam;
      const visited = [team.name];
      while (parentRef) {
        if (visited.includes(parentRef.name)) {
          throw new Error(
            `Team "${
              team.name
            }" has a circular parent reference that eventually loops back to itself.  Path: ${[
              ...visited,
              parentRef.name,
            ]
              .map(n => `"${n}"`)
              .join(' --> ')}`,
          );
        }
        visited.push(parentRef.name);
        if (parentRef.secret) {
          throw new Error(
            `Team "${team.name}" has a parent team "${parentRef.name}" that is marked as secret, this is not allowed by GitHub`,
          );
        }
        parentRef =
          (parentRef.parent && config.teams.find(t => t.name === parentRef!.parent)) || undefined;
      }
    }
  }

  const seenTeams = new Set<string>();
  for (const team of config.teams) {
    if (seenTeams.has(team.name)) {
      throw new Error(
        `Team "${team.name}" appears multiple times in the config, it should only appear once`,
      );
    }
    seenTeams.add(team.name);
  }

  const seenRepos = new Set<string>();
  for (const repo of config.repositories) {
    if (seenRepos.has(repo.name)) {
      throw new Error(
        `Repository "${repo.name}" appears multiple times in the config, it should only appear once`,
      );
    }
    seenRepos.add(repo.name);
  }

  for (const repo of config.repositories) {
    for (const team in repo.teams) {
      if (!config.teams.find(t => t.name === team))
        throw new Error(
          `Team "${team}" assigned to "${repo.name}" does not exist in the "teams" config`,
        );
    }
  }
};

async function main() {
  const builder = MessageBuilder.create();
  const config = await loadCurrentConfig();
  await validateConfigFast(config);

  const allRepos = await listAllOrgRepos(config);
  const allTeams = await listAllTeams(config);

  const allUsers = await listAllOrgMembersAndOwners(config);
  const badUsers: string[] = [];
  for (const team of config.teams) {
    for (const person of [...team.members, ...team.maintainers]) {
      if (!allUsers.find(u => u.login === person)) {
        badUsers.push(person);
      }
    }
  }

  if (badUsers.length) {
    for (const badUser of badUsers) {
      builder.addCritical(`User in team configuration is not in the target org: ${badUser}`);
      console.error(
        chalk.red('ERROR'),
        'User in team configuration is not in the target org::',
        chalk.cyan(badUser),
      );
    }
    return await builder.send();
  }

  const missingConfigRepos = allRepos.filter(
    r => !config.repositories.find(repo => repo.name === r.name),
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
    });
  }

  if (missingConfigRepos.length) builder.divide();

  const reposNotInTargetOrg = config.repositories.filter(
    r => !allRepos.find(repo => r.name === repo.name),
  );
  for (const repoNotInTargetOrg of reposNotInTargetOrg) {
    builder.addCritical(
      `Repository in config is not in the target org: ${repoNotInTargetOrg.name}`,
    );
    console.error(
      chalk.red('ERROR'),
      'Repository in config is not in the target org:',
      chalk.cyan(repoNotInTargetOrg.name),
    );
  }

  if (reposNotInTargetOrg.length) {
    return await builder.send();
  }

  const missingConfigTeams = allTeams.filter(t => !config.teams.find(team => team.name === t.name));
  for (const missingConfigTeam of missingConfigTeams) {
    builder.addCritical(`Deleting Team: \`${missingConfigTeam.name}\``);
    console.info(chalk.red('Deleting Team'), chalk.cyan(missingConfigTeam.name));
    await octokit.teams.delete({
      team_id: missingConfigTeam.id,
    });
  }

  if (missingConfigTeams.length) builder.divide();

  for (const team of config.teams) {
    for (const plugin of plugins) {
      await plugin.handleTeam(team, builder);
    }
    await checkTeam(builder, config, team);
  }

  for (const repo of config.repositories) {
    let octoRepo = allRepos.find(r => repo.name === r.name);
    if (!octoRepo) {
      octoRepo = (
        await octokit.repos.createInOrg({
          org: config.organization,
          name: repo.name,
          has_wiki: false,
        })
      ).data as ReposGetResponse;
    }
    // If it is archived we can not update permissions but it should still
    // be in our config in case it becomes un-archived
    if (!octoRepo.archived) {
      await checkRepository(builder, config, repo);
    }
  }

  if (!IS_DRY_RUN) await builder.send();
}

const listAllOrgOwners = memoize(function(config: PermissionsConfig) {
  return octokit.paginate(
    octokit.orgs.listMembers.endpoint.merge({
      org: config.organization,
      role: 'admin',
    }),
  ) as Promise<OrgsListMembersResponseItem[]>;
});

const listAllOrgMembersAndOwners = memoize(function(config: PermissionsConfig) {
  return octokit.paginate(
    octokit.orgs.listMembers.endpoint.merge({
      org: config.organization,
    }),
  ) as Promise<OrgsListMembersResponseItem[]>;
});

const listAllTeams = memoize(function(config: PermissionsConfig) {
  return octokit.paginate(
    octokit.teams.list.endpoint.merge({
      org: config.organization,
      headers: {
        Accept: 'application/vnd.github.hellcat-preview+json',
      },
    }),
  ) as Promise<TeamsListResponseItem[]>;
});

const listAllOrgRepos = memoize(async function(config: PermissionsConfig) {
  const repos = await (octokit.paginate(
    octokit.repos.listForOrg.endpoint.merge({
      org: config.organization,
    }),
  ) as Promise<ReposGetResponse[]>);

  const securityRepoPattern = /^[\w]+-ghsa-[A-Za-z0-9-]{4}-[A-Za-z0-9-]{4}-[A-Za-z0-9-]{4}$/;
  return repos.filter(r => {
    const isSecurityAdvisory = securityRepoPattern.test(r.name);
    const isGlitchedRepo = GLITCHED_REPO_HASHES.includes(
      crypto
        .createHash('SHA256')
        .update(r.name)
        .digest('hex'),
    );

    return !(isGlitchedRepo || isSecurityAdvisory);
  });
});

const computeRepoSettings = (config: PermissionsConfig, repo: RepositoryConfig): RepoSettings => {
  const keyOrDefault = (key: keyof RepoSettings) => {
    if (!repo.settings) return config.repository_defaults[key];
    if (typeof repo.settings[key] === 'undefined') return config.repository_defaults[key];
    return repo.settings[key]!;
  };

  return {
    has_wiki: keyOrDefault('has_wiki'),
  };
};

async function findTeamByName(
  builder: MessageBuilder,
  config: PermissionsConfig,
  teamName: string,
): Promise<TeamsListResponseItem> {
  const allTeams = await listAllTeams(config);
  const matchingTeams = allTeams.filter(team => team.name === teamName);
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

async function checkTeam(builder: MessageBuilder, config: PermissionsConfig, team: TeamConfig) {
  const octoTeam = await findTeamByName(builder, config, team.name);
  const orgOwners = await listAllOrgOwners(config);

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
      chalk.magenta(octoTeam.privacy),
      'to',
      chalk.magenta(proposedPrivacy),
    );
    if (!IS_DRY_RUN)
      await octokit.teams.update({
        name: team.name,
        team_id: octoTeam.id,
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
      await octokit.teams.update({
        name: team.name,
        team_id: octoTeam.id,
        parent_team_id: (await findTeamByName(builder, config, team.parent)).id,
        mediaType: {
          previews: ['hellcat-preview'],
        },
      });
  }

  let currentMembers: TeamsListMembersResponseItem[] = [];
  let currentMaintainers: TeamsListMembersResponseItem[] = [];
  if (IS_DRY_RUN && octoTeam.id === -1) {
    // Dry run with a team that has not been made yet
    // Assume empty team
  } else {
    currentMembers = (await octokit.paginate(
      octokit.teams.listMembers.endpoint.merge({
        team_id: octoTeam.id,
        role: 'member',
      }),
    )) as TeamsListMembersResponseItem[];
    currentMaintainers = (await octokit.paginate(
      octokit.teams.listMembers.endpoint.merge({
        team_id: octoTeam.id,
        role: 'maintainer',
      }),
    )) as TeamsListMembersResponseItem[];
  }

  for (const currentMaintainer of currentMaintainers) {
    // Current maintainer should not be a maintainer according to the config
    // NOTE: Here we exclude org owners as they are always reported as a maintainer
    if (
      !team.maintainers.includes(currentMaintainer.login) &&
      !(
        orgOwners.find(owner => owner.login === currentMaintainer.login) &&
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
          await octokit.teams.addOrUpdateMembership({
            team_id: octoTeam.id,
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
          await octokit.teams.removeMembership({
            team_id: octoTeam.id,
            username: currentMaintainer.login,
          });
      }
    }
  }

  for (const supposedMaintainer of team.maintainers) {
    // Maintainer according to the config is not currently a maintainer but should be
    if (
      !currentMaintainers.find(currentMaintainer => currentMaintainer.login === supposedMaintainer)
    ) {
      // It is possible that this supposed maintainer is currently a "member" and needs to be upgrades, let's check that now and try deal with it
      if (currentMembers.find(member => member.login === supposedMaintainer)) {
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
          await octokit.teams.addOrUpdateMembership({
            team_id: octoTeam.id,
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
          await octokit.teams.addOrUpdateMembership({
            team_id: octoTeam.id,
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
          await octokit.teams.removeMembership({
            team_id: octoTeam.id,
            username: currentMember.login,
          });
      }
    }
  }

  for (const supposedMember of team.members) {
    // Member according to the config is not currently a member but should be
    if (!currentMembers.find(currentMember => currentMember.login === supposedMember)) {
      // It's possible that this user is an org admin and currently registered as a "maintainer" due to a quirk in the GitHub API
      if (
        orgOwners.find(owner => owner.login === supposedMember) &&
        currentMaintainers.find(currentMaintainer => currentMaintainer.login === supposedMember)
      ) {
        // Ok, so this user is in a good state, they appear as a maintainer and there's nothing we can do about that because
        // org owners rule the whole world.
      } else {
        // Now it's possible that this user is already a maintainer and needs to be demoted, this would have been handled above
        // but to be sure we don't double-handle we still need to check here
        if (
          currentMaintainers.find(currentMaintainer => currentMaintainer.login === supposedMember)
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
            await octokit.teams.addOrUpdateMembership({
              team_id: octoTeam.id,
              username: supposedMember,
              role: 'member',
            });
        }
      }
    }
  }
}

async function checkRepository(
  builder: MessageBuilder,
  config: PermissionsConfig,
  repo: RepositoryConfig,
) {
  const currentTeams = (await octokit.paginate(
    octokit.repos.listTeams.endpoint.merge({
      owner: config.organization,
      repo: repo.name,
    }),
  )) as ReposListTeamsResponseItem[];

  for (const currentTeam of currentTeams) {
    // Current team should not be on this repo according to the config
    if (!Object.keys(repo.teams || {}).includes(currentTeam.name)) {
      // Blast them to oblivion
      builder.addContext(
        `:fire: Removing \`${currentTeam.name}\` team from repo \`${
          repo.name
        }\` used to have \`${gitHubLevelToSheriffLevel(
          currentTeam.permission as GitHubAccessLevel,
        )}\``,
      );
      console.info(
        chalk.red('Removing'),
        chalk.cyan(currentTeam.name),
        'team from repo',
        chalk.cyan(repo.name),
        'used to have',
        chalk.magenta(gitHubLevelToSheriffLevel(currentTeam.permission as GitHubAccessLevel)),
      );
      if (!IS_DRY_RUN)
        await octokit.teams.removeRepo({
          team_id: currentTeam.id,
          owner: config.organization,
          repo: repo.name,
        });
    } else {
      // It's supposed to be here, let's check the permission level is ok
      const currentLevel = gitHubLevelToSheriffLevel(currentTeam.permission as GitHubAccessLevel);
      const supposedLevel = repo.teams[currentTeam.name];
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
        if (!IS_DRY_RUN)
          await octokit.teams.addOrUpdateRepo({
            team_id: currentTeam.id,
            owner: config.organization,
            repo: repo.name,
            permission: sheriffLevelToGitHubLevel(supposedLevel),
          });
      }
    }
  }

  for (const supposedTeamName of Object.keys(repo.teams || {})) {
    // Supposed team is not currently on the repo and should be added
    if (!currentTeams.find(currentTeam => currentTeam.name === supposedTeamName)) {
      // Hm, let's suggest we add this team at the right access level
      builder.addContext(
        `:heavy_plus_sign: Adding \`${supposedTeamName}\` team to repo \`${repo.name}\` at base access level \`${repo.teams[supposedTeamName]}\``,
      );
      console.info(
        chalk.green('Adding'),
        chalk.cyan(supposedTeamName),
        'team to repo',
        chalk.cyan(repo.name),
        'at base access level',
        chalk.magenta(repo.teams[supposedTeamName]),
      );
      if (!IS_DRY_RUN)
        await octokit.teams.addOrUpdateRepo({
          team_id: (await findTeamByName(builder, config, supposedTeamName)).id,
          owner: config.organization,
          repo: repo.name,
          permission: sheriffLevelToGitHubLevel(repo.teams[supposedTeamName]),
        });
    }
  }

  const currentCollaborators = (await octokit.paginate(
    octokit.repos.listCollaborators.endpoint.merge({
      owner: config.organization,
      repo: repo.name,
      affiliation: 'direct',
    }),
  )) as ReposListCollaboratorsResponseItem[];

  for (const currentCollaborator of currentCollaborators) {
    // Current collaborator should not be on this repo according to the config
    if (!Object.keys(repo.external_collaborators || {}).includes(currentCollaborator.login)) {
      // Blast them to oblivion
      builder.addContext(
        `:fire: Removing Collaborator \`${currentCollaborator.login}\` from repo \`${
          repo.name
        }\` used to have \`${gitHubPermissionsToSheriffLevel(currentCollaborator.permissions)}\``,
      );
      console.info(
        chalk.red('Removing Collaborator'),
        chalk.cyan(currentCollaborator.login),
        'from repo',
        chalk.cyan(repo.name),
        'used to have',
        chalk.magenta(gitHubPermissionsToSheriffLevel(currentCollaborator.permissions)),
      );
      if (!IS_DRY_RUN)
        await octokit.repos.removeCollaborator({
          owner: config.organization,
          repo: repo.name,
          username: currentCollaborator.login,
        });
    } else {
      // They're supposed to be here, let's check the permission level is ok
      const currentLevel = gitHubPermissionsToSheriffLevel(currentCollaborator.permissions);
      const supposedLevel = repo.external_collaborators[currentCollaborator.login];
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
        if (!IS_DRY_RUN)
          await octokit.repos.addCollaborator({
            owner: config.organization,
            repo: repo.name,
            username: currentCollaborator.login,
            permission: sheriffLevelToGitHubLevel(supposedLevel),
          });
      }
    }
  }

  const octoRepo = (await listAllOrgRepos(config)).find(r => repo.name === r.name)!;
  const computedSettings = computeRepoSettings(config, repo);
  let update = false;
  update = update || octoRepo.has_wiki !== computedSettings.has_wiki;

  if (update) {
    builder.addContext(`:speak_no_evil: Updating repostiory settings for \`${octoRepo.name}\``);
    console.info(chalk.yellow('Updating repository settings for'), chalk.cyan(octoRepo.name));
    if (!IS_DRY_RUN) {
      await octokit.repos.update({
        owner: config.organization,
        repo: octoRepo.name,
        has_wiki: computedSettings.has_wiki,
      });
    }
  }

  for (const supposedCollaboratorName of Object.keys(repo.external_collaborators || {})) {
    // Supposed collaborator is not currently in the repo and should be added
    if (
      !currentCollaborators.find(
        currentCollaborator => currentCollaborator.login === supposedCollaboratorName,
      )
    ) {
      // Hm, let's suggest we add this collaborator at the right access level
      builder.addContext(
        `:heavy_plus_sign: Adding Collaborator \`${supposedCollaboratorName}\` to repo \`${repo.name}\` at base access level \`${repo.external_collaborators[supposedCollaboratorName]}\``,
      );
      console.info(
        chalk.green('Adding Collaborator'),
        chalk.cyan(supposedCollaboratorName),
        'to repo',
        chalk.cyan(repo.name),
        'at base access level',
        chalk.magenta(repo.external_collaborators[supposedCollaboratorName]),
      );
      if (!IS_DRY_RUN)
        await octokit.repos.addCollaborator({
          owner: config.organization,
          repo: repo.name,
          username: supposedCollaboratorName,
          permission: sheriffLevelToGitHubLevel(
            repo.external_collaborators[supposedCollaboratorName],
          ),
        });
    }
  }
}

if (process.mainModule === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
