import * as Octokit from '@octokit/rest';

require('dotenv-safe').config();

export const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN!,
});
