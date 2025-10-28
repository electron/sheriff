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

    // Get trusted publisher branches from config, default to ['main']
    let trustedBranches: string[];
    const configuredBranches = repo.properties?.trustedPublisherBranches;
    if (Array.isArray(configuredBranches)) {
      trustedBranches = configuredBranches;
    } else if (typeof configuredBranches === 'string') {
      trustedBranches = [configuredBranches];
    } else {
      trustedBranches = [GITHUB_DEFAULT_BRANCH];
    }

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

      const existingBranches = new Set<string>();
      for (const policy of policies.branch_policies || []) {
        if (trustedBranches.includes(policy.name!)) {
          existingBranches.add(policy.name!);
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
              `:wastebasket: Removed non-trusted branch deployment policy for \`${policy.name}\` from \`${NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT}\` environment in \`${repo.name}\``,
            );
          }
        }
      }

      // Add branch policies for any trusted branches that don't have them
      for (const branch of trustedBranches) {
        if (!existingBranches.has(branch)) {
          console.info(
            chalk.green('Adding deployment branch policy for'),
            chalk.cyan(branch),
            'to',
            chalk.cyan(NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT),
            'environment in',
            chalk.cyan(repo.name),
          );

          if (!IS_DRY_RUN) {
            builder.addContext(
              `:shield: Adding deployment branch policy for \`${branch}\` to \`${NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT}\` environment in \`${repo.name}\``,
            );
            await octokit.repos.createDeploymentBranchPolicy({
              owner: org,
              repo: repo.name,
              environment_name: NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
              name: branch,
              type: 'branch',
            });
          }
        }
      }
    }
  };
}

export const trustedPublisherPlugin = new TrustedPublisherPlugin();
