export const ORGANIZATION_NAME = process.env.ORGANIZATION_NAME || 'electron';
export const REPO_NAME = process.env.REPO_NAME || 'electron';

export const SHERIFF_GITHUB_APP_CREDS = process.env.SHERIFF_GITHUB_APP_CREDS;
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || 'development';

export const PERMISSIONS_FILE_ORG = process.env.PERMISSIONS_FILE_ORG;
export const PERMISSIONS_FILE_REPO = process.env.PERMISSIONS_FILE_REPO || '.permissions';
export const PERMISSIONS_FILE_PATH = process.env.PERMISSIONS_FILE_PATH || 'config.yaml';

export const SHERIFF_IMPORTANT_BRANCH = process.env.SHERIFF_IMPORTANT_BRANCH;

export const AUTO_TUNNEL_NGROK = process.env.AUTO_TUNNEL_NGROK;
export const PORT = process.env.PORT || 8080;

export const SHERIFF_HOST_URL = process.env.SHERIFF_HOST_URL;

export const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
export const SLACK_TOKEN = process.env.SLACK_TOKEN;

export const SHERIFF_PLUGINS = process.env.SHERIFF_PLUGINS || '';

export const GSUITE_CREDENTIALS = process.env.GSUITE_CREDENTIALS;
export const GSUITE_TOKEN = process.env.GSUITE_TOKEN;

export const SHERIFF_GSUITE_DOMAIN = process.env.SHERIFF_GSUITE_DOMAIN;
export const SHERIFF_SLACK_DOMAIN = process.env.SHERIFF_SLACK_DOMAIN;
