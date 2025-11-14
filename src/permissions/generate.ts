import chalk from 'chalk';
import ora from 'ora';
import yml from 'js-yaml';

import { PERMISSIONS_FILE_ORG } from '../constants.js';
import { getOctokit } from '../octokit.js';
import { gitHubPermissionsToSheriffLevel } from './level-converters.js';
import { PermissionsConfig, RepositoryConfig, TeamConfig } from './types.js';

const targetOrg = PERMISSIONS_FILE_ORG;

async function main(spinner: ora.Ora) {
  if (!targetOrg) {
    throw new Error('Missing value for PERMISSIONS_FILE_ORG');
  }
  const octokit = await getOctokit(targetOrg, true);

  const permissions: PermissionsConfig = {
    enterprise: 'name-here',
    organizations: [
      {
        organization: targetOrg,
        repository_defaults: {
          has_wiki: false,
        },
        teams: [],
        repositories: [],
      },
    ],
  };

  spinner.text = 'Fetching all teams';
  const allTeams = await octokit.paginate('GET /orgs/{org}/teams', {
    org: targetOrg,
  });
  for (const [index, team] of allTeams.entries()) {
    spinner.text = `Processing team "${chalk.cyan(team.name)}" (${index + 1}/${allTeams.length}})`;
    const teamConfig: TeamConfig = {
      name: team.name,
      members: [],
      maintainers: [],
    };

    const [existingMembers, existingMaintainers] = await Promise.all([
      octokit.paginate('GET /orgs/{org}/teams/{team_slug}/members', {
        org: targetOrg,
        team_slug: team.slug,
        role: 'member',
      }),
      octokit.paginate('GET /orgs/{org}/teams/{team_slug}/members', {
        org: targetOrg,
        team_slug: team.slug,
        role: 'maintainer',
      }),
    ]);
    for (const member of existingMembers) {
      teamConfig.members.push(member.login);
    }
    for (const maintainer of existingMaintainers) {
      teamConfig.maintainers.push(maintainer.login);
    }

    if (team.parent) {
      teamConfig.parent = team.parent.name;
    }
    if (team.privacy === 'secret') {
      teamConfig.secret = true;
    }

    permissions.organizations[0].teams.push(teamConfig);
  }

  spinner.text = 'Fetching all repositories';
  const allRepos = await octokit.paginate('GET /orgs/{org}/repos', {
    org: targetOrg,
  });

  for (const [index, repo] of allRepos.entries()) {
    spinner.text = `Processing repository "${chalk.cyan(repo.name)}" (${index + 1}/${
      allRepos.length
    }})`;
    const repoConfig: RepositoryConfig = {
      name: repo.name,
    };
    const [currentTeams, currentCollaborators] = await Promise.all([
      octokit.paginate('GET /repos/{owner}/{repo}/teams', {
        owner: targetOrg,
        repo: repo.name,
      }),
      octokit.paginate('GET /repos/{owner}/{repo}/collaborators', {
        owner: targetOrg,
        repo: repo.name,
        affiliation: 'direct',
      }),
    ]);
    if (currentTeams.length) {
      repoConfig.teams = {};
      for (const team of currentTeams) {
        repoConfig.teams[team.name] = gitHubPermissionsToSheriffLevel(team.permissions!);
      }
    }
    if (currentCollaborators.length) {
      repoConfig.external_collaborators = {};
      for (const collaborator of currentCollaborators) {
        repoConfig.external_collaborators[collaborator.login] = gitHubPermissionsToSheriffLevel(
          collaborator.permissions!,
        );
      }
    }
    if (repo.has_wiki) {
      repoConfig.settings = {
        has_wiki: true,
      };
    }
    if (repo.private) {
      repoConfig.visibility = 'private';
    }
    permissions.organizations[0].repositories.push(repoConfig);
  }

  permissions.organizations[0].teams.sort((a, b) => a.name.localeCompare(b.name));
  permissions.organizations[0].repositories.sort((a, b) => a.name.localeCompare(b.name));
  spinner.succeed('Generated configuration');
  console.log(
    yml.dump(permissions, {
      sortKeys: true,
    }),
  );
}

const spinner = ora('Generating configuration').start();
main(spinner).catch((err) => {
  spinner.fail(
    chalk.red(`Failed to generate config.yml for org "${chalk.cyan(targetOrg || 'unknown-org')}"`),
  );
  console.error(err);
  process.exit(1);
});
