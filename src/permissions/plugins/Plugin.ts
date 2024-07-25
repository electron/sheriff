import { MessageBuilder } from '../../MessageBuilder.js';
import { TeamConfig } from '../types.js';

export interface Plugin {
  handleTeam: (team: TeamConfig, builder: MessageBuilder) => Promise<void>;
}
