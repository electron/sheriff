import type { components } from '@octokit/openapi-types';
import type { VouchedUser } from './permissions/types.js';

// `GET /repos/{owner}/{repo}/pulls/{pull_number}/commits` never returns more
// than this many commits, so beyond it the listing is silently incomplete.
export const MAX_PULL_REQUEST_COMMITS = 250;

type SimpleUser = components['schemas']['simple-user'];

/**
 * The subset of a REST commit object (`GET /repos/{owner}/{repo}/pulls/{pull_number}/commits`)
 * that the decision depends on. `author` / `committer` are GitHub's server side
 * resolution of the commit emails to accounts; the git metadata in
 * `commit.author` / `commit.committer` is free-form text and deliberately unused.
 */
export interface VouchedCICommit {
  sha: string;
  author: SimpleUser | Record<string, never> | null;
  committer: SimpleUser | Record<string, never> | null;
  commit: {
    verification?: {
      verified: boolean;
      reason: string;
    } | null;
  };
}

/**
 * The subset of a `workflow_run` webhook payload that the decision depends on.
 * `head_repository` is typed as non-null by the webhook schema but the REST
 * representation can be `null` once a fork is deleted, so it is guarded anyway.
 */
export interface VouchedCIWorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string | null;
  head_repository: { id: number; owner: { login: string } | null } | null;
  event: string;
  status: string | null;
  conclusion: string | null;
}

export interface VouchedCIInput {
  vouched: VouchedUser[];
  /**
   * The `triggering_actor` of the `workflow_run` webhook event, i.e. the
   * authenticated user whose push to the fork created the run
   */
  sender: { id: number; login: string };
  /**
   * The run's `head_sha` from the webhook payload, the tree the approved run will execute
   */
  headSha: string;
  /**
   * The pull request as re-fetched *after* listing its commits
   */
  pullRequest: {
    headSha: string;
    headRepoId: number | null;
    baseRepoId: number;
    commitCount: number;
  };
  commits: VouchedCICommit[];
}

export type VouchedCIDecision =
  | { approve: true; vouchedUser: VouchedUser }
  | { approve: false; reason: string };

const refuse = (reason: string): VouchedCIDecision => ({ approve: false, reason });

const userId = (user: SimpleUser | Record<string, never> | null): number | null =>
  user && typeof user.id === 'number' ? user.id : null;

/**
 * Finds the vouched entry for a user. The numeric id is the identity, the login
 * is cross-checked (case-insensitively, like GitHub) so that a typo in the id
 * can never vouch for an unrelated account.
 */
export const findVouchedUser = (
  vouched: VouchedUser[],
  user: { id: number; login: string },
): VouchedUser | undefined =>
  vouched.find((v) => v.id === user.id && v.login.toLowerCase() === user.login.toLowerCase());

/**
 * Decides whether a workflow run for `headSha` may be approved. Approving a
 * run executes the whole head tree, so every commit in the pull request range
 * must have been authored, committed and verified-signed by the vouched user
 * who pushed it. Pure: every input comes from GitHub, nothing is fetched.
 */
export function evaluateVouchedCI(input: VouchedCIInput): VouchedCIDecision {
  const { sender, headSha, pullRequest, commits } = input;

  if (pullRequest.headRepoId === null) return refuse('head repository no longer exists');
  if (pullRequest.headRepoId === pullRequest.baseRepoId) {
    return refuse('pull request is not from a fork');
  }

  const vouchedUser = findVouchedUser(input.vouched, sender);
  if (!vouchedUser) return refuse(`sender ${sender.login} (${sender.id}) is not vouched`);

  if (pullRequest.headSha !== headSha) {
    return refuse(`head moved from ${headSha} to ${pullRequest.headSha} during verification`);
  }
  if (pullRequest.commitCount > MAX_PULL_REQUEST_COMMITS) {
    return refuse(`pull request has ${pullRequest.commitCount} commits, more than can be listed`);
  }
  if (commits.length === 0) return refuse('pull request has no commits');
  if (commits.length !== pullRequest.commitCount) {
    return refuse(
      `listed ${commits.length} commits but the pull request has ${pullRequest.commitCount}`,
    );
  }
  if (!commits.some((c) => c.sha === headSha)) {
    return refuse(`commit listing does not contain head ${headSha}`);
  }

  for (const commit of commits) {
    const author = userId(commit.author);
    const committer = userId(commit.committer);
    if (author !== vouchedUser.id) {
      return refuse(`commit ${commit.sha} author (${author}) is not ${vouchedUser.login}`);
    }
    if (committer !== vouchedUser.id) {
      return refuse(`commit ${commit.sha} committer (${committer}) is not ${vouchedUser.login}`);
    }
    const verification = commit.commit.verification;
    if (!verification?.verified || verification.reason !== 'valid') {
      return refuse(
        `commit ${commit.sha} signature is not verified (${verification?.reason || 'missing'})`,
      );
    }
  }

  return { approve: true, vouchedUser };
}

