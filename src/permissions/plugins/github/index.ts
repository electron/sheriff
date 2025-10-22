import { MessageBuilder } from '../../../MessageBuilder.js';
import { RepositoryConfig, TeamConfig } from '../../types.js';
import { Plugin } from '../Plugin.js';
import { IS_DRY_RUN } from '../../../helpers.js';
import { getOctokit } from '../../../octokit.js';

class GitHubPlugin implements Plugin {
  handleRepo = async (repo: RepositoryConfig, teams: TeamConfig[], org: string, builder: MessageBuilder) => {
    const { properties } = repo;
    if (!properties) return;

    if (properties.type === 'ecosystem-npm-package') {
      await this.ensureNpmEnvironment(repo, org, builder);
    }
  };

  private ensureNpmEnvironment = async (repo: RepositoryConfig, org: string, builder: MessageBuilder) => {
    const octokit = await getOctokit(org);
    const defaultBranch = 'main';
    const environmentName = 'npm';

    try {
      // Check if the environment already exists
      let environmentExists = false;
      try {
        await octokit.repos.getEnvironment({
          owner: org,
          repo: repo.name,
          environment_name: environmentName,
        });
        environmentExists = true;
      } catch (error: any) {
        if (error.status !== 404) {
          throw error;
        }
      }

      if (!environmentExists) {
        builder.addContext(
          `:sparkles: Creating GitHub environment \`${environmentName}\` for repository \`${repo.name}\``,
        );

        if (!IS_DRY_RUN) {
          await octokit.repos.createOrUpdateEnvironment({
            owner: org,
            repo: repo.name,
            environment_name: environmentName,
            deployment_branch_policy: null,
          });
        }
      }

      const { data: policies } = await octokit.repos.listDeploymentBranchPolicies({
        owner: org,
        repo: repo.name,
        environment_name: environmentName,
      });

      const hasDefaultBranchPolicy = policies.branch_policies?.some(
        (policy: any) => policy.name === defaultBranch,
      );

      if (!hasDefaultBranchPolicy) {
        builder.addContext(
          `:shield: Adding deployment branch policy for \`${defaultBranch}\` to \`${environmentName}\` environment in \`${repo.name}\``,
        );
        if (!IS_DRY_RUN) {
          await octokit.repos.createDeploymentBranchPolicy({
            owner: org,
            repo: repo.name,
            environment_name: environmentName,
            name: defaultBranch,
            type: 'branch',
          });
        }
        builder.addContext(
          `:white_check_mark: Successfully configured \`${environmentName}\` environment for \`${repo.name}\``,
        );
      } else {
        builder.addContext(
          `:white_check_mark: GitHub environment \`${environmentName}\` already configured for \`${repo.name}\``,
        );
      }

    } catch (error: any) {
      builder.addContext(
        `:x: Failed to configure GitHub environment \`${environmentName}\` for \`${repo.name}\`: ${error.message}`,
      );
      console.error(
        `Failed to configure GitHub environment ${environmentName} for ${repo.name}:`,
        error.message,
      );
    }
  };
}

export const githubPlugin = new GitHubPlugin();
