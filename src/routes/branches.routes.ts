import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateBranchSchema, UpdateBranchSchema, type Branch } from '../shared';
import { slugify } from '../utils/slugify';
import { notify } from '../services/push.service';
import { logFinanceAudit } from '../services/finance-audit.service';
import { getCached, setCached, invalidate } from '../utils/cache';
import { rowToApi, apiToRow } from '../utils/case';

export const router = Router();

/**
 * PostgREST serialises `numeric` as a STRING, so `company_share_pct` arrives as
 * "70.00" and the API contract says `number | null`. Left uncoerced it reaches
 * the branch form as a string and the ledger maths as a string — the same trap
 * finance-settings.service.ts documents at length on the global percentages.
 *
 * Null is preserved, NOT defaulted: null is the meaningful "inherit the global
 * split" value, and `Number(null)` is 0, which would silently put every branch
 * on a 0% company share.
 */
function normaliseBranch<T extends { companySharePct?: unknown }>(branch: T): T {
  const raw = branch.companySharePct;
  return {
    ...branch,
    companySharePct: raw === null || raw === undefined ? null : Number(raw),
  };
}

/**
 * GET /api/branches — all authenticated users can read branches.
 *
 * Inactive branches are EXCLUDED by default. DELETE /:id is a soft delete
 * (is_active = false), so without this a "deleted" branch kept appearing in
 * every list and picker forever. Pass ?includeInactive=true to get them back —
 * an admin screen managing closed branches would want that.
 *
 * The cache key varies with the flag; `invalidate('branches')` matches on the
 * `branches:` prefix so it still clears both variants on write.
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const includeInactive = req.query['includeInactive'] === 'true';
    const cacheKey = `branches:${includeInactive ? 'all' : 'active'}`;

    const hit = getCached<Branch[]>(cacheKey);
    if (hit) { res.json({ branches: hit }); return; }

    let query = supabaseAdmin.from('branches').select('*').order('name', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);

    const { data, error } = await query;
    if (error) throw error;

    const branches = rowToApi<Branch[]>(data ?? []).map(normaliseBranch);
    setCached(cacheKey, branches);
    res.json({ branches });
  } catch (err) {
    next(err);
  }
});

// GET /api/branches/:id
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    // maybeSingle() returns null instead of erroring when there is no match, so a
    // missing branch stays a clean 404 rather than a 500.
    const { data, error } = await supabaseAdmin
      .from('branches')
      .select('*')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Branch not found' }); return; }

    res.json({ branch: normaliseBranch(rowToApi<Branch>(data)) });
  } catch (err) {
    next(err);
  }
});

// POST /api/branches — admin only
router.post('/', authenticate, requireRole('super_admin'), validate(CreateBranchSchema), async (req: AuthRequest, res, next) => {
  try {
    const { name, location, phone, address, city, dailyBudget, weeklyBudget, monthlyBudget, companySharePct } = req.body;

    // created_at / updated_at come from column defaults — do not set them here.
    const { data, error } = await supabaseAdmin
      .from('branches')
      .insert({
        name,
        slug: slugify(name),
        location,
        phone,
        address,
        city,
        manager_id: null,
        manager_name: null,
        is_active: true,
        daily_budget: dailyBudget ?? 0,
        weekly_budget: weeklyBudget ?? 0,
        monthly_budget: monthlyBudget ?? 0,
        // `?? null` and NOT `?? 0`: null means "inherit the global company/branch
        // split", zero would mean "the company takes nothing from this branch"
        // and hand it the whole collection. See migration 68.
        company_share_pct: companySharePct ?? null,
      })
      .select('id')
      .single();

    // `slug` is UNIQUE. Two branches with the same name slugify identically, so
    // surface that as a 409 the UI can show rather than a generic 500.
    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: `A branch named "${name}" already exists` });
        return;
      }
      throw error;
    }

    invalidate('branches');

    // Notify admins of new branch. In-app only for now — web push is not
    // delivered until VAPID is implemented (see push.service.ts).
    // branchId is null: super_admin is a central role with no branch claim, and the
    // notifications RLS filters out a role broadcast whose branch_id doesn't match
    // the recipient's — so a non-null branchId hides this from every admin. The new
    // branch is still linked via relatedId.
    await notify({
      type: 'branch_added',
      title: 'New Branch Added',
      message: `${name} has been added to the system`,
      targetRole: 'super_admin',
      branchId: null,
      relatedId: data.id,
    });

    res.status(201).json({ id: data.id, name });
  } catch (err) {
    next(err);
  }
});

// PUT /api/branches/:id — admin only
router.put('/:id', authenticate, requireRole('super_admin'), validate(UpdateBranchSchema), async (req: AuthRequest, res, next) => {
  try {
    // updated_at is maintained by the branches_touch trigger — do not set it here.
    const updates = apiToRow(req.body);
    if (typeof req.body.name === 'string') updates['slug'] = slugify(req.body.name);

    // Read the share percentage BEFORE the write, and only when the payload
    // actually carries one — the finance trail wants from-and-to, and every
    // other field on this form moves no money and is not worth a round trip.
    // `in` rather than `!== undefined`: an explicit null clears the override.
    const changingShare = 'companySharePct' in req.body;
    const previousSharePct = changingShare
      ? await readCompanySharePct(req.params['id']!)
      : null;

    // A Postgres UPDATE against a missing row just reports 0 rows affected rather
    // than erroring. Select the id back so a bad :id is still a 404.
    const { data, error } = await supabaseAdmin
      .from('branches')
      .update(updates)
      .eq('id', req.params['id']!)
      .select('id, name, company_share_pct')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: `A branch named "${req.body.name}" already exists` });
        return;
      }
      throw error;
    }
    if (!data) { res.status(404).json({ error: 'Branch not found' }); return; }

    invalidate('branches');

    // Changing a branch's split changes what every future income approval books
    // as the company's and what it books as the branch's. That belongs in the
    // FINANCE trail (which records from-and-to on a target document) even though
    // it is edited from an Admin screen — an auditor asking why a branch's share
    // changed in March has nowhere else to look. Nothing else on this form is
    // logged there, deliberately: none of it moves money.
    if (changingShare) {
      const nextSharePct =
        data.company_share_pct === null || data.company_share_pct === undefined
          ? null
          : Number(data.company_share_pct);
      if (previousSharePct !== nextSharePct) {
        await logFinanceAudit(req, {
          entity: 'settings',
          entityId: data.id as string,
          entityRef: `branch:${data.name as string}`,
          action: 'settings_updated',
          // `null` is rendered as the inherit case rather than dropped, so the
          // trail distinguishes "put back on the default" from "not touched".
          previousValues: { companySharePct: previousSharePct, inheritsGlobalSplit: previousSharePct === null },
          newValues: { companySharePct: nextSharePct, inheritsGlobalSplit: nextSharePct === null },
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** The branch's stored override, or null when it inherits. */
async function readCompanySharePct(branchId: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from('branches')
    .select('company_share_pct')
    .eq('id', branchId)
    .maybeSingle();
  if (error) throw error;
  const raw = data?.company_share_pct;
  // PostgREST serialises numeric as a string — coerce so the change check below
  // compares 70 to 70 and not 70 to "70.00".
  return raw === null || raw === undefined ? null : Number(raw);
}

// DELETE /api/branches/:id — admin only (soft delete)
router.delete('/:id', authenticate, requireRole('super_admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('branches')
      .update({ is_active: false })
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Branch not found' }); return; }

    invalidate('branches');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
