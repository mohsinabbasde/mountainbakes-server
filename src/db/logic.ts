import { columnType, ident } from './catalog';
import { DbError } from './types';

/**
 * Filters: PostgREST's filter grammar in, a WHERE clause out.
 *
 * Two things arrive here. The typed builder calls (`.eq`, `.in`, `.is`, …)
 * become leaves directly. The strings — `.or('name.ilike.%a%,sku.ilike.%a%')`
 * and `.not('id', 'in', '(a,b)')` — are parsed with the same grammar PostgREST
 * applies to them, including where it REFUSES input: a search term containing a
 * comma splits the condition in two and is a parse error there, so it is a
 * parse error here, with the same code. Being more forgiving than the system
 * this replaces would change which requests fail, and nothing downstream
 * expects that.
 */

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'in' | 'is';

export type IsValue = 'null' | 'true' | 'false' | 'unknown';

export type Cond =
  | { column: string; op: Exclude<FilterOp, 'in' | 'is'>; negate: boolean; value: string }
  | { column: string; op: 'in'; negate: boolean; value: string[] }
  | { column: string; op: 'is'; negate: boolean; value: IsValue }
  | { join: 'and' | 'or'; negate: boolean; items: Cond[] };

const COMPARISON: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const OPS = new Set<string>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is']);

/** What a builder call was given, as the text PostgREST would have been sent. */
export function textOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isValue(raw: string, fail: () => never): IsValue {
  const v = raw.trim().toLowerCase();
  if (v === 'null' || v === 'true' || v === 'false' || v === 'unknown') return v;
  return fail();
}

class LogicParser {
  private i = 0;

  constructor(private readonly s: string) {}

  /**
   * The contents of `or=( … )`. In PostgREST's grammar the string sits inside
   * parentheses and is read up to the one that closes them — so an unquoted `)` in a
   * search term ends the filter there, and whatever followed it is silently
   * dropped rather than rejected. Reproduced, because it decides which rows a
   * search for `a)` returns today.
   */
  parseAll(): Cond[] {
    const items = this.list();
    this.ws();
    if (this.i < this.s.length && this.s[this.i] !== ')') this.fail();
    return items;
  }

  /** A bare `(a,b,"c d")`, as `in` takes it outside a logic tree. */
  parseList(): string[] {
    return this.listValue();
  }

  private fail(): never {
    throw new DbError({
      code: 'PGRST100',
      message: `"failed to parse logic tree ((${this.s}))" (line 1, column ${this.i + 2})`,
    });
  }

  private ws(): void {
    while (this.s[this.i] === ' ') this.i++;
  }

  private expect(ch: string): void {
    if (this.s[this.i] !== ch) this.fail();
    this.i++;
  }

