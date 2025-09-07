export type SheriffAccessLevel = 'read' | 'triage' | 'write' | 'maintain' | 'admin';
export type GitHubAccessLevel = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';

export type BasicRule =
  | 'restrict_creation'
  | 'restrict_update'
  | 'restrict_deletion'
  | 'require_linear_history'
  | 'require_signed_commits'
  | 'restrict_force_push';

export interface CustomProperty {
  property_name: string;
  value_type: 'string' | 'single_select' | 'multi_select';
  required?: boolean;
  default_value?: string | string[];
  description?: string;
  allowed_values?: string[];
}

export interface Ruleset {
  name: string;
  target: 'branch' | 'tag';
  enforcement?: 'disabled' | 'active' | 'evaluate';
  bypass?: {
    teams?: string[];
    apps?: number[];
  };
  ref_name: {
    include: string[];
    exclude?: string[];
  };
  rules?: BasicRule[];
  require_pull_request?: {
    dismiss_stale_reviews_on_push?: boolean;
    require_code_owner_review?: boolean;
    require_last_push_approval?: boolean;
    required_approving_review_count: number;
    required_review_thread_resolution?: boolean;
    allowed_merge_methods?: ('merge' | 'squash' | 'rebase')[];
  };
  require_status_checks?: {
    context: string;
    app_id: number;
  }[];
}
export interface RepositoryConfig {
  name: string;
  /**
   * Map of team name to access level
   */
  teams?: Record<string, SheriffAccessLevel>;
  /**
   * Map of username to access level
   */
  external_collaborators?: Record<string, SheriffAccessLevel>;
  settings?: Partial<RepoSettings>;
  visibility?: 'public' | 'private' | 'current';
  properties?: Record<string, string | string[]>;
  rulesets?: (Ruleset | string)[];
  heroku?: {
    app_name: string;
    team_name: string;
    access?: string[];
  };
}

export interface RepoSettings {
  has_wiki: boolean;
}

export interface TeamConfig {
  name: string;
  members: string[];
  maintainers: string[];
  parent?: string;
  secret?: boolean;
  gsuite?: {
    privacy: 'internal' | 'external';
  };
  displayName?: string;
  slack?: string | true;
}

export interface OrganizationConfig {
  organization: string;
  repository_defaults: RepoSettings;
  teams: TeamConfig[];
  repositories: RepositoryConfig[];
  common_rulesets?: Ruleset[];
  customProperties?: CustomProperty[];
}

export type PermissionsConfig = OrganizationConfig | OrganizationConfig[];
