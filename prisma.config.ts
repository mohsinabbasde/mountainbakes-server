import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Configuration for the Prisma CLI only (`db pull`, `generate`, `migrate`).
 * The running API never reads this file — it builds its own connection in
 * src/db/prisma.ts from DATABASE_URL.
 *
 * THE SCHEMA FILE IS READ FROM THE DATABASE, NEVER WRITTEN TO IT. The models
 * in prisma/schema.prisma are introspected (`pnpm prisma:pull`) and cannot
 * express the functions, triggers and partial indexes the application depends
 * on — so `prisma migrate dev` and `prisma db push`, which make the database
 * match the file, would remove them. Schema changes are hand-written SQL
 * migrations; the file is refreshed from the result. Names are left exactly as
 * they are in Postgres (snake_case, no @map), so a row read through Prisma has
 * the same keys the API already returns.
 *
 * DIRECT_DATABASE_URL, not DATABASE_URL: the CLI introspects and migrates,
 * which is an administrator's work, and DATABASE_URL is the API's own
 * restricted login.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DIRECT_DATABASE_URL'),
  },
});
