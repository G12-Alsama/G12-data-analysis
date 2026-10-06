# Multi-sitting provider — design note (Phase 1 + Phase 2)

Phase 1 status: implemented and live. Phase 2 (below, from "Phase 2 —") records the
period registry, N-sitting Overall, expected periods and the persisted-grades design.

Phase 1 status: implemented on `G12_App_Improvement`. This note records the design the code
follows; where the code and this note disagree, the code wins and this note is a bug.

## Problem

`SupabaseDataProvider` used to hold **one** `InMemoryDataProvider` built from the
**newest-created** `exam_cycles` row (`cycles[0]`). Every other sitting became a
stub (`participants: 0`, `mock: true`, `locked: true`, `assessments: []`), the
in-memory provider refused any `cycleId` other than that one (29 guards of the form
`cycleId !== this.seed.liveCycle.id`), and every create / ingest / delete / clear
threw the whole thing away and rebuilt it — silently re-pointing "the" sitting at
whatever was newest. Overall could not read a second real sitting at all (it fell back
to a synthetic February generated from May).

## Target

Any sitting can be opened at any time, independently. Opening, editing or refreshing
sitting B never touches sitting A. Creating a sitting changes nothing the user is
looking at.

## State: workspace-level vs cycle-level

**Workspace-level** — one copy, shared by reference by every provider instance
(`lib/data/workspace-state.ts`, `WorkspaceState`). Editing it through any instance is
immediately visible to all of them; nothing is copied or broadcast.

| State | Source of truth |
| --- | --- |
| Grading config (levels, awards, stars, cut-point defaults), quality thresholds, distinction-safeguard config, borderline band | `workspace_settings` |
| Roles, role → action grid, resolved action set | `roles`, `role_actions` |
| Per-subject element labels | `element_labels` |
| Incident Adjustments config (codes, formulae, caps, import mapping) | `incident_*` config tables |
| Test centres | `test_centres` |
| Members directory | `list_members` RPC |
| Signed-in user | session |
| Audit entries (session-local; there is no audit read in hydrate) | in memory |

**Cycle-level** — owned by that cycle's provider instance, keyed by its `cycleId`:
the ingested data (assessments, items, participants, responses, sittings roster,
diagnostics), item exclusions, clean removals, cohort exclusions, boundaries, essay
marks, incident log / rows / applications, staged exam incidents, alterations and
manual adjustments, CGJ, distinction state, document settings, **lock state**, and the
per-cycle id lookups (`qmToUuid`, `uuidToQm`, `incIdMap`, `subjectToAssessment`) that
translate UI ids to row ids for RPCs.

**Year-level** (derived, never stored): the grouping of sittings under an
`exam_years` row and the Overall rollup.

## Providers

```
SupabaseDataProvider
 ├─ workspace : WorkspaceState                      shared
 ├─ directory : InMemoryDataProvider                workspace reads/writes + the cycle LIST
 │                                                  (light summaries of ALL cycles)
 └─ slots     : Map<cycleId, CycleSlot>
        CycleSlot = { state, provider: InMemoryDataProvider, lookups, loadedAt }
```

* `InMemoryDataProvider` is, by construction, a provider for **one** cycle's detailed
  data plus (in the demo) some mock summaries. It is still the thing that knows how to
  compute every read-model from a `Seed`. It is constructed with the shared
  `WorkspaceState`, so its workspace reads/writes go to the shared object.
* Routing lives in `SupabaseDataProvider`: every cycle-scoped call is routed to
  `slots.get(cycleId).provider`. The 31 `cycleId !== liveCycle.id` guards in the
  in-memory provider became one `hostsCycle(cycleId)` lookup (a provider answers for the
  one cycle it hosts; any other id is "not hosted here"). An `InMemoryDataProvider` is
  therefore still *single-cycle by construction* — what changed is that nothing above it
  assumes there is only one.
* The **directory** instance hosts no cycle (its `liveCycle` is an empty placeholder
  that never appears in lists). Its `priorCycles` are the light summaries of every
  real cycle (`mock: false`, real lock state, real counts). It answers `listCycles`,
  `listYears`, `getYear`, `getCycle` (summary form, `loaded: false`) and every
  workspace-level call.

