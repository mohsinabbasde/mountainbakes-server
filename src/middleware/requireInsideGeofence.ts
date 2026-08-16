import { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import { geofenceMessage } from '../shared';
import {
  checkGeofence,
  clientIp,
  logGeofenceCheck,
  positionFromRequest,
} from '../services/geofence.service';

/**
 * Refuse a request made from outside the caller's authorised branch area.
 *
 * Mounted per-route rather than globally, and that is deliberate: the rule applies
 * to *creating and changing* things, never to reading them. A branch manager stuck
 * in traffic must still be able to open reports, check stock figures, read
 * notifications and raise a help-desk ticket — see the "Allowed Features Outside
 * Radius" list in the specification. Blanket middleware would have taken all of
 * that away, so each guarded endpoint names itself.
 *
 * `action` is the label the attempt is logged under ('sale.create', 'order.create',
 * 'stock.return'). It is what makes the audit trail answer "what were they trying to
 * do" rather than just "they were somewhere".
 *
 * Runs AFTER authenticate + requireRole + validate, so by the time it fires the
 * identity is known and the body is already well-formed. Order matters for the log:
 * an attempt worth recording is one from a real, authorised user.
 */
export function requireInsideGeofence(action: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const headers = req.headers as unknown as Record<string, unknown>;
    const position = positionFromRequest(headers);

    // The branch the sale is FOR, not merely the one on the token. The routes
    // already refuse a branch manager acting for another branch, so for them the two
    // agree; taking it from the body keeps this correct for any endpoint where they
    // could legitimately differ.
    const bodyBranchId =
      typeof (req.body as { branchId?: unknown } | undefined)?.branchId === 'string'
        ? (req.body as { branchId: string }).branchId
        : null;
    const branchId = bodyBranchId ?? user.branchId;

    let checked;
    try {
      checked = await checkGeofence({ branchId, role: user.role, position });
    } catch (err) {
      // A geofence that cannot be READ is not a geofence that has been satisfied.
      // Failing open here would make "make the database blink" a bypass; 503 tells
      // the client to retry rather than pretending the check passed.
      console.error('[geofence] check failed', err);
      res.status(503).json({
        error: 'Could not verify your location right now. Please try again in a moment.',
      });
      return;
    }

    const { verdict, geofence } = checked;

    // Fire-and-forget: the log must not add latency to a sale, and its failure is
    // already handled inside logGeofenceCheck.
    void logGeofenceCheck({
      action,
      verdict,
      position,
      branchId,
      branchName: geofence?.branchName ?? user.branchName,
      userId: user.uid,
      userName: user.email,
      userRole: user.role,
      ipAddress: clientIp(headers, req.ip),
      userAgent: typeof headers['user-agent'] === 'string' ? (headers['user-agent'] as string) : null,
    });

    if (verdict.allowed) {
      next();
      return;
    }

    // 403 rather than 400: the request is perfectly well-formed, the caller is
    // simply not permitted to make it from where they are.
    //
    // The body carries the numbers as well as the message so a client can render
    // its own layout without re-deriving them, and `geofenceMessage` is the SAME
    // text the browser would have shown had it blocked first — a user who gets past
    // the screen sees no new wording from the server.
    res.status(403).json({
      error: geofenceMessage(verdict),
      geofence: {
        outcome: verdict.outcome,
        distanceKm: verdict.distanceKm,
        radiusKm: verdict.radiusKm,
      },
    });
  };
}
