import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { BackupError } from './errors';
import { redactSecrets } from './backupConfig';

/**
 * pg_dump, driven as a child process. The connection is handed over through
 * the libpq environment (PGHOST/PGUSER/PGPASSWORD/…) rather than as an argv
 * URL, so the password never appears in `ps` output or a crash log. Stderr is
 * captured (capped) and redacted before it is attached to any error.
 *
 * Scope of the two archives a backup consists of (see docs/database-backup.md):
 *   MAIN  --schema=public --schema=app --schema=supabase_migrations
 *   AUTH  --table=auth.users --table=auth.identities
 */

export type SpawnFn = typeof nodeSpawn;

export const MAIN_SCHEMAS = ['public', 'app', 'supabase_migrations'] as const;
export const AUTH_TABLES = ['auth.users', 'auth.identities'] as const;
/** What the dumps deliberately leave out. Recorded in every manifest. */
export const EXCLUDED_SCOPE = [
  'auth.* except users/identities (sessions, refresh_tokens, mfa_*, audit_log_entries, flow_state, one_time_tokens)',
  'storage schema (object metadata) and the Supabase Storage files themselves',
  'extensions, vault, pgsodium, net, realtime, graphql, supabase_functions schemas',
  'Supabase project settings, Auth provider config, Edge Functions, Realtime config',
  'database roles and their login credentials (pg_dumpall --roles-only is not run)',
] as const;

export interface PgDeps {
  spawn?: SpawnFn;
  pgBinDir: string | null;
  log?: (line: string) => void;
  secrets?: string[];
}

export interface DumpSpec {
  dbUrl: string;
  outFile: string;
  schemas?: readonly string[];
  tables?: readonly string[];
  schemaOnly?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DumpResult {
  bytes: number;
  durationMs: number;
  /** argv actually used (safe: contains no credentials). */
  argv: string[];
}

export function resolvePgBinary(name: 'pg_dump' | 'pg_restore' | 'psql', pgBinDir: string | null): string {
  return pgBinDir ? path.join(pgBinDir, name) : name;
}

/** libpq environment for a connection string. Query params like sslmode are honoured. */
export function pgConnectionEnv(dbUrl: string): Record<string, string> {
  let u: URL;
  try {
    u = new URL(dbUrl);
  } catch {
    throw new BackupError('CONFIG_INVALID', 'SUPABASE_DB_URL is not a valid URL');
  }
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
    PGSSLMODE: u.searchParams.get('sslmode') || 'require',
    PGCONNECT_TIMEOUT: '30',
  };
  const options = u.searchParams.get('options');
  if (options) env.PGOPTIONS = options;
  return env;
}

export function buildPgDumpArgs(spec: Pick<DumpSpec, 'outFile' | 'schemas' | 'tables' | 'schemaOnly'>): string[] {
  const args = ['--format=custom', '--compress=6', '--no-sync', '--no-publications', '--no-subscriptions', '--file', spec.outFile];
  if (spec.schemaOnly) args.push('--schema-only');
  for (const s of spec.schemas ?? []) args.push(`--schema=${s}`);
  for (const t of spec.tables ?? []) args.push(`--table=${t}`);
  return args;
}

function connectionFailure(stderr: string): boolean {
  return /could not connect|connection refused|could not translate host name|password authentication failed|timeout expired|server closed the connection unexpectedly|SSL SYSCALL error|Connection timed out|no pg_hba\.conf entry|Network is unreachable|No route to host/i.test(stderr);
}

interface RunOptions {
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  label: string;
}

/** Run one pg binary to completion, returning captured stdout/stderr. */
export async function runPgProcess(
  binary: string,
  opts: RunOptions,
  deps: PgDeps,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; durationMs: number }> {
  const spawn = deps.spawn ?? nodeSpawn;
  const started = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(binary, opts.argv, { env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new BackupError('PG_DUMP_FAILED', `could not start ${opts.label}: ${redactSecrets(String(err), deps.secrets)}`);
  }

  const MAX_CAPTURE = 64 * 1024;
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8');
  });

  let timedOut = false;
  let aborted = false;
  const kill = () => {
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  timer.unref();
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new BackupError('PG_DUMP_FAILED', `could not run ${opts.label} (${binary}): ${redactSecrets(err.message, deps.secrets)}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  }).finally(() => opts.signal?.removeEventListener('abort', onAbort));

  const durationMs = Date.now() - started;
  const safeStderr = redactSecrets(stderr.trim(), deps.secrets);
  if (aborted) throw new BackupError('INTERRUPTED', `${opts.label} was interrupted (SIGTERM/SIGINT)`);
  if (timedOut) throw new BackupError('PG_DUMP_FAILED', `${opts.label} exceeded ${opts.timeoutMs}ms and was killed`);
  if (exit.code !== 0) {
    const category = connectionFailure(safeStderr) ? 'DB_CONNECTION_FAILED' : 'PG_DUMP_FAILED';
    throw new BackupError(category, `${opts.label} exited with code ${exit.code ?? exit.signal}: ${safeStderr || '(no stderr)'}`, {
      retryable: category === 'DB_CONNECTION_FAILED',
    });
  }
  return { ...exit, stdout: redactSecrets(stdout, deps.secrets), stderr: safeStderr, durationMs };
}

/** `pg_dump (PostgreSQL) 17.6 …` → '17.6' */
export async function getPgDumpVersion(deps: PgDeps): Promise<string> {
  const bin = resolvePgBinary('pg_dump', deps.pgBinDir);
  const res = await runPgProcess(bin, { argv: ['--version'], env: {}, timeoutMs: 15_000, label: 'pg_dump --version' }, deps);
  const m = /(\d+(?:\.\d+)*)/.exec(res.stdout);
  if (!m) throw new BackupError('PG_DUMP_FAILED', `could not parse pg_dump version from "${res.stdout.trim()}"`);
  return m[1];
}

/**
 * Connectivity probe: a schema-only dump of the tiny supabase_migrations
 * schema. One call proves the binary, the credentials, the pooler and the
 * client/server version compatibility (pg_dump refuses a server newer than
 * itself) before the real dump starts.
 */
export async function probeConnection(dbUrl: string, tmpDir: string, deps: PgDeps): Promise<{ durationMs: number }> {
  const bin = resolvePgBinary('pg_dump', deps.pgBinDir);
  const outFile = path.join(tmpDir, 'probe.dump');
  const argv = buildPgDumpArgs({ outFile, schemas: ['supabase_migrations'], schemaOnly: true });
  const res = await runPgProcess(bin, { argv, env: pgConnectionEnv(dbUrl), timeoutMs: 60_000, label: 'connection probe' }, deps);
  return { durationMs: res.durationMs };
}

export async function runPgDump(spec: DumpSpec, deps: PgDeps): Promise<DumpResult> {
  const bin = resolvePgBinary('pg_dump', deps.pgBinDir);
  const argv = buildPgDumpArgs(spec);
  const res = await runPgProcess(
    bin,
    { argv, env: pgConnectionEnv(spec.dbUrl), timeoutMs: spec.timeoutMs, signal: spec.signal, label: `pg_dump ${path.basename(spec.outFile)}` },
    deps,
  );
  let bytes = 0;
  try {
    bytes = (await stat(spec.outFile)).size;
  } catch {
    throw new BackupError('PG_DUMP_FAILED', `pg_dump exited 0 but ${path.basename(spec.outFile)} is missing`);
  }
  if (bytes === 0) throw new BackupError('DUMP_EMPTY', `${path.basename(spec.outFile)} is empty`);
  return { bytes, durationMs: res.durationMs, argv };
}
