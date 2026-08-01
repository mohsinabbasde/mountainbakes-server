-- 45: the full event catalogue, plus the two columns it needs.
--
-- Migration 41 seeded a starter set. This replaces it with the business's actual
-- calendar: 13 general Islamic occasions, 21 Ahlul Bayt (A.S.) commemorations,
-- 7 Pakistan national days and 13 international/retail dates.
--
-- ─── reminder_lead_days ──────────────────────────────────────────────────────
-- New, and the reason this migration exists as much as the extra rows do. Lead
-- time is NOT uniform: Eid-ul-Adha needs 30 days of notice because livestock,
-- packaging and staffing all have to be lined up, while Ashura needs 7. Before
-- this column every event shared one hardcoded reminder cascade, so either the
-- big events were warned too late or the small ones nagged for a month.
--
-- The reminder schedule now derives from it (services/event-notifications.service):
-- the first branch reminder fires at reminder_lead_days, with the standard 14/7/3
-- day nudges that still fall inside it. Production gets the same plus a week,
-- because it buys materials before branch demand has even arrived.
--
-- demand_lead_days is seeded at reminder_lead_days - 3: branches get three days
-- to answer the first reminder. It is an editable default, not a rule.
--
-- ─── anchor_offset_days ──────────────────────────────────────────────────────
-- Black Friday is "the day after the 4th Thursday of November" and Cyber Monday
-- is the Monday after that. Neither is expressible as an nth-weekday on its own.
--
-- It is tempting to call Black Friday "the last Friday of November" instead — that
-- is WRONG, and quietly so. The two agree in most years and diverge whenever
-- November starts on a Thursday: in 2029 the 4th Thursday is the 22nd (so Black
-- Friday is the 23rd) while the last Friday is the 30th. A whole week out, on the
-- single biggest retail promotion of the year.
--
-- ─── What is NOT seeded, and why ─────────────────────────────────────────────
-- "Weekend Promotion (every weekend)" and "Monthly Sales Campaign (first of each
-- month)" are deliberately absent. They are recurring SCHEDULES, not calendar
-- events: seeding them would mint 52 and 12 rows per year, each with its own
-- branch-demand collection cycle and its own reminder cascade — 64 demand
-- deadlines a year for promotions that need none of that. They want a promotions
-- feature, not this pipeline.
--
-- The other business events (New Branch Opening, Mega Sale, Winter/Summer/Back to
-- School promotions, Customer Appreciation Week) are admin-defined with no fixed
-- date, so there is nothing to seed — they are created through "Add Company
-- Event", which is exactly what that button is for.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table special_events
  add column if not exists reminder_lead_days smallint not null default 14
    check (reminder_lead_days between 1 and 120);

alter table special_events
  add column if not exists anchor_offset_days smallint not null default 0
    check (anchor_offset_days between -30 and 30);

-- The anchor check has to learn the new calendar system, which needs a Hijri
-- month plus a weekday ("the last Friday of Ramadan") and no day number.
alter table special_events
  drop constraint if exists special_events_anchor_ck;

alter table special_events
  add constraint special_events_anchor_ck check (
       (not is_recurring and confirmed_date is not null)
    or (calendar_system = 'hijri'     and hijri_month     is not null and hijri_day     is not null)
    or (calendar_system = 'gregorian' and gregorian_month is not null and gregorian_day is not null)
    or (calendar_system = 'gregorian_nth_weekday'
        and gregorian_month is not null and nth_weekday is not null and weekday is not null)
    or (calendar_system = 'hijri_last_weekday'
        and hijri_month is not null and weekday is not null)
  );

