require('dotenv-safe').config();

import express from 'express';
import { AddressInfo } from 'net';
import * as path from 'path';

import {
  Webhooks as WebhooksApi,
  createNodeMiddleware,
  EmitterWebhookEvent,
} from '@octokit/webhooks';
import { isMainRepo, hook } from './helpers';
import { MessageBuilder, createMessageBlock, createMarkdownBlock } from './MessageBuilder';
import { getOctokit } from './octokit';
import {
  AUTO_TUNNEL_NGROK,
  GITHUB_WEBHOOK_SECRET,
  PORT,
  SHERIFF_IMPORTANT_BRANCH,
  SHERIFF_SELF_LOGIN,
  SHERIFF_TRUSTED_RELEASERS,
} from './constants';
import { getValidatedConfig } from './permissions/run';
import {
  gitHubPermissionsToSheriffLevel,
  sheriffLevelToGitHubLevel,
} from './permissions/level-converters';

const webhooks = new WebhooksApi({
  secret: GITHUB_WEBHOOK_SECRET,
});

webhooks.onAny(
  hook(async ({ name }, ctx) => {
    ctx.log('Event:', name, 'received');
  }),
);

const importantBranchMatcher = () =>
  SHERIFF_IMPORTANT_BRANCH ? new RegExp('(^[0-9]+-[0-9]+-x$)|(^[0-9]+-x-y$)') : null;

webhooks.on(
  'delete',
  hook(async (event) => {
    if (event.payload.ref_type === 'tag') {
      if (SHERIFF_TRUSTED_RELEASERS?.includes(event.payload.sender.login)) return;

      // Deleted a tag
      const deletedTag = event.payload.ref;
      const text = `An existing tag was just deleted: ${deletedTag}`;
      await MessageBuilder.create()
        .setNotificationContent(text)
        .addBlock(createMessageBlock(text))
        .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
        .addSeverity('warning')
        .send();
    } else if (event.payload.ref_type === 'branch') {
      const deletedBranch = event.payload.ref;
      const matcher = importantBranchMatcher();
      if (isMainRepo(event.payload.repository) && matcher && matcher.test(deletedBranch)) {
        // Deleted a release branch
        const text = `A branch dedicated to an important release line was just removed: ${deletedBranch}`;
        await MessageBuilder.create()
          .setEventPayload(event)
          .setNotificationContent(text)
          .addBlock(createMessageBlock(text))
          .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
          .addSeverity('critical')
          .send();
      }
    }
  }),
);

webhooks.on(
  'deploy_key.created',
  hook(async (event) => {
    if (!event.payload.key.read_only) {
      // Write access deploy key
      const text = `A deploy key with name "${event.payload.key.title}" was just created with write access`;
      await MessageBuilder.create()
        .setNotificationContent(text)
        .addBlock(createMessageBlock(text))
        .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
        .addSeverity('critical')
        .send();
    } else if (event.payload.repository.private) {
      // Read access deploy key to a private repo
      const text = `A deploy key with name "${event.payload.key.title}" was just created with read access to a private repository`;
      await MessageBuilder.create()
        .setEventPayload(event)
        .setNotificationContent(text)
        .addBlock(createMessageBlock(text))
        .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
        .addSeverity('warning')
        .send();
    }
  }),
);

enum PermissionEnforcementAction {
  ALLOW_CHANGE,
  REVERT_CHANGE,
}

async function takeActionOnRepositoryCollaborator(
  event:
    | EmitterWebhookEvent<'member.added'>
    | EmitterWebhookEvent<'member.edited'>
    | EmitterWebhookEvent<'member.removed'>,
): Promise<PermissionEnforcementAction> {
  const repo = event.payload.repository;
  const member = event.payload.member;

  const currentConfig = await getValidatedConfig();
  const targetRepoConfig = currentConfig.repositories.find((r) => r.name === repo.name);
  if (!targetRepoConfig) return PermissionEnforcementAction.ALLOW_CHANGE;

  const expectedLevel = targetRepoConfig.external_collaborators?.[member.login];
  // They should not be on this repository
  if (!expectedLevel) {
    // If they were removed this is an expected change
    if (event.payload.action === 'removed') return PermissionEnforcementAction.ALLOW_CHANGE;

    const octokit = await getOctokit();
    await octokit.repos.removeCollaborator({
      owner: repo.owner.login,
      repo: repo.name,
      username: member.login,
    });
    return PermissionEnforcementAction.REVERT_CHANGE;
  }

  const octokit = await getOctokit();
  const allCollaborators = await octokit.paginate('GET /repos/{owner}/{repo}/collaborators', {
    owner: repo.owner.login,
    repo: repo.name,
    affiliation: 'direct',
  });
  const currentCollaborator = allCollaborators.find((c) => c.id === member.id);

  // currentCollaborator is undefined when this user was removed as a collaborator
  // during this event
  const currentSheriffLevel = currentCollaborator
    ? gitHubPermissionsToSheriffLevel(currentCollaborator.permissions!)
    : null;
  // The change resulted in an unexpected new state
  if (!currentSheriffLevel || currentSheriffLevel !== expectedLevel) {
    await octokit.repos.addCollaborator({
      owner: repo.owner.login,
      repo: repo.name,
      username: member.login,
      permission: sheriffLevelToGitHubLevel(expectedLevel),
    });
    return PermissionEnforcementAction.REVERT_CHANGE;
  }

  return PermissionEnforcementAction.ALLOW_CHANGE;
}

webhooks.on(
  'member.added',
  hook(async (event) => {
    const action = await takeActionOnRepositoryCollaborator(event);
    if (action === PermissionEnforcementAction.ALLOW_CHANGE) return;

    const text = 'An unexpected new collaborator was added to a repository';
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addUser(event.payload.member, 'Collaborator')
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('normal')
      .addReverted()
      .send();
  }),
);

