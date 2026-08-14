/**
 * Photo attachments — the supporting image captured alongside a finance
 * document or a branch demand.
 *
 * One shape for every attachment site. The parent is identified by
 * `(entity, entityId)` rather than by a foreign key, because the ledger reaches
 * an attachment from a posted voucher's `(sourceType, sourceId)` and no single
 * column can reference five different tables. See migration 67.
 */

export const ATTACHMENT_ENTITIES = [
  'finance_transaction',
  'partner_expense',
  'branch_share_payment',
  'salary_payment',
  'finance_income_approval',
  'production_order_demand',
  'production_order_verification',
  'production_order_special_item',
] as const;

export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number];

/** Human labels for the places a photo can be attached. */
export const ATTACHMENT_ENTITY_LABELS: Record<AttachmentEntity, string> = {
  finance_transaction: 'Income / expense entry',
  partner_expense: 'Partner advance or draw',
  branch_share_payment: 'Branch share payout',
  salary_payment: 'Salary payment',
  finance_income_approval: 'Branch income',
  production_order_demand: 'Demand',
  production_order_verification: 'Delivery verification',
  production_order_special_item: 'Special order item',
};

/**
 * What the API returns for one photo.
 *
 * `url` is a SHORT-LIVED signed URL minted at read time, not a stored value —
 * the bucket is private (migration 67) and an `<img src>` cannot carry a Bearer
 * token. It expires; never persist it, cache it past a page load, or put it in
 * a printed document. Re-fetch the parent to get a fresh one.
 */
export interface Attachment {
  id: string;
  entity: AttachmentEntity;
  /** Null only while the photo is staged and its parent does not exist yet. */
  entityId: string | null;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedBy: string | null;
  uploadedByName: string | null;
  createdAt: string; // ISO UTC
}

/** How long a minted signed URL stays valid, in seconds. */
export const ATTACHMENT_URL_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * The ceiling the API enforces on an upload, in bytes.
 *
 * The client downscales every capture well below this (see
 * ATTACHMENT_TARGET_MAX_BYTES); this is the backstop for a client that does
 * not, and it matches the bucket's own file_size_limit.
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Accepted image formats. Mirrors the bucket's allowed_mime_types. */
export const ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

// ---------------------------------------------------------------------------
// Capture/compression targets — shared so the client and any future server-side
// re-encode agree on what "low size" means.
// ---------------------------------------------------------------------------

/**
 * Longest edge a stored capture is allowed to keep, in pixels.
 *
 * 1280 is chosen to keep a receipt's printed figures and a delivery photo's
 * crate labels legible when zoomed, while cutting a modern phone's 12 MP frame
 * (~4 MB) to a few hundred KB. Lowering it further starts to cost readability,
 * which is the entire point of requiring the photo.
 */
export const ATTACHMENT_MAX_DIMENSION = 1280;

/** JPEG quality for the first encode pass. */
export const ATTACHMENT_JPEG_QUALITY = 0.7;

/**
 * Byte budget the client compresses towards, stepping quality down until the
 * encode fits. Roughly a quarter-megabyte — small enough to upload on a weak
 * branch connection, large enough to stay readable at 1280px.
 */
export const ATTACHMENT_TARGET_MAX_BYTES = 300 * 1024;

/** How many photos may hang off one document. */
export const ATTACHMENT_MAX_PER_ENTITY = 5;
