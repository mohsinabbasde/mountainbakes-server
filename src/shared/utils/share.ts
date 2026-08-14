/**
 * The company/branch income split.
 *
 * There are two places a percentage can come from — the global
 * `finance_settings.company_share_pct` and a per-branch override on
 * `branches.company_share_pct` — and four screens plus three server paths that
 * have to agree on how they combine. That resolution lives here, in shared, so
 * the form previewing the split and the approval posting it cannot disagree.
 *
 * Two invariants, both load-bearing:
 *
 *   * The branch share is DERIVED (100 − company), never stored or typed
 *     alongside. Two independently-edited numbers is how a split silently stops
 *     summing to 100 and starts creating or destroying income at the boundary.
 *   * `null` on a branch means "inherit", not "zero". A branch that has never
 *     been given its own percentage must follow the default when the default
 *     changes; a branch explicitly set to the same number as the default must
 *     not. Only a nullable column can tell those apart — see migration 68.
 */

/** How one branch's collection is split, and where the percentage came from. */
export interface ShareSplit {
  companySharePct: number;
  branchSharePct: number;
  /** True when the branch carries its own percentage rather than inheriting. */
  isOverride: boolean;
}

/** Kept in step with the server's `round2` — money is compared across both. */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** A percentage that is present, numeric and inside 0–100. */
function isUsablePct(value: unknown): value is number {
  const n = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * Resolve the split for one branch.
 *
 * `branchCompanySharePct` is the branch's own column (null when it inherits);
 * `defaultCompanySharePct` is the global finance setting. A stored value
 * outside 0–100 — which the CHECK constraints make unreachable through the API,
 * but a hand-run SQL statement does not — falls back to the default rather than
 * posting a nonsense share.
 */
export function resolveShareSplit(
  branchCompanySharePct: number | null | undefined,
  defaultCompanySharePct: number,
): ShareSplit {
  const isOverride = isUsablePct(branchCompanySharePct);
  const fallback = isUsablePct(defaultCompanySharePct) ? Number(defaultCompanySharePct) : 0;
  const companySharePct = round2(isOverride ? Number(branchCompanySharePct) : fallback);

  return {
    companySharePct,
    branchSharePct: round2(100 - companySharePct),
    isOverride,
  };
}

/**
 * Split an amount by a company percentage.
 *
 * The branch share is `base − companyShare`, not a second multiplication: at
 * 33.33/66.67 two independent roundings can leave the pair a paisa short of the
 * base, and a ledger that is a paisa out is a ledger nobody trusts. Same
 * reasoning as `splitByAccount` in finance-income.service.ts.
 */
export function splitShare(base: number, companySharePct: number): { companyShare: number; branchShare: number } {
  const companyShare = round2((Number(base) * Number(companySharePct)) / 100);
  return { companyShare, branchShare: round2(Number(base) - companyShare) };
}

/** "70 / 30" — the one label every screen showing a split renders. */
export function formatShareSplit(split: ShareSplit): string {
  const trim = (n: number) => String(Number(n.toFixed(2)));
  return `${trim(split.companySharePct)} / ${trim(split.branchSharePct)}`;
}
