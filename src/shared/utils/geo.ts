// Geofencing maths — the single implementation shared by the browser, the Express
// API and any future React Native client.
//
// It lives in `shared` for the same reason the stock and timezone helpers do: the
// client decides what to SHOW and the server decides what to ALLOW, and if those two
// ever disagree about a distance the user gets a screen that says "inside" over an
// API that says "outside". One function, imported twice.
//
// Deliberately dependency-free and side-effect-free: no Date.now(), no fetch, no
// geolocation API. Everything is passed in, which is what makes it callable from a
// React Native bridge or a Postgres-adjacent script without change.

/**
 * Mean Earth radius (IUGG), in kilometres.
 *
 * Haversine assumes a sphere. Over the ~50 km radii this system configures, the
 * error against a proper ellipsoidal (Vincenty) calculation is on the order of
 * tens of metres — far inside the accuracy of a phone GPS fix, and far inside any
 * radius an admin would sensibly set. Not worth the extra maths.
 */
export const EARTH_RADIUS_KM = 6371.0088;

/** The default a branch gets until an admin changes it. */
export const DEFAULT_GEOFENCE_RADIUS_KM = 50;

/**
 * Fraction of the radius past which a position counts as "near the boundary".
 *
 * Drives the amber state on the status indicator — a warning that one street more
 * will stop sales, shown while the user can still act on it.
 */
export const NEAR_BOUNDARY_FRACTION = 0.9;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * A reading from a device, as opposed to a configured point.
 *
 * `accuracyM` is the browser's own 68%-confidence radius (`coords.accuracy`). It is
 * load-bearing here, not decoration — see evaluateGeofence, which uses it to avoid
 * blocking someone standing in the shop on a coarse wifi fix.
 *
 * `capturedAt` is an ISO timestamp supplied by the caller. A position is a fact
 * about a moment; carrying the moment with it lets the server reject a stale fix
 * without having to trust that the request arrived promptly.
 */
export interface GeoPosition extends GeoPoint {
  accuracyM: number | null;
  capturedAt: string;
}

/**
 * Why a check came out the way it did. The distinction between the three
 * permissive outcomes matters for the audit log: `disabled` and `not_configured`
 * are policy, `allowed` is a measurement.
 */
export type GeofenceOutcome =
  /** Inside the radius. */
  | 'allowed'
  /** Outside the radius — the only outcome that stops a transaction on measurement. */
  | 'blocked'
  /** No usable fix: permission denied, timed out, or no GPS hardware. */
  | 'no_position'
  /** A fix arrived but is too coarse to place the device on either side of the boundary. */
  | 'inaccurate'
  /** The fix is older than the caller is willing to accept. */
  | 'stale'
  /** The branch has no location configured — fails open by design. */
  | 'not_configured'
  /** Geofencing is switched off globally — fails open by design. */
  | 'disabled'
  /** The identity is exempt (super admin, production user). */
  | 'exempt';

export type GeofenceProximity = 'inside' | 'near_boundary' | 'outside' | 'unknown';

export interface GeofenceVerdict {
  outcome: GeofenceOutcome;
  /** The one field callers gate on. Every non-`blocked` outcome permits the action. */
  allowed: boolean;
  /** Centre-to-device distance in km, or null when there was nothing to measure. */
  distanceKm: number | null;
  /** The radius the distance was judged against, or null when none applied. */
  radiusKm: number | null;
  proximity: GeofenceProximity;
}

export interface EvaluateGeofenceInput {
  /** The configured branch centre, or null when the branch has no location yet. */
  branch: GeoPoint | null;
  /** The device reading, or null when none could be obtained. */
  position: GeoPosition | null;
  radiusKm: number | null | undefined;
  /** Global master switch. */
  enabled: boolean;
  /** True for identities the rule does not apply to (super admin, production). */
  exempt?: boolean;
  /**
   * Reject a fix whose accuracy circle straddles the boundary, instead of falling
   * back to the raw point distance. Stricter, and the reason it is configurable:
   * indoors on wifi-only positioning it will refuse fixes all day.
   */
  requireHighAccuracy?: boolean;
  /**
   * Discard a fix older than this. Omit or pass null to accept any age — the
   * client refreshes on a ticker, so this is the server's protection against a
   * replayed header, not the client's.
   */
  maxAgeSeconds?: number | null;
  /** "Now", as an epoch-milliseconds value. Passed in to keep this function pure. */
  nowMs?: number;
}

