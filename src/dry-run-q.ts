import { Octokit } from '@octokit/rest';
import ansiToSvg from 'ansi-to-svg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PERMISSIONS_FILE_ORG,
  PERMISSIONS_FILE_PATH,
  PERMISSIONS_FILE_REPO,
  SHERIFF_GIST_TOKEN,
} from './constants.js';
import { spawn } from 'child_process';
import { getOctokit } from './octokit.js';

let jobQueue = Promise.resolve();

const SHERIFF_DRY_RUN_CHECK_NAME = 'Sheriff Dry Run';

export async function queueDryRun(octokit: Octokit, mergeSha: string | null, headSha: string) {
  if (!mergeSha) {
    await octokit.checks.create({
      repo: PERMISSIONS_FILE_REPO,
      owner: PERMISSIONS_FILE_ORG,
      name: SHERIFF_DRY_RUN_CHECK_NAME,
      head_sha: headSha,
      status: 'completed',
      conclusion: 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title: 'Dry Run Not Possible',
        summary: 'No merge sha available',
      },
    });
    return;
  }
  await octokit.checks.create({
    repo: PERMISSIONS_FILE_REPO,
    owner: PERMISSIONS_FILE_ORG,
    name: SHERIFF_DRY_RUN_CHECK_NAME,
    head_sha: headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });

  jobQueue = jobQueue
    .then(async () => {
      const configPath = path.resolve(os.tmpdir(), `sheriff-${mergeSha}-${headSha}.yaml`);
      const fileContent = await octokit.repos.getContent({
        repo: PERMISSIONS_FILE_REPO,
        owner: PERMISSIONS_FILE_ORG,
        ref: mergeSha,
        path: PERMISSIONS_FILE_PATH,
      });
      if (Array.isArray(fileContent.data)) {
        // Nah you bad
        throw new Error('wat');
      }

      await fs.promises.writeFile(
        configPath,
        // @ts-ignore - Octokit fails to type properties of ReposGetContentsResponse correctly.
        Buffer.from(fileContent.data.content || '', fileContent.data.encoding as any).toString(
          'utf8',
        ),
      );

      let out = '';
      const success = await new Promise<boolean>((resolve) => {
        const child = spawn(
          process.execPath,
          [path.resolve(import.meta.dirname, 'permissions', 'run.js')],
          {
            stdio: 'pipe',
            env: {
              ...process.env,
              PERMISSIONS_FILE_LOCAL_PATH: configPath,
              FORCE_COLOR: '2',
            },
          },
        );

        child.stdout.on('data', (d) => {
          out += d.toString();
        });
        child.stderr.on('data', (d) => {
          out += d.toString();
        });

        child.on('exit', (code, signal) => {
          if (signal !== null) return resolve(false); // Unknown error
          if (code === 0) return resolve(true); // We good
          resolve(false);
        });
      });

      const svg = ansiToSvg(out, {
        paddingTop: 16,
        paddingLeft: 16,
        paddingRight: 16,
        paddingBottom: 16,
      });
      const gistOctokit = new Octokit({
        auth: SHERIFF_GIST_TOKEN,
      });
      const gistData = await gistOctokit.gists.create({
        files: {
          ['out.svg']: {
            content: svg,
          },
        },
      });
      const svgUrl = gistData.data.files?.['out.svg']?.raw_url!;

      await octokit.checks.create({
        repo: PERMISSIONS_FILE_REPO,
        owner: PERMISSIONS_FILE_ORG,
        name: SHERIFF_DRY_RUN_CHECK_NAME,
        head_sha: headSha,
        status: 'completed',
        conclusion: success ? 'success' : 'failure',
        completed_at: new Date().toISOString(),
        output: {
          title: 'Dry Run Output',
          summary: success ? 'Looking good' : "Something isn't looking so hot",
          text: `<img src="${svgUrl}" width="800" />`,
        },
      });
    })
    .catch((err) => {
      console.error(err);
      return octokit.checks
        .create({
          repo: PERMISSIONS_FILE_REPO,
          owner: PERMISSIONS_FILE_ORG,
          name: SHERIFF_DRY_RUN_CHECK_NAME,
          head_sha: headSha,
          status: 'completed',
          conclusion: 'action_required',
          completed_at: new Date().toISOString(),
          output: {
            title: 'Dry Run Output',
            summary: 'Something went wrong :/',
          },
        })
        .catch(() => {})
        .then(() => {});
    });
}
