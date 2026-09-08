/**
 * Data Engine — aggregates over the filtered set.
 *
 * `GET /api/data/:resource/aggregate?metrics=count,sum:grandTotal&groupBy=status&…filters`
 *
 * The filters are parsed exactly as for the list (same fields, same operators,
 * same scope), then shipped as a condition tree to `data_engine_aggregate`
 * (migration 108), which renders it as SQL. A dashboard card and the table
 * under it therefore count the same rows by construction.
 *
 * `count` alone, with no grouping, needs no SQL function: PostgREST's
 * `count: 'exact'` head request answers it, so that case works before the
 * migration is applied.
 */
import { supabaseAdmin } from '../config/supabase';
import { AGGREGATE_METRICS, type AggregateMetric, type AggregateResponse, type AggregateRow } from '../shared';
import { camelToSnake, snakeToCamel } from '../utils/case';
import { ListQueryError, columnOf } from './parseListQuery';
import { resolveScope } from './queryBuilder';
import type { AuthUser, ResolvedListQuery, ResourceConfig } from './types';
import { applyCondition, buildCondition, type FilterableQuery } from './where';

export interface ParsedAggregate {
  metrics: Array<{ metric: AggregateMetric; column?: string; key: string }>;
  groupBy: Array<{ key: string; column: string }>;
}

/** `metrics=count,sum:grandTotal` and `groupBy=status,branchId` → validated columns. */
export function parseAggregateParams(query: Record<string, unknown>, config: ResourceConfig<unknown>): ParsedAggregate {
  const rawMetrics = String(query.metrics ?? 'count')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (rawMetrics.length === 0) throw new ListQueryError('Validation error', [{ field: 'metrics', message: 'At least one metric' }]);
  if (rawMetrics.length > 12) throw new ListQueryError('Validation error', [{ field: 'metrics', message: 'Too many metrics' }]);

  const metrics = rawMetrics.map((spec) => {
    const [metric, fieldKey] = spec.split(':') as [string, string | undefined];
    if (!(AGGREGATE_METRICS as readonly string[]).includes(metric)) {
      throw new ListQueryError('Validation error', [{ field: 'metrics', message: `Unknown metric ${metric}` }]);
    }
    if (metric === 'count') return { metric: 'count' as const, key: 'count' };
    if (!fieldKey || !config.aggregatableFields?.includes(fieldKey)) {
      throw new ListQueryError('Validation error', [
        { field: 'metrics', message: `${fieldKey ?? '(missing)'} cannot be aggregated on this resource` },
      ]);
    }
    const field = config.fields.find((f) => f.key === fieldKey);
    return { metric: metric as AggregateMetric, column: field ? columnOf(field) : camelToSnake(fieldKey), key: `${metric}:${fieldKey}` };
  });

  const groupBy = String(query.groupBy ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((key) => {
      if (!config.groupableFields?.includes(key)) {
        throw new ListQueryError('Validation error', [{ field: 'groupBy', message: `Cannot group by ${key}` }]);
      }
      const field = config.fields.find((f) => f.key === key);
      return { key, column: field ? columnOf(field) : camelToSnake(key) };
    });
  if (groupBy.length > 3) throw new ListQueryError('Validation error', [{ field: 'groupBy', message: 'At most three group fields' }]);

  return { metrics, groupBy };
}

export async function runAggregate<Row>(
  config: ResourceConfig<Row>,
  resolved: Omit<ResolvedListQuery, 'page' | 'pageSize' | 'sort'>,
  agg: ParsedAggregate,
  user: AuthUser,
): Promise<AggregateResponse> {
  const scopeRules = await resolveScope(config, user);
  const where = buildCondition(config, resolved, scopeRules);

  // The cheap path: a bare count is a HEAD request, no SQL function needed.
  if (agg.groupBy.length === 0 && agg.metrics.length === 1 && agg.metrics[0]!.metric === 'count') {
    const base = supabaseAdmin.from(config.table).select('id', { count: 'exact', head: true });
    const query = applyCondition(base as unknown as FilterableQuery, where);
    const { count, error } = await (query as unknown as typeof base);
    if (error) throw error;
    return { rows: [{ values: { count: count ?? 0 } }] };
  }

  const { data, error } = await supabaseAdmin.rpc('data_engine_aggregate', {
    p_table: config.table,
    p_where: where,
    p_metrics: agg.metrics.map((m) => ({ metric: m.metric, column: m.column ?? null })),
    p_group_by: agg.groupBy.map((g) => g.column),
  });

  if (error) {
    // PGRST202: the function is not in the schema cache — migration 108 has
    // not been applied. Say so, rather than surfacing a 500 with a hint about
    // a "function public.data_engine_aggregate".
    if (error.code === 'PGRST202' || /data_engine_aggregate/.test(error.message ?? '')) {
      throw Object.assign(
        new Error('Aggregation is not available until database migration 108 (data_engine_aggregate) is applied.'),
        { status: 501 },
      );
    }
    throw error;
  }

  const groupColumnToKey = new Map(agg.groupBy.map((g) => [g.column, g.key] as const));
  const metricColumnToKey = new Map(agg.metrics.map((m) => [m.column ? `${m.metric}:${m.column}` : 'count', m.key] as const));

  const rows: AggregateRow[] = ((data ?? []) as Record<string, unknown>[]).map((raw) => {
    const group: Record<string, string | number | boolean | null> = {};
    const values: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(raw)) {
      const groupKey = groupColumnToKey.get(k);
      if (groupKey) {
        group[groupKey] = v as string | number | boolean | null;
        continue;
      }
      const metricKey = metricColumnToKey.get(k) ?? snakeToCamel(k);
      values[metricKey] = v === null || v === undefined ? null : Number(v);
    }
    return agg.groupBy.length > 0 ? { group, values } : { values };
  });

  return { rows };
}
