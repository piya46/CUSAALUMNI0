import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseFiles, releaseContent } from './lib/release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let staging, archive;
try {
  if (process.argv.length > 2) throw new Error('This command accepts no arguments; it always builds production assets.');
  const zip = spawnSync('zip', ['-v'], { stdio: 'ignore' });
  if (zip.status !== 0) throw new Error('Install the zip command on the packaging computer.');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const build = spawnSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
  if (build.status !== 0) throw new Error('Production build failed; no deployment package was created.');
  const { parse } = createRequire(join(root, 'server/package.json'))('dotenv');
  const local = await readFile(join(root, '.env'), 'utf8').then(parse).catch(error => { if (error.code !== 'ENOENT') throw error; return {}; });
  const secretName = /^(LINE_LOGIN_CHANNEL_SECRET|LINE_MESSAGING_CHANNEL_SECRET|LINE_CHANNEL_ACCESS_TOKEN|FIREBASE_PRIVATE_KEY|DB_PASSWORD|SESSION_SECRET|ENCRYPTION_KEY|MFA_EVIDENCE_KEY|GOOGLE_CLIENT_SECRET|GMAIL_CLIENT_SECRET|GMAIL_REFRESH_TOKEN|GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY|INSTALL_TOKEN|REDIS_URL)$/;
  const secrets = [...Object.entries(local), ...Object.entries(process.env)]
    .filter(([key, value]) => secretName.test(key) && value).map(([, value]) => value);
  const output = join(root, 'releases');
  const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
  if (existing && !existing.isDirectory()) throw new Error('The releases path must be a regular directory, not a symlink.');
  await mkdir(output, { recursive: true, mode: 0o700 });
  staging = await mkdtemp(join(tmpdir(), 'cusa-release-'));
  const manifest = { format: 1, application: 'CUSA SSO', builtAt: new Date().toISOString(), files: [] };
  for (const file of await collectReleaseFiles(root)) {
    const content = await releaseContent(root, file, secrets);
    await mkdir(dirname(join(staging, file)), { recursive: true });
    await writeFile(join(staging, file), content, { flag: 'wx', mode: 0o644 });
    manifest.files.push({ path: file, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  await writeFile(join(staging, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  const name = `cusa-sso-${manifest.builtAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}.zip`;
  archive = join(output, name);
  const packed = spawnSync('zip', ['-q', '-X', '-r', archive, '.'], { cwd: staging, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (packed.status !== 0) throw new Error('ZIP creation failed.');
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${digest}  ${name}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ archive, sha256: digest, files: manifest.files.length, secretsIncluded: false, nodeModulesIncluded: false }, null, 2));
} catch (error) {
  if (archive) await rm(archive, { force: true }).catch(() => {});
  console.error(error instanceof Error ? error.message : 'Release packaging failed.');
  process.exitCode = 1;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
}
