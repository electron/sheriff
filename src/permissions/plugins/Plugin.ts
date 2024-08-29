import { MessageBuilder } from '../../MessageBuilder.js';
import { RepositoryConfig, TeamConfig } from '../types.js';

export interface Plugin {
  handleTeam?: (team: TeamConfig, builder: MessageBuilder) => Promise<void>;
  handleRepo?: (
    repo: RepositoryConfig,
    teams: TeamConfig[],
    builder: MessageBuilder,
  ) => Promise<void>;
}
