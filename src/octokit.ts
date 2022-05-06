import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import {
  appCredentialsFromString,
  getAuthOptionsForRepo,
  getTokenForRepo,
} from '@electron/github-app-auth';
import {
  SHERIFF_GITHUB_APP_CREDS,
  ORGANIZATION_NAME,
  REPO_NAME
} from './constants';

require('dotenv-safe').config();

let octokit: Octokit;
export async function getOctokit() {
  if (octokit) return octokit;

  const creds = appCredentialsFromString(SHERIFF_GITHUB_APP_CREDS!);
  const authOpts = await getAuthOptionsForRepo(
    {
      owner: ORGANIZATION_NAME,
      name: REPO_NAME,
    },
    creds,
  );
  octokit = new Octokit({ ...authOpts });
  return octokit;
}

export function graphyOctokit() {
  const creds = appCredentialsFromString(SHERIFF_GITHUB_APP_CREDS!);
  const token = getTokenForRepo({
    owner: ORGANIZATION_NAME,
    name: REPO_NAME
  }, creds);
  return graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });
}
