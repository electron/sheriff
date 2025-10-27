import { MessageBuilder } from '../../../MessageBuilder.js';
import { RepositoryConfig, TeamConfig } from '../../types.js';
import { Plugin } from '../Plugin.js';
import {
  GITHUB_DEFAULT_BRANCH,
  NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
} from '../../../constants.js';
import { IS_DRY_RUN } from '../../../helpers.js';
import { getOctokit } from '../../../octokit.js';
import chalk from 'chalk';

class TrustedPublisherPlugin implements Plugin {
  handleRepo = async (
    repo: RepositoryConfig,
    teams: TeamConfig[],
    org: string,
    builder: MessageBuilder,
  ) => {
    const { properties } = repo;
    if (!properties) return;

    if (properties.type === 'ecosystem-npm-package') {
      await this.ensureNpmEnvironment(repo, org, builder);
    }
  };

  private ensureNpmEnvironment = async (
    repo: RepositoryConfig,
    org: string,
    builder: MessageBuilder,
  ) => {
    const octokit = await getOctokit(org);

    let environment;
    try {
      ({ data: environment } = await octokit.repos.getEnvironment({
        owner: org,
        repo: repo.name,
        environment_name: NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
      }));

      if (!IS_DRY_RUN) {
        if (environment && environment.deployment_branch_policy?.custom_branch_policies !== true) {
          await octokit.repos.createOrUpdateEnvironment({
            owner: org,
            repo: repo.name,
            environment_name: NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
            deployment_branch_policy: {
              protected_branches: false,
              custom_branch_policies: true,
            },
          });
        }
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error;
      }
    }

    if (!environment) {
      console.info(
        chalk.green('Creating GitHub environment'),
        chalk.cyan(NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT),
        'for repository',
        chalk.cyan(repo.name),
      );

      if (!IS_DRY_RUN) {
        builder.addContext(
          `:npm: :security-meow: Creating GitHub environment \`${NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT}\` for repository \`${repo.name}\``,
        );
        await octokit.repos.createOrUpdateEnvironment({
          owner: org,
          repo: repo.name,
          environment_name: NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        });
      }
    }

    if (!IS_DRY_RUN || environment) {
      const { data: policies } = await octokit.repos.listDeploymentBranchPolicies({
        owner: org,
        repo: repo.name,
        environment_name: NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
      });

      let hasDefaultBranchPolicy = false;
      for (const policy of policies.branch_policies || []) {
        if (policy.name === GITHUB_DEFAULT_BRANCH) {
          hasDefaultBranchPolicy = true;
        } else {
          console.info(
            chalk.yellow('Removing deployment branch policy for'),
            chalk.cyan(policy.name),
            'from',
            chalk.cyan(NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT),
            'environment in',
            chalk.cyan(repo.name),
          );

          if (!IS_DRY_RUN) {
            await octokit.repos.deleteDeploymentBranchPolicy({
              owner: org,
              repo: repo.name,
              environment_name: NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
              branch_policy_id: policy.id!,
            });
            builder.addContext(
              `:wastebasket: Removed non-default branch deployment policy for \`${policy.name}\` from \`${NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT}\` environment in \`${repo.name}\``,
            );
          }
        }
      }
      // Add default branch policy if it doesn't exist
      if (!hasDefaultBranchPolicy) {
        console.info(
          chalk.green('Adding deployment branch policy for'),
          chalk.cyan(GITHUB_DEFAULT_BRANCH),
          'to',
          chalk.cyan(NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT),
          'environment in',
          chalk.cyan(repo.name),
        );

        if (!IS_DRY_RUN) {
          builder.addContext(
            `:shield: Adding deployment branch policy for \`${GITHUB_DEFAULT_BRANCH}\` to \`${NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT}\` environment in \`${repo.name}\``,
          );
          await octokit.repos.createDeploymentBranchPolicy({
            owner: org,
            repo: repo.name,
            environment_name: NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
            name: GITHUB_DEFAULT_BRANCH,
            type: 'branch',
          });
        }
      }

      if (!IS_DRY_RUN) {
        builder.addContext(
          `:white_check_mark: Successfully configured \`${NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT}\` environment for \`${repo.name}\``,
        );
      }
      console.info(
        chalk.green('Successfully configured'),
        chalk.cyan(NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT),
        'environment for',
        chalk.cyan(repo.name),
      );
    }
  };
}

export const trustedPublisherPlugin = new TrustedPublisherPlugin();
