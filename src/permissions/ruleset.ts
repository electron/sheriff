import type { components as OctokitTypes } from '@octokit/openapi-types';
import { diff } from 'jest-diff';

import { Ruleset } from './types.js';

export function rulesetToGithub(ruleset: Ruleset, allTeams: { id: number; name: string }[]) {
  const generatedRules: OctokitTypes['schemas']['repository-rule'][] = [];
  if (ruleset.rules) {
    for (const basicRule of ruleset.rules) {
      switch (basicRule) {
        case 'require_linear_history':
          generatedRules.push({
            type: 'required_linear_history',
          });
          break;
        case 'require_signed_commits':
          generatedRules.push({
            type: 'required_signatures',
          });
          break;
        case 'restrict_creation':
          generatedRules.push({
            type: 'creation',
          });
          break;
        case 'restrict_deletion':
          generatedRules.push({
            type: 'deletion',
          });
          break;
        case 'restrict_update':
          generatedRules.push({
            type: 'update',
          });
          break;
        case 'restrict_force_push':
          generatedRules.push({
            type: 'non_fast_forward',
          });
          break;
      }
    }
  }
  if (ruleset.require_pull_request) {
    generatedRules.push({
      type: 'pull_request',
      parameters: {
        dismiss_stale_reviews_on_push:
          ruleset.require_pull_request?.dismiss_stale_reviews_on_push ?? false,
        require_code_owner_review: ruleset.require_pull_request?.require_code_owner_review ?? false,
        require_last_push_approval:
          ruleset.require_pull_request?.require_last_push_approval ?? false,
        required_approving_review_count:
          ruleset.require_pull_request?.required_approving_review_count ?? 0,
        required_review_thread_resolution:
          ruleset.require_pull_request?.required_review_thread_resolution ?? false,
        allowed_merge_methods: ruleset.require_pull_request?.allowed_merge_methods ?? ['squash'],
      },
    });
  }
  if (ruleset.require_status_checks) {
    generatedRules.push({
      type: 'required_status_checks',
      parameters: {
        required_status_checks: ruleset.require_status_checks.map((check) => ({
          context: check.context,
          integration_id: check.app_id,
        })),
        strict_required_status_checks_policy: false,
      },
    });
  }
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement || 'active',
    bypass_actors: ruleset.bypass
      ? [
          ...(ruleset.bypass?.apps?.map((appId) => ({
            actor_id: appId,
            actor_type: 'Integration' as const,
            bypass_mode: 'always' as const,
          })) || []),
          ...(ruleset.bypass?.teams?.map((teamName) => ({
            actor_id: allTeams.find((t) => t.name === teamName)!.id,
            actor_type: 'Team' as const,
            bypass_mode: 'always' as const,
          })) || []),
        ].sort(sortBypassActors)
      : [],
    conditions: {
      ref_name: {
        include: ruleset.ref_name.include,
        exclude: ruleset.ref_name.exclude || [],
      },
    },
    rules: generatedRules.sort((a, b) => a.type.localeCompare(b.type)),
  } as const;
}

type BypassActor = Required<OctokitTypes['schemas']['repository-ruleset']>['bypass_actors'][0];
function sortBypassActors(a: BypassActor, b: BypassActor): number {
  if (a.actor_type === b.actor_type) {
    return a.actor_id! - b.actor_id!;
  }
  return a.actor_type!.localeCompare(b.actor_type!);
}

export function getDifferenceWithGithubRuleset(
  ruleset: ReturnType<typeof rulesetToGithub>,
  githubRuleset: OctokitTypes['schemas']['repository-ruleset'] | null,
  stripAnsi: boolean,
) {
  const _clonedGithubRuleset: OctokitTypes['schemas']['repository-ruleset'] = githubRuleset
    ? JSON.parse(JSON.stringify(githubRuleset))
    : githubRuleset;
  const clonedGitHubRuleset: ReturnType<typeof rulesetToGithub> = githubRuleset
    ? {
        name: _clonedGithubRuleset.name,
        target: _clonedGithubRuleset.target as any,
        enforcement: _clonedGithubRuleset.enforcement,
        bypass_actors: _clonedGithubRuleset.bypass_actors?.sort(sortBypassActors) as any,
        conditions: _clonedGithubRuleset.conditions! as any,
        rules: _clonedGithubRuleset.rules?.sort((a, b) => a.type.localeCompare(b.type)) as any,
      }
    : ({} as any);
  // This property is not in the API types but it is in the response, nuke it
  const prParameters = clonedGitHubRuleset.rules?.find((r) => r.type === 'pull_request')
    ?.parameters as any;
  if (prParameters) {
    delete prParameters.automatic_copilot_code_review_enabled;
  }

  if (stripAnsi) {
    const difference = diff(ruleset, clonedGitHubRuleset, {
      aColor: (a) => a,
      bColor: (a) => a,
      changeColor: (a) => a,
      changeLineTrailingSpaceColor: (a) => a,
      commonColor: (a) => a,
      commonLineTrailingSpaceColor: (a) => a,
      patchColor: (a) => a,
      aAnnotation: 'New',
      bAnnotation: 'Old',
      aIndicator: '+',
      bIndicator: '-',
    });
    if (difference?.trim() === 'Compared values have no visual difference.') {
      return null;
    }
    return difference;
  }
  const difference = diff(ruleset, clonedGitHubRuleset, {
    aAnnotation: 'New',
    bAnnotation: 'Old',
    aIndicator: '+',
    bIndicator: '-',
  });
  if (difference?.trim() === 'Compared values have no visual difference.') {
    return null;
  }
  return difference;
}
