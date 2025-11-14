import { MessageBuilder } from '../../MessageBuilder.js';
import { RepositoryConfig, TeamConfig } from '../types.js';

export type RepoOwner = {
  org: string;
  enterprise: string;
};

export interface Plugin {
  handleTeam?: (team: TeamConfig, builder: MessageBuilder) => Promise<void>;
  handleRepo?: (
    repo: RepositoryConfig,
    teams: TeamConfig[],
    owner: RepoOwner,
    builder: MessageBuilder,
  ) => Promise<void>;
}