-- ---------------------------------------------------------------------------
-- The catalogue. 2026 is the template row for each series; the propagation step
-- below pushes any correction out to the years already materialised, and
-- ensureEventYear() builds every other year on demand.
--
-- Colours: green for Islamic occasions, teal for Ahlul Bayt, Pakistan green for
-- national, rose for international, brand orange for company.
-- ---------------------------------------------------------------------------
insert into special_events (
  series_code, event_year, occurrence_index, name, category, calendar_system,
  hijri_month, hijri_day, gregorian_month, gregorian_day, nth_weekday, weekday,
  anchor_offset_days, duration_days, reminder_lead_days, priority, color, event_type, description
) values
  -- ── 1. Islamic calendar occasions ────────────────────────────────────────
  ('ISL-NEW-YEAR',    2026, 1, 'Islamic New Year',                        'islamic', 'hijri',              1,  1, null, null, null, null, 0, 1, 14, 'low',      '#16A34A', 'Religious Occasion', null),
  ('ISL-ASHURA',      2026, 1, 'Day of Ashura (Martyrdom of Imam Hussain A.S.)', 'islamic', 'hijri',        1, 10, null, null, null, null, 0, 1,  7, 'low',      '#16A34A', 'Mourning Observance', 'Mourning period — demand typically FALLS. Plan down, not up.'),
  ('ISL-MILAD',       2026, 1, '12 Rabi-ul-Awwal (Eid Milad-un-Nabi ﷺ)',  'islamic', 'hijri',              3, 12, null, null, null, null, 0, 1, 14, 'high',     '#16A34A', 'Religious Festival', 'Sweets and distribution boxes.'),
  ('ISL-SHAB-MIRAJ',  2026, 1, 'Shab-e-Miraj',                            'islamic', 'hijri',              7, 27, null, null, null, null, 0, 1,  7, 'normal',   '#16A34A', 'Religious Occasion', null),
  ('ISL-SHAB-BARAT',  2026, 1, 'Shab-e-Barat / Birth of Imam Mahdi (A.S.)','islamic', 'hijri',              8, 15, null, null, null, null, 0, 1, 10, 'high',     '#16A34A', 'Religious Occasion', 'Same night, two observances — one event so branches get one reminder, not two. Traditional sweets peak.'),
  ('ISL-RAMADAN',     2026, 1, 'Start of Ramadan',                        'islamic', 'hijri',              9,  1, null, null, null, null, 0, 1, 21, 'critical', '#16A34A', 'Religious Occasion', 'Sehri/Iftar demand pattern shifts for the whole month, not just day one.'),
  ('ISL-SHAB-QADR',   2026, 1, 'Laylat-ul-Qadr (27 Ramadan)',             'islamic', 'hijri',              9, 27, null, null, null, null, 0, 1,  7, 'normal',   '#16A34A', 'Religious Occasion', null),
  ('ISL-JUMUAT-WIDA', 2026, 1, 'Jumuat-ul-Wida',                          'islamic', 'hijri_last_weekday', 9, null, null, null, null, 5, 0, 1,  7, 'normal',   '#16A34A', 'Religious Occasion', 'Last Friday of Ramadan — the date moves with the month length, so it is resolved, not fixed.'),
  ('ISL-EID-FITR',    2026, 1, 'Eid-ul-Fitr',                             'islamic', 'hijri',             10,  1, null, null, null, null, 0, 3, 21, 'critical', '#16A34A', 'Religious Festival', 'Peak cake, sweets and gift-box demand of the year.'),
  ('ISL-HAJJ',        2026, 1, 'Hajj Begins',                             'islamic', 'hijri',             12,  8, null, null, null, null, 0, 1, 14, 'normal',   '#16A34A', 'Religious Occasion', null),
  ('ISL-ARAFAH',      2026, 1, 'Day of Arafah',                           'islamic', 'hijri',             12,  9, null, null, null, null, 0, 1,  7, 'normal',   '#16A34A', 'Religious Occasion', null),
  ('ISL-EID-ADHA',    2026, 1, 'Eid-ul-Adha',                             'islamic', 'hijri',             12, 10, null, null, null, null, 0, 3, 30, 'critical', '#16A34A', 'Religious Festival', 'Longest lead time in the calendar — packaging and staffing must be committed a month out.'),
  ('ISL-TASHREEQ',    2026, 1, 'Days of Tashreeq',                        'islamic', 'hijri',             12, 11, null, null, null, null, 0, 3,  7, 'normal',   '#16A34A', 'Religious Occasion', 'The three days following Eid-ul-Adha.'),

  -- ── 2. Ahlul Bayt (A.S.) ─────────────────────────────────────────────────
  -- Births are celebratory (sweets, cakes); martyrdoms are mourning, where
  -- demand generally falls — hence the split in priority.
  ('AB-ARBAEEN',        2026, 1, 'Arbaeen',                                    'ahlul_bayt', 'hijri',  2, 20, null, null, null, null, 0, 1,  7, 'low',    '#0D9488', 'Mourning Observance', 'Fortieth day after Ashura. Mourning — demand typically falls.'),
  ('AB-HASAN-MARTYR',   2026, 1, 'Martyrdom of Imam Hasan (A.S.)',             'ahlul_bayt', 'hijri',  2, 28, null, null, null, null, 0, 1,  7, 'low',    '#0D9488', 'Mourning Observance', null),
  ('AB-RAZA-MARTYR',    2026, 1, 'Martyrdom of Imam Ali Raza (A.S.)',          'ahlul_bayt', 'hijri',  2, 29, null, null, null, null, 0, 1,  7, 'low',    '#0D9488', 'Mourning Observance', null),
  ('AB-SADIQ-BIRTH',    2026, 1, 'Birth of Imam Jafar Sadiq (A.S.)',           'ahlul_bayt', 'hijri',  3, 17, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-ASKARI-BIRTH',   2026, 1, 'Birth of Imam Hasan Askari (A.S.)',          'ahlul_bayt', 'hijri',  4,  8, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-FATIMA-MARTYR-A',2026, 1, 'Martyrdom of Lady Fatimah Zahra (S.A.) — 13 Jumada al-Awwal', 'ahlul_bayt', 'hijri', 5, 13, null, null, null, null, 0, 1, 7, 'low', '#0D9488', 'Mourning Observance', 'One of two dates observed by different traditions; the other is 3 Jumada al-Thani. Both are seeded — disable whichever your branches do not observe.'),
  ('AB-FATIMA-MARTYR-B',2026, 1, 'Martyrdom of Lady Fatimah Zahra (S.A.) — 3 Jumada al-Thani',  'ahlul_bayt', 'hijri', 6,  3, null, null, null, null, 0, 1, 7, 'low', '#0D9488', 'Mourning Observance', 'One of two dates observed by different traditions; the other is 13 Jumada al-Awwal.'),
  ('AB-FATIMA-BIRTH',   2026, 1, 'Birth of Lady Fatimah Zahra (S.A.)',         'ahlul_bayt', 'hijri',  6, 20, null, null, null, null, 0, 1, 10, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-BAQIR-BIRTH',    2026, 1, 'Birth of Imam Muhammad Baqir (A.S.)',        'ahlul_bayt', 'hijri',  7,  1, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-TAQI-BIRTH',     2026, 1, 'Birth of Imam Muhammad Taqi (A.S.)',         'ahlul_bayt', 'hijri',  7, 10, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-ALI-BIRTH',      2026, 1, 'Birth of Imam Ali (A.S.)',                   'ahlul_bayt', 'hijri',  7, 13, null, null, null, null, 0, 1, 10, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-MUSA-KAZIM-MARTYR',2026,1,'Martyrdom of Imam Musa Kazim (A.S.)',        'ahlul_bayt', 'hijri',  7, 25, null, null, null, null, 0, 1,  7, 'low',    '#0D9488', 'Mourning Observance', null),
  ('AB-HUSSAIN-BIRTH',  2026, 1, 'Birth of Imam Hussain (A.S.)',               'ahlul_bayt', 'hijri',  8,  3, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-ABBAS-BIRTH',    2026, 1, 'Birth of Hazrat Abbas (A.S.)',               'ahlul_bayt', 'hijri',  8,  4, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-ZAINULABIDEEN-BIRTH',2026,1,'Birth of Imam Zain-ul-Abideen (A.S.)',     'ahlul_bayt', 'hijri',  8,  5, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-ALIAKBAR-BIRTH', 2026, 1, 'Birth of Hazrat Ali Akbar (A.S.)',           'ahlul_bayt', 'hijri',  8, 11, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-HASAN-BIRTH',    2026, 1, 'Birth of Imam Hasan (A.S.)',                 'ahlul_bayt', 'hijri',  9, 15, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-ALI-MARTYR',     2026, 1, 'Martyrdom of Imam Ali (A.S.)',               'ahlul_bayt', 'hijri',  9, 21, null, null, null, null, 0, 1,  7, 'low',    '#0D9488', 'Mourning Observance', null),
  ('AB-SADIQ-MARTYR',   2026, 1, 'Martyrdom of Imam Jafar Sadiq (A.S.)',       'ahlul_bayt', 'hijri', 10, 25, null, null, null, null, 0, 1,  7, 'low',    '#0D9488', 'Mourning Observance', null),
  ('AB-RAZA-BIRTH',     2026, 1, 'Birth of Imam Ali Raza (A.S.)',              'ahlul_bayt', 'hijri', 11, 11, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),
  ('AB-NAQI-BIRTH',     2026, 1, 'Birth of Imam Ali Naqi (A.S.)',              'ahlul_bayt', 'hijri', 12, 15, null, null, null, null, 0, 1,  7, 'normal', '#0D9488', 'Religious Occasion', null),

  -- ── 3. Pakistan national ─────────────────────────────────────────────────
  ('NAT-KASHMIR',      2026, 1, 'Kashmir Solidarity Day', 'national', 'gregorian', null, null,  2,  5, null, null, 0, 1,  7, 'low',    '#01411C', 'Public Holiday', null),
  ('NAT-PAKISTAN-DAY', 2026, 1, 'Pakistan Day',           'national', 'gregorian', null, null,  3, 23, null, null, 0, 1, 10, 'high',   '#01411C', 'National Day',   null),
  ('NAT-LABOUR',       2026, 1, 'Labour Day',             'national', 'gregorian', null, null,  5,  1, null, null, 0, 1,  7, 'low',    '#01411C', 'Public Holiday', null),
  ('NAT-INDEPENDENCE', 2026, 1, 'Independence Day',       'national', 'gregorian', null, null,  8, 14, null, null, 0, 1, 14, 'high',   '#01411C', 'National Day',   'Themed cakes and green/white decoration — packaging ordered well ahead.'),
  ('NAT-DEFENCE',      2026, 1, 'Defence Day',            'national', 'gregorian', null, null,  9,  6, null, null, 0, 1,  7, 'normal', '#01411C', 'National Day',   null),
  ('NAT-IQBAL',        2026, 1, 'Iqbal Day',              'national', 'gregorian', null, null, 11,  9, null, null, 0, 1,  7, 'low',    '#01411C', 'Public Holiday', 'Optional observance.'),
  ('NAT-QUAID',        2026, 1, 'Quaid-e-Azam Day',       'national', 'gregorian', null, null, 12, 25, null, null, 0, 1,  7, 'normal', '#01411C', 'National Day',   null),

  -- ── 4. International / retail ────────────────────────────────────────────
  ('INT-NEW-YEAR',      2026, 1, 'New Year''s Day',              'international', 'gregorian',             null, null,  1,  1, null, null, 0, 1, 14, 'high',   '#DB2777', 'Seasonal', null),
  ('INT-VALENTINE',     2026, 1, 'Valentine''s Day',             'international', 'gregorian',             null, null,  2, 14, null, null, 0, 1, 14, 'high',   '#DB2777', 'Seasonal', 'Heart cakes, gift boxes — one of the strongest single days of the year.'),
  ('INT-WOMENS-DAY',    2026, 1, 'International Women''s Day',   'international', 'gregorian',             null, null,  3,  8, null, null, 0, 1,  7, 'low',    '#DB2777', 'Seasonal', null),
  ('INT-MOTHERS',       2026, 1, 'Mother''s Day',                'international', 'gregorian_nth_weekday', null, null,  5, null, 2, 0, 0, 1, 14, 'high',   '#DB2777', 'Seasonal', 'Second Sunday of May.'),
  ('INT-ENVIRONMENT',   2026, 1, 'World Environment Day',        'international', 'gregorian',             null, null,  6,  5, null, null, 0, 1,  7, 'low',    '#DB2777', 'Seasonal', null),
  ('INT-FATHERS',       2026, 1, 'Father''s Day',                'international', 'gregorian_nth_weekday', null, null,  6, null, 3, 0, 0, 1, 10, 'normal', '#DB2777', 'Seasonal', 'Third Sunday of June.'),
  ('INT-YOUTH',         2026, 1, 'International Youth Day',      'international', 'gregorian',             null, null,  8, 12, null, null, 0, 1,  7, 'low',    '#DB2777', 'Seasonal', null),
  ('INT-FOOD-DAY',      2026, 1, 'World Food Day',               'international', 'gregorian',             null, null, 10, 16, null, null, 0, 1,  7, 'low',    '#DB2777', 'Seasonal', null),
  ('INT-HALLOWEEN',     2026, 1, 'Halloween',                    'international', 'gregorian',             null, null, 10, 31, null, null, 0, 1, 10, 'low',    '#DB2777', 'Seasonal', 'Optional observance — themed cupcakes and novelty lines only.'),
  -- The +1 and +4 offsets are the whole point: see the header note on why "last
  -- Friday of November" is not the same thing and breaks in 2029.
  ('INT-BLACK-FRIDAY',  2026, 1, 'Black Friday',                 'international', 'gregorian_nth_weekday', null, null, 11, null, 4, 4, 1, 1, 14, 'high',   '#DB2777', 'Retail Promotion', 'Day after the 4th Thursday of November.'),
  ('INT-CYBER-MONDAY',  2026, 1, 'Cyber Monday',                 'international', 'gregorian_nth_weekday', null, null, 11, null, 4, 4, 4, 1, 10, 'normal', '#DB2777', 'Retail Promotion', 'Monday following Black Friday.'),
  ('INT-CHRISTMAS',     2026, 1, 'Christmas',                    'international', 'gregorian',             null, null, 12, 25, null, null, 0, 1, 14, 'normal', '#DB2777', 'Seasonal', null),
  ('INT-NEW-YEAR-EVE',  2026, 1, 'New Year''s Eve',              'international', 'gregorian',             null, null, 12, 31, null, null, 0, 1, 14, 'high',   '#DB2777', 'Seasonal', null)

on conflict (series_code, event_year, occurrence_index) do update set
  name               = excluded.name,
  category           = excluded.category,
  calendar_system    = excluded.calendar_system,
  hijri_month        = excluded.hijri_month,
  hijri_day          = excluded.hijri_day,
  gregorian_month    = excluded.gregorian_month,
  gregorian_day      = excluded.gregorian_day,
  nth_weekday        = excluded.nth_weekday,
  weekday            = excluded.weekday,
  anchor_offset_days = excluded.anchor_offset_days,
  duration_days      = excluded.duration_days,
  reminder_lead_days = excluded.reminder_lead_days,
  priority           = excluded.priority,
  color              = excluded.color,
  event_type         = excluded.event_type,
  description        = excluded.description;

-- ---------------------------------------------------------------------------
-- Push the corrections out to years already materialised (ensureEventYear built
-- 2027 and 2028 before this migration ran). 2026 occurrence 1 is the template.
--
-- Deliberately does NOT touch estimated_date or confirmed_date: a later year's
-- resolved date is still correct for its own year, and a confirmed date is an
-- admin decision. Only ISL-JUMUAT-WIDA and the two November promotions change
-- anchor, and those series have no other years yet.
-- ---------------------------------------------------------------------------
update special_events e set
  name               = t.name,
  category           = t.category,
  calendar_system    = t.calendar_system,
  hijri_month        = t.hijri_month,
  hijri_day          = t.hijri_day,
  gregorian_month    = t.gregorian_month,
  gregorian_day      = t.gregorian_day,
  nth_weekday        = t.nth_weekday,
  weekday            = t.weekday,
  anchor_offset_days = t.anchor_offset_days,
  duration_days      = t.duration_days,
  reminder_lead_days = t.reminder_lead_days,
  priority           = t.priority,
  color              = t.color,
  event_type         = t.event_type,
  description        = t.description
from special_events t
where t.event_year = 2026
  and t.occurrence_index = 1
  and e.series_code = t.series_code
  and e.id <> t.id;

-- Branches get three days to answer the first reminder. An editable default.
update special_events
set demand_lead_days = greatest(1, reminder_lead_days - 3);

-- ---------------------------------------------------------------------------
-- Retire the three placeholders from migration 41 that are not on the business's
-- calendar. Deactivated across every year rather than deleted: is_active = false
-- already hides them everywhere and excludes them from ensureEventYear, and a
-- delete would cascade their auto-seeded production-stage rows for no gain.
-- ---------------------------------------------------------------------------
update special_events
set is_active = false
where series_code in ('INT-CHOCOLATE', 'INT-TEACHERS', 'INT-CHILDRENS');
