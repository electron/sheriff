import type { Octokit } from '@octokit/rest';
import type { components as OctokitTypes } from '@octokit/openapi-types';

// The PR creation cap endpoints
// (`/repos/{owner}/{repo}/interaction-limits/pulls/bypass-list` and
// `/repos/{owner}/{repo}/interaction-limits/pulls/creation-cap`) are absent
// from octokit's OpenAPI types, so there are no generated typed methods and
// `octokit.request(...)` returns `OctokitResponse<any>`. This module confines
// the raw route strings and the single unavoidable cast per response to one
// place so the rest of the codebase can call these operations type-safely.

export type SimpleUser = OctokitTypes['schemas']['simple-user'];

export interface PullRequestCreationCap {
  enabled: boolean;
  max_open_pull_requests?: number;
}

const BYPASS_LIST_ROUTE = '/repos/{owner}/{repo}/interaction-limits/pulls/bypass-list' as const;
const CREATION_CAP_ROUTE = '/repos/{owner}/{repo}/interaction-limits/pulls/creation-cap' as const;

export async function getBypassList(
  octokit: Octokit,
  { owner, repo }: { owner: string; repo: string },
): Promise<SimpleUser[]> {
  const response = await octokit.request(`GET ${BYPASS_LIST_ROUTE}`, {
    owner,
    repo,
  });
  return response.data as SimpleUser[];
}

export async function addToBypassList(
  octokit: Octokit,
  { owner, repo, users }: { owner: string; repo: string; users: string[] },
): Promise<void> {
  await octokit.request(`PUT ${BYPASS_LIST_ROUTE}`, {
    owner,
    repo,
    users,
  });
}

export async function removeFromBypassList(
  octokit: Octokit,
  { owner, repo, users }: { owner: string; repo: string; users: string[] },
): Promise<void> {
  await octokit.request(`DELETE ${BYPASS_LIST_ROUTE}`, {
    owner,
    repo,
    users,
  });
}

export async function getCreationCap(
  octokit: Octokit,
  { owner, repo }: { owner: string; repo: string },
): Promise<PullRequestCreationCap> {
  const response = await octokit.request(`GET ${CREATION_CAP_ROUTE}`, {
    owner,
    repo,
  });
  return response.data as PullRequestCreationCap;
}

export async function setCreationCap(
  octokit: Octokit,
  {
    owner,
    repo,
    enabled,
    maxOpenPullRequests,
  }: { owner: string; repo: string; enabled: boolean; maxOpenPullRequests?: number },
): Promise<void> {
  await octokit.request(`PATCH ${CREATION_CAP_ROUTE}`, {
    owner,
    repo,
    enabled,
    max_open_pull_requests: maxOpenPullRequests,
  });
}
