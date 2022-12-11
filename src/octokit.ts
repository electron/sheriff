import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import {
  appCredentialsFromString,
  AuthNarrowing,
  getAuthOptionsForRepo,
  getTokenForRepo,
} from '@electron/github-app-auth';
import { SHERIFF_GITHUB_APP_CREDS, ORGANIZATION_NAME, REPO_NAME } from './constants';
import { IS_DRY_RUN } from './helpers';

require('dotenv-safe').config();

function getAuthNarrowing(): AuthNarrowing {
  // In a dry run, ensure we only have read access to resources to avoid
  // any mishaps
  if (IS_DRY_RUN) {
    return {
      permissions: {
        administration: 'read',
        members: 'read',
        contents: 'read',
        metadata: 'read',
      },
    };
  }
  // Otherwise we should get a token with write access to admin/members
  return {
    permissions: {
      administration: 'write',
      members: 'write',
      contents: 'read',
      metadata: 'read',
    },
  };
}

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
    getAuthNarrowing(),
  );
  octokit = new Octokit({ ...authOpts });
  return octokit;
}

export async function graphyOctokit() {
  const creds = appCredentialsFromString(SHERIFF_GITHUB_APP_CREDS!);
  const token = await getTokenForRepo(
    {
      owner: ORGANIZATION_NAME,
      name: REPO_NAME,
    },
    creds,
    getAuthNarrowing(),
  );
  return graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });
}
