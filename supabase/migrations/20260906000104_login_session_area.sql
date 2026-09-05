-- ---------------------------------------------------------------------------
-- 104: Neighbourhood on a login session, from a device fix only.
--
-- The Login History is asked to read "Manzoor Colony, Karachi, Pakistan" rather
-- than "Karachi, Pakistan". An IP lookup cannot say that: it places an address
-- in the middle of a city at best (see migration 99 on `location_source`), so a
-- neighbourhood written from IP data would be invented. The only honest source
-- is the DEVICE's own position — which the browser already sends on every API
-- call once the person has granted location for geofencing — reverse-geocoded
-- into a place name.
--
-- So `area` is filled ONLY alongside `location_source = 'DEVICE_GPS'`, by the
-- API, when a session is opened or pinged with a device position; a session
-- that never carries one keeps `area` null and reads at the city level its IP
-- resolved to. Never back-filled: an old row has no fix to geocode.
-- ---------------------------------------------------------------------------
alter table login_sessions
  add column area text;

comment on column login_sessions.area is
  'Neighbourhood / suburb from reverse-geocoding the device position (Manzoor Colony). Set only with location_source = DEVICE_GPS; null for an IP-resolved row, which knows the city at best.';
