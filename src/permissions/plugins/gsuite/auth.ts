import * as readline from 'readline';
import { google } from 'googleapis';
import { GSUITE_CREDENTIALS, GSUITE_TOKEN } from '../../../constants';

const SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user',
  'https://www.googleapis.com/auth/admin.directory.group',
  'https://www.googleapis.com/auth/apps.groups.settings',
];

const credentials = JSON.parse(Buffer.from(GSUITE_CREDENTIALS!, 'base64').toString());

export function getAuthorizedClient() {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (!GSUITE_TOKEN) {
    throw new Error('Missing GSUITE_TOKEN environment variable');
  }
  oauth2Client.credentials = JSON.parse(Buffer.from(GSUITE_TOKEN!, 'base64').toString());
  return oauth2Client;
}

if (process.mainModule === module) {
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Generate token by visiting this url:', authUrl);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oauth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oauth2Client.credentials = token!;
      console.log('Token:\n\n');
      console.log(Buffer.from(JSON.stringify(token)).toString('base64'));
    });
  });
}
