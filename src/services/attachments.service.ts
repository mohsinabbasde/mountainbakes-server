import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_ENTITY,
  ATTACHMENT_URL_TTL_SECONDS,
  type Attachment,
  type AttachmentEntity,
} from '../shared';
import { rowToApi } from '../utils/case';

/**
 * Photo attachments — upload, bind, and read-time URL signing.
 *
 * Three things about this module are load-bearing:
 *
 *   1. **The bucket is private.** Nothing here ever returns a storage path to a
 *      client; it returns a signed URL with a one-hour life. `<img src>` cannot
 *      send an Authorization header, so a signed URL is the only way a private
 *      object renders in the browser — and the expiry is the point, since these
 *      are expense receipts and delivery photos.
 *   2. **Upload precedes the parent row.** A photo is required on the same
 *      request that creates its document, so it cannot be uploaded with the
 *      parent's id. `uploadAttachment` writes a STAGED row (entity_id null);
 *      `bindAttachments` claims it once the parent exists. See migration 67.
 *   3. **Signing is batched.** `createSignedUrls` takes a list; a ledger page of
 *      100 entries must not become 100 round-trips to Storage.
 */

const BUCKET = 'attachments';

/** Extension from the SNIFFED mimetype, never from the client's filename —
 *  same reasoning as the logo upload in settings.routes.ts. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

interface AttachmentRow {
  id: string;
  entity: AttachmentEntity;
  entityId: string | null;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string;
}

const SELECT =
  'id, entity, entity_id, storage_path, mime_type, size_bytes, width, height, uploaded_by, uploaded_by_name, created_at';

function clientError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

/**
 * Mint short-lived URLs for a batch of rows.
 *
 * A row whose signing fails is dropped rather than throwing: a finance page that
 * 500s because one storage object went missing is worse than the same page
 * showing four photos instead of five. The failure is logged so it is not
 * silent.
 */
async function signRows(rows: AttachmentRow[]): Promise<Attachment[]> {
  if (rows.length === 0) return [];

  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrls(rows.map((r) => r.storagePath), ATTACHMENT_URL_TTL_SECONDS);
  if (error) throw error;

  // Each result carries its own `path` and its own `error`. Keyed by the
  // returned path rather than by array index: the index only lines up if the
  // response preserves request order, and a silent reordering would attach one
  // document's receipt to another — the one failure mode this feature must not
  // have. `path` is only absent on a malformed response, hence the fallback.
  const urlByPath = new Map<string, string>();
  (data ?? []).forEach((d, i) => {
    const path = d.path ?? rows[i]?.storagePath;
    if (!path) return;
    if (d.error || !d.signedUrl) {
      console.warn(`[attachments] could not sign ${path}:`, d.error ?? 'no URL returned');
      return;
    }
    urlByPath.set(path, d.signedUrl);
  });

  return rows.flatMap((r) => {
    const url = urlByPath.get(r.storagePath);
    if (!url) return [];
    return [
      {
        id: r.id,
        entity: r.entity,
        entityId: r.entityId,
        url,
        mimeType: r.mimeType,
        sizeBytes: Number(r.sizeBytes),
        width: r.width,
        height: r.height,
        uploadedBy: r.uploadedBy,
        uploadedByName: r.uploadedByName,
        createdAt: r.createdAt,
      },
    ];
  });
}

/**
 * Store one captured photo and stage it against `entity`.
 *
 * The returned attachment's `id` is what the caller puts in the create request's
 * `attachmentIds`. Until that happens the row is an orphan and belongs to
 * nothing.
 */
