import { ident, resolveFunction } from './catalog';
import { failed, ok, toDbError } from './errors';
import type { DbResult, Executor } from './types';

/**
 * Call one of the database's functions by name, with named arguments.
 *
 * The business rules that must be atomic — committing a sale, moving stock,
 * posting to the ledger — are plpgsql functions, and they stay exactly where
 * they are. This is only the call: `rpc('commit_sale', { p_order, p_items })`
 * becomes `select public.commit_sale(p_order => …, p_items => …)`.
 *
 * ARGUMENTS travel as one JSON document and are read back out with
 * `json_to_record`, each as the type the function declares for it. That is how
 * PostgREST passes them, and it is what makes a JS array arrive as `uuid[]` and
 * a JS object as `jsonb` without this file knowing how to spell either. An
 * argument left out (or `undefined`) is not passed at all, so the function's
 * own default applies.
 *
 * THE RESULT has the shape PostgREST gives it, which depends on what the
 * function returns:
 *
 *   returns jsonb / text / uuid / …   that value
 *   returns <row type>                one object
 *   returns setof … / table(…)        a list
 *   returns void                      null
 *
 * A `raise exception` inside the function comes back as `{ error }` with its
 * SQLSTATE and its message untouched.
 */
export async function runRpc<T>(
  executor: Executor,
  fn: string,
  args: Record<string, unknown> = {},
  maxRows: number,
): Promise<DbResult<T>> {
  try {
    const names = Object.keys(args).filter((k) => args[k] !== undefined);
    const info = resolveFunction(fn, names);
    const typeOf = new Map(info.args.map((a) => [a.name, a.type]));

    const params: unknown[] = [];
    let input = '';
    if (names.length > 0) {
      params.push(JSON.stringify(Object.fromEntries(names.map((n) => [n, args[n]]))));
      input = `json_to_record($1::text::json) as _a(${names.map((n) => `${ident(n)} ${typeOf.get(n)}`).join(', ')})`;
    }
    const call = `"public".${ident(fn)}(${names.map((n) => `${ident(n)} => _a.${ident(n)}`).join(', ')})`;
    const fromInput = input ? ` from ${input}` : '';
    const lateral = input ? `${input} cross join lateral ` : '';

    let sql: string;
    if (info.returns === 'void') {
      sql = `select (${call})::text as r${fromInput}`;
    } else if (info.returnsSet) {
      const rows =
        info.returns === 'composite'
          ? `select _f.* from ${lateral}${call} as _f limit ${maxRows}`
          : `select _f._v from ${lateral}${call} as _f(_v) limit ${maxRows}`;
      const element = info.returns === 'composite' ? '_r' : '_r._v';
      sql = `select coalesce(json_agg(${element}), '[]'::json) as r from (${rows}) as _r`;
    } else if (info.returns === 'composite') {
      sql = `select row_to_json(_f) as r from ${lateral}${call} as _f`;
    } else {
      sql = `select to_json(${call}) as r${fromInput}`;
    }

    const [row] = await executor.query(sql, params);
    return ok((info.returns === 'void' ? null : (row?.['r'] ?? null)) as T | null);
  } catch (e) {
    return failed(toDbError(e));
  }
}
