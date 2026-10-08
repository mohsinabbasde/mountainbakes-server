import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pgConnectionEnv } from '../../src/services/backup/postgresBackup';

/**
 * Generate the credentials the Railway stack runs on, and give the two service
 * roles in the database their passwords.
 *
 *   pnpm railway:secrets            create them (or re-apply the ones on file)
 *   pnpm railway:secrets --rotate   throw the old ones away and make new ones
 *
 * Writes infra/railway/.secrets.env (git-ignored, mode 600) and prints only
 * where it is — never a secret. That file is then the single place to copy
 * values from into Railway, Heroku and the two client builds.
 *
 * WHAT IS GENERATED
 *   JWT_SECRET               signs every token. Shared by the Auth server
 *                            (which issues them) and PostgREST (which checks them).
 *   SERVICE_ROLE_KEY         a token for role `service_role` — the API's key.
 *                            Whoever holds it has the whole database.
 *   ANON_KEY                 a token for role `anon` — the key the browser and
 *                            the phone send. It opens nothing in the database
 *                            (see post-restore.sql); the Auth server needs a
 *                            caller to present *a* key, and this is it.
 *   AUTHENTICATOR_PASSWORD   PostgREST's database login.
 *   AUTH_ADMIN_PASSWORD      the Auth server's database login.
 *
 * RE-RUNNING without --rotate re-applies the passwords already on file. That is
 * what a fresh `railway:migrate --reset-target` needs: the roles survive the
 * wipe, so nothing changes, but it is safe to run either way.
 *
 * --rotate on a live system signs every user out and stops both services until
 * their variables are updated. It is for a leak, not for routine.
 */

const FILE = path.join(__dirname, '.secrets.env');
const TEN_YEARS = 10 * 365 * 24 * 60 * 60;

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

function signJwt(claims: Record<string, unknown>, secret: string): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** URL-safe, so it can sit in a connection string without escaping. */
const password = () => randomBytes(24).toString('base64url');

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** SQL goes in on stdin, so a password never appears in the process list. */
function psqlStdin(env: Record<string, string>, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    child.on('error', (e) => reject(new Error(`could not start psql: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`psql failed: ${err.trim().split('\n')[0]}`))));
    child.stdin.end(sql);
  });
}

async function main() {
  const rotate = process.argv.includes('--rotate');
  const target = (process.env.RAILWAY_DB_URL || process.env.DATABASE_URL || '').trim();
  if (!target) throw new Error('RAILWAY_DB_URL (or DATABASE_URL) is required');
  const targetEnv = pgConnectionEnv(target);
  if (!new URL(target).searchParams.get('sslmode')) targetEnv.PGSSLMODE = 'prefer';
  if (/supabase/i.test(targetEnv.PGHOST)) throw new Error('The target host is Supabase. Refusing.');

  const onFile = existsSync(FILE) && !rotate ? parseEnvFile(await readFile(FILE, 'utf8')) : {};
  const reused = Boolean(onFile.JWT_SECRET);

  const jwtSecret = onFile.JWT_SECRET || randomBytes(48).toString('base64url');
  const authenticatorPassword = onFile.AUTHENTICATOR_PASSWORD || password();
  const authAdminPassword = onFile.AUTH_ADMIN_PASSWORD || password();
  const iat = Math.floor(Date.now() / 1000);
  const key = (role: string) => signJwt({ role, iss: 'mountainbakes', iat, exp: iat + TEN_YEARS }, jwtSecret);
  const serviceRoleKey = onFile.SERVICE_ROLE_KEY || key('service_role');
  const anonKey = onFile.ANON_KEY || key('anon');

  // Passwords are base64url, so there is nothing in them for a quote to end.
  await psqlStdin(
    targetEnv,
    `alter role authenticator login password '${authenticatorPassword}';
     alter role supabase_auth_admin login password '${authAdminPassword}';`,
  );

  const db = targetEnv.PGDATABASE;
  await writeFile(
    FILE,
    `# Mountain Bakes — Railway stack credentials. NEVER COMMIT. Generated ${new Date().toISOString()}
# Regenerate with: pnpm railway:secrets --rotate   (signs everyone out)

JWT_SECRET=${jwtSecret}
SERVICE_ROLE_KEY=${serviceRoleKey}
ANON_KEY=${anonKey}
AUTHENTICATOR_PASSWORD=${authenticatorPassword}
AUTH_ADMIN_PASSWORD=${authAdminPassword}

# ── Where each value goes ──────────────────────────────────────────────────
# Railway · postgrest service      (rest of its variables: postgrest.env.example)
#   PGRST_DB_URI=postgres://authenticator:${authenticatorPassword}@\${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${db}
#   PGRST_JWT_SECRET=${jwtSecret}
#
# Railway · auth service           (rest of its variables: gotrue.env.example)
#   GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${authAdminPassword}@\${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/${db}
#   GOTRUE_JWT_SECRET=${jwtSecret}
#
# Heroku · the API                 (<gateway> = the gateway service's public domain)
#   SUPABASE_URL=https://<gateway>
#   SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}
#
# Web build (frontend/.env.production)
#   NEXT_PUBLIC_SUPABASE_URL=https://<gateway>
#   NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}
#
# Mobile build (mobile/.env.production)
#   SUPABASE_URL=https://<gateway>
#   SUPABASE_ANON_KEY=${anonKey}
`,
    { mode: 0o600 },
  );
  await chmod(FILE, 0o600);

  console.log(`[secrets] ${reused ? 're-applied the credentials on file' : rotate ? 'ROTATED — every service and client needs the new values' : 'generated new credentials'}`);
  console.log(`[secrets] database roles authenticator and supabase_auth_admin can now log in to ${targetEnv.PGHOST}/${db}`);
  console.log(`[secrets] written to ${path.relative(process.cwd(), FILE)} (mode 600, git-ignored). Nothing secret was printed.`);
}

main().catch((err) => {
  console.error('[secrets]', err instanceof Error ? err.message : err);
  process.exit(1);
});