export async function uploadAttachment(input: {
  entity: AttachmentEntity;
  buffer: Buffer;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  actor: { uid: string; email: string };
}): Promise<Attachment> {
  const extension = EXTENSIONS[input.mimeType];
  if (!extension) {
    throw clientError('A photo must be a JPEG, PNG or WebP image', 400);
  }
  if (input.buffer.length > ATTACHMENT_MAX_BYTES) {
    throw clientError('That photo is too large. Retake it and try again.', 413);
  }

  // Foldered by entity so the bucket stays browsable, named by UUID so nothing
  // about the path is guessable or derived from user input.
  const storagePath = `${input.entity}/${randomUUID()}.${extension}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(storagePath, input.buffer, { contentType: input.mimeType });
  if (uploadErr) throw uploadErr;

  const { data, error } = await supabaseAdmin
    .from('attachments')
    .insert({
      entity: input.entity,
      storage_path: storagePath,
      mime_type: input.mimeType,
      size_bytes: input.buffer.length,
      width: input.width ?? null,
      height: input.height ?? null,
      uploaded_by: input.actor.uid,
      uploaded_by_name: input.actor.email,
    })
    .select(SELECT)
    .single();

  if (error) {
    // The row is what makes the file findable; a file with no row is invisible
    // to the app forever. Roll the upload back rather than leaving one behind.
    const { error: cleanupErr } = await supabaseAdmin.storage.from(BUCKET).remove([storagePath]);
    if (cleanupErr) {
      console.warn(`[attachments] orphaned ${storagePath} after a failed insert:`, cleanupErr.message);
    }
    throw error;
  }

  const [signed] = await signRows([rowToApi<AttachmentRow>(data)]);
  if (!signed) throw new Error('Photo was stored but could not be read back');
  return signed;
}

/**
 * Claim staged attachments for a freshly created document.
 *
 * The `.is('entity_id', null)` and `.eq('uploaded_by', ...)` predicates are the
 * security of this whole flow, not defensive noise:
 *
 *   * `entity_id is null` makes binding a one-shot. An id already bound to
 *     voucher A cannot be re-bound to voucher B, so a receipt cannot be made to
 *     support two payments.
 *   * `uploaded_by = actor` stops one user's create request from claiming a
 *     photo another user uploaded. Attachment ids are UUIDs and not enumerable,
 *     but "unguessable" is not an authorization model.
 *   * `entity = <expected>` stops a demand photo being passed off as an expense
 *     receipt.
 *
 * Anything that fails those predicates simply does not update, so the count
 * comes back short and this throws. Callers run it AFTER inserting the parent;
 * a throw therefore leaves a parent row with no photo, which is why every caller
 * validates the ids are present before it starts writing.
 */
export async function bindAttachments(input: {
  entity: AttachmentEntity;
  entityId: string;
  attachmentIds: string[];
  actor: { uid: string };
}): Promise<Attachment[]> {
  const ids = [...new Set(input.attachmentIds)];
  if (ids.length === 0) return [];
  if (ids.length > ATTACHMENT_MAX_PER_ENTITY) {
    throw clientError(`At most ${ATTACHMENT_MAX_PER_ENTITY} photos may be attached`, 400);
  }

  const { data, error } = await supabaseAdmin
    .from('attachments')
    .update({ entity_id: input.entityId, bound_at: new Date().toISOString() })
    .in('id', ids)
    .eq('entity', input.entity)
    .eq('uploaded_by', input.actor.uid)
    .is('entity_id', null)
    .select(SELECT);
  if (error) throw error;

  const bound = rowToApi<AttachmentRow[]>(data ?? []);
  if (bound.length !== ids.length) {
    throw clientError(
      'One of the attached photos is no longer available. Retake it and submit again.',
      409,
    );
  }
  return signRows(bound);
}

/**
 * Photos for one parent, newest last.
 *
 * Prefer `listAttachmentsFor` when reading more than one parent — this issues a
 * query and a signing call per call site.
 */
export async function listAttachments(
  entity: AttachmentEntity,
  entityId: string,
): Promise<Attachment[]> {
  const byId = await listAttachmentsFor(entity, [entityId]);
  return byId.get(entityId) ?? [];
}

/**
 * Photos for many parents of the SAME entity, keyed by parent id.
 *
 * One query and one signing call regardless of how many parents — this is what
 * a list endpoint should use.
 */
export async function listAttachmentsFor(
  entity: AttachmentEntity,
  entityIds: string[],
): Promise<Map<string, Attachment[]>> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  const byParent = new Map<string, Attachment[]>();
  if (ids.length === 0) return byParent;

  const { data, error } = await supabaseAdmin
    .from('attachments')
    .select(SELECT)
    .eq('entity', entity)
    .in('entity_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const signed = await signRows(rowToApi<AttachmentRow[]>(data ?? []));
  for (const a of signed) {
    if (!a.entityId) continue;
    const list = byParent.get(a.entityId);
    if (list) list.push(a);
    else byParent.set(a.entityId, [a]);
  }
  return byParent;
}

/**
 * Photos for parents spanning SEVERAL entity types, keyed by `${entity}:${id}`.
 *
 * The ledger needs exactly this: one page mixes vouchers sourced from manual
 * entries, salaries, partner expenses and branch shares, and reading them as
 * four separate round-trips per page would be four times the latency for the
 * same rows.
 */
export async function listAttachmentsAcross(
  refs: { entity: AttachmentEntity; entityId: string }[],
): Promise<Map<string, Attachment[]>> {
  const byKey = new Map<string, Attachment[]>();
  if (refs.length === 0) return byKey;

  // Group by entity so each type is one `in (...)` predicate. PostgREST has no
  // tuple-IN, and an `or(and(...),and(...))` chain over 100 refs would be a URL
  // long enough to hit the request-line limit.
  const idsByEntity = new Map<AttachmentEntity, Set<string>>();
  for (const ref of refs) {
    if (!ref.entityId) continue;
    const set = idsByEntity.get(ref.entity);
    if (set) set.add(ref.entityId);
    else idsByEntity.set(ref.entity, new Set([ref.entityId]));
  }

  const perEntity = await Promise.all(
    [...idsByEntity.entries()].map(async ([entity, ids]) => ({
      entity,
      byParent: await listAttachmentsFor(entity, [...ids]),
    })),
  );

  for (const { entity, byParent } of perEntity) {
    for (const [entityId, list] of byParent) {
      byKey.set(`${entity}:${entityId}`, list);
    }
  }
  return byKey;
}

/** The key `listAttachmentsAcross` returns its map under. */
export function attachmentKey(entity: AttachmentEntity, entityId: string): string {
  return `${entity}:${entityId}`;
}
