import { GitHubAccessLevel, SheriffAccessLevel } from './types.js';

export const sheriffLevelToGitHubLevel = (accessLevel: SheriffAccessLevel): GitHubAccessLevel => {
  switch (accessLevel) {
    case 'read':
      return 'pull';
    case 'triage':
      return 'triage';
    case 'write':
      return 'push';
    case 'maintain':
      return 'maintain';
    case 'admin':
      return 'admin';
  }
  throw new Error(`Attempted to convert unknown github access level "${accessLevel}"`);
};

export const gitHubPermissionsToSheriffLevel = (gitHubPermissions: {
  pull: boolean;
  triage?: boolean;
  push: boolean;
  maintain?: boolean;
  admin: boolean;
}): SheriffAccessLevel => {
  if (gitHubPermissions.admin) return 'admin';
  if (gitHubPermissions.maintain) return 'maintain';
  if (gitHubPermissions.push) return 'write';
  if (gitHubPermissions.triage) return 'triage';
  if (gitHubPermissions.pull) return 'read';
  throw new Error(
    `Attempted to convert unhandleable github permissions object "${JSON.stringify(
      gitHubPermissions,
    )}"`,
  );
};
