import { config } from 'dotenv-safe';
import { graphql } from '@octokit/graphql';
import { Octokit } from '@octokit/rest';
import {
  appCredentialsFromString,
  AuthNarrowing,
  getAuthOptionsForEnterprise,
  getAuthOptionsForOrg,
  getTokenForOrg,
} from '@electron/github-app-auth';
import { SHERIFF_GITHUB_APP_CREDS } from './constants.js';
import { IS_DRY_RUN } from './helpers.js';

config();

function getAuthNarrowing(forceReadOnly: boolean): AuthNarrowing {
  // In a dry run, ensure we only have read access to resources to avoid
  // any mishaps
  if (IS_DRY_RUN || forceReadOnly) {
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

// org <-> Octokit
let octokitMap: Map<string, Octokit> = new Map();
export async function getOctokit(org: string, forceReadOnly = false): Promise<Octokit> {
  const mapKey = `org/${org}`;
  if (!octokitMap.has(mapKey)) {
    const creds = appCredentialsFromString(SHERIFF_GITHUB_APP_CREDS!);
    const authOpts = await getAuthOptionsForOrg(org, creds, getAuthNarrowing(forceReadOnly));
    octokitMap.set(mapKey, new Octokit({ ...authOpts }));
  }

  return octokitMap.get(mapKey)!;
}

// Approving fork pull request workflow runs needs "actions: write" (and listing
// the PR's commits needs "pull_requests: read"), neither of which the rest of
// Sheriff uses. GitHub refuses to mint a token that requests a permission the
// App has not been granted, so this lives on its own token to ensure a missing
// App permission only breaks vouched_ci rather than every Sheriff API call.
export async function getVouchedCIOctokit(org: string): Promise<Octokit> {
  const mapKey = `vouched_ci/${org}`;
  if (!octokitMap.has(mapKey)) {
    const creds = appCredentialsFromString(SHERIFF_GITHUB_APP_CREDS!);
    const authOpts = await getAuthOptionsForOrg(org, creds, {
      permissions: {
        actions: IS_DRY_RUN ? 'read' : 'write',
        contents: 'read',
        metadata: 'read',
        pull_requests: 'read',
      },
    });
    octokitMap.set(mapKey, new Octokit({ ...authOpts }));
  }

  return octokitMap.get(mapKey)!;
}

export async function getEnterpriseOctokit(
  enterprise: string,
  forceReadOnly = false,
): Promise<Octokit> {
  const mapKey = `enterprise/${enterprise}`;
  if (!octokitMap.has(mapKey)) {
    const creds = appCredentialsFromString(SHERIFF_GITHUB_APP_CREDS!);
    const authOpts = await getAuthOptionsForEnterprise(
      enterprise,
      creds,
      getAuthNarrowing(forceReadOnly),
    );
    octokitMap.set(mapKey, new Octokit({ ...authOpts }));
  }

  return octokitMap.get(mapKey)!;
}

export async function graphyOctokit(org: string, forceReadOnly = false) {
  const creds = appCredentialsFromString(SHERIFF_GITHUB_APP_CREDS!);
  const token = await getTokenForOrg(org, creds, getAuthNarrowing(forceReadOnly));
  return graphql.defaults({
    headers: {
      authorization: `token ${token}`,
    },
  });
}
