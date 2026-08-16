import { z } from 'zod';
import { DEFAULT_GEOFENCE_RADIUS_KM } from '../utils/geo';

/**
 * Bounds are the WGS84 ones, not a Pakistan bounding box.
 *
 * Tempting to reject anything outside the country, but it would turn a legitimate
 * future branch — or a test fixture — into a validation error nobody can read, and
 * it is not the schema's job to know where the company operates.
 */
const LATITUDE = z
  .number()
  .min(-90, 'Latitude must be between -90 and 90')
  .max(90, 'Latitude must be between -90 and 90');

const LONGITUDE = z
  .number()
  .min(-180, 'Longitude must be between -180 and 180')
  .max(180, 'Longitude must be between -180 and 180');

/**
 * Upper bound of 500 km is a guard against a fat-fingered entry (5000 instead of
 * 50) silently disabling the control, rather than a real operational limit — a
 * radius that large already covers most of the country.
 */
const RADIUS_KM = z
  .number()
  .positive('Radius must be greater than zero')
  .max(500, 'Radius cannot exceed 500 KM');

/**
 * Set or replace a branch's location. Upsert rather than create/update: a branch
 * has at most one geofence (enforced by a unique constraint on branch_id), so the
 * caller should not have to know whether one already exists.
 */
export const UpsertBranchLocationSchema = z.object({
  latitude: LATITUDE,
  longitude: LONGITUDE,
  address: z.string().min(3, 'Address is required'),
  radiusKm: RADIUS_KM.default(DEFAULT_GEOFENCE_RADIUS_KM),
  // Google returns a place id only when the admin picked a search result; clicking
  // bare map coordinates yields none, which is a perfectly valid location.
  googlePlaceId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

/** Enable/disable one branch's geofence without touching its coordinates. */
export const UpdateBranchLocationStatusSchema = z.object({
  isActive: z.boolean(),
});

/**
 * A device reading, as the client reports it.
 *
 * Mirrors the `X-Geo-Position` header, and exists so the same shape can also be
 * accepted in a request body — which is what a React Native client that cannot set
 * arbitrary headers on every transport would use.
 */
export const GeoPositionSchema = z.object({
  latitude: LATITUDE,
  longitude: LONGITUDE,
  accuracyM: z.number().nonnegative().nullable().optional(),
  capturedAt: z.string().min(1),
});

export type UpsertBranchLocationInput = z.infer<typeof UpsertBranchLocationSchema>;
export type UpdateBranchLocationStatusInput = z.infer<typeof UpdateBranchLocationStatusSchema>;
export type GeoPositionInput = z.infer<typeof GeoPositionSchema>;