/** Round to one decimal — the precision every distance is displayed at. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function isFiniteCoord(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** True when a point is a usable WGS84 coordinate pair. */
export function isValidGeoPoint(point: GeoPoint | null | undefined): point is GeoPoint {
  return (
    !!point &&
    isFiniteCoord(point.latitude) &&
    isFiniteCoord(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

/**
 * Great-circle distance between two points, in kilometres.
 *
 * The `asin(sqrt(h))` form rather than `atan2`: both are correct, but this one is
 * numerically stable for the small distances that actually matter here, where the
 * naive spherical law of cosines loses precision to floating point.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Decide whether a device may transact against a branch.
 *
 * The permissive outcomes are deliberate policy, not oversights:
 *
 *   - `exempt` / `disabled` / `not_configured` short-circuit before any maths. A
 *     branch whose location an admin has not set yet must keep trading — turning
 *     the master switch on cannot be allowed to halt every unconfigured shop, and
 *     the "Missing GPS" count on the admin dashboard is what drives configuration.
 *
 * Accuracy is handled as a circle rather than a point, which is the part worth
 * reading twice. A phone indoors routinely reports ±100–300 m. Comparing only the
 * centre of that circle to the boundary would refuse a cashier standing behind the
 * counter of a shop 49.9 km out, and would equally clear someone 50.1 km out. So:
 *
 *   - accuracy circle entirely inside the radius  → allowed, whatever the setting
 *   - accuracy circle entirely outside            → blocked, whatever the setting
 *   - circle straddles the boundary               → ambiguous; `requireHighAccuracy`
 *                                                   decides whether to refuse the
 *                                                   fix or fall back to the centre
 *
 * That makes the strict setting cost nothing in the clear-cut cases and apply only
 * where the reading genuinely cannot answer the question.
 */
export function evaluateGeofence(input: EvaluateGeofenceInput): GeofenceVerdict {
  const { branch, position, enabled, exempt, requireHighAccuracy, maxAgeSeconds, nowMs } = input;

  const permit = (outcome: GeofenceOutcome): GeofenceVerdict => ({
    outcome,
    allowed: true,
    distanceKm: null,
    radiusKm: null,
    proximity: 'unknown',
  });

  if (exempt) return permit('exempt');
  if (!enabled) return permit('disabled');
  if (!isValidGeoPoint(branch)) return permit('not_configured');

  const radiusKm =
    isFiniteCoord(input.radiusKm) && input.radiusKm > 0
      ? input.radiusKm
      : DEFAULT_GEOFENCE_RADIUS_KM;

  // From here on the branch IS configured and the feature IS on, so every remaining
  // failure denies the action. A missing fix is not a free pass: that is the whole
  // point of the control, and it is also the cheapest way to bypass it.
  const deny = (outcome: GeofenceOutcome): GeofenceVerdict => ({
    outcome,
    allowed: false,
    distanceKm: null,
    radiusKm,
    proximity: 'unknown',
  });

  if (!isValidGeoPoint(position)) return deny('no_position');

  if (isFiniteCoord(maxAgeSeconds) && maxAgeSeconds > 0 && isFiniteCoord(nowMs)) {
    const capturedMs = Date.parse(position.capturedAt);
    if (!Number.isFinite(capturedMs)) return deny('stale');
    const ageSeconds = (nowMs - capturedMs) / 1000;
    // A small negative age is ordinary clock skew between phone and server, not a
    // forgery; only a fix from meaningfully in the future is rejected.
    if (ageSeconds > maxAgeSeconds || ageSeconds < -maxAgeSeconds) return deny('stale');
  }

  const distanceKm = haversineKm(branch, position);
  const accuracyKm = isFiniteCoord(position.accuracyM) ? Math.max(0, position.accuracyM) / 1000 : 0;

  const certainlyInside = distanceKm + accuracyKm <= radiusKm;
  const certainlyOutside = distanceKm - accuracyKm > radiusKm;

  const verdict = (allowed: boolean, outcome: GeofenceOutcome): GeofenceVerdict => ({
    outcome,
    allowed,
    distanceKm: round1(distanceKm),
    radiusKm,
    proximity: !allowed
      ? 'outside'
      : distanceKm >= radiusKm * NEAR_BOUNDARY_FRACTION
        ? 'near_boundary'
        : 'inside',
  });

  if (certainlyInside) return verdict(true, 'allowed');
  if (certainlyOutside) return verdict(false, 'blocked');
  if (requireHighAccuracy) {
    return { ...deny('inaccurate'), distanceKm: round1(distanceKm) };
  }
  return verdict(distanceKm <= radiusKm, distanceKm <= radiusKm ? 'allowed' : 'blocked');
}

/** '62.4 KM' — the display form used in messages and on the status card. */
export function formatDistanceKm(km: number | null | undefined): string {
  if (!isFiniteCoord(km)) return '—';
  // Under a kilometre, kilometres to one decimal reads as "0.0 KM" for anyone
  // standing at the shop. Metres are both truer and more reassuring.
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${round1(km).toFixed(1)} KM`;
}

/**
 * The message a blocked user sees, in the wording the specification fixed.
 *
 * Built here rather than in a component so the API can return the same text it
 * would have rendered — a request refused by the server and an action refused by
 * the screen say exactly the same thing.
 */
export function geofenceMessage(verdict: GeofenceVerdict): string {
  switch (verdict.outcome) {
    case 'blocked':
      return [
        'Sales are disabled.',
        '',
        'You are outside the permitted operating area for this branch.',
        '',
        'Current Distance:',
        formatDistanceKm(verdict.distanceKm),
        '',
        'Allowed Radius:',
        formatDistanceKm(verdict.radiusKm),
        '',
        'Please return to your assigned branch to continue sales.',
      ].join('\n');
    case 'no_position':
      return [
        'Sales are disabled.',
        '',
        'Your location could not be determined.',
        '',
        'Allow location access for this site and try again. Sales cannot be recorded',
        'without a verified location.',
      ].join('\n');
    case 'inaccurate':
      return [
        'Sales are disabled.',
        '',
        'Your location is not accurate enough to verify that you are at the branch.',
        '',
        'Move somewhere with a clearer view of the sky, or connect to a network with',
        'better positioning, and try again.',
      ].join('\n');
    case 'stale':
      return [
        'Sales are disabled.',
        '',
        'Your location reading is out of date. Refresh your location and try again.',
      ].join('\n');
    default:
      return '';
  }
}

/**
 * Serialise a position for the `X-Geo-Position` request header.
 *
 * A header rather than a body field so that one place — the API client's request()
 * — attaches it to every call, instead of every mutation schema growing a `geo`
 * property that each new endpoint has to remember. Format is
 * `lat;lng;accuracyM;capturedAt`, semicolon-separated because an ISO timestamp
 * already contains colons and commas are the conventional list separator in HTTP.
 * Values are plain ASCII, which keeps the header byte-safe without encoding.
 */
export const GEO_POSITION_HEADER = 'X-Geo-Position';

export function encodeGeoPosition(position: GeoPosition): string {
  const accuracy = isFiniteCoord(position.accuracyM) ? Math.round(position.accuracyM) : '';
  return [
    position.latitude.toFixed(7),
    position.longitude.toFixed(7),
    accuracy,
    position.capturedAt,
  ].join(';');
}

/** Inverse of encodeGeoPosition. Returns null for anything malformed. */
export function decodeGeoPosition(raw: string | null | undefined): GeoPosition | null {
  if (!raw) return null;
  const [lat, lng, accuracy, capturedAt] = raw.split(';');
  const position: GeoPosition = {
    latitude: Number(lat),
    longitude: Number(lng),
    accuracyM: accuracy ? Number(accuracy) : null,
    capturedAt: capturedAt ?? '',
  };
  if (!isValidGeoPoint(position)) return null;
  if (position.accuracyM !== null && !Number.isFinite(position.accuracyM)) position.accuracyM = null;
  return position;
}
