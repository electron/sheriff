import { createAppAuth } from '@octokit/auth-app';
import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';

require('dotenv-safe').config();

export const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY!, 'base64').toString('utf8'),
    installationId: process.env.GITHUB_INSTALLATION_ID,
  },
});

export const graphyOctokit = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN!}`,
  },
});
