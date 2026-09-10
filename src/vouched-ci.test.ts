import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateVouchedCI,
  findVouchedUser,
  selectApprovableRuns,
  MAX_PULL_REQUEST_COMMITS,
  VouchedCICommit,
  VouchedCIInput,
} from './vouched-ci.js';

const alice = { login: 'alice', id: 1001 };
const bob = { login: 'bob', id: 2002 };
const vouched = [alice];

const user = (id: number) => ({ login: `user-${id}`, id } as any);

const commit = (
  sha: string,
  {
    author = alice.id,
    committer = alice.id,
    verified = true,
    reason = 'valid',
  }: {
    author?: number | null;
    committer?: number | null;
    verified?: boolean;
    reason?: string | null;
  } = {},
): VouchedCICommit => ({
  sha,
  author: author === null ? null : user(author),
  committer: committer === null ? null : user(committer),
  commit: { verification: reason === null ? null : { verified, reason } },
});

const input = (overrides: Partial<VouchedCIInput> = {}): VouchedCIInput => {
  const commits = overrides.commits || [commit('aaa'), commit('bbb')];
  return {
    vouched,
    sender: alice,
    headSha: commits[commits.length - 1]?.sha ?? 'bbb',
    pullRequest: {
      headSha: commits[commits.length - 1]?.sha ?? 'bbb',
      headRepoId: 77,
      baseRepoId: 55,
      commitCount: commits.length,
    },
    ...overrides,
    commits,
  };
};

const expectRefusal = (decision: ReturnType<typeof evaluateVouchedCI>, pattern: RegExp) => {
  assert.equal(decision.approve, false);
  if (!decision.approve) assert.match(decision.reason, pattern);
};

describe('findVouchedUser', () => {
  it('matches on id and login, case-insensitively', () => {
    assert.equal(findVouchedUser(vouched, { id: 1001, login: 'Alice' }), alice);
  });

  it('does not match a different account that reused the login', () => {
    assert.equal(findVouchedUser(vouched, { id: 9999, login: 'alice' }), undefined);
  });

  it('does not match the pinned id under a different login (id typo guard)', () => {
    assert.equal(findVouchedUser(vouched, { id: 1001, login: 'mallory' }), undefined);
  });
});

