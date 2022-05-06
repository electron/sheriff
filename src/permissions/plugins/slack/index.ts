import { Plugin, TeamConfig } from '../Plugin';
import { MessageBuilder } from '../../../MessageBuilder';
import { memoize, IS_DRY_RUN } from '../../../helpers';
import chalk from 'chalk';

import { WebClient } from '@slack/web-api';
import { SHERIFF_GSUITE_DOMAIN, SLACK_TOKEN } from '../../../constants';

interface UserGroup {
  id: string;
  date_delete: number;
  name: string;
  handle: string;
  users: string[];
  is_external: boolean;
}

interface SlackUser {
  id: string;
  team_id: string;
  real_name: string;
  profile: {
    email: string;
  };
  sheriff_username: string;
}

const client = new WebClient(SLACK_TOKEN);

const getAllGroups = memoize(async () => {
  const result = await client.usergroups.list({
    include_users: true,
    include_disabled: true,
  });
  return (result.usergroups as UserGroup[]).filter(g => !g.is_external);
});

const getAllUsers = memoize(async () => {
  const usersById = new Map<string, SlackUser>();
  const usersByUsername = new Map<string, SlackUser>();
  for await (const page of client.paginate('users.list') as any) {
    for (const member of page.members) {
      // Ignore non-full members and members without linked domain emails
      if (
        member.is_restricted ||
        member.is_ultra_restricted ||
        member.is_bot ||
        member.is_app_user ||
        member.deleted
      )
        continue;
      if (!member.profile.email || !member.profile.email.endsWith(`@${SHERIFF_GSUITE_DOMAIN}`))
        continue;
      const username = member.profile.email.split('@')[0].toLowerCase();
      member.sheriff_username = username;

      usersById.set(member.id, member);
      usersByUsername.set(username, member);
    }
  }
  return { usersById, usersByUsername };
});

const englishCommaJoin = (arr: string[]) => {
  if (arr.length <= 1) return arr.join(',');
  return `${arr.slice(0, arr.length - 2).join(', ')} and ${arr[arr.length - 1]}`;
};

class SlackPlugin implements Plugin {
  handleTeam = async (team: TeamConfig, builder: MessageBuilder) => {
    // No slack, we stop here
    if (!team.slack) return;

    let groups = await getAllGroups();
    const { usersById, usersByUsername } = await getAllUsers();

    const groupName = team.slack === true ? team.name : team.slack;
    const userGroupName = team.displayName || team.name;
    let existingGroup = groups.find(g => g.handle === groupName);
    if (!existingGroup) {
      builder.addContext(
        `:slack: :tada: Creating Slack User Group with handle \`${groupName}\` as it did not exist`,
      );
      console.info(
        chalk.green('Creating Slack User Group'),
        'with handle',
        chalk.cyan(groupName),
        'as it did not exist',
      );
      if (!IS_DRY_RUN) {
        const { usergroup } = await client.usergroups.create({
          handle: groupName,
          name: userGroupName,
        });
        existingGroup = {
          id: (usergroup as any).id,
          name: userGroupName,
          handle: groupName,
          date_delete: 0,
          is_external: false,
          users: [],
        };
        getAllGroups.invalidate();
        groups = await getAllGroups();
      } else {
        existingGroup = {
          id: 'NEW_USER_GROUP_ID',
          name: userGroupName,
          handle: groupName,
          date_delete: 0,
          is_external: false,
          users: [],
        };
      }
    }

    if (existingGroup.name !== userGroupName) {
      builder.addContext(
        `:slack: :pencil2: Updating Slack User Group Name for \`${existingGroup.handle}\` from \`${existingGroup.name}\` :arrow_right: \`${userGroupName}\``,
      );
      console.info(
        chalk.yellow('Updating Slack User Group Name'),
        'for',
        chalk.cyan(existingGroup.handle),
        'from',
        chalk.magenta(existingGroup.name),
        'to',
        chalk.magenta(userGroupName),
      );
      if (!IS_DRY_RUN) {
        await client.usergroups.update({
          usergroup: existingGroup.id,
          name: userGroupName,
        });
      }
    }

    const expectedUserIds: string[] = [];
    for (const username of team.maintainers.concat(team.members)) {
      const slackUser = usersByUsername.get(username.toLowerCase());
      if (!slackUser) continue;
      expectedUserIds.push(slackUser.id);
    }

    existingGroup.users.sort();
    expectedUserIds.sort();
    // The users match up, let's move on
    if (JSON.stringify(existingGroup.users) === JSON.stringify(expectedUserIds)) return;

    const usernamesToRemove: string[] = [];
    const usernamesToAdd: string[] = [];
    for (const userId of expectedUserIds) {
      if (!existingGroup.users.includes(userId)) {
        usernamesToAdd.push(usersById.get(userId)!.sheriff_username);
      }
    }
    for (const userId of existingGroup.users) {
      if (!expectedUserIds.includes(userId)) {
        const slackUser = usersById.get(userId);
        usernamesToRemove.push(slackUser ? `\`${slackUser.sheriff_username}\`` : `<@${userId}>`);
      }
    }

    if (usernamesToRemove.length) {
      builder.addContext(
        `:slack: :skull_and_crossbones: Evicting ${englishCommaJoin(
          usernamesToRemove,
        )} out of Slack User Group \`${existingGroup.handle}\``,
      );
      console.info(
        chalk.red('Evicting'),
        chalk.cyan(englishCommaJoin(usernamesToRemove)),
        'out of Slack User Group',
        chalk.cyan(existingGroup.handle),
      );
    }
    if (usernamesToAdd.length) {
      builder.addContext(
        `:slack: :new: Adding \`${englishCommaJoin(usernamesToAdd)}\` to Slack User Group \`${
          existingGroup.handle
        }\``,
      );
      console.info(
        chalk.green('Adding'),
        chalk.cyan(englishCommaJoin(usernamesToAdd)),
        'to Slack User Group',
        chalk.cyan(existingGroup.handle),
      );
    }
    if (!IS_DRY_RUN) {
      await client.usergroups.users.update({
        usergroup: existingGroup.id,
        users: expectedUserIds.join(','),
      });
    }
  };
}

export const slackPlugin = new SlackPlugin();
