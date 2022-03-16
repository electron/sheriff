import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';

require('dotenv-safe').config();

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN!,
});

export const graphyOctokit = graphql.defaults({
  headers: {
    authorization: `token ${process.env.GITHUB_TOKEN!}`,
  },
});
