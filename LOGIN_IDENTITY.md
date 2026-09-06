# Login History — identity & location engine

How a `login_sessions` row learns **who** signed in, **with what**, and **from
where**. Everything here is server-side TypeScript inside this Express API; there
is no separate service.

```
Browser signs in (Supabase Auth)            ← the API is not in this request path
        │
        ▼
POST /api/login-history/start  (Bearer JWT)
        │
        ├─ middleware/auth.ts          verify token → uid, amr methods, Google identity
        ├─ services/login-identity     resolveLoginIdentity() · resumeVerdict()
        ├─ services/geoip              IP → country/region/city        (cached, ≤2.8s, never throws)
        ├─ services/geocode            device fix → neighbourhood      (cached, ≤2.8s, never throws)
        ├─ utils/userAgent             User-Agent → browser/version/OS/device
        ├─ services/login-security     suspicion verdict
        │
        ▼
login_sessions row  →  GET /api/login-history  →  Admin → Security → Login History
```

## Browser email: what it is and is not

`browser_email` is **the Google account the session was authenticated with**,
read off the verified token's identities when the session opens. It is `null`
("Not recorded") for a password login — including a password login on an
account that has a Google identity linked.

It is **not** the account Chrome's profile menu shows as "Signed in as …". A
web page has no API for that: no header carries it, no cookie is readable, and
nothing in this codebase tries. The only honest source is an explicit Google
authentication to Mountain Bakes through Supabase Auth's Google provider.

| Sign-in                                   | `amr`        | Google identity | `browser_email`          |
|-------------------------------------------|--------------|-----------------|--------------------------|
| "Continue with Google"                    | `oauth`      | yes             | the Google address       |
| Return from "Connect Google account"      | `oauth`      | yes             | the Google address       |
| Email + password                          | `password`   | any             | `null` → "Not recorded"  |
| OAuth session, no verified Google identity| `oauth`      | no              | `null`                   |

The rule is `resolveLoginIdentity()` in `src/services/login-identity.service.ts`.
The route never reads it from a request body.

## The resume rule (and the bug it fixes)

The client offers back the session id it holds on every dashboard mount so a
reload continues the row instead of adding one. `resumeVerdict()` honours the
offer only when the row is the caller's, still open, seen inside the stale
window **and carries the same GoTrue `auth_session_id` as the token**.

The fourth test is what was missing. Without it, coming back from "Connect
Google account" — where GoTrue issues a fresh `oauth` session and reloads the
dashboard — resumed the earlier *password* row, so the Browser email column
stayed "Not recorded" for a browser that had just authenticated with Google.
Now the old row is ended with `end_reason = 'reauth'` (migration 105) and a new
row records the Google identity.

## Location

Priority, decided field by field so a geocoder that named the neighbourhood
but not the region still keeps the region the IP lookup knew:

1. **Device position** — the `X-Geo-Position` header the browser attaches once
   the person has granted location (the same consented fix the geofence check
   uses; nothing here prompts for it). Reverse-geocoded for the neighbourhood.
   `location_source = 'DEVICE_GPS'`.
2. **IP geolocation** — `lookupIp()`, server-side, per-IP cache, 2.8 s cap.
   `location_source = 'IP'`.
3. **Unknown** — `location_source = 'UNKNOWN'`; the UI says "Location unavailable".

Display composes `area, city, country` and drops what is null:
"Manzoor Colony, Karachi, Pakistan" · "Karachi, Pakistan" · "Pakistan". The
detail view shows the source in words ("IP address (approximate)" / "Device
location (precise)"). A neighbourhood is **never** written from an IP answer.

Both lookups run concurrently and neither can fail the login: a timeout or a
provider error leaves the location columns null and the row is still written.
Env: `GEOIP_ENABLED`, `GEOIP_URL`, `REVERSE_GEOCODE_ENABLED`, `REVERSE_GEOCODE_URL`
(see `.env.example`). No provider key ever reaches the browser.

## Search

The admin search box matches, case-insensitively, on: Mountain Bakes ID, name,
area, city, region, country, browser, browser version, OS, device type, IP
address — and, for a super admin only, both email columns (so the box cannot be
used as an oracle for which addresses exist). A status word — `active`, `idle`,
`ended`, `expired`, `revoked` — is applied as the state predicate; `success`
narrows nothing because every row is a successful sign-in (refused ones are in
`login_attempts`).

## Enabling Google in the Supabase project

The frontend hides every Google control until the provider is on, read from
GoTrue's public `/auth/v1/settings`.

1. Google Cloud → OAuth client (Web). Authorised redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Supabase → Authentication → Providers → Google: enable, paste client ID and
   secret.
3. Supabase → Authentication → URL Configuration: add the web origin(s) to
   *Redirect URLs* (e.g. `https://mountainbakes-dfc2c.web.app/**` and
   `http://localhost:3000/**`).
4. Supabase → Authentication → Settings: enable **Manual linking**. Without it
   `linkIdentity` is refused and "Connect Google account" cannot work.
5. Staff whose Google address differs from their Mountain Bakes address must
   link once from the dashboard; a Google sign-in on an unlinked address creates
   a role-less user the app refuses.

## Verifying

```bash
pnpm verify:login-identity     # pure rules: identity, resume, user-agent — no env needed
pnpm typecheck
```

Deploying this needs migration 105 applied (`supabase db push`) before or with
the API: the API writes `end_reason = 'reauth'`, which the previous constraint
rejects (the failure is logged, not raised, so a login still records — but the
old row would then fall to "expired" rather than "reauth").
