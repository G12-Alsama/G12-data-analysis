-- ============================================================================
-- 0050 PRE-FLIGHT — READ-ONLY. Run these in the Supabase SQL editor (EU) BEFORE the
-- migration `supabase/migrations/0050_year_sitting_unique.sql`. They only SELECT; nothing here
-- changes data. Paste the results back so each finding can be resolved (see the
-- "WHAT TO DO" note under each query).
--
-- Background: a sitting is an `exam_cycles` row, and its PERIOD is the stored
-- `exam_cycles.sitting` (february | may). The create form used to omit the period,
-- so the RPC defaulted every UI-created sitting to 'may' whatever it was called —
-- and nothing stopped two sittings holding the same (year, period).
-- ============================================================================

-- ── 0. Overview ─────────────────────────────────────────────────────────────
select count(*)                                 as cycles_total,
       count(*) filter (where year_id is null)  as without_year,
       count(*) filter (where sitting is null)  as without_period
  from exam_cycles;
-- WHAT TO DO: without_year / without_period must both be 0 (see query 3 if not).


-- ── 1. DUPLICATES — two or more sittings in the same (year, period) ─────────
-- These would violate the new unique (year_id, sitting). `participants`,
-- `assessments` and `grade_rows` show which one carries real work.
select y.name                                             as year,
       t.name                                             as centre,
       c.sitting,
       c.id                                               as cycle_id,
       c.name                                             as cycle_name,
       c.status,
       c.sitting_date,
       c.created_at,
       (select count(*) from participants p where p.cycle_id = c.id) as participants,
       (select count(*) from assessments  a where a.cycle_id = c.id) as assessments,
       (select count(*) from grades       g where g.cycle_id = c.id) as grade_rows,
       count(*) over (partition by c.year_id, c.sitting)             as sittings_in_slot
  from exam_cycles c
  join exam_years y on y.id = c.year_id
  left join test_centres t on t.id = y.test_centre_id
 where c.sitting is not null
   and exists (select 1 from exam_cycles d
                where d.year_id = c.year_id and d.sitting = c.sitting and d.id <> c.id)
 order by y.name, t.name, c.sitting, c.created_at;
-- WHAT TO DO (per group, decide by hand — never automatic):
--   * an empty leftover (participants = 0, status 'draft', no grade_rows) → delete it
--     in the app (Settings → Delete sitting); or
--   * two real sittings that are genuinely different periods → fix the wrong one's
--     period (query 2 gives the statement); or
--   * a sitting filed under the wrong year → move it to the right year, or delete and
--     recreate it there.
-- Re-run until this returns no rows.


-- ── 2. NAME says one period, STORED period says the other ───────────────────
-- `name_says` looks for a month WORD in the sitting's name: february = a whole word
-- january/february/march/april (or jan/feb/mar/apr); may = the word "may". `weak`
-- means the name merely STARTS with jan/feb/mar/apr (e.g. "Marketing…") — treat as
-- unreliable. `suggested_fix` is TEXT for you to review; it is not executed here.
with named as (
  select c.id, c.year_id, c.name, c.sitting, c.status,
         case
           when c.name ~* '\m(january|february|march|april|jan|feb|mar|apr)\M'
                and c.name ~* '\mmay\M'                                   then 'ambiguous'
           when c.name ~* '\m(january|february|march|april|jan|feb|mar|apr)\M' then 'february'
           when c.name ~* '\mmay\M'                                        then 'may'
           when c.name ~* '\m(jan|feb|mar|apr)'                            then 'february (weak)'
           else null
         end as name_says
    from exam_cycles c
)
select y.name                                   as year,
       t.name                                   as centre,
       n.id                                     as cycle_id,
       n.name                                   as cycle_name,
       n.sitting                                as stored_period,
       n.name_says,
       n.status,
       exists (select 1 from exam_cycles o
                where o.year_id = n.year_id and o.id <> n.id
                  and o.sitting::text = split_part(n.name_says, ' ', 1)) as target_period_already_taken,
       case when n.name_says in ('february', 'may')
             and not exists (select 1 from exam_cycles o
                              where o.year_id = n.year_id and o.id <> n.id
                                and o.sitting::text = n.name_says)
            then format('update exam_cycles set sitting = %L where id = %L;', n.name_says, n.id)
       end                                      as suggested_fix
  from named n
  left join exam_years y on y.id = n.year_id
  left join test_centres t on t.id = y.test_centre_id
 where n.sitting is not null
   and n.name_says is not null
   and split_part(n.name_says, ' ', 1) <> n.sitting::text
 order by y.name, t.name, n.name;
-- WHAT TO DO: for each row decide whether the NAME or the STORED period is right.
--   * Stored 'may' but the name clearly says February (the create-form bug) → run the
--     row's suggested_fix. The migration's backfill does this automatically ONLY for
--     whole-word Jan–Apr names whose year has no other February and a single candidate.
--   * `ambiguous` / `weak` / `target_period_already_taken` → resolve by hand; the
--     migration leaves these alone and its pre-flight will stop on any duplicate.
--   * Apply ONE suggested_fix per year, then re-run: two sittings in the same year can
--     both be offered 'february', and applying both would just move the duplicate.


-- ── 3. NO year or NO period (cannot satisfy NOT NULL / unique) ──────────────
-- Created by the legacy `create_cycle(name, region)` RPC, which sets neither.
select c.id as cycle_id, c.name as cycle_name, c.status, c.created_at,
       c.year_id, c.sitting,
       (select count(*) from participants p where p.cycle_id = c.id) as participants
  from exam_cycles c
 where c.year_id is null or c.sitting is null
 order by c.created_at;
-- WHAT TO DO: expected to be empty. If not: delete the empty ones, or give each a year
-- and period by hand (year_id from exam_years; sitting 'february' | 'may').
