/**
 * `/api/data/:resource` — the generic list, aggregate and export endpoint.
 *
 * One route family for every table the resource registry publishes. The URL
 * names a RESOURCE, never a table; `getResource()` is the only way from one to
 * the other, and an unknown name is a 404 before anything else runs.
 *
 *   GET /api/data/:resource            one page       → PaginatedResponse<Row>
 *   GET /api/data/:resource/meta       what may be filtered/sorted → ResourceMeta
 *   GET /api/data/:resource/aggregate  count/sum/avg/min/max (+groupBy) over the filtered set
 *   GET /api/data/:resource/export     every filtered row as .xlsx / .csv, server-side
 *
 * Authorisation is two-stage and both stages are in the registry, not here:
 * `roles` decides whether the caller may read the resource at all (403), and
 * `scope()` decides which rows — from the verified JWT, never from a query
 * parameter. See `src/data-engine/types.ts`.
 */
import { Router } from 'express';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { getResource } from '../data-engine/registry';
import { ListQueryError, asClientError, operatorsFor, parseListQuery } from '../data-engine/parseListQuery';
import { runFullQuery, runListQuery } from '../data-engine/queryBuilder';
import { parseAggregateParams, runAggregate } from '../data-engine/aggregate';
import { ScopeDenied, type ResolvedListQuery, type ResourceConfig } from '../data-engine/types';
import { genericCSV, genericExcel } from '../services/production-export.service';
import type { ResourceMeta } from '../shared';

export const router = Router();
router.use(authenticate);

const DEFAULT_EXPORT_MAX_ROWS = 10_000;

/**
 * Resolve `:resource` and check the caller's role. Attached to `req` for the
 * handler; an unpublished name is a 404 and a role outside the list a 403 —
 * two different problems for the person on the other end.
 */
interface DataRequest extends AuthRequest {
  resourceName?: string;
  resource?: ResourceConfig;
}

router.param('resource', (req: DataRequest, res, next, name: string) => {
  const config = getResource(name);
  if (!config) {
    res.status(404).json({ error: `Unknown resource: ${name}` });
    return;
  }
  if (!config.roles.includes(req.user!.role)) {
    res.status(403).json({ error: `Forbidden: ${name} is not available to your role` });
    return;
  }
  req.resourceName = name;
  req.resource = config;
  next();
});

/**
 * Validation and scope refusals become 400/403 in words; the rest bubbles.
 *
 * `resolved` lets a database rejection of a caller's VALUE (a bad enum member
 * in a shared link) be named as the 400 it is rather than surfacing as a 500 —
 * see `asClientError`.
 */
function fail(
  raw: unknown,
  res: import('express').Response,
  next: import('express').NextFunction,
  resolved?: ResolvedListQuery,
) {
  const err = resolved ? asClientError(raw, resolved) : raw;
  if (err instanceof ListQueryError) {
    res.status(400).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ScopeDenied) {
    res.status(403).json({ error: err.message });
    return;
  }
  next(err);
}

// ---------------------------------------------------------------------------
// meta — what the client may ask for, so it never has a second copy of the rules
// ---------------------------------------------------------------------------
router.get('/:resource/meta', (req: DataRequest, res) => {
  const config = req.resource!;
  const meta: ResourceMeta = {
    resource: req.resourceName!,
    searchable: (config.searchableFields?.length ?? 0) > 0,
    filterable: config.fields.map((f) => ({
      key: f.key,
      type:
        f.kind === 'timestamp' || f.kind === 'date'
          ? 'date-range'
          : f.kind === 'number'
            ? 'number-range'
            : f.kind === 'boolean'
              ? 'boolean'
              : f.kind === 'enum'
                ? 'select'
                : 'text',
      operators: operatorsFor(f),
    })),
    sortable: [...(config.sortableFields ?? [])],
    defaultSort: config.defaultSort ?? null,
    exportable: Boolean(config.export),
    businessDate: config.fields.some((f) => f.businessDay),
  };
  res.json(meta);
});

// ---------------------------------------------------------------------------
// aggregate — totals over the filtered set, for cards and reports
// ---------------------------------------------------------------------------
router.get('/:resource/aggregate', async (req: DataRequest, res, next) => {
  let resolved: ResolvedListQuery | undefined;
  try {
    const config = req.resource!;
    const { metrics: _m, groupBy: _g, ...listParams } = req.query as Record<string, unknown>;
    resolved = parseListQuery(listParams, config, req.user!.role);
    const agg = parseAggregateParams(req.query as Record<string, unknown>, config);
    res.json(await runAggregate(config, resolved, agg, req.user!));
  } catch (err) {
    fail(err, res, next, resolved);
  }
});

// ---------------------------------------------------------------------------
// export — the SAME filtered set the table shows, as a file
// ---------------------------------------------------------------------------
router.get('/:resource/export', async (req: DataRequest, res, next) => {
  let resolved: ResolvedListQuery | undefined;
  try {
    const config = req.resource!;
    if (!config.export) {
      res.status(404).json({ error: 'This resource cannot be exported' });
      return;
    }
    const { format: rawFormat, scope: rawScope, ...listParams } = req.query as Record<string, unknown>;
    const format = rawFormat === 'csv' ? 'csv' : 'excel';
    const scope = rawScope === 'page' ? 'page' : 'all';
    resolved = parseListQuery(listParams, config, req.user!.role);

    let rows: Record<string, unknown>[];
    if (scope === 'page') {
      rows = (await runListQuery(config, resolved, req.user!)).data as Record<string, unknown>[];
    } else {
      const maxRows = config.export.maxRows ?? DEFAULT_EXPORT_MAX_ROWS;
      const full = await runFullQuery(config, resolved, req.user!, maxRows);
      if (full.truncated) {
        res.status(400).json({
          error: `This export would exceed ${maxRows.toLocaleString()} rows. Narrow the filters or date range and try again.`,
        });
        return;
      }
      rows = full.rows as Record<string, unknown>[];
    }

    const headers = config.export.columns.map((c) => c.header);
    const body = rows.map((row) => config.export!.columns.map((c) => exportCell(row[c.key])));
    const title = config.export.fileName.replace(/-/g, ' ');
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `mountain-bakes-${config.export.fileName}-${stamp}`;

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}.csv"`);
      res.send(genericCSV(headers, body));
      return;
    }
    const buffer = await genericExcel(title, headers, body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    fail(err, res, next, resolved);
  }
});

/** A row value as a spreadsheet cell: scalars as-is, booleans as words, objects as JSON. */
function exportCell(value: unknown): string | number {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? '' : JSON.stringify(value);
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// list — one page
// ---------------------------------------------------------------------------
router.get('/:resource', async (req: DataRequest, res, next) => {
  let resolved: ResolvedListQuery | undefined;
  try {
    const config = req.resource!;
    resolved = parseListQuery(req.query as Record<string, unknown>, config, req.user!.role);
    const page = await runListQuery(config, resolved, req.user!);
    // Static resources may be held briefly by the browser; live ones never.
    res.setHeader('Cache-Control', config.cache === 'static' ? 'private, max-age=60' : 'no-store');
    res.json(page);
  } catch (err) {
    fail(err, res, next, resolved);
  }
});
