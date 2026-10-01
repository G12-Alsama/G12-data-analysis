# Overall from two real sittings (O9): deploy and verify

**What ships:** migration `0046_real_two_sitting_overall` (plus its rollback), and the app change where Overall reads two **real, locked** sittings. Overall shows no rows until **both** are locked, and nothing is synthesised on live data. Unchanged: `lib/engine/**` (parity 183/183), `rollupOverall`, `deriveAward`, `mock-admin.ts`. Tests: **1348/1348 green**.

Run SQL in the Supabase SQL editor (EU) **as the project owner**. Migrations go in **before** the merge, as in `docs/prod-cutover/RUNBOOK.md`.

## 1. Pre-flight (read-only)
1. Take a Supabase backup or snapshot.
2. Confirm 0045 is the last applied migration (0001–0045 present).
3. Snapshot the current state:
   ```sql
   select t.slug, y.name as year, c.name, c.sitting, c.status, c.sitting_date, c.id
     from exam_cycles c join exam_years y on y.id = c.year_id
     join test_centres t on t.id = y.test_centre_id order by c.created_at;
   select slug, name, active from test_centres where slug like 'seed-ov-%';
   ```
4. Run the **DRY RUN** query from the header of `0046_real_two_sitting_overall.sql`. It lists every cycle whose stored sitting disagrees with its ingested result dates. A February created through the app shows `stored = may, derived = february`. That row is the defect 0046 fixes.

## 2. Apply the migration
Run `supabase/migrations/0046_real_two_sitting_overall.sql` once. It runs in one transaction.

Then check:
```sql
select * from app.sitting_backfill_0046;                      -- what was corrected
select count(*) from test_centres where is_synthetic;         -- the seed-ov centres (0 if already removed)
select cycle_id, before, after from audit_log where action = 'derive_sitting' order by ts desc;
```
No grade, score, lock or sign-off is changed. The February keeps `status = locked`.

## 3. Merge and redeploy
Merge the PR, then redeploy production (Vercel). No new environment variables are required. `NEXT_PUBLIC_SHOW_SYNTHETIC_ANALYTICS` is optional and should stay unset in production.

## 4. Operational sequence
1. **February:** already real and locked, so leave it alone. (For a fresh year: Start a new sitting → same centre → pick a **Jan–Apr date** → Upload the 3 Questionmark CSVs → run the pipeline to Grades → **Lock**.)
2. **May:** **Start a new sitting**:
   - **same test centre as February** (the "△ Sample" centres are no longer offered);
   - name e.g. `G12++ May 2026` (any name containing 2026 joins the same 2026 year);
   - **date in May**.
   Then Upload the 3 CSVs and run the full pipeline. Ingest re-designates the sitting from the export's `ResultGroupName` (e.g. `MAY2026`). Finish at Grades → **Lock**.
3. **Overall:** Years → 2026 → Overall. For every student and each of the five subjects, it shows the **Feb** level, the **May** level and the **Combined** level (the higher, tagged Feb or May), plus the **Overall award**. Before both sittings are locked it shows "Overall is not available yet" and lists which sitting is outstanding.

## 5. Verify
```sql
-- Exactly one February and one May, same year_id, both locked:
select c.sitting, c.status, c.year_id, c.name from exam_cycles c
  join exam_years y on y.id = c.year_id join test_centres t on t.id = y.test_centre_id
 where not t.is_synthetic and y.name = '2026' order by c.sitting;
```
In the app:
- The table has **3 columns per subject × 5 subjects + the award**.
- **Row count** equals the number of distinct students across both sittings.
- Spot-check 3 students against each sitting's own Grades screen. The Feb and May columns must match, Combined must be the higher of the two, and ties go to May.
- "Feb only" / "May only" tags appear only for students who really sat once. An unexpected pair means the student's Questionmark participant ID changed between sittings; fix it in the source data.
- Overall › Certificates: the "Real (non-synthetic) data" and "All sittings locked" gates are met. Official issue is still gated on the O1/O2 sign-off (unchanged).

## 6. Rollback
- **App:** redeploy the previous build. It is compatible with 0046 (same RPC signature).
- **DB:** run `0046_real_two_sitting_overall.rollback.sql`. It restores every backfilled sitting from `app.sitting_backfill_0046` (audited), restores the 0031 `create_cycle_with_assessments` body, and drops the trigger, helper functions and `is_synthetic`. It never deletes or edits audit rows.
- **Remove the synthetic sample entirely (optional):** run `0043_overall_analytics_seed.rollback.sql`. It deletes only `seed-ov-*` data; real cohort data is untouched. Both rollbacks were verified on PostgreSQL 16 over the full 0001→0046 chain.

## Known limits / follow-ups (not blockers for this deploy)
- **Analytics page (`/analytics`)** reads persisted `grades` rows. Real sittings never write those (`lock_grades` only flips flags), so it shows an honest **empty** state for real data instead of synthetic figures. Follow-up: persist a grades snapshot at lock.
- February's grades are **recomputed** from its stored decisions each time Overall loads, the same way the live cycle is. Do not change **workspace grading defaults** (level labels, default cuts) between locking February and issuing certificates. The snapshot follow-up above removes this caveat.
- Only the newest sitting is editable in the app. After May is created, February cannot be unlocked from the UI (unchanged behaviour).
