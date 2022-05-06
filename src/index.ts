require('dotenv-safe').config();

import express from 'express';
import { AddressInfo } from 'net';
import * as path from 'path';

import { Webhooks as WebhooksApi, createNodeMiddleware } from '@octokit/webhooks';
import { isMainRepo, hook } from './helpers';
import { MessageBuilder, createMessageBlock, createMarkdownBlock } from './MessageBuilder';
import { octokit } from './octokit';

const webhooks = new WebhooksApi({
  secret: process.env.GITHUB_WEBHOOK_SECRET || 'development',
});

webhooks.onAny(
  hook(async ({ name }, ctx) => {
    ctx.log('Event:', name, 'received');
  }),
);

const importantBranchMatcher = () =>
  process.env.SHERIFF_IMPORTANT_BRANCH ? new RegExp('(^[0-9]+-[0-9]+-x$)|(^[0-9]+-x-y$)') : null;

webhooks.on(
  'delete',
  hook(async event => {
    if (event.payload.ref_type === 'tag') {
      // Deleted a tag
      const deletedTag = event.payload.ref;
      await MessageBuilder.create()
        .addBlock(createMessageBlock(`An existing tag was just deleted: ${deletedTag}`))
        .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
        .addSeverity('warning')
        .send();
    } else if (event.payload.ref_type === 'branch') {
      const deletedBranch = event.payload.ref;
      const matcher = importantBranchMatcher();
      if (isMainRepo(event.payload.repository) && matcher && matcher.test(deletedBranch)) {
        // Deleted a release branch
        await MessageBuilder.create()
          .addBlock(
            createMessageBlock(
              `A branch dedicated to an important release line was just removed: ${deletedBranch}`,
            ),
          )
          .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
          .addSeverity('critical')
          .send();
      }
    }
  }),
);

webhooks.on(
  'deploy_key.created',
  hook(async event => {
    if (!event.payload.key.read_only) {
      // Write access deploy key
      await MessageBuilder.create()
        .addBlock(
          createMessageBlock(
            `A deploy key with name "${event.payload.key.title}" was just created with write access`,
          ),
        )
        .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
        .addSeverity('critical')
        .send();
    } else if (event.payload.repository.private) {
      // Read access deploy key to a private repo
      await MessageBuilder.create()
        .addBlock(
          createMessageBlock(
            `A deploy key with name "${event.payload.key.title}" was just created with read access to a private repository`,
          ),
        )
        .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
        .addSeverity('warning')
        .send();
    }
  }),
);

webhooks.on(
  'member.added',
  hook(async event => {
    // Collaborator added to repo
    await MessageBuilder.create()
      .addBlock(createMessageBlock(`A new collaborator was added to a repository`))
      .addUser(event.payload.member, 'Collaborator')
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('warning')
      .send();
  }),
);

webhooks.on(
  'member.removed',
  hook(async event => {
    // Collaborator removed from repo
    await MessageBuilder.create()
      .addBlock(createMessageBlock(`A collaborator was removed from a repository`))
      .addUser(event.payload.member, 'Collaborator')
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('normal')
      .send();
  }),
);

webhooks.on(
  'member.edited',
  hook(async event => {
    // Collaborator has permission level changed on repo
    const originalPermission = (event.payload as any).changes.permission.from;
    // We have to fetch the new permission level through the API
    const newPermissionLevel = await octokit.repos.getCollaboratorPermissionLevel({
      owner: event.payload.repository.owner.login,
      repo: event.payload.repository.name,
      username: event.payload.member.login,
    });
    const newPermission = newPermissionLevel.data.permission;
    await MessageBuilder.create()
      .addBlock(
        createMarkdownBlock(
          `A collaborators permission level was changed on a repository from \`${originalPermission}\` :arrow_right: \`${newPermission}\``,
        ),
      )
      .addUser(event.payload.member, 'Collaborator')
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity(
        newPermission === 'admin' ? 'critical' : newPermission === 'write' ? 'warning' : 'normal',
      )
      .send();
  }),
);

webhooks.on(
  'meta.deleted',
  hook(async event => {
    await MessageBuilder.create()
      .addBlock(
        createMessageBlock('The org-wide webhook powering Electron Sheriff was just deleted!!!!'),
      )
      .addBlame(event.payload.sender)
      .addSeverity('critical')
      .send();
  }),
);

webhooks.on(
  'organization.member_invited',
  hook(async event => {
    const invitedLogin = event.payload.invitation.login;
    await MessageBuilder.create()
      .addBlock(
        createMessageBlock(
          `A new member was just invited to the "${event.payload.organization.login}" organization`,
        ),
      )
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
  hook(async event => {
    await MessageBuilder.create()
      .addBlock(
        createMessageBlock(
          `A new member was just added to the "${event.payload.organization.login}" organization`,
        ),
      )
      .addUser(event.payload.membership.user, 'New Member')
      .addBlame(event.payload.sender)
      .addSeverity('normal')
      .send();
  }),
);

webhooks.on(
  'organization.member_removed',
  hook(async event => {
    await MessageBuilder.create()
      .addBlock(
        createMessageBlock(
          `A member was just removed from the "${event.payload.organization.login}" organization`,
        ),
      )
      .addUser(event.payload.membership.user, 'Removed Member')
      .addBlame(event.payload.sender)
      .addSeverity('normal')
      .send();
  }),
);

webhooks.on(
  'organization.renamed',
  hook(async event => {
    await MessageBuilder.create()
      .addBlock(
        createMessageBlock(
          `The organization was just renamed to \`${event.payload.organization.login}\`, this is incredibly unexpected`,
        ),
      )
      .addBlame(event.payload.sender)
      .addSeverity('critical')
      .send();
  }),
);

webhooks.on(
  'public',
  hook(async event => {
    await MessageBuilder.create()
      .addBlock(createMessageBlock(`A private repository was just made public`))
      .addRepositoryAndBlame(event.payload.repository, event.payload.sender)
      .addSeverity('warning')
      .send();
  }),
);

webhooks.on(
  'release',
  hook(async event => {
    const message = MessageBuilder.create();
    let severity: 'critical' | 'warning' | 'normal' = 'normal';
    message.addBlock(
      createMessageBlock(
        `The "${event.payload.release.name}" release was just ${event.payload.action}`,
      ),
    );
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

const server = app.listen(process.env.PORT || 8080, async () => {
  const port = (server.address() as AddressInfo).port;
  console.log('Electron Sheriff Listening:', `http://127.0.0.1:${port}`);
  if (process.env.AUTO_TUNNEL_NGROK) {
    const ngrok = require('ngrok');
    const url = await ngrok.connect({
      subdomain: process.env.AUTO_TUNNEL_NGROK,
      port,
    });
    console.log('Ngrok Tunnel Active:', url);
  }
});
