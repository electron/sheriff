export type SheriffAccessLevel = 'read' | 'triage' | 'write' | 'maintain' | 'admin';
export type GitHubAccessLevel = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';
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
  properties?: Record<string, string>;
  heroku?: {
    app_name: string;
    team_name: string;
    access: string[];
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
}

export type PermissionsConfig = OrganizationConfig | OrganizationConfig[];
