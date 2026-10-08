-- 148: a photo on every branch return, and a way to clean up the ones that were
-- uploaded for a return that never happened.
--
-- ─── 1. Where the photo hangs ────────────────────────────────────────────────
-- One Save Return creates one `production_returns` row PER PRODUCT, but the
-- branch takes ONE picture of the tray. `attachments.entity_id` can name only
-- one parent, so the link runs the other way: every row of the submission
-- carries the attachment's id. The attachment itself is bound (entity
-- 'branch_return') to the first row of the submission, which is what makes it
-- immutable and takes it out of the staged set.
--
-- Nullable, and it stays nullable: returns raised before this migration have no
-- photo, and neither do the ones Production records itself. The rule that a NEW
-- branch return must carry one lives in the API (POST /api/stock/return), where
-- it can say so in words.
--
-- No ON DELETE action is needed. A bound attachment can never be deleted (below),
-- and a staged one is never referenced from here — the route binds in the same
-- request that writes this column.
alter table production_returns
  add column if not exists photo_attachment_id uuid references attachments (id);

-- The reverse lookup ("is this photo used by a return?") is what the cleanup
-- path asks before it removes anything.
create index if not exists production_returns_photo_idx
  on production_returns (photo_attachment_id)
  where photo_attachment_id is not null;

-- ─── 2. Staged photos may be deleted; bound ones still may not ───────────────
-- Migration 67 refused every DELETE on `attachments`, which was right for the
-- flows that existed: a photo was only ever uploaded by someone about to submit
-- the form in front of them, and the occasional abandoned one was noise.
--
-- A return photo is different in volume, not in kind — one per return, every
-- branch, every evening, on a storage plan with a ceiling — so an upload whose
-- return was then refused has to be removable. What makes that safe is the line
-- 67 already drew: a row with `entity_id IS NULL` is STAGED and belongs to
-- nothing. No document cites it and no screen reads it. Deleting it removes no
-- one's evidence.
--
-- A BOUND attachment is exactly as immutable as before. The audit-trail
-- guarantee is about those, and this does not touch it.
create or replace function app.attachments_immutable() returns trigger
  language plpgsql
  as $$
  begin
    if tg_op = 'DELETE' then
      if old.entity_id is null then
        return old;
      end if;
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