describe('evaluateVouchedCI', () => {
  it('approves when every commit is authored, committed and verified by the vouched sender', () => {
    const decision = evaluateVouchedCI(input());
    assert.deepEqual(decision, { approve: true, vouchedUser: alice });
  });

  it('approves a single commit pull request', () => {
    assert.equal(evaluateVouchedCI(input({ commits: [commit('aaa')] })).approve, true);
  });

  it('refuses when the sender is not vouched, even if the commits are', () => {
    expectRefusal(evaluateVouchedCI(input({ sender: bob })), /sender bob \(2002\) is not vouched/);
  });

  it('refuses a sender whose login collides with a vouched login but has a different id', () => {
    expectRefusal(
      evaluateVouchedCI(input({ sender: { login: 'alice', id: 31337 } })),
      /is not vouched/,
    );
  });

  it('refuses when nobody is vouched', () => {
    expectRefusal(evaluateVouchedCI(input({ vouched: [] })), /is not vouched/);
  });

  it('refuses pull requests that are not from a fork', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({ pullRequest: { headSha: 'bbb', headRepoId: 55, baseRepoId: 55, commitCount: 2 } }),
      ),
      /not from a fork/,
    );
  });

  it('refuses when the head repository is gone', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({
          pullRequest: { headSha: 'bbb', headRepoId: null, baseRepoId: 55, commitCount: 2 },
        }),
      ),
      /no longer exists/,
    );
  });

  it('refuses when the head SHA moved between the event and verification', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({ pullRequest: { headSha: 'ccc', headRepoId: 77, baseRepoId: 55, commitCount: 2 } }),
      ),
      /head moved from bbb to ccc/,
    );
  });

  it('refuses when the commit listing does not contain the head SHA', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({
          headSha: 'zzz',
          pullRequest: { headSha: 'zzz', headRepoId: 77, baseRepoId: 55, commitCount: 2 },
        }),
      ),
      /does not contain head zzz/,
    );
  });

  it('refuses when the listing is incomplete', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({ pullRequest: { headSha: 'bbb', headRepoId: 77, baseRepoId: 55, commitCount: 3 } }),
      ),
      /listed 2 commits but the pull request has 3/,
    );
  });

  it('refuses pull requests with more commits than can be listed', () => {
    const count = MAX_PULL_REQUEST_COMMITS + 1;
    expectRefusal(
      evaluateVouchedCI(
        input({
          pullRequest: { headSha: 'bbb', headRepoId: 77, baseRepoId: 55, commitCount: count },
        }),
      ),
      /more than can be listed/,
    );
  });

  it('refuses an empty pull request', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({
          commits: [],
          headSha: 'bbb',
          pullRequest: { headSha: 'bbb', headRepoId: 77, baseRepoId: 55, commitCount: 0 },
        }),
      ),
      /no commits/,
    );
  });

  it('refuses when any commit is unsigned', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({ commits: [commit('aaa'), commit('bbb', { verified: false, reason: 'unsigned' })] }),
      ),
      /commit bbb signature is not verified \(unsigned\)/,
    );
  });

  it('refuses a verified signature whose reason is not "valid"', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({ commits: [commit('aaa', { verified: true, reason: 'unknown_key' })] }),
      ),
      /not verified \(unknown_key\)/,
    );
  });

  it('refuses when the verification object is missing', () => {
    expectRefusal(
      evaluateVouchedCI(input({ commits: [commit('aaa', { reason: null })] })),
      /not verified \(missing\)/,
    );
  });

  it('refuses when a commit was authored by someone else but committed by the vouched user', () => {
    expectRefusal(
      evaluateVouchedCI(input({ commits: [commit('aaa', { author: bob.id })] })),
      /commit aaa author \(2002\) is not alice/,
    );
  });

  it('refuses when a commit was committed by someone else (e.g. web-flow) but authored by the vouched user', () => {
    expectRefusal(
      evaluateVouchedCI(input({ commits: [commit('aaa', { committer: 19864447 })] })),
      /commit aaa committer \(19864447\) is not alice/,
    );
  });

  it('refuses when GitHub could not resolve the author or committer to an account', () => {
    expectRefusal(
      evaluateVouchedCI(input({ commits: [commit('aaa', { author: null })] })),
      /author \(null\) is not alice/,
    );
    expectRefusal(
      evaluateVouchedCI(input({ commits: [{ ...commit('aaa'), committer: {} }] })),
      /committer \(null\) is not alice/,
    );
  });

  it('refuses when a commit from another vouched user is mixed in', () => {
    const decision = evaluateVouchedCI(
      input({
        vouched: [alice, bob],
        commits: [commit('aaa'), commit('bbb', { author: bob.id, committer: bob.id })],
      }),
    );
    expectRefusal(decision, /commit bbb author \(2002\) is not alice/);
  });

  it('refuses when an earlier commit in the range is not vouched, even if the head is', () => {
    expectRefusal(
      evaluateVouchedCI(
        input({
          commits: [commit('aaa', { author: bob.id, committer: bob.id }), commit('bbb')],
        }),
      ),
      /commit aaa/,
    );
  });
});

describe('selectApprovableRuns', () => {
  const run = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    head_sha: 'bbb',
    event: 'pull_request',
    status: 'action_required',
    conclusion: 'action_required',
    ...overrides,
  });

  it('keeps only pending pull_request runs on the verified head SHA', () => {
    const runs = [
      run(1),
      run(2, { head_sha: 'ccc' }),
      run(3, { event: 'pull_request_target' }),
      run(4, { status: 'completed', conclusion: 'success' }),
      run(5, { status: 'action_required', conclusion: null }),
      run(6, { status: 'completed', conclusion: 'action_required' }),
    ];
    assert.deepEqual(
      selectApprovableRuns(runs, 'bbb').map((r) => r.id),
      [1, 5, 6],
    );
  });

  it('selects nothing when the head SHA does not match', () => {
    assert.deepEqual(selectApprovableRuns([run(1)], 'ccc'), []);
  });
});
