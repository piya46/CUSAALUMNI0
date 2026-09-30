import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

// Resolve an existing ancestor before creating anything. This also catches a
// public directory that the host has symlinked to a different physical path.
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const entry = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink()) throw new Error('Dangling evidence directory symlink');
    const parent = dirname(path);
    if (parent === path) throw new Error('Cannot resolve evidence directory');
    return join(await canonicalPath(parent), path.slice(parent.length).replace(/^[/\\]+/, ''));
  }
}

export async function resolveEvidenceDirectory(folder: string, applicationRoot: string): Promise<string> {
  const root = await canonicalPath(resolve(applicationRoot));
  const actual = await canonicalPath(resolve(folder));
  if (actual === root || root.startsWith(actual.endsWith(sep) ? actual : actual + sep)) {
    throw new Error('Use a dedicated private evidence directory');
  }
  for (const name of ['public', 'web/public', 'web/dist', 'server/dist']) {
    const unsafe = await canonicalPath(resolve(root, name));
    if (actual === unsafe || actual.startsWith(unsafe + sep)) {
      throw new Error('Evidence directory must be outside public roots');
    }
  }
  return actual;
}
