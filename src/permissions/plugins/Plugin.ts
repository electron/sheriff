import { MessageBuilder } from '../../MessageBuilder';

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

export interface Plugin {
  handleTeam: (team: TeamConfig, builder: MessageBuilder) => Promise<void>;
}
