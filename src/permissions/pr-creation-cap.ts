import type { Octokit } from '@octokit/rest';
import type { components as OctokitTypes } from '@octokit/openapi-types';

// The PR creation cap bypass-list endpoint
// (`/repos/{owner}/{repo}/interaction-limits/pulls/bypass-list`) is absent from
// octokit's OpenAPI types, so there is no generated typed method and
// `octokit.request(...)` returns `OctokitResponse<any>`. This module confines
// the raw route strings and the single unavoidable cast to one place so the
// rest of the codebase can call these operations type-safely.

export type SimpleUser = OctokitTypes['schemas']['simple-user'];

const BYPASS_LIST_ROUTE = '/repos/{owner}/{repo}/interaction-limits/pulls/bypass-list' as const;

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