## Hydration and cache

1. **Light load** (`loadWorkspace`, at sign-in and on explicit refresh): `exam_cycles`
   (all), `exam_years`, `test_centres`, `workspace_settings`, `roles`/`role_actions`,
   `element_labels`, plus per-cycle counts from column-limited selects of
   `participants`, `assessments` and `cohort_exclusions`. **Never** `responses`,
   `items`, `item_stats`, `sittings`, grades, scores or any other fact table.
2. **Cycle load** (`hydrateCycle(cycleId)`): the full per-cycle read that `hydrate()`
   used to do for the newest cycle, unchanged in content (so its integrity guards and
   the 15→6 paging fix still apply), minus the workspace tables.
   The replay runs inside `replayPersisted`: permission gates are bypassed and no audit
   entries are written, because loading stored state is not a decision the current user
   is making. (Replaying through the gated mutators silently dropped every stored
   decision for a read-only viewer, and wrote phantom audit rows for everyone.)
3. **Lazy**: a cycle loads only when something asks for it — the cycle layout calls
   `ensureCycleLoaded(cycleId)` on mount, and Overall calls `ensureYearLoaded(yearId)`
   (which loads only the year's **locked** sittings).
4. **Cache**: a loaded slot stays for the session. Concurrent callers share one
   in-flight promise. A refresh builds the new instance off to the side and swaps it in
   on success, so the screen never flashes empty and a failed refresh keeps the old data.
5. The Overall-**analytics** projection (`fetchOverallAnalytics`, unfiltered reads of
   `grades`/`score_runs`/`participant_scores`) is no longer part of sign-in; it loads the
   first time `/analytics` asks for it. (Its content and the page are unchanged —
   Phase 2.)

## Invalidation on writes

| Write | What is refreshed |
| --- | --- |
| Cycle decision (exclude item, clean removal, boundary, essay, incident, distinction, manual mark, document settings, …) | Applied optimistically to **that** cycle's instance only. RPCs that mint DB ids (essay upsert, incident insert/clear) then refresh **that** cycle. |
| Lock / unlock | That cycle + its directory summary. The RPC fires only if the in-memory lock was actually accepted; on RPC failure that cycle is re-read from the DB. |
| Ingest (`/api/cycles/:id/ingest`) | That cycle (reload) + directory summary. |
| Clear sitting data | That cycle (reload) + directory summary. |
| Delete sitting / delete cycle | Slot dropped, light list refreshed. |
| Create sitting | Light list refreshed. The new cycle is **not** loaded or opened; nothing the user is viewing changes. |
| Workspace setting (grading, quality, safeguard, borderline, labels, incident config) | Mutates the shared `WorkspaceState`; every loaded cycle recomputes on its next read (read-models are derived). No refetch. |
| Roles, test centres, year → centre move | Workspace + list re-read; loaded cycles untouched. |

## Lock state — single source of truth

`exam_cycles.status = 'locked'`, read the same way for every cycle (list, hydrate,
Overall). `lock_grades` flips `grades.locked` only for rows that exist — and the app
never writes `grades` rows — so the old `grades.some(g => g.locked)` read lost the lock
on reload for any sitting without grade rows. Hydration also now restores the lock
through an **ungated** setter (the interactive `lockCycle` is permission-gated and
silently dropped the lock for a read-only viewer).

## Overall

* Rule: per student and subject, the best performance level across sittings; ties go
  to the **latest** sitting; students matched by `qm_participant_id` (email).
* **Only locked sittings count.** An unlocked sitting is listed, flagged *"not counted
  yet: grades not locked"*, and never loaded for the rollup.
* Sittings are separate cycles with separate assessment UUIDs, so each sitting's grades
  are re-keyed to a canonical subject key (`subjectKeyOf`) before rolling up.
* The synthetic February baseline (`demoFebruaryGrades`) exists only in the in-memory
  demo; the live provider never fabricates a sitting.
* "Latest" = period order within the year (the existing order of the two slots), not
  `sitting_date`. A date-based order is a Phase 2 decision.

## Periods

Only February and May exist. Phase 2 generalises periods, so this phase adds no new
`"february" | "may"` literals: period order/labels/keys come from one module
(`lib/data/periods.ts`), and new code iterates it. The existing two-slot shapes
(`YearSummary.february/may`, `OverallGradeCell.source`, `rollupOverall({february, may})`)
are unchanged and are the remaining two-slot coupling.

## Known limits / deliberate choices

* Light participant count = participants − cohort exclusions. Once a cycle is opened
  the count comes from the loaded cycle (which additionally honours Clean-stage removals),
  so it can drop slightly on open. It is never inflated by dangling keys.
* Loaded cycles are not evicted. A year has two sittings, so memory is bounded by the
  sittings a user actually opens in one session.
* The directory shares the audit list but not any cycle's decision state; the audit
  page is still session-local (there is no audit read).

## Measured (synthetic, in-process — no network time)

* Sign-in load: **13 queries over 11 small tables**; no fact table.
* Opening a sitting: **20 queries**; a 37,500-response sitting (250 students × 5 subjects
  × 30 items) took ≈ 1 s CPU and retained ≈ 3.5 MB (≈ 95 bytes per response).
* `getGrades` for that sitting: ≈ 175 ms (recomputed on read, as before).

---

# Phase 2 — periods, N-sitting Overall, readiness, persisted grades

Status: steps 1–3, 5, 6, 8 implemented; step 4 (persisted grades) is **design only** and
step 7 (access) is a **report only** — nothing in either was changed. Where the code and
this note disagree, the code wins and this note is a bug.

Decisions taken as given: Overall = best performance level per student and subject across
**locked** sittings; ties go to the latest sitting by **period order** within the year (not
`sitting_date`); students match on `qm_participant_id` (email); demo mode is untouched; one
sitting per period per year per centre; only February and May exist today but any month may
be added later.

## 1. Period registry (`lib/data/periods.ts`)

One table, `PERIOD_DEFS`: `key`, `label`, `shortLabel`, `month`, `order`, `covers` (the
calendar months an export dated in them is attributed to the period), `expectedByDefault`.
`SittingKey` is derived from it; the validator rejects duplicate keys/orders and any month
covered by zero or two periods. Everything that used to spell `"february" | "may"` now asks
the registry: the Years/Year/Overall/New-sitting pages, `YearSummary`/`YearDetail`
(`sittings: SittingRef[]` in period order instead of `february`/`may` fields), the Overall
cell (`levels[]`), the QM sitting parser (`parseSitting` → `periodOfMonth`), the legacy
name fallback, the document generator's source tag, and the DB type alias.

**Adding a period = one `PERIOD_DEFS` entry + one migration** extending the enum
(`supabase/templates/add-sitting-period.template.sql`, including the `ALTER TYPE … ADD VALUE`
transaction caveat). `tests/periods.registry.test.ts` fails if the registry and the
`sitting_period` enum declared by the migrations disagree, in either direction.
Only the sitting **slots** are generic; one remaining deliberate two-slot coupling is the
`/analytics` projection (`OACell.february/may`, "Sat Feb → Sat May" sections): it compares
the registry's first two periods and now **skips** a sitting in any other period instead of
mislabelling it. Generalising it belongs with persisted grades (step 4).

## 2. N-sitting rollup (`lib/data/overall.ts`)

`rollupOverall({ sittings: [{key, grades}], … })` takes any number of sittings, one per
period. It orders them by the registry, walks oldest → newest and lets a later sitting take
the cell on `<=`, so a tie goes to the latest and an older sitting wins only when strictly
better. A sitting with `grades: null` (not counted) contributes nothing but still appears in
each cell's `levels`. An unknown or duplicate period throws (a wrong input must not be
guessed). `OverallGradeCell` is `{ level, stars, source, levels: [{key, level|null}] }`;
`OverallGradeRow` carries `presentIn` (periods) instead of `inFebruary`/`inMay`.
`rollupOrdered` is the positional adapter (entry *i* = registry period *i*, or explicit
`keys`) and no longer refuses more than two.

