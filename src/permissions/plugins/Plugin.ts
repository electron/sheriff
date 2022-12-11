import { MessageBuilder } from '../../MessageBuilder';
import { TeamConfig } from '../types';

export interface Plugin {
  handleTeam: (team: TeamConfig, builder: MessageBuilder) => Promise<void>;
}
