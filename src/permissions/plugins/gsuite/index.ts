import { Plugin, TeamConfig } from '../Plugin';
import { MessageBuilder } from '../../../MessageBuilder';
import { memoize, IS_DRY_RUN } from '../../../helpers';
import { getAuthorizedClient } from './auth';
import { google, admin_directory_v1 } from 'googleapis';
import chalk from 'chalk';
import { privacySettings } from './privacy';
import { SHERIFF_GSUITE_DOMAIN, SHERIFF_SLACK_DOMAIN } from '../../../constants';

const getService = memoize(async () =>
  google.admin({ version: 'directory_v1', auth: getAuthorizedClient() }),
);
const getAllDirectoryUsers = memoize(async () => {
  const service = await getService();
  const list = async (pageToken?: string): Promise<admin_directory_v1.Schema$User[]> => {
    const users = await service.users.list({
      domain: SHERIFF_GSUITE_DOMAIN,
      pageToken,
    });
    if (users.data.nextPageToken) {
      return [...users.data.users!, ...(await list(users.data.nextPageToken))];
    }
    return users.data.users!;
  };
  return list();
});
const getAllDirectoryGroups = memoize(async () => {
  const service = await getService();
  const list = async (pageToken?: string): Promise<admin_directory_v1.Schema$Group[]> => {
    const groups = await service.groups.list({
      domain: SHERIFF_GSUITE_DOMAIN,
      pageToken,
    });
    if (groups.data.nextPageToken) {
      return [...groups.data.groups!, ...(await list(groups.data.nextPageToken))];
    }
    return groups.data.groups!;
  };
  return list();
});
const getMembersOfGroup = async (groupKey: string) => {
  const service = await getService();
  const list = async (pageToken?: string): Promise<admin_directory_v1.Schema$Member[]> => {
    const groups = await service.members.list({
      groupKey,
      pageToken,
    });
    if (groups.data.nextPageToken) {
      return [...groups.data.members!, ...(await list(groups.data.nextPageToken))];
    }
    return groups.data.members!;
  };
  return (await list()) || [];
};

