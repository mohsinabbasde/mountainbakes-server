import { columnType, ident, relationship, tableRef } from './catalog';
import { DbError, type OrderOptions } from './types';

/**
 * The `select` string: which columns come back, and which child rows come back
 * nested inside each parent.
 *
 *   '*'                                    every column
 *   'id, name'                             those two, in that order
 *   'total:grand_total'                    a column under another key
 *   '*, items:order_items(product_id, qty)'
 *                                          every column, plus the order's items
 *                                          as a list under `items`
 *
 * That is the whole of what this codebase asks for, and the whole of what is
 * implemented. Casts, JSON paths, `!inner` and foreign-key hints are PostgREST
 * features nothing here uses; they are rejected rather than half-supported.
 */

export type SelectItem =
  | { kind: 'star' }
  | { kind: 'column'; name: string; alias: string }
  | { kind: 'embed'; table: string; alias: string; items: SelectItem[] };

export interface EmbedOrder {
  column: string;
  options: OrderOptions;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unsupported(select: string, token: string): never {
  throw new DbError({
    code: 'PGRST100',
    message: `"failed to parse select parameter (${select})": '${token}' is not supported by the query layer`,
  });
}

function splitTopLevel(s: string, select: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) unsupported(select, s);
  }
  if (depth !== 0) unsupported(select, s);
  parts.push(s.slice(start));
  return parts;
}

function parseItems(s: string, select: string): SelectItem[] {
  return splitTopLevel(s, select).map((token): SelectItem => {
    if (token === '*') return { kind: 'star' };

    const open = token.indexOf('(');
    if (open !== -1) {
      if (!token.endsWith(')')) unsupported(select, token);
      const head = token.slice(0, open);
      const [alias, table = alias] = head.split(':');
      if (!alias || !NAME.test(alias) || !NAME.test(table) || head.split(':').length > 2) unsupported(select, token);
      return { kind: 'embed', table, alias, items: parseItems(token.slice(open + 1, -1), select) };
    }

    const [alias, name = alias] = token.split(':');
    if (!alias || !NAME.test(alias) || !NAME.test(name) || token.split(':').length > 2) unsupported(select, token);
    return { kind: 'column', name, alias };
  });
}

export function parseSelect(select: string): SelectItem[] {
  // supabase-js strips whitespace before sending, so a select laid out over
  // several lines in the source is the same select.
  const compact = select.replace(/\s+/g, '');
  return parseItems(compact === '' ? '*' : compact, select);
}

function renderOrder(table: string, alias: string, orders: EmbedOrder[]): string {
  if (orders.length === 0) return '';
  const terms = orders.map(({ column, options }) => {
    columnType(table, column);
    const direction = options.ascending === false ? 'desc' : 'asc';
    const nulls = options.nullsFirst === undefined ? '' : options.nullsFirst ? ' nulls first' : ' nulls last';
    return `${alias}.${ident(column)} ${direction}${nulls}`;
  });
  return ` order by ${terms.join(', ')}`;
}

/**
 * The select list as SQL, for rows of `table` aliased `alias`.
 *
 * A child list is a correlated subquery aggregated to JSON, under the alias the
 * caller asked for — `items`, `packingItems` — so the response keeps the keys
 * it has today. `embedOrders` carries `.order(col, { referencedTable })`: the
 * order of the children inside each parent, keyed by the embed's alias or its
 * table name, whichever the caller used.
 */
export function renderSelectList(
  items: SelectItem[],
  table: string,
  alias: string,
  embedOrders: Map<string, EmbedOrder[]>,
  depth = 0,
): string {
  return items
    .map((item) => {
      if (item.kind === 'star') return `${alias}.*`;

      if (item.kind === 'column') {
        columnType(table, item.name);
        const col = `${alias}.${ident(item.name)}`;
        return item.alias === item.name ? col : `${col} as ${ident(item.alias)}`;
      }

      const rel = relationship(table, item.table);
      const child = `_e${depth}`;
      const inner = renderSelectList(item.items, item.table, child, embedOrders, depth + 1);
      const on = rel.childColumns
        .map((c, i) => `${child}.${ident(c)} = ${alias}.${ident(rel.parentColumns[i]!)}`)
        .join(' and ');
      const order = renderOrder(item.table, child, embedOrders.get(item.alias) ?? embedOrders.get(item.table) ?? []);
      const rows = `select ${inner} from ${tableRef(item.table)} as ${child} where ${on}`;

      return rel.kind === 'many'
        ? `coalesce((select json_agg(_r) from (${rows}${order}) as _r), '[]'::json) as ${ident(item.alias)}`
        : `(select row_to_json(_r) from (${rows} limit 1) as _r) as ${ident(item.alias)}`;
    })
    .join(', ');
}

export { renderOrder };
