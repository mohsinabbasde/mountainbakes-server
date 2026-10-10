# Schema history

The SQL that built this database, one file per change, in the order it was
applied. It is kept for two reasons:

- **To read.** Each file's header says why the change was made. When a table, a
  trigger or a function looks odd, the explanation is here.
- **For the tests.** The integration tests in `src/services/__tests__` and the
  two in `tests/` run individual files in an in-memory Postgres to prove a
  function or trigger does what its header says.

Nothing applies these files to a database any more. The schema as it stands is
`prisma/migrations/0_baseline/migration.sql`, and changes from here on are new
folders under `prisma/migrations/`, applied with `pnpm exec prisma migrate
deploy` (see `infra/railway/README.md`, "Afterwards").

Some files mention roles (`anon`, `authenticated`, `service_role`), row-level
security and an `auth` schema. Those belonged to the hosted Postgres this
schema was first built on. The database the API serves from has no row-level
security and no `auth` schema: the API is its only client and authorises every
request itself.
