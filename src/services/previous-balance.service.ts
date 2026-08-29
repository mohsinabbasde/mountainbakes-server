import { supabaseAdmin } from '../config/supabase';
import { resolveShareSplit } from '../shared';

/**
 * What a branch owes for the delivery immediately preceding a given production
 * order — the figures the company copy of that order's slip prints.
 *
 * Extracted verbatim from GET /api/production-orders/:id/previous-balance so the
 * Collections export can bill exactly what the slip bills. It is deliberately
 * NOT re-derived there: the returns/discounts window below is bounded by the two
 * orders' `submitted_at` timestamps, and the comments on it record two separate
 * bugs caused by a day-based window instead. One implementation, one set of
 * windows, no drift between the slip and the spreadsheet.
 */
export interface PreviousOrderBalance {
  previous: { demandNumber: string; date: string } | null;
  deliveredValue: number;
  companySharePct: number;
  companyShareValue: number;
  returnsValue: number;
  returnItems: { productName: string; qty: number; amount: number }[];
  discountsValue: number;
  discountItems: { demandNumber: string; amount: number }[];
  amountToCollect: number;
}

// GET /api/production-orders/:id/previous-balance — what the branch owes for its
// PREVIOUS delivery, for the company copy of this order's slip.
//
// Deliberately NOT production_balances: that table is unmet demand (goods the
// branch asked for and Production could not supply), i.e. value owed TO the
// branch — the opposite direction from a receivable.
//
// Bills the IMMEDIATELY PRECEDING delivered order, not the previous business
// day's total, and that distinction is load-bearing: branches routinely take
// several deliveries in one day (four on 2026-08-09 for one branch). Billing a
// day's total would reprint the same figure on every slip that day and invite
// collecting it more than once, whereas chaining slip→previous order bills each
// delivery exactly once. The tradeoff accepted here is that a slip can bill
// goods delivered only hours earlier rather than strictly "yesterday".
//
// Computed server-side because the company share lives in finance_settings (and
// per branch on branches.company_share_pct), and production users have no access
// to the finance module at any layer — only the service-role client can read it.
// The money maths stays server-side with it.
//
// NOTE: nothing records whether a previous order was actually settled, so this
// reports the same figure on every reprint. It is a "what this order was worth"
// statement, not a live outstanding balance.
//
// Returns null when the order id does not exist (the route turns that into a 404).
export async function getPreviousOrderBalance(orderId: string): Promise<PreviousOrderBalance | null> {
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('production_orders')
    .select('id, branch_id, business_date, submitted_at')
    .eq('id', orderId)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order) return null;

  // Only a DELIVERED order can be owed for. 'pending' shipped nothing yet and
  // 'rejected' never will, so both are skipped when walking back.
  const { data: prev, error: prevErr } = await supabaseAdmin
    .from('production_orders')
    .select('id, demand_number, business_date, submitted_at, items:production_order_items(product_id, approved_qty)')
    .eq('branch_id', order.branch_id)
    .in('status', ['awaiting_verification', 'approved'])
    .lt('submitted_at', order.submitted_at)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevErr) throw prevErr;

  // The branch's own percentage where it has one, the global finance setting
  // where it does not (migration 68) — the same resolution branch-income
  // approval uses, so the slip bills at the terms the branch is actually on.
  const [{ data: fin, error: finErr }, { data: branchRow, error: branchErr }] = await Promise.all([
    supabaseAdmin.from('finance_settings').select('company_share_pct').maybeSingle(),
    supabaseAdmin.from('branches').select('company_share_pct').eq('id', order.branch_id).maybeSingle(),
  ]);
  if (finErr) throw finErr;
  if (branchErr) throw branchErr;
  const { companySharePct } = resolveShareSplit(
    (branchRow?.company_share_pct ?? null) as number | null,
    Number(fin?.company_share_pct ?? 75),
  );

  if (!prev) {
    return {
      previous: null, deliveredValue: 0, companySharePct,
      companyShareValue: 0, returnsValue: 0, returnItems: [],
      discountsValue: 0, discountItems: [], amountToCollect: 0,
    };
  }

  const prevItems = (prev.items ?? []) as { product_id: string | null; approved_qty: number | string | null }[];
  const productIds = [...new Set(prevItems.map((i) => i.product_id).filter((p): p is string => !!p))];

  let deliveredValue = 0;
  if (productIds.length > 0) {
    const { data: products, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id, price')
      .in('id', productIds);
    if (prodErr) throw prodErr;
    const priceById = new Map((products ?? []).map((p) => [p.id as string, Number(p.price ?? 0)]));
    deliveredValue = prevItems.reduce(
      (a, i) => a + Number(i.approved_qty ?? 0) * (i.product_id ? (priceById.get(i.product_id) ?? 0) : 0),
      0,
    );
  }

  // Returns that came back during the period this slip bills for: after the
  // previous order was placed, up to and including this one.
  //
  // Windowed on the billing period rather than on "the previous calendar day",
  // which is what this did first and which was wrong twice over. Branches take
  // several deliveries a day, so a day-based rule (a) credited returns against
  // an order they had nothing to do with, and worse (b) re-credited the SAME
  // returns on every slip of that day — four orders, one return deducted four
  // times. Bounding by the two orders' timestamps partitions returns exactly:
  // each falls in one window, so it is deducted once and never lost.
  const { data: returns, error: retErr } = await supabaseAdmin
    .from('production_returns')
    .select('product_id, product_name, qty')
    .eq('branch_id', order.branch_id)
    .eq('status', 'accepted')
    .gt('created_at', prev.submitted_at)
    .lte('created_at', order.submitted_at);
  if (retErr) throw retErr;

  let returnsValue = 0;
  let returnItems: { productName: string; qty: number; amount: number }[] = [];
  const returnRows = (returns ?? []) as { product_id: string; product_name: string; qty: number | string }[];
  if (returnRows.length > 0) {
    const retIds = [...new Set(returnRows.map((r) => r.product_id))];
    const { data: retProducts, error: retProdErr } = await supabaseAdmin
      .from('products')
      .select('id, price')
      .in('id', retIds);
    if (retProdErr) throw retProdErr;
    const retPriceById = new Map((retProducts ?? []).map((p) => [p.id as string, Number(p.price ?? 0)]));
    // Itemised here rather than re-derived on the client, so the lines the slip
    // prints are by construction the ones the total was built from.
    returnItems = returnRows.map((r) => ({
      productName: r.product_name,
      qty: Number(r.qty ?? 0),
      amount: Number(r.qty ?? 0) * (retPriceById.get(r.product_id) ?? 0),
    }));
    returnsValue = returnItems.reduce((a, r) => a + r.amount, 0);
  }

  // Approved discount claims falling in the SAME billing window as the returns
  // above — after the previous order, up to and including this one.
  //
  // Windowed identically on purpose, and the reasoning the returns block sets
  // out applies unchanged: a day-based rule would re-deduct the same claim on
  // every slip of a day a branch took several deliveries. Bounding by the two
  // orders' timestamps partitions claims exactly, so each is deducted once and
  // none is lost.
  //
  // 'approved' only. A claim still pending is one Production has not agreed to,
  // and netting it off the collection would hand the branch money on a decision
  // nobody has taken; a rejected or sent-back one is not owed at all.
  //
  // No price lookup, unlike returns: a claim IS an amount. There are no units to
  // value, which is why the printed line carries money alone where Less Returns
  // carries `qty · money`.
  const { data: discounts, error: discErr } = await supabaseAdmin
    .from('branch_discounts')
    .select('demand_number, amount')
    .eq('branch_id', order.branch_id)
    .eq('status', 'approved')
    .gt('created_at', prev.submitted_at)
    .lte('created_at', order.submitted_at);
  if (discErr) throw discErr;

  // Itemised here rather than re-derived on the client, for the reason the
  // return items are: the lines the slip prints are then by construction the
  // ones the total was built from, and cannot drift from it.
  const discountItems = ((discounts ?? []) as { demand_number: string | null; amount: number | string }[]).map(
    (d) => ({ demandNumber: d.demand_number ?? '—', amount: Number(d.amount ?? 0) }),
  );
  const discountsValue = discountItems.reduce((a, d) => a + d.amount, 0);

  const companyShareValue = (deliveredValue * companySharePct) / 100;

  return {
    previous: { demandNumber: prev.demand_number, date: prev.business_date },
    deliveredValue,
    companySharePct,
    companyShareValue,
    returnsValue,
    returnItems,
    discountsValue,
    discountItems,
    // Both deductions come off the company's share. A discount reduces what the
    // rider collects exactly as a return does — the only difference is that one
    // is goods coming back and the other is money agreed off.
    amountToCollect: companyShareValue - returnsValue - discountsValue,
  };
}
