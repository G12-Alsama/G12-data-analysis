# Supabase setup

This folder holds the database schema for the G12++ Exam Processing Suite. The
team works browser-only, so there is **no CLI step** — everything below is done
in the Supabase web dashboard.

## How to run the migration

1. Create a Supabase project. **Pin it to a UK/EU region** (e.g. London /
   Frankfurt) — participant PII is region-bound (Section 1 of the spec).
2. In the dashboard, open **SQL Editor → New query**.
3. Open `migrations/0001_init.sql` from this repo, copy its **entire** contents
   into the editor, and click **Run**. Run the whole file in one go, top to
   bottom — it creates enums, tables, RLS policies, column grants and the
   `SECURITY DEFINER` transition functions in dependency order.
4. You should see "Success. No rows returned." If you re-run it on an existing
   database, the enum/`create table if not exists` guards make it safe to read
   top-to-bottom, but it is designed for a fresh project.

## Migration order

There is currently a single migration:

| Order | File                       | What it does                                   |
| ----- | -------------------------- | ---------------------------------------------- |
| 1     | `migrations/0001_init.sql` | All enums, tables, RLS, column grants, RPCs.   |

When future migrations are added, run them in ascending filename order
(`0002_…`, `0003_…`) the same way.

## Security model (what to know before changing anything)

- **RLS is on for every table.** Access is driven by the `memberships` table
  (roles: `lead_admin`, `reviewer`, `viewer`).
- **Status / computed / decision columns are never client-writable.** They
  change only through the `SECURITY DEFINER` functions at the bottom of the
  migration (e.g. `set_cycle_status`, `decide_item_exclusion`,
  `write_item_stats`, `lock_grades`, `save_grade_scheme`,
  `set_import_validation`). Column-level `REVOKE`/`GRANT` enforces this even if
  a policy would otherwise allow the update.
- **`responses` are immutable** after ingest (insert-only; no update/delete).
- **`audit_log` is append-only** and is written exclusively by those functions.
  Every exclusion, boundary change, grade lock and export writes an audit row.

## Calling the privileged transitions from the app

Use Supabase RPC, e.g.:

```ts
// A sitting belongs to an exam year and has a period (february | may); both are
// explicit. Create the year first (idempotent), then the sitting in it.
const { data: year } = await supabase.rpc("create_exam_year", {
  p_name: "2026",
  p_region: "eu-west",
  p_test_centre_id: centreId,
});
const { data: cycleId, error } = await supabase.rpc("create_cycle_with_assessments", {
  p_name: "May 2026",
  p_region: "eu-west",
  p_year_id: year.id,
  p_sitting: "may",
  p_sitting_date: "2026-05-14",
  p_assessments: [{ name: "Applicable Maths" }],
});
// (The original year-less `create_cycle(name, region)` is retired by migration 0050.)

await supabase.rpc("decide_item_exclusion", {
  p_item: itemId,
  p_exclude: true,
  p_reason: "Negative discrimination",
});
```

Each function performs its own role check and raises `not authorized` if the
caller lacks the right membership role.

## Auth / environment

The app reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(see `.env.example`). Never put the service-role key in any `NEXT_PUBLIC_*`
variable or ship it to the browser.
