import { IncomingWebhook, IncomingWebhookSendArguments } from '@slack/webhook';
import { RepositoryCreatedEvent } from '@octokit/webhooks-types';
import { KnownBlock } from '@slack/types';
import { AUTO_TUNNEL_NGROK, SHERIFF_HOST_URL, SLACK_WEBHOOK_URL } from './constants';

const HOST = AUTO_TUNNEL_NGROK ? `https://${AUTO_TUNNEL_NGROK}.ngrok.io` : SHERIFF_HOST_URL;

const hook = new IncomingWebhook(SLACK_WEBHOOK_URL!);

type MinimalUserInfo = {
  login: string;
  avatar_url: string;
  html_url: string;
};

export const createMessageBlock = (msg: string, emojiSupport = false): KnownBlock => ({
  type: 'section',
  text: {
    type: 'plain_text',
    emoji: emojiSupport,
    text: msg,
  },
});

export const createMarkdownBlock = (msg: string): KnownBlock => ({
  type: 'section',
  text: {
    type: 'mrkdwn',
    text: msg,
  },
});

export class MessageBuilder {
  private state: IncomingWebhookSendArguments = {};

  private constructor() {}

  public static create() {
    return new MessageBuilder();
  }

  public addRepositoryAndBlame(
    repository: RepositoryCreatedEvent['repository'],
    user: MinimalUserInfo,
  ) {
    this.divide();
    this.addRepositoryContext(repository);
    this.divide();
    this.addBlame(user);
    this.divide();
    return this;
  }

  public addUser(user: MinimalUserInfo, userType: string, extraInfo?: string) {
    this.addBlock({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${userType}: <${user.html_url}|${user.login}>*${extraInfo ? `\n${extraInfo}` : ''}`,
      },
      accessory: {
        type: 'image',
        image_url: user.avatar_url,
        alt_text: 'user',
      },
    });
    return this;
  }

  public addBlame(user: MinimalUserInfo) {
    this.addUser(user, 'Sender', `Time: ${new Date()}`);
    return this;
  }

  public addRepositoryContext(repo: RepositoryCreatedEvent['repository']) {
    this.addBlock(
      createMarkdownBlock(
        `*Repository: <${repo.html_url}|${repo.owner.login}/${repo.name}>*\n${repo.description ||
          'No Description'}`,
      ),
    );
    return this;
  }

  public addWarning(markdown: string) {
    return this.addBlock({
      type: 'context',
      elements: [
        {
          type: 'image',
          image_url: `${HOST}/static/warning.png`,
          alt_text: 'warning',
        },
        {
          type: 'mrkdwn',
          text: markdown,
        },
      ],
    });
  }

  public addCritical(markdown: string) {
    return this.addBlock({
      type: 'context',
      elements: [
        {
          type: 'image',
          image_url: `${HOST}/static/critical.png`,
          alt_text: 'critical',
        },
        {
          type: 'mrkdwn',
          text: markdown,
        },
      ],
    });
  }

  public addContext(markdown: string) {
    return this.addBlock({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: markdown,
        },
      ],
    });
  }

  public addSeverity(severity: 'normal' | 'warning' | 'critical') {
    switch (severity) {
      case 'normal':
        return this.addBlock({
          type: 'context',
          elements: [
            {
              type: 'image',
              image_url: `${HOST}/static/info.png`,
              alt_text: 'info',
            },
            {
              type: 'mrkdwn',
              text: '*This alert is considered informational*',
            },
          ],
        });
      case 'warning':
        return this.addWarning('*This alert is considered a warning, please look into it*');
      case 'critical':
        return this.addCritical(
          '*This alert is considered critical, please investigate immediately @channel*',
        );
    }
    return this;
  }

  public divide() {
    this.addBlock({
      type: 'divider',
    });
    return this;
  }

  public setNotificationContent(message: string) {
    this.state.text = message;
    return this;
  }

  public addBlock(block: KnownBlock) {
    if (!this.state.blocks) {
      this.state.blocks = [];
    }
    this.state.blocks.push(block);
    return this;
  }

  async send() {
    const { blocks, ...rest } = this.state;
    if (!blocks) return;

    const allBlocks = [...blocks!];
    while (allBlocks.length > 0) {
      const state = {
        ...rest,
        blocks: allBlocks.splice(0, 50),
      };
      await hook.send(state);
    }
  }
}
