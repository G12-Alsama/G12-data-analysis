# supabase/drafts

SQL that is **written but deliberately NOT part of the migration chain** — nothing
in here is applied by anyone or anything automatically, and the opt-in Postgres test
harness (`tests/helpers/scratch-pg.ts`) only applies `supabase/migrations/`.

A draft graduates by being reviewed, then moved into `supabase/migrations/` under its
number and applied by a human in the Supabase SQL editor (EU) — after running its
read-only pre-flight and acting on the results.

| File | What |
| --- | --- |
| `0050_year_sitting_preflight.sql` | READ-ONLY queries: duplicate (year, period) sittings, name-vs-stored-period mismatches, cycles with no year/period. Run first. |
| `0050_year_sitting_unique.sql` | Draft migration: conservative backfill, pre-flight guard, NOT NULL + `unique (year_id, sitting)`, retire legacy `create_cycle`. |
| `0050_year_sitting_unique.rollback.sql` | Its rollback. |
