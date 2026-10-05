# supabase/diagnostics

**Read-only** SQL for inspecting a database before or after a migration. Nothing here
changes data, and none of it is part of the migration chain (it is not in
`supabase/migrations/`, so nothing applies it automatically). Paste into the Supabase
SQL editor and read the results.

| File | What |
| --- | --- |
| `0050_year_sitting_preflight.sql` | Before `0050_year_sitting_unique.sql`: duplicate (year, period) sittings, name-vs-stored-period mismatches (with reviewable `suggested_fix` text), and cycles with no year or period. |
