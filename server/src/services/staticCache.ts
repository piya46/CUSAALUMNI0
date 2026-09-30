import { basename, dirname, resolve } from 'node:path';

export function staticCachePolicy(file: string, webRoot: string): string {
  // Vite's content-hashed assets can be cached for a year; unversioned HTML,
  // policies and documents must be revalidated after a deployment.
  const hashed = dirname(resolve(file)) === resolve(webRoot, 'assets')
    && /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|jpe?g|webp|svg)$/.test(basename(file));
  return hashed ? 'public, max-age=31536000, immutable' : 'no-cache';
}