## 3. Expected periods ("ready")

`exam_years.expected_periods sitting_period[] not null default '{february,may}'`
(migration 0051). A year is **ready** when it has an expected list and every expected period
has a started, locked sitting. A locked sitting in a non-expected period is counted but never
blocks; an unlocked one is listed "not counted yet" and does not block readiness either.
Years show a tile for every expected period plus any period that has a sitting. With the
default list the behaviour is identical to the old hard-coded pair (tests pin this).
The default for an unconfigured year comes from the registry (`expectedByDefault`), so adding
a period does **not** make every old year "not ready". The client reads `select *` from
`exam_years` and treats a missing column as "defaults", so the code can ship before the
migration is applied. Setting a year's list is `set_year_expected_periods(p_year_id,
p_periods)` (same gate as moving a year between centres).

## 4. Persisted grades — DESIGN ONLY (nothing implemented)

### What exists today (verified)

* `grades(cycle_id, participant_id, scope, grade_label, score, locked, signed_off_*)`,
  `unique(cycle_id, participant_id, scope)`; `scope` = assessment id or `'overall'`. The app
  never writes it. `lock_grades(p_cycle)` (0041, gate `general.signoff`) flips `grades.locked`
  for rows that exist (none) and sets `exam_cycles.status='locked'`; it computes and checks
  nothing. `unlock_grades` sets `status='graded'` (reason required).
* Grades are computed **only in client TypeScript** (`InMemoryDataProvider.getGrades`, from
  hydrated state). The only server-side engine is `recomputeAndWrite` (raw scores into
  `score_runs`/`participant_scores`); it computes **no** cut points, levels, awards, D3 cap,
  adjustments-as-grades. `participant_scores` are **pre-adjustment** (alterations/manual
  adjustments, essay and incident effects, item/row exclusions live outside them).
* Only reader: `fetchOverallAnalytics` (unfiltered: no `locked`, no status, no sample flag).
  Real sittings have no rows, so `/analytics` shows only the 0043 synthetic seed
  (`△ Sample …` centres, 12 sittings, `engine_version='seed-synthetic'`).
* **No server-side lock enforcement exists**: no RPC or route checks `status`. Ingest sets
  `in_review` and `clear_cycle_ingest` deletes `grades`; so re-ingesting a locked sitting
  silently unlocks it and drops its rows. `clear_sitting_data` sets `draft`.

### Options

| | A. Client-computed snapshot sent at lock | B. Server recompute at lock (recommended) | C. Port grading to SQL |
| --- | --- | --- | --- |
| Who computes | the browser (`getGrades`), POSTed | a Node route re-runs the same TS code on persisted state | plpgsql |
| Matches what the signer saw | exactly | yes, if their decisions are persisted; enforced by a digest check | no guarantee |
| Trust | server must validate a client-supplied payload; a user holding `general.signoff` could post any numbers | none placed in the client | none |
| Code | smallest | medium: reuse `hydrateCycle` + `InMemoryDataProvider` server-side (no second implementation) | large; duplicates a parity-locked engine (183/183 vs `reconcile.py`) |
| Drift risk | none | none (same code) | high |

### Recommendation: B, with the signer's view as a precondition

1. UI "Lock grades" sends `POST /api/cycles/:id/lock { viewDigest }` where `viewDigest` is a
   hash of the grades the user is looking at.
2. The route authenticates the user, checks `app.can_do(cycle,'general.signoff')` with the
   user's own client, then builds the sitting server-side with the **same** code
   (`hydrateCycle` → `InMemoryDataProvider` → `getGrades`) using the service client. If its
   digest ≠ `viewDigest` it refuses ("this sitting changed since you reviewed it — reload").
3. It calls `lock_grades_snapshot(p_cycle, p_actor, p_header, p_rows)` — **service_role
   only** — which, in one transaction, re-checks the actor's gate, writes the snapshot,
   `grades` rows and flips `status`. `lock_grades` is revoked from `authenticated` so a
   client cannot lock without a snapshot. A failure anywhere leaves the sitting unlocked.

Fallback if server hydration proves too heavy: option A with server validation (levels ∈
vocabulary, exactly one row per cohort participant matching `participants`, counts agree).

### Snapshot schema

* Header `grade_snapshots(id, cycle_id, state ('active'|'stale'|'superseded'), source
  ('lock'|'backfill'|'seed'), locked_at, locked_by, engine_version, inputs_digest,
  participant_count, config jsonb)`; `config` freezes the grading vocabulary, per-assessment
  cuts, borderline/safeguard settings and the *effects* applied (counts and ids of item
  exclusions, clean removals, cohort exclusions, manual adjustments, incident alterations, D3
  overrides) so an auditor can see what produced the numbers.
* Rows: keep using `grades` (so `fetchOverallAnalytics` keeps working) with `snapshot_id`,
  `student_key` (the `qm_participant_id`), `grade_label`, `score` (**post-adjustment** pct),
  and a `detail jsonb` (raw, max, stars, marginal, D3 cap, award, adjusted flag). One active
  snapshot per cycle. Values come from the computed `GradesModel`, **never** from
  `participant_scores`, so adjustments, exclusions and incident effects are included.

### Lifecycle

* **Unlock:** `unlock_grades` marks the header `stale` (same transaction); rows stay for
  comparison but every reader filters on `status='locked'` **and** `state='active'`.
* **Re-lock:** replaces the rows, supersedes the old header.
* **Re-ingest / re-score of a locked sitting:** today these silently unlock/delete. Proposed:
  refuse server-side while `status='locked'` ("unlock first"), via one `app.assert_unlocked`
  guard added to the input-changing RPCs and the ingest/recompute routes. Until that exists
  the snapshot would silently diverge; the header's `inputs_digest` lets a reader detect it.
* **Workspace config change after lock:** the snapshot is the frozen truth; the live
  recompute may differ — surface "config changed since lock" by comparing `config` digests.

### Backfill (the existing locked production sitting)

A one-off, idempotent admin route runs the same compute path for every `locked` cycle with
no active snapshot and writes `source='backfill'`, `locked_by` = null, `locked_at` =
`exam_cycles.updated_at`. It reflects **current** inputs, not necessarily those at lock time —
hence the flag and a dry-run mode that prints a diff against what the UI shows; the lead
admin confirms before writing.

### `/analytics`

`fetchOverallAnalytics` joins `exam_cycles.status='locked'` and `grade_snapshots.state='active'`.
Unlocked/stale/superseded sittings never appear. Its two-slot cell structure is generalised
with the registry at the same time.

### Sample data stays labelled

Add `test_centres.is_sample boolean not null default false` (backfilled for the 0043
centres) and give the 0043 rows a header with `source='seed'`, so they keep matching the new
filter. Cells carry `synthetic: true` (already in `OACell`); the page tags them "Sample" and
excludes them from real aggregates by default.

### Test plan

SQL/real-PG: lock writes snapshot + status atomically and rolls back on error; `lock_grades`
not callable by `authenticated`; unlock stales; re-lock supersedes; guard refuses input
changes while locked; 0043 rows keep showing, labelled. Unit: snapshot includes a manual
adjustment, an item exclusion and an incident effect (golden: snapshot pct == `getGrades`, ≠
`participant_scores`); digest mismatch refuses; analytics excludes unlocked/stale; backfill is
idempotent and flags `source`; sample centres are tagged.

## 5. Overall documents

`getOverallDocuments` used to return `cycleId: yearId`, and the documents page sent that to
`record_documents(p_cycle)` — which checks `app.is_member(p_cycle)` on a **year** id, so the
event was refused and lost. The model now carries `recordCycleId` (the latest counted sitting,
else the latest started one) and `yearId`; the document-issue audit event is recorded against
that real cycle with the year named in the detail. No migration: the audit row belongs to a
real sitting. `getOverallGrades`/`getOverallDocuments`/`getYear` all resolve a year by either
`y.id` or the real `exam_years.id`.

## 6. Upload mismatch warning

All parsing happens in the browser before anything is sent, so the check sits between
`ingestThreeExports` and `ingestRawExport`. The canonical model now also carries the export's
result date range (`ResultStartLocal`/`ResultFinishedLocal`, when present). A pure function
compares the export's tagged year/period (from `ResultGroupName`) and its dates (year and
registry period of the date range) with the sitting's year and period. Any difference shows a
warning that must be confirmed ("Upload anyway" / "Cancel"); it never hard-blocks. An export
with no date columns, or no group-name tag, compares only what it has; with nothing to compare
there is no warning. `sitting_date` is display-only and is not compared.

## 7. Access (report only — nothing changed)

Verified against the migrations (latest definition wins) and the client; not run against a
live database, so live drift (functions edited by hand) is not visible here.

**How read access works.** `exam_cycles` rows are visible to anyone with any membership
whose enum `role` is set and whose scope is the workspace (`cycle_id IS NULL`) or that cycle
(`app.is_member`). `exam_years` rows are visible only through `app.is_year_member` (0005,
never redefined): a membership **on one of the year's sittings**, or having **created** the
year. A workspace (NULL-scope) membership does not count. Per-sitting fact tables follow
`is_member(cycle_id)`. `general.view` gates nothing.

**Who sees what when opening a year with several sittings**

| Persona | Years list / Year page | Overall | Sittings |
| --- | --- | --- | --- |
| Workspace admin (NULL-scope, Admin) | sees every sitting (`is_member`), but only years they created or sit in carry a year row — others fall back to a name parsed from the cycle name and to the **primary centre**; `expected_periods` is invisible so the year reads as the default | all locked sittings count; ready per the (possibly default) expectation | full access; actions follow the grid |
| New user, no membership | `/access-denied`; nothing loads (a direct API call can still read centres, workspace settings, roles, null-scope audit rows, and call `create_exam_year`/`create_cycle_with_assessments`) | – | – |
| Read-only viewer (per-sitting membership in only some) | only years with a visible sitting; **a sitting they cannot see renders "Not started" with a start button**, indistinguishable from a missing one (creating it fails on `unique(year_id, sitting)`) | partial: counts only visible locked sittings, never "ready", yet the certificates link still shows | edit controls follow ONE client-resolved role, which may be wrong per sitting |

**Gaps** (none changed here):

1. `is_year_member` ignores workspace memberships → workspace admins get wrong year labels/
   centres, and **a year's `expected_periods` is unreadable to anyone who cannot read the year
   row, so readiness silently falls back to February + May for them** (new with 0051).
2. Memberships don't carry to a new sitting: only its creator joins; a colleague who created
   February does not see May unless they hold a workspace membership.
3. `invite_member`/`set_member_role` write only `role_id`; the enum `role` stays NULL (invitee
   fails `is_member`, sees nothing) or stale (a demoted lead keeps enum-gated powers).
   Creators/RUNBOOK admins have no `role_id`, so `can_do` is false while the UI shows admin.
4. No read-only role is seeded (`viewer` was backfilled to "G12 team member", which can edit).
5. Several RPCs still gate on the enum while the UI gates on the grid (`save_grade_scheme`,
   distinction RPCs, incident apply/unapply, `decide_item_exclusion`, …).
6. `create_exam_year`/`create_cycle_with_assessments` have no role gate; any authenticated user
   can create years and sittings and attach to any year id they know.
7. The ingest/recompute routes gate on the enum `lead_admin` (`authorizeCycleAdmin`), not on
   `upload.ingest`; `awards.generate` is client-only.
8. `list_members` returns every user's email/role/scope to anyone with any membership.
9. The Overall can be partial for a user who cannot see every sitting, without saying so.

## Known limits / deliberate choices (Phase 2)

* The `/analytics` projection stays two-slot (see §1).
* Loaded sittings are still not evicted.
* Demo mode is unchanged (its copy is generated from the registry but reads identically).