webhooks.on(
  'member.removed',
  hook(async (event) => {
    const action = await takeActionOnRepositoryCollaborator(event);
    if (action === PermissionEnforcementAction.ALLOW_CHANGE) return;

    const text = 'A collaborator was unexpectedly removed from a repository';
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addUser(event.payload.member, 'Collaborator')
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('normal')
      .addReverted()
      .send();
  }),
);

webhooks.on(
  'member.edited',
  hook(async (event) => {
    const action = await takeActionOnRepositoryCollaborator(event);
    if (action === PermissionEnforcementAction.ALLOW_CHANGE) return;

    // Collaborator has permission level changed on repo
    const originalPermission = (event.payload as any).changes.permission.from;
    // We have to fetch the new permission level through the API
    const octokit = await getOctokit();
    const newPermissionLevel = await octokit.repos.getCollaboratorPermissionLevel({
      owner: event.payload.repository.owner.login,
      repo: event.payload.repository.name,
      username: event.payload.member.login,
    });
    const newPermission = newPermissionLevel.data.permission;
    const text = `A collaborators permission level was unexpectedly changed on a repository from \`${originalPermission}\` :arrow_right: \`${newPermission}\``;
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMarkdownBlock(text))
      .addUser(event.payload.member, 'Collaborator')
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('normal')
      .addReverted()
      .send();
  }),
);

webhooks.on(
  'meta.deleted',
  hook(async (event) => {
    const text = 'The org-wide webhook powering Electron Sheriff was just deleted!!!!';
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addBlame(event.payload.sender)
      .addSeverity('critical')
      .send();
  }),
);

webhooks.on(
  'organization.member_invited',
  hook(async (event) => {
    const invitedLogin = event.payload.invitation.login;
    const text = `A new member was just invited to the "${event.payload.organization.login}" organization`;
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addUser(
        {
          login: invitedLogin,
          html_url: `https://github.com/${invitedLogin}`,
          avatar_url: `https://github.com/${invitedLogin}.png`,
        },
        'Invited Member',
      )
      .addBlame(event.payload.sender)
      .addSeverity('normal')
      .send();
  }),
);

webhooks.on(
  'organization.member_added',
  hook(async (event) => {
    const text = `A new member was just added to the "${event.payload.organization.login}" organization`;
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addUser(event.payload.membership.user, 'New Member')
      .addBlame(event.payload.sender)
      .addSeverity('normal')
      .send();
  }),
);

webhooks.on(
  'organization.member_removed',
  hook(async (event) => {
    const text = `A member was just removed from the "${event.payload.organization.login}" organization`;
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addUser(event.payload.membership.user, 'Removed Member')
      .addBlame(event.payload.sender)
      .addSeverity('normal')
      .send();
  }),
);

webhooks.on(
  'organization.renamed',
  hook(async (event) => {
    const text = `The organization was just renamed to \`${event.payload.organization.login}\`, this is incredibly unexpected`;
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addBlame(event.payload.sender)
      .addSeverity('critical')
      .send();
  }),
);

webhooks.on(
  'repository.deleted',
  hook(async (event) => {
    if (event.payload.sender.login === SHERIFF_SELF_LOGIN) return;

    const text = 'A repository was just deleted';
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('critical')
      .send();
  }),
);

webhooks.on(
  'repository.archived',
  hook(async (event) => {
    if (event.payload.sender.login === SHERIFF_SELF_LOGIN) return;

    const text = 'A repository was just archived';
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('warning')
      .send();
  }),
);

webhooks.on(
  'public',
  hook(async (event) => {
    if (event.payload.sender.login === SHERIFF_SELF_LOGIN) return;

    const text = 'A private repository was just made public';
    await MessageBuilder.create()
      .setEventPayload(event)
      .setNotificationContent(text)
      .addBlock(createMessageBlock(text))
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('warning')
      .send();
  }),
);

webhooks.on(
  'release',
  hook(async (event) => {
    if (SHERIFF_TRUSTED_RELEASERS?.includes(event.payload.sender.login)) return;

    const message = MessageBuilder.create();
    let severity: 'critical' | 'warning' | 'normal' = 'normal';
    const text = `The "${event.payload.release.name}" release was just ${event.payload.action}`;
    message.addBlock(createMessageBlock(text));
    switch (event.payload.action) {
      case 'deleted':
        severity = 'critical';
        break;
      case 'unpublished':
      case 'edited':
        severity = 'warning';
        break;
      case 'created':
      case 'published':
      case 'prereleased':
        break;
      default:
        return;
    }
    await message
      .setEventPayload(event)
      .setNotificationContent(text)
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity(severity)
      .send();
  }),
);

const app = express();

app.use('/static', express.static(path.resolve(__dirname, '../static')));

app.use(
  createNodeMiddleware(webhooks, {
    path: '/',
  }),
);

const server = app.listen(PORT, async () => {
  const port = (server.address() as AddressInfo).port;
  console.log('Electron Sheriff Listening:', `http://127.0.0.1:${port}`);
  if (AUTO_TUNNEL_NGROK) {
    const ngrok = require('ngrok');
    const url = await ngrok.connect({
      subdomain: AUTO_TUNNEL_NGROK,
      port,
    });
    console.log('Ngrok Tunnel Active:', url);
  }
  process.on('SIGINT', () => {
    console.log('\nSIGINT detected, retiring the sheriff...');
    server.close(() => {
      console.log("\nThe Sheriff's Day is Done!");
      process.exit(0);
    });
  });
});
