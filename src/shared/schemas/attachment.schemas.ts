import { z } from 'zod';
import { ATTACHMENT_ENTITIES, ATTACHMENT_MAX_PER_ENTITY } from '../types/attachment.types';

/**
 * Attachment request schemas.
 *
 * The photo itself never travels in JSON. It is uploaded first, as multipart, to
 * `POST /api/attachments`, which returns an id; the create request that follows
 * carries only that id. Base64 in the document body would have been simpler to
 * write and would have inflated every finance payload by a third for no gain.
 */

/**
 * `entity` is declared at upload time, before the parent exists, so the staged
 * row already knows which kind of document it is waiting for. The binding step
 * then refuses an id whose entity does not match the document being created —
 * which is what stops a demand photo being passed off as an expense receipt.
 */
export const UploadAttachmentSchema = z.object({
  entity: z.enum(ATTACHMENT_ENTITIES),
});

/** A list of staged attachment ids, as carried by a create request. */
const attachmentIds = z
  .array(z.string().uuid())
  .max(ATTACHMENT_MAX_PER_ENTITY, `At most ${ATTACHMENT_MAX_PER_ENTITY} photos`);

/**
 * Optional attachment list — zero photos is a valid submission.
 *
 * Used only where a document can be created without a human present to hold a
 * camera. Branch Income is the sole case: those rows are machine-imported from
 * the branch closing, so requiring a photo there would break the import.
 */
export const optionalAttachmentIds = attachmentIds.default([]);

/**
 * Mandatory attachment list — at least one photo.
 *
 * Every human-entered finance document and every branch demand/verification
 * uses this. The message is deliberately plain: it is shown verbatim under the
 * camera button when someone tries to submit without capturing.
 */
export const requiredAttachmentIds = attachmentIds.min(1, 'A photo is required');

export type UploadAttachmentInput = z.infer<typeof UploadAttachmentSchema>;
