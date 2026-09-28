import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { pool } from '../db.js';
import { exportAuditSnapshot } from '../models/auditModel.js';

interface Manifest {
  version: 1; format: 'cusa-audit-jsonl'; file: string; fromInclusive: string; toExclusive: string;
  exportedAt: string; rows: number; expectedRows: number; sha256: string;
}

function date(value: string | undefined): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Dates must use YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Invalid date');
  return parsed;
}

export async function archiveAudit(from: Date, to: Date, destination: string): Promise<Manifest> {
  if (to > new Date()) throw new Error('Archive end must be in the past');
  const output = resolve(destination);
  const partial = `${output}.partial`;
  const file = await open(partial, 'wx', 0o600);
  const digest = createHash('sha256');
  let result: { rows: number; expectedRows: number };
  try {
    result = await exportAuditSnapshot(from, to, async rows => {
      const chunk = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
      await file.writeFile(chunk, 'utf8');
      digest.update(chunk, 'utf8');
    });
    await file.sync();
  } finally { await file.close(); }
  const manifest: Manifest = {
    version: 1, format: 'cusa-audit-jsonl', file: basename(output),
    fromInclusive: from.toISOString(), toExclusive: to.toISOString(), exportedAt: new Date().toISOString(),
    ...result, sha256: digest.digest('hex'),
  };
  // Hard-link creation is exclusive; an existing archive is never overwritten.
  await link(partial, output);
  await unlink(partial);
  await writeFile(`${output}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return manifest;
}

export async function verifyArchive(destination: string): Promise<Manifest> {
  const output = resolve(destination);
  const manifest: Manifest = JSON.parse(await readFile(`${output}.manifest.json`, 'utf8'));
  const canonicalDate = (value: unknown): value is string => typeof value === 'string'
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (manifest.version !== 1 || manifest.format !== 'cusa-audit-jsonl' || manifest.file !== basename(output)
    || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.rows)
    || manifest.rows < 0 || manifest.expectedRows !== manifest.rows
    || !canonicalDate(manifest.fromInclusive) || !canonicalDate(manifest.toExclusive)
    || !canonicalDate(manifest.exportedAt) || manifest.fromInclusive >= manifest.toExclusive) {
    throw new Error('Invalid archive manifest');
  }
  const digest = createHash('sha256');
  let buffer = Buffer.alloc(0);
  let count = 0;
  let previous: { id: string; createdAt: string } | undefined;
  for await (const chunk of createReadStream(output)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    digest.update(bytes);
    buffer = Buffer.concat([buffer, bytes]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const row = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
      buffer = buffer.subarray(newline + 1);
      if (typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id) || !canonicalDate(row.createdAt)
        || row.createdAt < manifest.fromInclusive || row.createdAt >= manifest.toExclusive
        || (previous && (row.createdAt < previous.createdAt
          || (row.createdAt === previous.createdAt && row.id <= previous.id)))) {
        throw new Error('Archive contains an invalid interval or keyset ordering');
      }
      previous = row;
      count += 1;
    }
    if (buffer.length > 8 * 1024 * 1024) throw new Error('Archive record exceeds 8 MiB');
  }
  if (buffer.length || count !== manifest.rows || digest.digest('hex') !== manifest.sha256) {
    throw new Error('Archive checksum or row-count verification failed');
  }
  return manifest;
}

async function main() {
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' }, verify: { type: 'string' },
  } });
  if (values.verify) {
    const manifest = await verifyArchive(values.verify);
    console.log(JSON.stringify({ verified: true, ...manifest }, null, 2));
  } else {
    if (!values.out) throw new Error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD --out file.jsonl, or --verify file.jsonl');
    const manifest = await archiveAudit(date(values.from), date(values.to), values.out);
    console.log(JSON.stringify(manifest, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Audit archive failed');
    process.exitCode = 1;
  }).finally(() => pool.end());
}
