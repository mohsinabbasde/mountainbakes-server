import { z } from 'zod';
import { DAILY_SALE_AMEND_FIELDS, DAILY_SALE_MANUAL_METHODS } from '../types/daily-sale.types';

// ── Daily Sale Record ────────────────────────────────────────────────────────
//
// `branchId` is OPTIONAL in every schema here and means one thing only: the
// branch a SUPER ADMIN is acting on. A branch role's own branch comes off the
// JWT and its `branchId` is discarded — the same rule CreateBranchDiscountSchema
// follows, for the same reason. A branch that could name its own branch could
// name someone else's.
//
// No schema here accepts an auto figure, a difference or a status. Auto figures
// are aggregated in Postgres from `orders`; differences are generated columns;
// the status is moved by the two decision endpoints. There is deliberately no
// shape in which a client can send a total (§24).

/** 'YYYY-MM-DD', and a day that actually exists. */
const businessDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a business date as YYYY-MM-DD')
  .refine((s) => {
    // '2026-02-31' parses and rolls into March rather than failing, so the round
    // trip back to a string is what catches a date that does not exist — the
    // same check `optionalBusinessDate` makes.
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That date does not exist');

/**
 * A counted amount: zero or more, to two decimal places.
 *
 * **Zero is allowed, and that is the whole point** — an empty drawer is a real
 * count and the one figure a `.positive()` would refuse. Absence is expressed by
 * omitting the field, not by sending 0; the record's null column is what "not
 * counted" means (see DailySaleRecord.manualCash).
 *
 * `.multipleOf(0.01)` because the column is numeric(14,2) and would silently
 * round a third decimal — refusing it here is the difference between somebody
 * fixing a digit and the record quietly disagreeing with what they typed. The
 * cap is a fat-finger guard, not a policy limit: it catches the missing decimal
 * point that turns 4,500 into 450,000 on a screen somebody is typing quickly.
 */
const countedAmount = z
  .number()
  .min(0, 'A counted amount cannot be negative')
  .max(100_000_000, 'That amount looks wrong — check the figure')
  .multipleOf(0.01, 'An amount can have at most 2 decimal places');

/** POST — create or refresh one day's record. Idempotent server-side (§14). */
export const GenerateDailySaleRecordSchema = z.object({
  businessDate,
  branchId: z.string().uuid().optional(),
});

/**
 * PUT — record what was physically counted (§7, §8).
 *
 * Every method is optional so a partial count is one call per figure rather than
 * a re-key of all three: cash goes in when the drawer is counted, bank when the
 * slip arrives. An omitted method leaves its stored count alone.
 *
 * Foodpanda has no field here, matching DAILY_SALE_MANUAL_METHODS: the aggregator
 * settles it and there is nothing at the counter to count, so the only figure
 * anybody could enter is the system's own — which is not a verification.
 *
 * `.refine` rather than a `.min(1)` on the object, because at least one figure
 * has to arrive and Zod cannot say that structurally. Without it an empty body
 * would reach the RPC and be refused there, one round trip later, with a message
 * the form could not point at a field.
 */
export const FeedDailySaleRecordSchema = z
  .object({
    businessDate,
    branchId: z.string().uuid().optional(),
    cash: countedAmount.optional(),
    easypaisa: countedAmount.optional(),
    bank: countedAmount.optional(),
  })
  .refine((v) => v.cash !== undefined || v.easypaisa !== undefined || v.bank !== undefined, {
    message: 'Enter at least one counted amount',
    path: ['cash'],
  });

/**
 * PUT — unlock a closed record.
 *
 * The reason is MANDATORY and cannot be blank. §11 requires every unlock to be
 * recorded with its reason, and "Admin unlocked this record" on its own answers
 * nothing six weeks later. `decide_daily_sale_record` refuses a blank one too —
 * this is the copy that can name the field.
 */
export const UnlockDailySaleRecordSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this record is being unlocked').max(500),
});

/**
 * PUT — amend a figure on a closed record (§16).
 *
 * Only a counted figure is amendable; `DAILY_SALE_AMEND_FIELDS` is the list and
 * it contains no auto column. An auto figure is derived from `orders`, so a wrong
 * one is a wrong sale — corrected by correcting the sale, never by overwriting
 * the reconciliation.
 *
 * The old value is not sent and could not be trusted if it were: the RPC reads it
 * off the row it is about to change, in the same transaction, and writes both
 * halves to the history.
 */
export const AmendDailySaleRecordSchema = z.object({
  field: z.enum(DAILY_SALE_AMEND_FIELDS),
  amount: countedAmount,
  reason: z.string().trim().min(3, 'Say why this figure is being amended').max(500),
});

/**
 * PUT — an admin sets one payment method's lock for one branch (§10-§12).
 *
 * `branchId` is REQUIRED here, unlike everywhere else in this file: only an admin
 * may call it, an admin has no branch of their own, and a lock that silently
 * applied to "whichever branch" is not a configuration anybody could reason
 * about.
 *
 * 'staff' is not in `DAILY_SALE_MANUAL_METHODS` and so cannot be sent — a staff
 * sale takes no money and has nothing to reconcile. Foodpanda IS in
 * `paymentMethod` below even though it has no manual field, because §12 is
 * explicit that the configuration must be able to say something about all four
 * rather than hardcode one of them shut.
 */
export const SetPaymentMethodLockSchema = z.object({
  branchId: z.string().uuid('Pick a branch'),
  paymentMethod: z.enum(['cash', 'easypaisa', 'foodpanda', 'bank_account']),
  isLocked: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/** The methods a manual feed may name — exported so a form can iterate one list. */
export const ManualMethodSchema = z.enum(DAILY_SALE_MANUAL_METHODS);

export type GenerateDailySaleRecordInput = z.infer<typeof GenerateDailySaleRecordSchema>;
export type FeedDailySaleRecordInput = z.infer<typeof FeedDailySaleRecordSchema>;
export type UnlockDailySaleRecordInput = z.infer<typeof UnlockDailySaleRecordSchema>;
export type AmendDailySaleRecordInput = z.infer<typeof AmendDailySaleRecordSchema>;
export type SetPaymentMethodLockInput = z.infer<typeof SetPaymentMethodLockSchema>;
