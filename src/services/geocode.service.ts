import type { GeoPoint, LocationSource } from '../shared';

/**
 * Reverse-geocode a device position into a place name, best-effort.
 *
 * WHY IT EXISTS. The Login History wants "Manzoor Colony, Karachi, Pakistan"
 * where the IP lookup can honestly offer "Karachi, Pakistan". The extra word is
 * only obtainable from a position the DEVICE reported — the browser sends one
 * on every API call once the person has granted location for geofencing — and
 * only by asking a geocoder what is at that point. This module asks.
 *
 * SAME STANCE AS `geoip.service.ts`, for the same reason: the login is the
 * fact, the place name is a nicety. Every failure path — timeout, rate limit,
 * non-JSON, a point in the sea — returns EMPTY and the session is recorded
 * without an area. Nothing here throws.
 *
 * PROVIDER. Nominatim (OpenStreetMap) by default: no key, no account, and an
 * `address` object with the neighbourhood-level fields this needs. Its usage
 * policy asks for an identifying User-Agent and at most one request a second,
 * which a login event stream is nowhere near — and the cache below means one
 * device pinging from the same spot costs one lookup, not one per ping.
 * `REVERSE_GEOCODE_URL` swaps the provider; `REVERSE_GEOCODE_ENABLED=false`
 * turns it off.
 */

const DEFAULT_URL =
  'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat}&lon={lng}&zoom=16&accept-language=en';
const TIMEOUT_MS = 2_800;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2_000;

export interface ReverseGeocode {
  /** Neighbourhood / suburb — the word an IP lookup cannot supply. */
  area: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  source: LocationSource;
}

const EMPTY: ReverseGeocode = {
  area: null,
  city: null,
  region: null,
  country: null,
  countryCode: null,
  source: 'UNKNOWN',
};

const cache = new Map<string, { at: number; value: ReverseGeocode }>();

/** Empty string, 'null', 'undefined' and 'Unknown' all mean "the provider does not know". */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^(null|undefined|unknown)$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * 'Karachi Division' → 'Karachi'. OpenStreetMap files some cities under their
 * administrative unit — Karachi's `city` is literally "Karachi Division" — and
 * the unit is not what a person calls the place. Only a trailing, capitalised
 * admin word is dropped, so 'Division Street' or a town whose name ends
 * that way is left alone.
 */
function stripAdminSuffix(name: string | null): string | null {
  return name ? name.replace(/\s+(Division|District|Municipality|Metropolitan Area|Tehsil|Taluka)$/i, '').trim() || name : null;
}

/** First non-empty of several address fields, in the order given. */
function first(address: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = clean(address[key]);
    if (v) return v;
  }
  return null;
}

/**
 * Three decimals is ~110 m — close enough that two fixes inside it are the same
 * neighbourhood, coarse enough that a phone wandering around a shop does not
 * miss the cache on every ping.
 */
function cacheKey(p: GeoPoint): string {
  return `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`;
}

/** What is at this point? Never throws, never rejects. */
export async function reverseGeocode(point: GeoPoint | null | undefined): Promise<ReverseGeocode> {
  if (process.env['REVERSE_GEOCODE_ENABLED'] === 'false') return EMPTY;
  if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return EMPTY;
  if (Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) return EMPTY;

  const key = cacheKey(point);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const template = process.env['REVERSE_GEOCODE_URL'] || DEFAULT_URL;
  const url = template.replace("{lat}", String(point.latitude)).replace("{lng}", String(point.longitude));

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'application/json',
        // Nominatim refuses anonymous clients; an identifying agent is its one
        // hard requirement.
        'user-agent': 'mountain-bakes-server (login history place names)',
      },
    });
    if (!res.ok) return EMPTY;

    const body = (await res.json()) as Record<string, unknown>;
    if (body['error']) return EMPTY;
    const address = (body['address'] ?? {}) as Record<string, unknown>;

    const value: ReverseGeocode = {
      // Nominatim's neighbourhood tier, most specific first. A point with none
      // of these — open country, a highway — honestly gets no area.
      area: first(address, ['neighbourhood', 'suburb', 'quarter', 'residential', 'hamlet', 'village', 'city_district']),
      // `city` first, then the district tier — 'Karachi District' also reads as
      // Karachi once the suffix is stripped — and only then a town, which in a
      // metropolis is a sub-city ('Saddar Town') and would mislabel the place.
      city: stripAdminSuffix(first(address, ['city', 'city_district', 'town', 'municipality', 'county'])),
      region: first(address, ['state', 'province', 'state_district']),
      country: clean(address['country']),
      countryCode: clean(address['country_code'])?.toUpperCase() ?? null,
      source: 'DEVICE_GPS',
    };
    // A 200 that names nothing is not a place. Not cached either, for the
    // reason geoip gives: a transient refusal must not be held for a day.
    if (!value.country && !value.city && !value.area) return EMPTY;

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // Timeout, DNS, non-JSON — same outcome, and not an error of this app's.
    return EMPTY;
  }
}
