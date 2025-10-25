import { Plugin } from './Plugin.js';

import { githubPlugin } from './github/index.js';
import { gsuitePlugin } from './gsuite/index.js';
import { slackPlugin } from './slack/index.js';
import { SHERIFF_PLUGINS } from '../../constants.js';
import { herokuPlugin } from './heroku/index.js';

const enabledPlugins = SHERIFF_PLUGINS.split(',');

export const plugins: Plugin[] = [];

if (enabledPlugins.includes('github')) {
  plugins.push(githubPlugin);
}

if (enabledPlugins.includes('gsuite')) {
  plugins.push(gsuitePlugin);
}

if (enabledPlugins.includes('slack')) {
  plugins.push(slackPlugin);
}

if (enabledPlugins.includes('heroku')) {
  plugins.push(herokuPlugin);
}
