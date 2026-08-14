import { Router } from 'express';
import multer from 'multer';
import { authenticate, type AuthRequest } from '../middleware/auth';
import {
  ATTACHMENT_MAX_BYTES,
  UploadAttachmentSchema,
  isBranchRole,
  isFinanceRole,
  type AttachmentEntity,
  type UserRole,
} from '../shared';
import { uploadAttachment } from '../services/attachments.service';

export const router = Router();

/**
 * The one place a captured photo enters the system.
 *
 * Multipart rather than base64-in-JSON: an image inflates ~33% under base64 and
 * would sit in every finance payload's request log. Memory storage because the
 * buffer goes straight to Supabase Storage — nothing is ever written to the
 * dyno's disk, which is ephemeral anyway.
 *
 * The 5 MB limit is a backstop, not the working size. The client downscales
 * every capture to roughly 100–300 KB before it gets here (compressImage in the
 * frontend's lib/attachments.ts); anything arriving near this limit means the
 * client-side compression did not run.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
});

/**
 * Who may attach a photo to what.
 *
 * This is the same authorization the CREATE endpoint applies, enforced a second
 * time at upload. Without it, a branch user could stage a photo against
 * `salary_payment` — harmless on its own, since binding also checks the entity
 * and the finance create endpoints are role-guarded, but it would let anyone
 * with a login write objects into the finance folder of the bucket.
 */
const ENTITY_ROLES: Record<AttachmentEntity, (role: UserRole) => boolean> = {
  finance_transaction: (r) => isFinanceRole(r) || r === 'super_admin',
  partner_expense: (r) => isFinanceRole(r) || r === 'super_admin',
  branch_share_payment: (r) => isFinanceRole(r) || r === 'super_admin',
  salary_payment: (r) => isFinanceRole(r) || r === 'super_admin',
  finance_income_approval: (r) => isFinanceRole(r) || r === 'super_admin',
  production_order_demand: (r) => isBranchRole(r) || r === 'super_admin',
  production_order_verification: (r) => isBranchRole(r) || r === 'super_admin',
};

router.use(authenticate);

/**
 * POST /api/attachments — upload one captured photo, staged against `entity`.
 *
 * Returns the attachment, including a signed URL for the form's own thumbnail.
 * The `id` is what the caller then sends as one of `attachmentIds` on the
 * request that creates the document; until that binding happens the row belongs
 * to nothing. See the lifecycle note in migration 67.
 */
router.post(
  '/',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  upload.single('photo') as any,
  async (req: AuthRequest, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No photo uploaded' });
        return;
      }

      // Parsed here rather than through the `validate` middleware: that runs
      // before multer, so it would see an empty body on a multipart request.
      // The schema is still the source of truth for what `entity` may be.
      const parsed = UploadAttachmentSchema.safeParse({ entity: req.body?.entity });
      if (!parsed.success) {
        res.status(400).json({ error: 'Unknown attachment type' });
        return;
      }
      const { entity } = parsed.data;

      if (!ENTITY_ROLES[entity](req.user!.role)) {
        res.status(403).json({ error: 'Forbidden: cannot attach a photo to this kind of record' });
        return;
      }

      // Dimensions are captured client-side and are presentational only (they
      // let the gallery reserve space before the image loads), so a missing or
      // nonsensical value is dropped rather than rejected.
      const toDimension = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n) : null;
      };

      const attachment = await uploadAttachment({
        entity,
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        width: toDimension(req.body?.width),
        height: toDimension(req.body?.height),
        actor: { uid: req.user!.uid, email: req.user!.email },
      });

      res.status(201).json({ attachment });
    } catch (err) {
      next(err);
    }
  },
);
