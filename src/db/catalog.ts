import generated from './catalog.generated.json';
import { DbError } from './types';

/**
 * What the query layer knows about the database — see scripts/gen-db-catalog.ts
 * for where it comes from and why it is also the allowlist.
 *
 * Every identifier that reaches generated SQL is looked up here first and
 * quoted on the way out. A name that is not in the catalog produces the error
 * PostgREST would have produced, never a query.
 */

export interface TableInfo {
  /** Column → type, without a length or precision (`numeric`, not `numeric(12,2)`). */
  columns: Record<string, string>;
  pk: string[];
  unique: string[][];
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface FunctionInfo {
  name: string;
  args: Array<{ name: string; type: string; hasDefault: boolean }>;
  returnsSet: boolean;
  /** 'v' may write; 's' (stable) and 'i' (immutable) only read. */
  volatility: 'v' | 's' | 'i';
  returns: 'scalar' | 'composite' | 'void';
  returnType: string;
}

export interface Catalog {
  tables: Record<string, TableInfo>;
  foreignKeys: ForeignKey[];
  functions: Record<string, FunctionInfo[]>;
}

let current = generated as unknown as Catalog;

export function catalog(): Catalog {
  return current;
}

/** Tests run against a handful of stub tables, not the production schema. */
export function setCatalog(next: Catalog): void {
  current = next;
}

export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function tableRef(table: string): string {
  return `"public".${ident(table)}`;
}

export function tableInfo(table: string): TableInfo {
  const info = Object.prototype.hasOwnProperty.call(current.tables, table) ? current.tables[table] : undefined;
  if (!info) {
    throw new DbError({
      code: 'PGRST205',
      message: `Could not find the table 'public.${table}' in the schema cache`,
    });
  }
  return info;
}

export function columnType(table: string, column: string): string {
  const info = tableInfo(table);
  const type = Object.prototype.hasOwnProperty.call(info.columns, column) ? info.columns[column] : undefined;
  if (!type) {
    throw new DbError({ code: '42703', message: `column ${table}.${column} does not exist` });
  }
  return type;
}

export type Relationship =
  | { kind: 'many'; parentColumns: string[]; childColumns: string[] }
  | { kind: 'one'; parentColumns: string[]; childColumns: string[] };

/**
 * How `child` hangs off `parent` in an embedded select such as
 * `items:order_items(...)` on `orders`.
 *
 *   many  the child rows point at the parent (order_items.order_id → orders.id)
 *         and the embed is a list
 *   one   the parent points at the child (orders.branch_id → branches.id), or
 *         the child's foreign key is itself unique, and the embed is one
 *         object or null
 *
 * Exactly one foreign key must connect the two. PostgREST refuses to guess
 * between several (PGRST201) and so does this.
 */
export function relationship(parent: string, child: string): Relationship {
  tableInfo(parent);
  // A child that is not a table at all is reported as a missing relationship,
  // not a missing table — it is the embed that is wrong.
  const childInfo = Object.prototype.hasOwnProperty.call(current.tables, child) ? current.tables[child]! : null;

  const toMany = current.foreignKeys.filter((fk) => fk.table === child && fk.refTable === parent);
  const toOne = current.foreignKeys.filter((fk) => fk.table === parent && fk.refTable === child);
  const found = toMany.length + toOne.length;

  if (found === 0 || !childInfo) {
    throw new DbError({
      code: 'PGRST200',
      message: `Could not find a relationship between '${parent}' and '${child}' in the schema cache`,
    });
  }
  if (found > 1) {
    throw new DbError({
      code: 'PGRST201',
      message: `Could not embed because more than one relationship was found for '${parent}' and '${child}'`,
    });
  }

  if (toOne.length === 1) {
    const fk = toOne[0]!;
    return { kind: 'one', parentColumns: fk.columns, childColumns: fk.refColumns };
  }

  const fk = toMany[0]!;
  // A child that can exist at most once per parent is embedded as an object.
  const single = childInfo.unique.some((key) => key.every((col) => fk.columns.includes(col)));
  return { kind: single ? 'one' : 'many', parentColumns: fk.refColumns, childColumns: fk.columns };
}

/**
 * The function a named-argument call resolves to: every argument supplied is
 * one it declares, and every one it declares without a default was supplied.
 */
export function resolveFunction(name: string, argNames: string[]): FunctionInfo {
  const overloads = Object.prototype.hasOwnProperty.call(current.functions, name) ? current.functions[name]! : [];
  const match = overloads.filter((fn) => {
    const declared = new Set(fn.args.map((a) => a.name));
    return argNames.every((n) => declared.has(n)) && fn.args.every((a) => a.hasDefault || argNames.includes(a.name));
  });
  if (match.length === 1) return match[0]!;

  const signature = argNames.length > 0 ? `public.${name}(${[...argNames].sort().join(', ')})` : `public.${name} without parameters`;
  if (match.length > 1) {
    throw new DbError({
      code: 'PGRST203',
      message: `Could not choose the best candidate function between overloads of ${signature}`,
    });
  }
  throw new DbError({
    code: 'PGRST202',
    message: `Could not find the function ${signature} in the schema cache`,
    details:
      `Searched for the function public.${name} ` +
      (argNames.length > 0 ? `with parameter${argNames.length > 1 ? 's' : ''} ${[...argNames].sort().join(', ')}` : 'without parameters') +
      `, but no matches were found in the schema cache.`,
  });
}