class GSuitePlugin implements Plugin {
  handleTeam = async (team: TeamConfig, builder: MessageBuilder) => {
    const service = await getService();

    const users = await getAllDirectoryUsers();
    const groups = await getAllDirectoryGroups();
    const expectedEmail = `${team.name}@${SHERIFF_GSUITE_DOMAIN}`;
    let existingGroup = groups.find(g => g.email === expectedEmail);

    if (!team.gsuite) {
      if (existingGroup) {
        // Delete a group that should not exist
        builder.addCritical(`Deleting GSuite group with address: \`${expectedEmail}\``);
        console.info(chalk.red('Deleting GSuite group with address'), chalk.cyan(expectedEmail));
        if (!IS_DRY_RUN) {
          await service.groups.delete({
            groupKey: existingGroup.email,
          });
        }
      }
      return;
    }

    // Create group that does not exist
    if (!existingGroup) {
      getAllDirectoryGroups.invalidate();
      builder.addContext(
        `:tada: Creating GSuite group with address \`${expectedEmail}\` as it did not exist`,
      );
      console.info(
        chalk.green('Creating GSuite group'),
        'with address',
        chalk.cyan(expectedEmail),
        'as it did not exist',
      );
      if (!IS_DRY_RUN) {
        existingGroup = (await service.groups.insert({
          requestBody: {
            email: expectedEmail,
            name: team.displayName,
          },
        })).data!;
      }
    }

    // Always udpate permissions, it's cheaper to always update than to check if we need to first
    if (!IS_DRY_RUN) {
      const groupsService = google.groupssettings('v1');
      await groupsService.groups.patch({
        auth: getAuthorizedClient(),
        groupUniqueId: expectedEmail,
        requestBody:
          team.gsuite.privacy === 'internal' ? privacySettings.internal : privacySettings.external,
      });
    }

    const existingMembers = await getMembersOfGroup(expectedEmail);
    for (const member of existingMembers) {
      const username = member.email!.split('@')[0];

      // Remove user from group, they should not be here
      if (
        ![...team.members, ...team.maintainers].some(
          m => m.toLowerCase() === username.toLowerCase(),
        )
      ) {
        // Ignore slack notification emails, we need those
        if (
          !SHERIFF_SLACK_DOMAIN ||
          !member.email!.endsWith(`@${SHERIFF_SLACK_DOMAIN}.slack.com`)
        ) {
          builder.addContext(
            `:skull_and_crossbones: Evicting \`${member.email}\` out of GSuite group \`${expectedEmail}\``,
          );
          console.info(
            chalk.red('Evicting'),
            chalk.cyan(member.email!),
            'out of GSuite group',
            chalk.cyan(expectedEmail),
          );
          if (!IS_DRY_RUN) {
            await service.members.delete({
              groupKey: expectedEmail,
              memberKey: member.email,
            });
          }
        }
        continue;
      }

      // Make owners be members if they should be
      if (
        team.members.some(m => m.toLowerCase() === username.toLowerCase()) &&
        member.role === 'OWNER'
      ) {
        builder.addContext(
          `:arrow_heading_down: Demoting \`${member.email}\` to member of GSuite group \`${expectedEmail}\``,
        );
        console.info(
          chalk.yellow('Demoting'),
          chalk.cyan(member.email!),
          'to member of GSuite group',
          chalk.cyan(expectedEmail),
        );
        if (!IS_DRY_RUN) {
          await service.members.patch({
            groupKey: expectedEmail,
            memberKey: member.email,
            requestBody: {
              role: 'MEMBER',
            },
          });
        }
      }

      // Make members be owners if they should be
      if (
        team.maintainers.some(m => m.toLowerCase() === username.toLowerCase()) &&
        member.role === 'MEMBER'
      ) {
        builder.addContext(
          `:arrow_heading_up: Promoting \`${member.email}\` to owner of GSuite group \`${expectedEmail}\``,
        );
        console.info(
          chalk.green('Promoting'),
          chalk.cyan(member.email!),
          'to owner of GSuite group',
          chalk.cyan(expectedEmail),
        );
        if (!IS_DRY_RUN) {
          await service.members.patch({
            groupKey: expectedEmail,
            memberKey: member.email,
            requestBody: {
              role: 'OWNER',
            },
          });
        }
      }
    }

    for (const member of team.members) {
      // If they already exist we have dealt with them above, so we just need to add them
      if (existingMembers.find(m => m.email!.split('@')[0].toLowerCase() === member.toLowerCase()))
        continue;

      const memberEmail = `${member.toLowerCase()}@${SHERIFF_GSUITE_DOMAIN}`;
      if (!users.some(u => u.primaryEmail === memberEmail)) continue;

      // Add new members
      builder.addContext(
        `:new: :crown: Adding \`${memberEmail}\` as a member of GSuite group \`${expectedEmail}\``,
      );
      console.info(
        chalk.green('Adding'),
        chalk.cyan(memberEmail),
        'as a member of GSuite group',
        chalk.cyan(expectedEmail),
      );
      if (!IS_DRY_RUN) {
        await service.members.insert({
          groupKey: expectedEmail,
          requestBody: {
            email: memberEmail,
            delivery_settings: 'ALL_MAIL',
            role: 'MEMBER',
          },
        });
      }
    }

    for (const member of team.maintainers) {
      // If they already exist we have dealt with them above, so we just need to add them
      if (existingMembers.find(m => m.email!.split('@')[0].toLowerCase() === member.toLowerCase()))
        continue;

      const memberEmail = `${member.toLowerCase()}@${SHERIFF_GSUITE_DOMAIN}`;
      if (!users.some(u => u.primaryEmail === memberEmail)) continue;

      // Add new owners
      builder.addContext(
        `:new: :crown: Adding \`${memberEmail}\` as an owner of GSuite group \`${expectedEmail}\``,
      );
      console.info(
        chalk.green('Adding'),
        chalk.cyan(memberEmail),
        'as an owner of GSuite group',
        chalk.cyan(expectedEmail),
      );
      if (!IS_DRY_RUN) {
        await service.members.insert({
          groupKey: expectedEmail,
          requestBody: {
            email: memberEmail,
            delivery_settings: 'ALL_MAIL',
            role: 'OWNER',
          },
        });
      }
    }
  };
}

export const gsuitePlugin = new GSuitePlugin();
