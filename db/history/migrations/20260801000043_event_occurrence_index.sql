-- 43: allow a Hijri series to occur TWICE in one Gregorian year.
--
-- Migration 41 keyed occurrences on (series_code, event_year), which quietly
-- assumes every recurring event happens exactly once per Gregorian year. That
-- holds for a fixed Gregorian anchor. It does NOT hold for a Hijri one: a Hijri
-- year is ~354 days, so the Gregorian date walks ~11 days earlier annually and
-- some anniversaries land twice inside one Gregorian year while others skip it
-- entirely.
--
-- This is not theoretical. 15 Sha'ban (Shab-e-Barat) falls on BOTH 2028-01-12 and
-- 2028-12-31. Under the old key the second one could not be stored, so the
-- calendar would silently omit a real event that the business needs to bake for.
--
-- The fix is an occurrence ordinal within the year. Existing rows are all the
-- first (and only) occurrence, so the default of 1 back-fills them correctly and
-- nothing downstream changes for a Gregorian event — it simply always has
-- occurrence_index = 1.
--
-- `hijriAnniversariesIn()` in shared/utils/hijri.ts has always returned an ARRAY
-- for exactly this reason; before this migration the API had to drop everything
-- past the first element.

alter table special_events
  add column if not exists occurrence_index smallint not null default 1
    check (occurrence_index between 1 and 2);

-- Swap the key. Dropped by name: migration 41 declared it as a table constraint,
-- so it exists as a constraint rather than a bare index.
alter table special_events
  drop constraint if exists special_events_series_year_key;

alter table special_events
  add constraint special_events_series_year_occurrence_key
    unique (series_code, event_year, occurrence_index);
