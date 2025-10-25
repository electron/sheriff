import { MessageBuilder } from '../../../MessageBuilder.js';
import { RepositoryConfig, TeamConfig } from '../../types.js';
import { Plugin } from '../Plugin.js';
import { GITHUB_DEFAULT_BRANCH, GITHUB_DEFAULT_ENVIRONMENT } from '../../../constants.js';
import { IS_DRY_RUN } from '../../../helpers.js';
import { getOctokit } from '../../../octokit.js';
import chalk from 'chalk';

class GitHubPlugin implements Plugin {
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

    try {
      // Check if the environment already exists
      let environmentExists = false;
      try {
        await octokit.repos.getEnvironment({
          owner: org,
          repo: repo.name,
          environment_name: GITHUB_DEFAULT_ENVIRONMENT,
        });
        environmentExists = true;
      } catch (error: any) {
        if (error.status !== 404) {
          throw error;
        }
      }

      if (!environmentExists) {
        builder.addContext(
          `:sparkles: Creating GitHub environment \`${GITHUB_DEFAULT_ENVIRONMENT}\` for repository \`${repo.name}\``,
        );
        console.info(
          chalk.green('Creating GitHub environment'),
          chalk.cyan(GITHUB_DEFAULT_ENVIRONMENT),
          'for repository',
          chalk.cyan(repo.name),
        );

        if (!IS_DRY_RUN) {
          await octokit.repos.createOrUpdateEnvironment({
            owner: org,
            repo: repo.name,
            environment_name: GITHUB_DEFAULT_ENVIRONMENT,
            deployment_branch_policy: null,
          });
        }
      }

      const { data: policies } = await octokit.repos.listDeploymentBranchPolicies({
        owner: org,
        repo: repo.name,
        environment_name: GITHUB_DEFAULT_ENVIRONMENT,
      });

      const hasDefaultBranchPolicy = policies.branch_policies?.some(
        (policy: any) => policy.name === GITHUB_DEFAULT_BRANCH,
      );

      if (!hasDefaultBranchPolicy) {
        builder.addContext(
          `:shield: Adding deployment branch policy for \`${GITHUB_DEFAULT_BRANCH}\` to \`${GITHUB_DEFAULT_ENVIRONMENT}\` environment in \`${repo.name}\``,
        );
        console.info(
          chalk.green('Adding deployment branch policy for'),
          chalk.cyan(GITHUB_DEFAULT_BRANCH),
          'to',
          chalk.cyan(GITHUB_DEFAULT_ENVIRONMENT),
          'environment in',
          chalk.cyan(repo.name),
        );

        if (!IS_DRY_RUN) {
          await octokit.repos.createDeploymentBranchPolicy({
            owner: org,
            repo: repo.name,
            environment_name: GITHUB_DEFAULT_ENVIRONMENT,
            name: GITHUB_DEFAULT_BRANCH,
            type: 'branch',
          });
        }
        builder.addContext(
          `:white_check_mark: Successfully configured \`${GITHUB_DEFAULT_ENVIRONMENT}\` environment for \`${repo.name}\``,
        );
        console.info(
          chalk.green('Successfully configured'),
          chalk.cyan(GITHUB_DEFAULT_ENVIRONMENT),
          'environment for',
          chalk.cyan(repo.name),
        );
      } else {
        // Only log this, we don't want this in the Slack channel on each Sheriff run
        console.info(
          chalk.green('GitHub environment'),
          chalk.cyan(GITHUB_DEFAULT_ENVIRONMENT),
          'already configured for',
          chalk.cyan(repo.name),
        );
      }
    } catch (error: any) {
      builder.addContext(
        `:x: Failed to configure GitHub environment \`${GITHUB_DEFAULT_ENVIRONMENT}\` for \`${repo.name}\`: ${error.message}`,
      );
      console.error(
        `Failed to configure GitHub environment ${GITHUB_DEFAULT_ENVIRONMENT} for ${repo.name}:`,
        error.message,
      );
    }
  };
}

export const githubPlugin = new GitHubPlugin();
