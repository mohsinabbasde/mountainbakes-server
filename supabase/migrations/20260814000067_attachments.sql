-- 67: photo attachments for finance documents and branch demands.
--
-- One table for every attachment site rather than an `attachment_url` column on
-- each document table. Two reasons:
--
--   1. The ledger has to render the photo behind a posted voucher, and a
--      `ledger_entries` row identifies its origin only as (source_type,
--      source_id). A generic (entity, entity_id) table is therefore a single
--      indexed lookup from the ledger; per-table columns would be a union of
--      five outer joins that grows every time a document type is added.
--   2. `ledger_entries` is immutable by trigger (migration 52) and deliberately
--      so. Hanging the photo off the ledger row would mean either widening that
--      trigger's guarded tuple or leaving a mutable column on an append-only
--      book. The photo belongs to the *document*, which is what the ledger
--      already points at.
--
-- ---------------------------------------------------------------------------
-- The staged → bound lifecycle
-- ---------------------------------------------------------------------------
-- A photo is required on the SAME request that creates its parent, so it has to
-- be uploaded before the parent row exists and therefore before its id is known.
-- The upload endpoint writes a row with `entity_id IS NULL` ("staged"), and the
-- create handler binds it — sets entity_id, stamps bound_at — inside the same
-- handler that inserts the parent.
--
-- A staged row is claimable ONLY by the uploader (see bindAttachments), which is
-- what stops one user's create request from binding a photo another user
-- uploaded. Staged rows that are never bound are orphans; `attachments_orphan_idx`
-- exists so a future sweep can find them cheaply. Nothing deletes them today —
-- an orphan is a few hundred KB and losing a real photo to an over-eager sweep
-- is much worse than keeping it.

create type attachment_entity as enum (
  'finance_transaction',
  'partner_expense',
  'branch_share_payment',
  'salary_payment',
  'finance_income_approval',
  'production_order_demand',
  'production_order_verification'
);

create table attachments (
  id               uuid primary key default gen_random_uuid(),
  entity           attachment_entity not null,
  -- Null while staged. There is no FK: the target table is chosen by `entity`,
  -- so no single column can reference it. Deleting a parent leaves the row
  -- behind, which is intentional for a finance audit trail.
  entity_id        uuid,
  storage_path     text not null unique,
  mime_type        text not null,
  size_bytes       integer not null check (size_bytes > 0),
  width            integer,
  height           integer,
  uploaded_by      uuid references users (id) on delete set null,
  uploaded_by_name text,
  bound_at         timestamptz,
  created_at       timestamptz not null default now()
);

create index attachments_entity_idx on attachments (entity, entity_id)
  where entity_id is not null;

-- Partial index over the staged rows only — the orphan sweep's working set.
create index attachments_orphan_idx on attachments (created_at)
  where entity_id is null;

-- ---------------------------------------------------------------------------
-- Immutability.
--
-- Binding is the one permitted state change, and it happens exactly once. Once
-- entity_id is set, nothing about the row may change again: a receipt that can
-- be re-pointed at a different voucher after the fact is not evidence of
-- anything. Deletes are refused for the same reason the ledger refuses them.
-- ---------------------------------------------------------------------------
create or replace function app.attachments_immutable() returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'DELETE' then
      raise exception
        'attachment % cannot be deleted. A document''s supporting photo is part of '
        'its audit trail.', old.id;
    end if;

    if old.entity_id is not null then
      raise exception
        'attachment % is already bound to %/% and is immutable.',
        old.id, old.entity, old.entity_id;
    end if;

    if (new.entity, new.storage_path, new.mime_type, new.size_bytes, new.uploaded_by)
       is distinct from
       (old.entity, old.storage_path, old.mime_type, old.size_bytes, old.uploaded_by)
    then
      raise exception
        'attachment % may only have entity_id and bound_at set; the file itself is '
        'immutable.', old.id;
    end if;

    return new;
  end;
  $$;

create trigger attachments_immutable
  before update or delete on attachments
  for each row execute function app.attachments_immutable();

-- ---------------------------------------------------------------------------
-- RLS.
--
-- Every read and write in the app goes through the API on the service-role key,
-- which bypasses RLS entirely — these policies exist so that a leaked anon key
-- cannot enumerate the table, not as the app's authorization model. That is
-- enforced in the route handlers, same as everywhere else in this schema.
-- ---------------------------------------------------------------------------
alter table attachments enable row level security;

create policy attachments_read on attachments
  for select to authenticated
  using (
    -- Finance documents: the finance readers. Operational documents (demands,
    -- verifications): any signed-in staff member, matching who can already see
    -- the demand itself.
    case
      when entity in ('finance_transaction', 'partner_expense', 'branch_share_payment',
                      'salary_payment', 'finance_income_approval')
        then app.can_read_finance()
      else true
    end
  );

-- ---------------------------------------------------------------------------
-- Storage bucket.
--
-- PRIVATE, unlike `branding` (migration 10). The logo had to be public because
-- its URL is persisted and rendered pre-login on printed receipts; these are
-- expense receipts and delivery photos, which are only ever shown to an
-- authenticated user inside the app. The API mints a short-lived signed URL at
-- read time (see attachments.service.ts) — an <img src> cannot carry a Bearer
-- token, so a signed URL is what makes a private bucket usable from the browser.
--
-- The size limit is 5 MB as a backstop only. The client downscales and
-- re-encodes every capture to roughly 100-300 KB before it is ever uploaded
-- (compressImage in the frontend's lib/attachments.ts) and the API rejects
-- anything over 5 MB before it reaches storage; the bucket limit is the third
-- line of defence, not the first.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments',
  'attachments',
  false,
  5242880,  -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Reads are served through API-minted signed URLs, which are issued by the
-- service-role key and do not consult these policies. Direct authenticated
-- reads are allowed as well so an internal tool can browse the bucket; writes
-- are not, because every upload must go through the endpoint that records the
-- row above. A file in the bucket with no `attachments` row is invisible to the
-- app and would be an orphan nothing can account for.
create policy attachments_authenticated_read on storage.objects
  for select to authenticated
  using (bucket_id = 'attachments');
