-- 44: enum values needed by the expanded event catalogue (migration 45).
--
-- Its own file for the usual reason (migrations 14, 34, 42): Postgres cannot USE
-- an enum value in the transaction that adds it, and migration 45's seed inserts
-- both of these as literals.
--
-- `hijri_last_weekday` — "the last Friday of Ramadan" (Jumuat-ul-Wida). This
-- cannot be expressed by any existing anchor. It is not a fixed Hijri day, and it
-- cannot be faked with a day number either: Ramadan is 30 days in 1447 but 29 in
-- 1448-1450, so the last Friday moves relative to the month's start. Resolving it
-- needs the real month length, which shared/utils/hijri.ts now computes.
--
-- `ahlul_bayt` — the Ahlul Bayt (A.S.) commemorations are their own category so
-- they can be filtered, reported on and given their own demand posture. They sit
-- apart from the general `islamic` occasions on purpose: most are births
-- (celebratory, higher demand) or martyrdoms (mourning, where demand typically
-- FALLS rather than rises), which is the opposite planning signal from an Eid.

alter type event_calendar_system add value if not exists 'hijri_last_weekday';
alter type event_category        add value if not exists 'ahlul_bayt';
