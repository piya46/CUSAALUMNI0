import { lstat, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, join } from 'node:path';

export const releaseRoots = [
  'app.cjs', 'package.json', 'package-lock.json', '.env.example', '.dockerignore', '.gitignore',
  'README.md', 'Dockerfile', 'compose.yaml', 'Caddyfile',
  'public', 'server/package.json', 'server/tsconfig.json', 'server/src', 'server/dist',
  'server/migrations', 'server/sql', 'web/package.json', 'web/tsconfig.json',
  'web/vite.config.ts', 'web/index.html', 'web/src', 'web/public', 'web/dist',
  'scripts', 'docs',
];
const extensions = new Set(['.cjs', '.mjs', '.js', '.ts', '.tsx', '.css', '.json', '.html', '.sql', '.md', '.py', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2', '.ttf']);
const denied = /(^|\/)(?:node_modules|var|releases|\.git|\.codex|\.agents|test-results|playwright-report)(\/|$)|(?:\.env(?:\..*)?$|\.(?:key|pem|enc|map|log|sql\.gz|tsbuildinfo)$)|service-account/i;

export async function collectReleaseFiles(root, roots = releaseRoots) {
  const files = [];
  async function walk(relative) {
    if (relative.split('/').some(part => part === '..' || part === '') || relative.startsWith('/')) throw new Error('Invalid release path');
    if (relative !== '.env.example' && denied.test(relative)) throw new Error(`Private or generated file inside release sources: ${relative}`);
    const info = await lstat(join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`Symlinks cannot enter a release: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(join(root, relative))).sort()) {
        if (entry === '.DS_Store' || entry.endsWith('.tsbuildinfo') || entry.endsWith('.map')) continue;
        await walk(`${relative}/${entry}`);
      }
    } else if (info.isFile()) {
      if (roots.includes(relative) || relative === 'public/.gitkeep' || extensions.has(extname(relative))) files.push(relative);
      else throw new Error(`Unexpected file type in release sources: ${relative}`);
    } else throw new Error(`Only regular files are allowed in a release: ${relative}`);
  }
  for (const relative of roots) await walk(relative);
  return [...new Set(files)].sort();
}

export function assertNoSecrets(content, secrets = []) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content.toString('utf8'))) throw new Error('Private key material detected in a release source');
  for (const secret of secrets) {
    if (secret.length >= 8 && content.includes(Buffer.from(secret))) throw new Error('A configured secret was detected in a release source');
  }
}

export async function releaseContent(root, file, secrets) {
  // Recheck immediately before reading: do not follow a replacement symlink.
  const handle = await open(join(root, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Release source changed during packaging');
    const content = await handle.readFile();
    assertNoSecrets(content, secrets);
    return content;
  } finally { await handle.close(); }
}
