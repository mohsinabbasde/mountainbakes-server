import { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import { financeCan, type FinancePermission } from '../shared';
import { getFinanceSettings } from '../services/finance-settings.service';

/**
 * Authorise a Finance Ledger request.
 *
 * This is `requireRole` one level up: the finance module's rules are not "which
 * role are you" but "which role are you AND what is this endpoint about". A
 * Finance Manager may approve a partner expense but not rewrite the share
 * percentages; an Accountant may raise the expense but not approve it; a Read
 * Only Auditor may see all of it and touch none of it.
 *
 * Super Admin is the interesting case and the reason this reads settings. The
 * brief says Admin may view reports but not modify finance records "unless
 * granted permission" — so `view` always passes for a super admin, and every
 * other permission is gated on the `allowSuperAdminWrite` toggle in Finance
 * Settings (off by default). That toggle is read per request rather than
 * captured at boot so revoking the grant takes effect immediately; the settings
 * read is served from the same 60-second in-process cache the rest of the app
 * uses, so it costs no round trip in the common case.
 *
 * Branch managers and production users never match — `financeCan` returns false
 * for them on every permission, including `view`.
 */
export function requireFinance(permission: FinancePermission) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const { allowSuperAdminWrite } = await getFinanceSettings();
      if (!financeCan(req.user.role, permission, allowSuperAdminWrite)) {
        // The message distinguishes "you are not in finance at all" from "you
        // are, but not at this level" — the second is a normal, recoverable
        // situation (ask an approver) and the user deserves to be told which.
        const inModule = req.user.role === 'super_admin' || req.user.role.startsWith('finance_') || req.user.role === 'accountant';
        res.status(403).json({
          error: inModule
            ? `Forbidden: your finance role may not ${permission} finance records.`
            : 'Forbidden: the Finance Ledger is restricted to Finance and Super Admin accounts.',
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * The Admin-verifies step in the branch-income workflow.
 *
 *   Branch closing → ADMIN VERIFIES → Finance approves → posted.
 *
 * Deliberately NOT `requireFinance('approve')`, for a reason that would
 * otherwise be a live bug: verification is the brief's *Admin* step, but
 * `allowSuperAdminWrite` defaults to OFF — so routing it through requireFinance
 * would lock the only role the workflow names out of the only step it names for
 * them, and every branch's income would sit at pending_verification forever.
 *
 * Verification moves no money (it advances a row from pending_verification to
 * pending_approval and posts nothing), so it is not a "modification of a finance
 * record" in the sense the toggle guards. Finance Admins and Managers may also
 * verify, so a finance team running without the admin step is not blocked.
 */
export function requireIncomeVerifier() {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const allowed = ['super_admin', 'finance_admin', 'finance_manager'];
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({
        error: 'Forbidden: only a Super Admin, Finance Admin or Finance Manager may verify branch income.',
      });
      return;
    }
    next();
  };
}
