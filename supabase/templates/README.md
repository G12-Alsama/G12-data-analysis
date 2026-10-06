# supabase/templates

SQL that is **not** part of the migration chain and is never applied by the repo's
tooling. Files here are templates; copy one into `supabase/migrations/`
under the next free number (and review it) when you actually want it.

| File | What it is |
| --- | --- |
| `add-sitting-period.template.sql` | Template for adding a value to the `sitting_period` enum when a new period is added to `lib/data/periods.ts`. Read the transaction caveat in its header first. |
