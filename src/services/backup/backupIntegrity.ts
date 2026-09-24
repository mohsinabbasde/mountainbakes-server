import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import type { BackupVerifyCheck } from '../../shared';

/** SHA-256 of a file, streamed — never reads the whole dump into memory. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(filePath),
    new Writable({
      write(chunk, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest('hex');
}

export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

export interface ObjectHead {
  contentLength: number | undefined;
  etag: string | undefined;
  metadata: Record<string, string> | undefined;
}

/**
 * Compare what S3 reports for an object against what we computed locally (or
 * what the manifest recorded). Size is authoritative; the stored sha256
 * metadata must match too — S3 cannot recompute a SHA-256 for a multipart
 * object on request, so the checksum we write as metadata at upload time is
 * what a later verification compares against.
 */
export function compareObject(
  head: ObjectHead | null,
  expected: { size: number; sha256: string },
  label: string,
): BackupVerifyCheck[] {
  if (!head) return [{ name: `${label}: object exists`, ok: false, detail: 'HeadObject returned nothing' }];
  const checks: BackupVerifyCheck[] = [{ name: `${label}: object exists`, ok: true }];
  const size = head.contentLength ?? -1;
  checks.push({
    name: `${label}: size matches`,
    ok: size === expected.size,
    detail: size === expected.size ? `${size} bytes` : `S3 reports ${size} bytes, expected ${expected.size}`,
  });
  checks.push({ name: `${label}: non-empty`, ok: size > 0 });
  const storedSha = head.metadata?.sha256 ?? head.metadata?.['sha256'];
  checks.push({
    name: `${label}: checksum matches`,
    ok: storedSha === expected.sha256,
    detail: storedSha ? (storedSha === expected.sha256 ? 'sha256 metadata matches' : 'sha256 metadata differs') : 'no sha256 metadata on object',
  });
  return checks;
}