export type VouchedCIRunCheck = { approvable: true } | { approvable: false; reason: string };

/**
 * Cheap, payload-only checks for a `workflow_run` `requested` event: is this a
 * run that `vouched_ci` could ever approve? Only `pull_request` runs
 * (`pull_request_target` and friends already run in the base repository
 * context), only runs GitHub gated on approval (reported as `completed` /
 * `action_required` in the webhook payload) and only runs from a fork. This
 * event fires for every run in the organization, so it runs before any I/O.
 */
export function isApprovableRun(run: VouchedCIWorkflowRun, baseRepoId: number): VouchedCIRunCheck {
  if (run.event !== 'pull_request') {
    return { approvable: false, reason: `run event is ${run.event}, not pull_request` };
  }
  if (run.conclusion !== 'action_required' && run.status !== 'action_required') {
    return {
      approvable: false,
      reason: `run is not awaiting approval (${run.status} / ${run.conclusion})`,
    };
  }
  if (!run.head_repository) return { approvable: false, reason: 'run has no head repository' };
  if (run.head_repository.id === baseRepoId) {
    return { approvable: false, reason: 'run is not from a fork' };
  }
  if (!run.head_repository.owner?.login) {
    return { approvable: false, reason: 'run head repository has no owner' };
  }
  if (!run.head_branch) return { approvable: false, reason: 'run has no head branch' };
  return { approvable: true };
}

export interface VouchedCIPullRequest {
  number: number;
  head: {
    sha: string;
    repo: { id: number } | null;
  };
}

export type VouchedCIPullRequestMatch<T extends VouchedCIPullRequest> =
  | { pullRequest: T }
  | { pullRequest: null; reason: string };

/**
 * Picks the pull request a fork run belongs to. `workflow_run.pull_requests` is
 * empty for runs from forks, so the candidates come from listing the open pull
 * requests for the run's `owner:branch` head; a candidate only counts if it is
 * pinned to the exact tree the run will execute *and* comes from the run's head
 * repository (a fork of a fork can reuse the owner login of a deleted fork).
 * Exactly one pull request must match: with two the run cannot be attributed.
 */
export function matchPullRequestForRun<T extends VouchedCIPullRequest>(
  pullRequests: T[],
  run: Pick<VouchedCIWorkflowRun, 'head_sha' | 'head_repository'>,
): VouchedCIPullRequestMatch<T> {
  const matches = pullRequests.filter(
    (pr) =>
      pr.head.sha === run.head_sha &&
      run.head_repository !== null &&
      pr.head.repo?.id === run.head_repository.id,
  );
  if (matches.length === 1) return { pullRequest: matches[0] };
  if (matches.length === 0) {
    return {
      pullRequest: null,
      reason: `no open pull request has head ${run.head_sha} from repository ${
        run.head_repository?.id ?? 'unknown'
      } (${pullRequests.length} candidate(s))`,
    };
  }
  return {
    pullRequest: null,
    reason: `${matches.length} open pull requests (${matches
      .map((pr) => `#${pr.number}`)
      .join(', ')}) share head ${run.head_sha}`,
  };
}

/**
 * Resolves a numeric GitHub user id to the account's current login, or `null`
 * when no account has that id (`GET /user/{account_id}` answers 404).
 */
export type VouchedUserLookup = (id: number) => Promise<{ login: string } | null>;

/**
 * Confirms that every `vouched_ci` entry's id really belongs to its login by
 * resolving each id through GitHub (`GET /user/{account_id}`). The handler only
 * ever vouches for a user whose id *and* login match the entry, so an entry
 * that fails this check is dead config at best and a typo pointing at an
 * unrelated account at worst; either way the permissions run should refuse it.
 * Returns one message per bad entry, empty when every entry checks out.
 */
export async function verifyVouchedUsers(
  vouched: VouchedUser[],
  fetchUserById: VouchedUserLookup,
): Promise<string[]> {
  const problems: string[] = [];
  for (const user of vouched) {
    const resolved = await fetchUserById(user.id);
    if (!resolved) {
      problems.push(
        `vouched_ci user "${user.login}" (${user.id}): no GitHub user has id ${user.id}`,
      );
    } else if (resolved.login.toLowerCase() !== user.login.toLowerCase()) {
      problems.push(
        `vouched_ci user "${user.login}" (${user.id}): id ${user.id} belongs to "${resolved.login}", not "${user.login}"`,
      );
    }
  }
  return problems;
}
