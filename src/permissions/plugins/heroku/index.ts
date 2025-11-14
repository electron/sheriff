import HerokuClient from 'heroku-client';

import { MessageBuilder } from '../../../MessageBuilder.js';
import { RepositoryConfig, TeamConfig } from '../../types.js';
import { Plugin, RepoOwner } from '../Plugin.js';
import { HEROKU_MAGIC_ADMIN, HEROKU_TOKEN, SHERIFF_GSUITE_DOMAIN } from '../../../constants.js';
import { IS_DRY_RUN } from '../../../helpers.js';
import chalk from 'chalk';

interface HerokuCollab {
  id: string;
  user: {
    email: string;
  };
}

interface HerokuMember {
  role: 'collaborator' | 'admin';
  user: {
    email: string;
  };
}

interface HerokuApp {
  locked: boolean;
}

class HerokuPlugin implements Plugin {
  private client = new HerokuClient({
    token: HEROKU_TOKEN,
  });

  private emailSame = (e1: string, e2: string) => e1.toLowerCase() === e2.toLowerCase();

  handleRepo = async (
    repo: RepositoryConfig,
    teams: TeamConfig[],
    owner: RepoOwner,
    builder: MessageBuilder,
  ) => {
    const { heroku } = repo;
    if (!heroku) return;

    const userEmails: string[] = [];
    if (heroku.access) {
      for (const user of heroku.access) {
        if (user.startsWith('team:')) {
          const teamName = user.slice('team:'.length);
          const targetTeam = teams.find((t) => t.name === teamName)!;
          for (const member of [...targetTeam.members, ...targetTeam.maintainers]) {
            userEmails.push(`${member}@${SHERIFF_GSUITE_DOMAIN}`);
          }
        } else {
          userEmails.push(`${user}@${SHERIFF_GSUITE_DOMAIN}`);
        }
      }
    }

    const collaborators = (
      (await this.client.get(`/teams/apps/${heroku.app_name}/collaborators`)) as HerokuCollab[]
    ).filter(
      (c) => !c.user.email.endsWith('@herokumanager.com') && c.user.email !== HEROKU_MAGIC_ADMIN,
    );

    const teamAdmins = (
      (await this.client.get(`/teams/${heroku.team_name}/members`)) as HerokuMember[]
    ).filter((m) => m.role === 'admin');

    const app = (await this.client.get(`/teams/apps/${heroku.app_name}`)) as HerokuApp;
    // Just lock every app we control
    if (!app.locked && !IS_DRY_RUN) {
      await this.client.patch(`/teams/apps/${heroku.app_name}`, {
        body: {
          locked: true,
        },
      });
    }

    for (const email of userEmails) {
      // If this user is not a collab and not an admin, we need to add them
      if (
        !collaborators.find((c) => this.emailSame(c.user.email, email)) &&
        !teamAdmins.find((a) => this.emailSame(a.user.email, email))
      ) {
        builder.addContext(
          `:new: :crown: Adding \`${email}\` as a collaborator on Heroku app \`${heroku.app_name}\``,
        );
        console.info(
          chalk.green('Adding'),
          chalk.cyan(email),
          'as a collaborator on Heroku app',
          chalk.cyan(heroku.app_name),
        );

        if (!IS_DRY_RUN) {
          await this.client.post(`/teams/apps/${heroku.app_name}/collaborators`, {
            body: {
              user: email,
            },
          });
        }
      }
    }

    for (const collab of collaborators) {
      // If this collab is not supposed to have access, nuke em
      if (!userEmails.find((email) => this.emailSame(collab.user.email, email))) {
        builder.addContext(
          `:skull_and_crossbones: Evicting \`${collab.user.email}\` out of Heroku app \`${heroku.app_name}\``,
        );
        console.info(
          chalk.red('Evicting'),
          chalk.cyan(collab.user.email!),
          'out of Heroku app',
          chalk.cyan(heroku.app_name),
        );

        if (!IS_DRY_RUN) {
          await this.client.delete(`/teams/apps/${heroku.app_name}/collaborators/${collab.id}`);
        }
      }
    }
  };
}

export const herokuPlugin = new HerokuPlugin();
