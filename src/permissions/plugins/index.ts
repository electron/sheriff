import { Plugin } from './Plugin.js';

import { gsuitePlugin } from './gsuite/index.js';
import { slackPlugin } from './slack/index.js';
import { SHERIFF_PLUGINS } from '../../constants.js';

const enabledPlugins = SHERIFF_PLUGINS.split(',');

export const plugins: Plugin[] = [];

if (enabledPlugins.includes('gsuite')) {
  plugins.push(gsuitePlugin);
}

if (enabledPlugins.includes('slack')) {
  plugins.push(slackPlugin);
}
