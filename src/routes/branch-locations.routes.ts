import { Router } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { authenticate, type AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import {
  UpsertBranchLocationSchema,
  UpdateBranchLocationStatusSchema,
  type BranchLocationRow,
  type BranchLocationStats,
} from '../shared';
import { rowToApi } from '../utils/case';
import { getAppSettings } from '../services/settings.service';
import {
  checkGeofence,
  clientIp,
  invalidateBranchGeofences,
  logGeofenceCheck,
  positionFromRequest,
} from '../services/geofence.service';
import { logAudit, resolveAdminName } from '../services/audit.service';

export const router = Router();

router.use(authenticate);

/** Shape of a `branch_locations` row as selected below. */
type LocationRow = {
  id: string;
  branch_id: string;
  branch_name: string | null;
  address: string | null;
  latitude: string | number;
  longitude: string | number;
  radius_km: string | number;
  google_place_id: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * numeric columns arrive from supabase-js as STRINGS.
 *
 * Postgres `numeric` has no lossless JavaScript representation, so PostgREST plays
 * safe and serialises it as text. Left alone it reaches the browser as "24.8607"
 * and every distance calculation silently produces NaN — the geofence then reads as
 * "not configured" and quietly stops enforcing. Converted once, here, at the edge.
 */
function toApiLocation(row: LocationRow) {
  return {
    ...rowToApi<Record<string, unknown>>(row),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusKm: Number(row.radius_km),
  };
}

/**
 * GET /api/branch-locations
 *
 * Every branch, each with its location or null — NOT just the configured ones. The
 * "Missing GPS" tile counts the nulls, so a branch without a geofence has to be in
 * the list rather than filtered out of it.
 */
router.get('/', requireRole('super_admin'), async (_req: AuthRequest, res, next) => {
  try {
    const [branchesRes, locationsRes, settings] = await Promise.all([
      supabaseAdmin.from('branches').select('id, name, address, is_active').order('name'),
      supabaseAdmin.from('branch_locations').select('*'),
      getAppSettings(),
    ]);
    if (branchesRes.error) throw branchesRes.error;
    if (locationsRes.error) throw locationsRes.error;

    const byBranch = new Map<string, LocationRow>(
      (locationsRes.data ?? []).map((row) => [(row as LocationRow).branch_id, row as LocationRow]),
    );

    const branches = (branchesRes.data ?? []) as {
      id: string;
      name: string;
      address: string | null;
      is_active: boolean;
    }[];

    const rows: BranchLocationRow[] = branches.map((b) => {
      const row = byBranch.get(b.id);
      return {
        branchId: b.id,
        branchName: b.name,
        branchAddress: b.address ?? '',
        branchIsActive: b.is_active,
        location: row ? (toApiLocation(row) as BranchLocationRow['location']) : null,
      };
    });

    // "Online" is the last verification interval, doubled — one missed tick is a
    // phone that slept or a tab that lost focus, not a user who has gone home.
    const windowMs = settings.geofenceVerifyIntervalMin * 2 * 60_000;
    const since = new Date(Date.now() - windowMs).toISOString();

    const { data: recent, error: recentError } = await supabaseAdmin
      .from('geofence_logs')
      .select('user_id, allowed, created_at')
      .gte('created_at', since)
      .not('user_id', 'is', null);
    if (recentError) throw recentError;

    // Latest row per user, so someone who walked back inside counts as inside. The
    // query is already ordered by nothing in particular, hence the explicit compare.
    const latestByUser = new Map<string, { allowed: boolean; at: string }>();
    for (const r of (recent ?? []) as { user_id: string; allowed: boolean; created_at: string }[]) {
      const prev = latestByUser.get(r.user_id);
      if (!prev || r.created_at > prev.at) {
        latestByUser.set(r.user_id, { allowed: r.allowed, at: r.created_at });
      }
    }

    const configured = rows.filter((r) => r.location !== null).length;
    const stats: BranchLocationStats = {
      totalBranches: rows.length,
      activeBranches: rows.filter((r) => r.branchIsActive).length,
      gpsConfigured: configured,
      missingGps: rows.length - configured,
      onlineUsers: latestByUser.size,
      usersOutsideRadius: [...latestByUser.values()].filter((v) => !v.allowed).length,
    };

    res.json({ branches: rows, stats, geofencingEnabled: settings.geofencingEnabled });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/branch-locations/me
 *
 * The caller's OWN branch geofence plus the settings the client needs to run its
 * copy of the check — radius, verification interval, GPS timeout, accuracy rule.
 *
 * Open to every authenticated role rather than gated to branch managers: an admin
 * or production user hitting it simply gets `exempt: true` and no coordinates,
 * which is what lets one provider mount unconditionally on the dashboard layout
 * instead of every consumer branching on role first.
 */
router.get('/me', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const settings = await getAppSettings();
    const position = positionFromRequest(req.headers as unknown as Record<string, unknown>);
    const { verdict, geofence } = await checkGeofence({
      branchId: user.branchId,
      role: user.role,
      position,
    });

    res.json({
      exempt: verdict.outcome === 'exempt',
      enabled: settings.geofencingEnabled,
      branch: geofence
        ? {
            branchId: geofence.branchId,
            branchName: geofence.branchName,
            latitude: geofence.centre.latitude,
            longitude: geofence.centre.longitude,
            radiusKm: geofence.radiusKm,
          }
        : null,
      verdict,
      config: {
        verifyIntervalMin: settings.geofenceVerifyIntervalMin,
        requireHighAccuracy: settings.geofenceRequireHighAccuracy,
        gpsTimeoutSec: settings.geofenceGpsTimeoutSec,
        maxPositionAgeSec: settings.geofenceMaxPositionAgeSec,
        defaultRadiusKm: settings.geofenceDefaultRadiusKm,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/branch-locations/logs — the audit trail, newest first.
 *
 * `?blockedOnly=true` is backed by the partial index from migration 48; the
 * unfiltered listing is capped because this table grows with every sale.
 */
router.get('/logs', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(Number(req.query['limit']) || 100, 500);
    let query = supabaseAdmin
      .from('geofence_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (req.query['branchId']) query = query.eq('branch_id', String(req.query['branchId']));
    if (req.query['userId']) query = query.eq('user_id', String(req.query['userId']));
    if (req.query['blockedOnly'] === 'true') query = query.eq('allowed', false);

    const { data, error } = await query;
    if (error) throw error;

    const logs = (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        ...rowToApi<Record<string, unknown>>(r),
        latitude: r['latitude'] != null ? Number(r['latitude']) : null,
        longitude: r['longitude'] != null ? Number(r['longitude']) : null,
        distanceKm: r['distance_km'] != null ? Number(r['distance_km']) : null,
        radiusKm: r['radius_km'] != null ? Number(r['radius_km']) : null,
      };
    });

    res.json({ logs, total: logs.length });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/branch-locations/:branchId — set or replace a branch's location.
 *
 * Upsert rather than POST/PATCH: one geofence per branch (unique constraint in
 * migration 48), so the caller should not have to know whether one exists yet.
 */
router.put('/:branchId', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const parsed = UpsertBranchLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.errors });
      return;
    }

    const branchId = req.params['branchId']!;
    const { data: branch, error: branchError } = await supabaseAdmin
      .from('branches')
      .select('id, name')
      .eq('id', branchId)
      .maybeSingle();
    if (branchError) throw branchError;
    if (!branch) { res.status(404).json({ error: 'Branch not found' }); return; }

    const { latitude, longitude, address, radiusKm, googlePlaceId, isActive } = parsed.data;

    const { data, error } = await supabaseAdmin
      .from('branch_locations')
      .upsert(
        {
          branch_id: branchId,
          // Re-stamped on every write so the cache cannot outlive a branch rename.
          branch_name: (branch as { name: string }).name,
          address,
          latitude,
          longitude,
          radius_km: radiusKm,
          google_place_id: googlePlaceId ?? null,
          ...(isActive === undefined ? {} : { is_active: isActive }),
          created_by: req.user!.uid,
        },
        { onConflict: 'branch_id' },
      )
      .select('*')
      .single();
    if (error) throw error;

    invalidateBranchGeofences(branchId);

    // Changing where a branch may sell from is exactly the kind of act the audit log
    // exists for — it can switch selling on or off for a whole shop.
    void logAudit({
      action: 'branch_location_updated',
      adminId: req.user!.uid,
      adminName: await resolveAdminName(req.user!.uid, req.user!.email),
      details: JSON.stringify({
        scope: 'branch_location',
        branchId,
        branchName: (branch as { name: string }).name,
        latitude,
        longitude,
        radiusKm,
      }),
    });

    res.json({ location: toApiLocation(data as LocationRow) });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/branch-locations/:branchId/status — enable/disable without losing the pin. */
router.patch('/:branchId/status', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const parsed = UpdateBranchLocationStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.errors });
      return;
    }

    const branchId = req.params['branchId']!;
    const { data, error } = await supabaseAdmin
      .from('branch_locations')
      .update({ is_active: parsed.data.isActive })
      .eq('branch_id', branchId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'This branch has no location configured' }); return; }

    invalidateBranchGeofences(branchId);
    res.json({ location: toApiLocation(data as LocationRow) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/branch-locations/:branchId — remove the geofence entirely.
 *
 * A real delete, and it fails OPEN: with no row the branch is unrestricted again.
 * That is the intended escape hatch for a location entered wrongly — Disable is the
 * reversible option, Delete is the one that forgets the coordinates.
 */
router.delete('/:branchId', requireRole('super_admin'), async (req: AuthRequest, res, next) => {
  try {
    const branchId = req.params['branchId']!;
    const { data, error } = await supabaseAdmin
      .from('branch_locations')
      .delete()
      .eq('branch_id', branchId)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'This branch has no location configured' }); return; }

    invalidateBranchGeofences(branchId);

    // Deleting a location lifts the restriction on that branch entirely, so it is
    // audited for the same reason moving one is.
    void logAudit({
      action: 'branch_location_removed',
      adminId: req.user!.uid,
      adminName: await resolveAdminName(req.user!.uid, req.user!.email),
      details: JSON.stringify({ scope: 'branch_location', branchId }),
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/branch-locations/verify — record a periodic check without transacting.
 *
 * The client's background ticker calls this. It is what populates the "Online Users"
 * and "Users Outside Radius" tiles, and what puts a user's drift out of the area
 * into the audit trail at the moment it happens rather than at the next sale.
 *
 * Always 200, even when the verdict is a refusal: nothing is being authorised here,
 * so the answer is the verdict itself. Returning 403 would make the client's own
 * error handling fight with its status polling.
 */
router.post('/verify', async (req: AuthRequest, res, next) => {
  try {
    const user = req.user!;
    const headers = req.headers as unknown as Record<string, unknown>;
    const position = positionFromRequest(headers);
    const { verdict, geofence } = await checkGeofence({
      branchId: user.branchId,
      role: user.role,
      position,
    });

    // Exempt identities are not logged: a super admin's location is not the subject
    // of this control, and recording it would build a movement history of the
    // company's own administrators for no stated purpose.
    if (verdict.outcome !== 'exempt') {
      void logGeofenceCheck({
        action: 'verify',
        verdict,
        position,
        branchId: user.branchId,
        branchName: geofence?.branchName ?? user.branchName,
        userId: user.uid,
        userName: user.email,
        userRole: user.role,
        ipAddress: clientIp(headers, req.ip),
        userAgent: typeof headers['user-agent'] === 'string' ? (headers['user-agent'] as string) : null,
      });
    }

    res.json({ verdict, branchName: geofence?.branchName ?? user.branchName ?? null });
  } catch (err) {
    next(err);
  }
});
