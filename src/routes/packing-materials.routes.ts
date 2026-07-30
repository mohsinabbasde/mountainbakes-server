import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { CreatePackingMaterialSchema, UpdatePackingMaterialSchema } from '../shared';
import { rowToApi, apiToRow } from '../utils/case';
import { getCached, setCached, invalidate } from '../utils/cache';

export const router = Router();

router.use(authenticate);

/**
 * GET /api/packing-materials
 *
 * Every role reads this — the branch demand form and the production review both
 * need the catalogue. `?includeInactive=true` is the admin view; everyone else
 * gets active rows only, which is what enforces "only active packing materials can
 * be selected" at the source rather than relying on each caller to filter.
 */
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const includeInactive = req.query['includeInactive'] === 'true' && req.user!.role === 'super_admin';
    const search = req.query['search'];

    // Same caching rule as products: cache the unfiltered list variants (the hot
    // path), pass free-text searches straight through so results stay fresh.
    const cacheKey = search ? null : `packing-materials:${includeInactive ? 'all' : 'active'}`;
    if (cacheKey) {
      const hit = getCached<{ packingMaterials: Record<string, unknown>[]; total: number }>(cacheKey);
      if (hit) { res.json(hit); return; }
    }

    let query = supabaseAdmin
      .from('packing_materials')
      .select('*')
      .order('material_code', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);

    if (search) {
      // Commas/parens are PostgREST `or` separators — strip before interpolating.
      const term = String(search).replace(/[(),*]/g, ' ').trim();
      if (term) query = query.or(`material_name.ilike.%${term}%,material_code.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const packingMaterials = rowToApi<Record<string, unknown>[]>(data ?? []);
    const payload = { packingMaterials, total: packingMaterials.length };
    if (cacheKey) setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('packing_materials')
      .select('*')
      .eq('id', req.params['id']!)
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Packing material not found' }); return; }

    res.json({ packingMaterial: rowToApi(data) });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const parsed = CreatePackingMaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.errors });
      return;
    }

    const { materialCode, materialName, category, description } = parsed.data;

    const { data, error } = await supabaseAdmin
      .from('packing_materials')
      .insert({
        material_code: materialCode,
        material_name: materialName,
        category: category || null,
        description: description || null,
        is_active: true,
        created_by: req.user!.uid,
      })
      .select('id')
      .single();
    // material_code is unique; surface the collision as a 409 rather than a 500.
    if (error) {
      if (error.code === '23505') { res.status(409).json({ error: `Code ${materialCode} is already in use` }); return; }
      throw error;
    }

    invalidate('packing-materials');
    res.status(201).json({ id: data.id, materialCode, materialName });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requireRole('super_admin'), async (req, res, next) => {
  try {
    const parsed = UpdatePackingMaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.errors });
      return;
    }

    // updated_at is maintained by the packing_materials_touch trigger.
    const updates = apiToRow(parsed.data);

    const { data, error } = await supabaseAdmin
      .from('packing_materials')
      .update(updates)
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();
    if (error) {
      if (error.code === '23505') { res.status(409).json({ error: 'That code is already in use' }); return; }
      throw error;
    }
    if (!data) { res.status(404).json({ error: 'Packing material not found' }); return; }

    invalidate('packing-materials');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/packing-materials/:id — a REAL delete, unlike products.
 *
 * Products soft-delete because order history references them for price and
 * reporting. A packing line snapshots `material_name` and holds
 * `packing_material_id ... on delete set null` (migration 39), so removing a
 * material leaves every historical demand and printed slip intact. That is what
 * lets Delete and Disable be genuinely different actions: Disable hides it from new
 * demands, Delete removes it from the catalogue.
 */
router.delete('/:id', requireRole('super_admin'), async (req, res, next) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('packing_materials')
      .delete()
      .eq('id', req.params['id']!)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Packing material not found' }); return; }

    invalidate('packing-materials');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