  private take(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  private list(): Cond[] {
    const items = [this.node()];
    for (;;) {
      this.ws();
      if (this.s[this.i] !== ',') return items;
      this.i++;
      items.push(this.node());
    }
  }

  private node(): Cond {
    this.ws();
    const group = this.take(/(not\.)?(and|or) *\(/y);
    if (group) {
      const negate = group.startsWith('not.');
      const join = group.replace('not.', '').startsWith('and') ? 'and' : 'or';
      const items = this.list();
      this.ws();
      this.expect(')');
      return { join, negate, items };
    }

    const column = this.take(/[A-Za-z_][A-Za-z0-9_$]*/y);
    if (!column) this.fail();
    this.expect('.');
    const negate = this.take(/not\./y) !== null;
    const op = this.take(/[a-z]+/y);
    if (!op || !OPS.has(op)) this.fail();
    this.expect('.');

    if (op === 'in') return { column, op, negate, value: this.listValue() };
    const raw = this.singleValue();
    if (op === 'is') return { column, op, negate, value: isValue(raw, () => this.fail()) };
    return { column, op: op as Exclude<FilterOp, 'in' | 'is'>, negate, value: raw };
  }

  /** A double-quoted value, if one starts here and is followed by a delimiter. */
  private quoted(): string | null {
    if (this.s[this.i] !== '"') return null;
    let j = this.i + 1;
    let out = '';
    for (; j < this.s.length; j++) {
      const c = this.s[j]!;
      if (c === '\\' && j + 1 < this.s.length) {
        out += this.s[++j];
        continue;
      }
      if (c === '"') break;
      out += c;
    }
    if (this.s[j] !== '"') return null;
    const after = this.s[j + 1];
    if (after !== undefined && after !== ',' && after !== ')') return null;
    this.i = j + 1;
    return out;
  }

  /** Quoted, or everything up to the next `,` or `)`. */
  private singleValue(): string {
    return this.quoted() ?? this.take(/[^,)]*/y) ?? '';
  }

  listValue(): string[] {
    this.ws();
    this.expect('(');
    const values = [this.singleValue()];
    while (this.s[this.i] === ',') {
      this.i++;
      values.push(this.singleValue());
    }
    this.ws();
    this.expect(')');
    // `in.()` is how an empty list is spelled; it is not a list of one ''.
    return values.length === 1 && values[0] === '' ? [] : values;
  }
}

/** Parse the argument of `.or(...)`. */
export function parseLogic(input: string): Cond[] {
  return new LogicParser(input).parseAll();
}

const RESERVED = /[,()]/;

/**
 * `.in(column, values)`, by way of PostgREST's text form of the list.
 *
 * Going through that form rather than straight to a list keeps two behaviours
 * callers rely on: `in(col, [''])` is the EMPTY list (it is sent
 * as `in.()`), and a value is only quoted when it contains `,`, `(` or `)`.
 */
export function inFilter(column: string, values: readonly unknown[]): Cond {
  const wire = [...new Set(values)].map((v) => (typeof v === 'string' && RESERVED.test(v) ? `"${v}"` : textOf(v))).join(',');
  return { column, op: 'in', negate: false, value: new LogicParser(`(${wire})`).parseList() };
}

/**
 * `.not(column, operator, value)`. The value is in PostgREST's own syntax —
 * `null` for `is`, `(a,b,"c d")` for `in` — which is how every call site
 * already writes it.
 */
export function notFilter(column: string, operator: string, value: unknown): Cond {
  const fail = (): never => {
    throw new DbError({
      code: 'PGRST100',
      message: `"failed to parse filter (not.${operator}.${textOf(value)})" (line 1, column 1)`,
    });
  };
  if (!OPS.has(operator)) fail();
  const raw = textOf(value);
  if (operator === 'is') return { column, op: 'is', negate: true, value: isValue(raw, fail) };
  if (operator === 'in') return { column, op: 'in', negate: true, value: new LogicParser(raw).parseList() };
  return { column, op: operator as Exclude<FilterOp, 'in' | 'is'>, negate: true, value: raw };
}

export interface RenderContext {
  table: string;
  /** SQL alias of the row being filtered. */
  alias: string;
  /** Add a bound parameter; returns its bare placeholder (`$3`). */
  bind: (value: string) => string;
}

/**
 * One condition as SQL.
 *
 * Every value is bound as text and cast to the column's own type, which is
 * what PostgREST's untyped literals amount to: `branch_id = $1::text::uuid`.
 * A value that does not fit the type fails in Postgres with the same SQLSTATE
 * and message it always did.
 */
export function renderCond(cond: Cond, ctx: RenderContext): string {
  if ('join' in cond) {
    const inner = cond.items.map((c) => renderCond(c, ctx)).join(` ${cond.join} `);
    return cond.negate ? `not (${inner})` : `(${inner})`;
  }

  const type = columnType(ctx.table, cond.column);
  const col = `${ctx.alias}.${ident(cond.column)}`;
  let sql: string;

  switch (cond.op) {
    case 'is':
      sql = `${col} is ${cond.value}`;
      break;
    case 'in':
      // An empty list matches nothing — and, negated, everything.
      sql = cond.value.length === 0 ? 'false' : `${col} in (${cond.value.map((v) => `${ctx.bind(v)}::text::${type}`).join(', ')})`;
      break;
    case 'like':
    case 'ilike':
      // `*` is PostgREST's URL-safe spelling of `%`, accepted everywhere. The
      // pattern is the one parameter left untyped: Postgres then resolves the
      // operator from the column alone, and `ilike` on a uuid column is the
      // same "operator does not exist" it is through PostgREST.
      sql = `${col} ${cond.op} ${ctx.bind(cond.value.replace(/\*/g, '%'))}`;
      break;
    default:
      sql = `${col} ${COMPARISON[cond.op]} ${ctx.bind(cond.value)}::text::${type}`;
  }

  return cond.negate ? `not (${sql})` : sql;
}
