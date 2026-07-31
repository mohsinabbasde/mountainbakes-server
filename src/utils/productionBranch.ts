import { supabaseAdmin } from '../config/supabase';
import { getCached, setCached } from './cache';

/** Slug of the sentinel branch that production-counter sales are booked to (migration 37). */
const PRODUCTION_BRANCH_SLUG = 'production-counter';

/**
 * The Production sentinel branch's id, resolved by slug and cached.
 *
 * Production sales have no branch of their own, but orders.branch_id is NOT NULL,
 * so they all point here. Resolving by slug rather than hardcoding a uuid keeps
 * this working against any database the migration has been applied to.
 *
 * Only orders.routes.ts may BOOK a sale to this branch. Other callers may only
 * FILTER by it — support.routes.ts uses it both to scope a production user's sale
 * lookups and to recognise a pool-funded sale, which must not be corrected through
 * the branch-stock machinery. The id is still never sent to the client.
 */
export async function getProductionBranchId(): Promise<string> {
  const cacheKey = `branches:${PRODUCTION_BRANCH_SLUG}`;
  const hit = getCached<string>(cacheKey);
  if (hit) return hit;

  const { data, error } = await supabaseAdmin
    .from('branches')
    .select('id')
    .eq('slug', PRODUCTION_BRANCH_SLUG)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw Object.assign(
      new Error(`Production branch ('${PRODUCTION_BRANCH_SLUG}') is missing — apply migration 37.`),
      { status: 500 },
    );
  }

  const id = (data as { id: string }).id;
  setCached(cacheKey, id);
  return id;
}
