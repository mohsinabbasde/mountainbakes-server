import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { CreateFinanceQuerySchema, UpdateFinanceQuerySchema } from '../shared';
import { apiToRow, rowToApi } from '../utils/case';

/**
 * Mutations for the Finance Query resource. Reads (list/search/filter/sort/
 * export) go through the Data Engine (`GET /api/data/financeQueries`,
 * registered in `data-engine/registry.ts`) — this router only creates,
 * edits and deletes.
 *
 * Admin has complete control per the brief (chagneQuery.md §3/§10): every
 * write here is `super_admin`-only, via `requireRole` directly rather than
 * `requireFinance(...)`, so it can never be gated behind the
 * `allowSuperAdminWrite` finance-settings toggle — the same reasoning as
 * `requireFinanceHelpDeskAdmin()`.
 */
export const router = Router();

router.use(authenticate);

async function branchName(branchId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from('branches').select('name').eq('id', branchId).maybeSingle();
  if (error) throw error;
  return data?.name ?? null;
}

// POST /api/finance-queries — Admin adds a finance record (§4 Add Finance Data)
router.post('/', requireRole('super_admin'), validate(CreateFinanceQuerySchema), async (req: AuthRequest, res, next) => {
  try {
    const { date, branchId, ...rest } = req.body;
    const name = await branchName(branchId);
    if (!name) { res.status(400).json({ error: 'Branch not found' }); return; }

    const { data, error } = await supabaseAdmin
      .from('finance_queries')
      .insert({
        ...apiToRow(rest),
        business_date: date,
        branch_id: branchId,
        branch_name: name,
        created_by: req.user!.uid,
        created_by_name: req.user!.email,
      })
      .select('*')
      .single();
    if (error) throw error;

    res.status(201).json({ query: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/finance-queries/:id — Admin edits any field, including the
// Comment box (§3/§5): a partial patch, only fields present in the body change.
router.patch('/:id', requireRole('super_admin'), validate(UpdateFinanceQuerySchema), async (req: AuthRequest, res, next) => {
  try {
    const { date, branchId, ...rest } = req.body;
    const patch: Record<string, unknown> = apiToRow(rest);
    if (date !== undefined) patch['business_date'] = date;

    if (branchId !== undefined) {
      const name = await branchName(branchId);
      if (!name) { res.status(400).json({ error: 'Branch not found' }); return; }
      patch['branch_id'] = branchId;
      patch['branch_name'] = name;
    }

    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
    patch['updated_by'] = req.user!.uid;
    patch['updated_by_name'] = req.user!.email;

    const { data, error } = await supabaseAdmin
      .from('finance_queries')
      .update(patch)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Finance query not found' }); return; }

    res.json({ query: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/finance-queries/:id — Admin deletes a finance record. A Finance
// Query IS the record (no separate line-item table), so this one endpoint
// backs both the row-level "Delete Data" (§6) and the detail-view
// "Delete Query" (§7) actions — same operation, two confirmations client-side.
router.delete('/:id', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('finance_queries')
      .delete()
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Finance query not found' }); return; }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
