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

export interface VouchedCIWorkflowRun {
  id: number;
  head_sha: string;
  event: string;
  status: string | null;
  conclusion: string | null;
}

export interface VouchedCIInput {
  vouched: VouchedUser[];
  /**
   * The `sender` of the `pull_request` webhook event, i.e. the authenticated
   * user who pushed to the fork (for `synchronize`) or opened the pull request
   */
  sender: { id: number; login: string };
  /**
   * The head SHA from the webhook payload, the tree any approved run will execute
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
 * Decides whether the workflow runs for `headSha` may be approved. Approving a
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

/**
 * Picks the runs that are safe to approve for a verified head SHA: only runs
 * awaiting approval, only `pull_request` runs (`pull_request_target` and friends
 * already run in the base repository context) and only runs pinned to the exact
 * tree that was verified.
 */
export const selectApprovableRuns = <T extends VouchedCIWorkflowRun>(
  runs: T[],
  verifiedHeadSha: string,
): T[] =>
  runs.filter(
    (run) =>
      run.head_sha === verifiedHeadSha &&
      run.event === 'pull_request' &&
      (run.status === 'action_required' || run.conclusion === 'action_required'),
  );
