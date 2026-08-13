import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import {
  ApproveBranchUserRequestSchema,
  CreateBranchUserRequestSchema,
  RejectBranchUserRequestSchema,
  BRANCH_SHIFT_LABELS,
  type BranchUserRequest,
} from '../shared';
import { notify } from '../services/push.service';
import { rowToApi } from '../utils/case';

export const router = Router();

router.use(authenticate);

/** Read one request row, or null. */
async function getRequest(id: string): Promise<BranchUserRequest | null> {
  const { data, error } = await supabaseAdmin
    .from('branch_user_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToApi<BranchUserRequest>(data) : null;
}

// ---------------------------------------------------------------------------
// GET /api/branch-user-requests — the queue.
//
// A manager sees their OWN branch's requests and nothing else; an admin sees
// every branch. Scoped from the JWT's branchId rather than a query parameter,
// so there is no branch to tamper with.
// ---------------------------------------------------------------------------
router.get('/', requireRole('super_admin', 'branch_manager'), async (req: AuthRequest, res, next) => {
  try {
    let query = supabaseAdmin
      .from('branch_user_requests')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (req.user!.role === 'branch_manager') {
      const branchId = req.user!.branchId;
      if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }
      query = query.eq('branch_id', branchId);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ requests: (data ?? []).map((r) => rowToApi<BranchUserRequest>(r)) });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/branch-user-requests — a manager forwards a request to Admin.
//
// branch_manager only. An admin has no reason to come through here: they can
// create the account outright at POST /api/users, and a request they raised to
// themselves would sit in a queue waiting for its own author.
// ---------------------------------------------------------------------------
router.post(
  '/',
  requireRole('branch_manager'),
  validate(CreateBranchUserRequestSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const branchId = req.user!.branchId;
      if (!branchId) { res.status(400).json({ error: 'No branch assigned to this account' }); return; }

      const { displayName, email, phone, shift, note } = req.body;
      const normalisedEmail = String(email).trim().toLowerCase();

      // Reject an address that is already a login before it reaches the queue.
      // Without this the request sits pending until an admin approves it and
      // Supabase Auth fails on the duplicate — an error the manager never sees
      // and cannot act on.
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from('users')
        .select('id')
        .ilike('email', normalisedEmail)
        .maybeSingle();
      if (existingErr) throw existingErr;
      if (existing) { res.status(409).json({ error: 'An account with that email already exists' }); return; }

      const { data, error } = await supabaseAdmin
        .from('branch_user_requests')
        .insert({
          // request_no, status and created_at all come from column defaults.
          branch_id: branchId,
          branch_name: req.user!.branchName ?? '',
          requested_by: req.user!.uid,
          requested_by_name: req.user!.email,
          display_name: displayName,
          email: normalisedEmail,
          phone,
          shift,
          note,
        })
        .select()
        .single();

      // 23505 = the partial unique index on a pending email: the same address is
      // already queued. Usually a double submit.
      if (error) {
        if ((error as { code?: string }).code === '23505') {
          res.status(409).json({ error: 'A request for that email is already pending' });
          return;
        }
        throw error;
      }

      const request = rowToApi<BranchUserRequest>(data);

      await notify({
        type: 'branch_user_requested',
        title: 'Branch user account requested',
        message: `${request.requestedByName} (${request.branchName}) requested a ${BRANCH_SHIFT_LABELS[request.shift]} account for ${request.displayName}.`,
        targetRole: 'super_admin',
      });

      res.status(201).json({ request });
    } catch (err) { next(err); }
  },
);

// ---------------------------------------------------------------------------
// POST /api/branch-user-requests/:id/approve — admin creates the account.
//
// This is the "on behalf of" step. The new account takes the REQUESTING
// MANAGER'S branchId, not the admin's (an admin has none), which is what makes
// the shift user read and write the manager's branch data rather than a private
// set of its own.
//
// Auth user first, then the public.users row: users.id is a FK onto
// auth.users.id, so the order cannot be reversed.
// ---------------------------------------------------------------------------
router.post(
  '/:id/approve',
  requireRole('super_admin'),
  validate(ApproveBranchUserRequestSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const request = await getRequest(req.params['id'] as string);
      if (!request) { res.status(404).json({ error: 'Request not found' }); return; }
      if (request.status !== 'pending') {
        res.status(409).json({ error: `This request was already ${request.status}` });
        return;
      }

      const { password, username } = req.body;
      // The email local part is a reasonable default and is what the Users page
      // shows; uniqueness is enforced by the users_username_key index below.
      const finalUsername = (username as string | undefined) ?? request.email.split('@')[0];

      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: request.email,
        password,
        email_confirm: true,
        user_metadata: { displayName: request.displayName },
        app_metadata: {
          role: 'branch_user',
          branchId: request.branchId,
          branchName: request.branchName,
        },
      });
      if (createErr || !created.user) throw createErr ?? new Error('Failed to create user');
      const uid = created.user.id;

      const { error: rowErr } = await supabaseAdmin.from('users').insert({
        id: uid,
        email: request.email,
        display_name: request.displayName,
        phone: request.phone,
        username: finalUsername,
        role: 'branch_user',
        branch_id: request.branchId,
        branch_name: request.branchName,
        shift: request.shift,
        status: 'active',
      });
      // Roll the auth user back rather than leaving a login with no profile row —
      // it would authenticate and then 500 on every request that reads `users`.
      if (rowErr) {
        await supabaseAdmin.auth.admin.deleteUser(uid).catch((e) =>
          console.error(`[branch-user-requests] orphaned auth user ${uid} — profile insert failed and cleanup did too`, e),
        );
        // 23505 here is almost always `username`: it is unique, and when the
        // admin does not supply one it is derived from the email local part,
        // which two branches can easily share ('info@…', 'shop@…'). Left to the
        // error handler this is a masked 500 in production — the admin retypes
        // the same value and fails the same way, with nothing pointing at the
        // field the approve dialog lets them change. POST /api/users answers the
        // identical collision the identical way.
        if ((rowErr as { code?: string }).code === '23505') {
          res.status(409).json({ error: 'That email or username is already taken' });
          return;
        }
        throw rowErr;
      }

      const { data: updated, error: updErr } = await supabaseAdmin
        .from('branch_user_requests')
        .update({
          status: 'approved',
          reviewed_by: req.user!.uid,
          reviewed_by_name: req.user!.email,
          reviewed_at: new Date().toISOString(),
          created_user_id: uid,
        })
        .eq('id', request.id)
        .select()
        .single();
      if (updErr) throw updErr;

      if (request.requestedBy) {
        await notify({
          type: 'branch_user_reviewed',
          title: 'Branch user account approved',
          message: `${request.displayName}'s ${BRANCH_SHIFT_LABELS[request.shift]} account (${request.email}) is active.`,
          targetUserId: request.requestedBy,
        });
      }

      res.json({ request: rowToApi<BranchUserRequest>(updated), userId: uid });
    } catch (err) { next(err); }
  },
);

// POST /api/branch-user-requests/:id/reject — admin declines, with a reason.
router.post(
  '/:id/reject',
  requireRole('super_admin'),
  validate(RejectBranchUserRequestSchema),
  async (req: AuthRequest, res, next) => {
    try {
      const request = await getRequest(req.params['id'] as string);
      if (!request) { res.status(404).json({ error: 'Request not found' }); return; }
      if (request.status !== 'pending') {
        res.status(409).json({ error: `This request was already ${request.status}` });
        return;
      }

      const { data: updated, error } = await supabaseAdmin
        .from('branch_user_requests')
        .update({
          status: 'rejected',
          reviewed_by: req.user!.uid,
          reviewed_by_name: req.user!.email,
          reviewed_at: new Date().toISOString(),
          rejection_reason: req.body.reason,
        })
        .eq('id', request.id)
        .select()
        .single();
      if (error) throw error;

      if (request.requestedBy) {
        await notify({
          type: 'branch_user_reviewed',
          title: 'Branch user account declined',
          message: `The request for ${request.displayName} was declined: ${req.body.reason}`,
          targetUserId: request.requestedBy,
        });
      }

      res.json({ request: rowToApi<BranchUserRequest>(updated) });
    } catch (err) { next(err); }
  },
);
