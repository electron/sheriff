export const SHERIFF_GITHUB_APP_CREDS = process.env.SHERIFF_GITHUB_APP_CREDS;
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'development';
export const SHERIFF_GIST_TOKEN = process.env.SHERIFF_GIST_TOKEN || '';
export const GITHUB_DEFAULT_BRANCH = 'main';
export const NPM_TRUSTED_PUBLISHER_DEFAULT_ENVIRONMENT = 'npm-trusted-publisher';
export const NPM_TRUSTED_PUBLISHER_GITHUB_APP_CLIENT_ID =
  process.env.NPM_TRUSTED_PUBLISHER_GITHUB_APP_CLIENT_ID;

export const PERMISSIONS_FILE_LOCAL_PATH = process.env.PERMISSIONS_FILE_LOCAL_PATH || '';

export const PERMISSIONS_FILE_ORG = process.env.PERMISSIONS_FILE_ORG!;
export const PERMISSIONS_FILE_REPO = process.env.PERMISSIONS_FILE_REPO || '.permissions';
export const PERMISSIONS_FILE_PATH = process.env.PERMISSIONS_FILE_PATH || 'config.yaml';
export const PERMISSIONS_FILE_REF = process.env.PERMISSIONS_FILE_REF || 'main';

export const SHERIFF_IMPORTANT_BRANCH = process.env.SHERIFF_IMPORTANT_BRANCH;

export const PORT = process.env.PORT || 8080;

export const SHERIFF_HOST_URL = process.env.SHERIFF_HOST_URL;

export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
export const SLACK_TOKEN = process.env.SLACK_TOKEN;

export const HEROKU_TOKEN = process.env.HEROKU_TOKEN;
export const HEROKU_MAGIC_ADMIN = process.env.HEROKU_MAGIC_ADMIN;

export const SHERIFF_PLUGINS = process.env.SHERIFF_PLUGINS || '';

export const GSUITE_CREDENTIALS = process.env.GSUITE_CREDENTIALS;
export const GSUITE_TOKEN = process.env.GSUITE_TOKEN;

export const SHERIFF_GSUITE_DOMAIN = process.env.SHERIFF_GSUITE_DOMAIN;
export const SHERIFF_SLACK_DOMAIN = process.env.SHERIFF_SLACK_DOMAIN;

export const SHERIFF_TRUSTED_RELEASERS = process.env.SHERIFF_TRUSTED_RELEASERS?.split(',').map(
  (s) => s.trim(),
);
// Used to allow automated releases that "follow" an upstream repo
export const SHERIFF_TRUSTED_RELEASER_POLICIES: {
  repository: string;
  releaser: string;
  mustMatchRepo: string;
  actions: string[];
}[] = JSON.parse(process.env.SHERIFF_TRUSTED_RELEASER_POLICIES || '[]');
export const SHERIFF_SELF_LOGIN = process.env.SHERIFF_SELF_LOGIN || null;
