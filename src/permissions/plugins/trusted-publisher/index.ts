import { MessageBuilder } from '../../../MessageBuilder.js';
import { RepositoryConfig, TeamConfig } from '../../types.js';
import { Plugin, RepoOwner } from '../Plugin.js';
import {
  GITHUB_DEFAULT_BRANCH,
  NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT,
  NPM_TRUSTED_PUBLISHER_GITHUB_APP_CLIENT_ID,
} from '../../../constants.js';
import { IS_DRY_RUN } from '../../../helpers.js';
import { getEnterpriseOctokit, getOctokit } from '../../../octokit.js';
import chalk from 'chalk';

class TrustedPublisherPlugin implements Plugin {
  private installationIdCache: Record<string, number> = Object.create(null);
  private installedRepos: Record<string, string[] | undefined> = Object.create(null);

  handleRepo = async (
    repo: RepositoryConfig,
    teams: TeamConfig[],
    { org, enterprise }: RepoOwner,
    builder: MessageBuilder,
  ) => {
    const { properties } = repo;

    if (properties?.type === 'ecosystem-npm-package') {
      await this.ensureNpmEnvironment(repo, org, builder);
    }

    if (NPM_TRUSTED_PUBLISHER_GITHUB_APP_CLIENT_ID) {
      await this.ensureAppInstallStateMatches(
        repo,
        { org, enterprise },
        builder,
        properties?.type === 'ecosystem-npm-package',
      );
    }
  };

  private ensureAppInstallStateMatches = async (
    repo: RepositoryConfig,
    { org, enterprise }: RepoOwner,
    builder: MessageBuilder,
    shouldBeInstalled: boolean,
  ) => {
    const octokit = await getEnterpriseOctokit(enterprise);

    let installId = this.installationIdCache[org];
    if (!installId) {
      const installations = await octokit.paginate<{ client_id: string; id: number }>(
        'GET /enterprises/{enterprise}/apps/organizations/{org}/installations',
        {
          enterprise: enterprise,
          org: org,
        },
      );

      for (const install of installations) {
        if (install.client_id === NPM_TRUSTED_PUBLISHER_GITHUB_APP_CLIENT_ID) {
          installId = install.id;
          break;
        }
      }

      if (!installId) {
        installId = -1;
      }

      this.installationIdCache[org] = installId;
    }

    let installedRepos = this.installedRepos[org];
    if (!installedRepos && installId !== -1) {
      const repos = await octokit.request(
        'GET /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories',
        {
          enterprise: enterprise,
          org: org,
          installation_id: installId,
        },
      );

      installedRepos = repos.data.map((r: { name: string }) => r.name);
      this.installedRepos[org] = installedRepos;
    }

    if (!installedRepos?.includes(repo.name) && shouldBeInstalled) {
      if (installId === -1) {
        console.info(
          'Installing npm publisher github app installation in org',
          chalk.cyan(org),
          'and adding repo',
          chalk.cyan(repo.name),
        );

        if (!IS_DRY_RUN) {
          builder.addContext(
            `:npm: :security-meow: :github2: Installating NPM Publisher GitHub App installation in org \`${org}\` and adding repo \`${repo.name}\``,
          );
          const newInstall = await octokit.request(
            'POST /enterprises/{enterprise}/apps/organizations/{org}/installations',
            {
              enterprise: enterprise,
              org: org,
              client_id: NPM_TRUSTED_PUBLISHER_GITHUB_APP_CLIENT_ID,
              repository_selection: 'selected',
              repositories: [repo.name],
            },
          );
          installId = newInstall.data.id;
          this.installationIdCache[org] = installId;
        }
      } else {
        console.info(
          chalk.green('Installing npm publisher github app into'),
          chalk.cyan(repo.name),
        );
        installedRepos?.push(repo.name);

        if (!IS_DRY_RUN) {
          builder.addContext(
            `:npm: :security-meow: Installing NPM Publisher GitHub App onto repository \`${repo.name}\``,
          );
          await octokit.request(
            'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories/add',
            {
              enterprise: enterprise,
              org: org,
              installation_id: installId,
              repositories: [repo.name],
            },
          );
        }
      }
    } else if (installedRepos?.includes(repo.name) && !shouldBeInstalled) {
      console.info(chalk.red('Removing npm publisher github app from'), chalk.cyan(repo.name));
      installedRepos?.splice(installedRepos.indexOf(repo.name), 1);

      if (!IS_DRY_RUN) {
        builder.addContext(
          `:npm: :security-meow: Removing NPM Publisher GitHub App from repository \`${repo.name}\``,
        );
        await octokit.request(
          'PATCH /enterprises/{enterprise}/apps/organizations/{org}/installations/{installation_id}/repositories/remove',
          {
            enterprise: enterprise,
            org: org,
            installation_id: installId,
            repositories: [repo.name],
          },
        );
      }
    }
  };

  private ensureNpmEnvironment = async (
    repo: RepositoryConfig,
    org: string,
    builder: MessageBuilder,
  ) => {
    const octokit = await getOctokit(org);

    // Get trusted publisher branches from config, default to ['main']
    const trustedBranches: string[] = repo.trustedPublisherBranches || [GITHUB_DEFAULT_BRANCH];

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
