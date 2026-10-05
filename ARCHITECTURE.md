# G12++ Exam Processing Suite — Architecture (backend & engine)

This document summarises what has been built so far: the data model, the
computation engine and its swap point, the validation gates, and exactly what is
stubbed. The source of truth for *intent* is `G12pp_Exam_Suite_Design_Spec.md`;
this document describes the *implementation*.

> **Scope note.** The backend (schema, parity-verified engine, ingest/export)
> and the **six-screen front end** are both built. The provider has **two
> implementations behind one interface**: an in-memory provider (the default —
> tests + no-network demo) and a live **`SupabaseDataProvider`** with real
> `@supabase/ssr` auth, selected by `NEXT_PUBLIC_DATA_PROVIDER` (see "Frontend
> (UI)" below). Migrations `0001`–`0003` define the schema/RLS/RPCs.

## Stack

- **Next.js 14 (App Router) + TypeScript (strict)** — see `tsconfig.json`
  (`strict`, `noUncheckedIndexedAccess`).
- **Tailwind** + ported design-system CSS (`app/globals.css`) and tokens
  (`lib/ui/tokens.ts`). Fonts via `next/font`: **Sofia Sans** (UI), **IBM Plex
  Mono** (data), **Yellowtail** (the script “A” mark) — matching the Claude
  Design hi-fi in `design/`.
- **recharts** for the score-distribution histogram and breakdown charts.
- **Supabase** (Postgres/Auth/Storage/RLS) — env-var-based clients in
  `lib/supabase/`. Not yet wired to the UI. No keys committed; see `.env.example`.
- **SheetJS (`xlsx`) / `xlsx-js-style`** for Excel I/O.
- **Vitest** for tests. `npm test` runs 256 tests, all passing.

## Repository layout

```
app/                      Placeholder home route + layout (no styled UI)
lib/
  supabase/               Browser + server Supabase clients (RLS-bound)
  types/database.ts       Hand-written strict types mirroring the schema
  engine/                 Computation engine (Section 8 interface)
  ingest/                 Questionmark parse → clean → validate
  export/                 SheetJS workbook builders
supabase/
  migrations/0001_init.sql  Schema, RLS, column grants, SECURITY DEFINER fns
  README.md               How to run the migration in the SQL editor
data/                     De-identified fixtures (parity + sample export)
tests/                    Vitest suites (parity is the trust gate)
```

## Database schema & security model

`supabase/migrations/0001_init.sql` implements the Section 5 model:
`exam_cycles, memberships, assessments, items, item_stats, participants,
responses, item_reviews, score_runs, participant_scores, grade_schemes, grades,
import_batches, audit_log`. Status fields use Postgres **enums**.

Non-negotiable security model (Sections 3 & 5), all enforced in the database:

- **RLS is enabled on every table.** Read access = members of the cycle; write
  access is role-gated through `memberships` (`lead_admin`, `reviewer`,
  `viewer`).
- **Status / computed / decision columns are never client-writable.** This is
  enforced with column-level `REVOKE`/`GRANT`: clients receive `UPDATE` only on
  the specific editable columns, never on `exam_cycles.status`,
  `assessments.status`, `items.status`, any of `item_stats`,
  `participant_scores`, `grades.locked` / `signed_off_*`,
  `score_runs.computed_at`, or `import_batches.validation_passed`. Those change
  **only** through `SECURITY DEFINER` functions, which run as the table owner
  and bypass the column grants.
- **`responses` are immutable after ingest** — insert-only; `UPDATE`/`DELETE`
  are revoked and no policy permits them.
- **`audit_log` is append-only** and written exclusively by the definer
  functions; `INSERT`/`UPDATE`/`DELETE` are revoked from clients.
- **Every privileged transition writes an audit row** — exclusions
  (`decide_item_exclusion`), boundary changes (`save_grade_scheme`), grade
  lock/unlock (`lock_grades`/`unlock_grades`), exports (`record_export`),
  status changes and `write_item_stats` all call the internal `app.audit(...)`.

The transition RPCs (`public.*`, callable by `authenticated`, each enforcing its
own role check):

| Function | Purpose |
| --- | --- |
| `create_cycle_with_assessments` | Create a sitting (an `exam_cycles` row) with its assessments, under an exam year and period, and make the creator its `lead_admin`. (The original year-less `create_cycle` was retired by migration 0050.) |
| `set_cycle_status` / `set_assessment_status` | Move status enums (lead only). |
| `decide_item_exclusion` | Record human gate 1 + flip `items.status` + audit. |
| `write_item_stats` | Engine writes `item_stats`, tagged with `engine_version`. |
| `save_grade_scheme` | Save boundaries + audit the change. |
| `lock_grades` / `unlock_grades` | Sign-off lock; unlock requires a reason. |
| `set_import_validation` | Mark `validation_passed` + advance status. |
| `record_export` | Audit an export. |

Types in `lib/types/database.ts` are hand-written to match, with `Insert`/
`Update` shapes that omit protected columns (the real guarantee is in the DB).

## Computation engine (Section 8) and its swap point

The engine lives behind a single interface, `ComputationEngine`
(`lib/engine/index.ts`):

```ts
interface ComputationEngine {
  readonly version: string;
  ingestAndClean(rawExport): { cleanedResponses, validationReport };
  computeItemStats({ responses, items?, scoringConfig? }): ItemStat[];
  computeScores(responses, excludedItemIds, options?): ParticipantScore[]; // ScoreOptions: essayMarks, alterations, essayAssessmentIds…
  rollUp({ participantScores, responses, items, excludedItemIds? }): RollUp;
}
```

- The active implementation is `TypeScriptEngine`, a transparent TS port. Every
  result is tagged with `ENGINE_VERSION` (`ts-engine-0.1.0`).
- **Swap point:** callers depend only on the interface and the domain types in
  `lib/engine/types.ts`. To drop in the validated Python later: implement the
  interface against the Python service, bump `ENGINE_VERSION`, and return it from
  `getEngine()`. **No caller, route, table or test signature changes — only
  `lib/engine/index.ts`.** The parity test must pass against the new engine
  before it is trusted in production.

### The maths (verified)

For dichotomous (0/1) items, grouped per assessment:

- **p-value** = mean item score.
- **item-total** (corrected) = Pearson(item score, total of the *other* items).
- **point-biserial** = Pearson(item score, full total incl. the item).
- **discrimination** = mean(upper group) − mean(lower group), where the groups
  are the top/bottom `g = round(n/3)` participants ranked by the corrected
  (item-excluded) total **descending, ties broken by the full total
  descending**. (The tie-break by full total is what reproduces the published
  values exactly; it is principled — among equal rest-totals, the participant
  who got *this* item right ranks higher.)
- A correlation with zero variance (undefined) is stored as `null` and rated
  **Flag**.
- **Ratings** (computed on full precision, values rounded to 3 dp for display):
  - p-value: `<0.20` Flag · `<0.30` Review · `≤0.85` Good · `≤0.90` Review · else Flag.
  - item-total / point-biserial / discrimination: undefined→Flag · `<0.10` Flag · `<0.30` Review · else Good.
  - overall = worst of the four (Flag > Review > Good).

### ScoringConfig — the engine's configuration (and parity-against-defaults)

The engine no longer hardcodes its *judgement* — only the verified *maths*. A
single **`ScoringConfig`** object (`lib/engine/config.ts`) holds everything that
is policy rather than arithmetic, so editing it in Settings actually changes
scoring:

```ts
interface ScoringConfig {
  quality: {                        // Good/Review/Flag bands per statistic
    pValue:        { flagBelow; reviewBelow; goodUpTo; reviewUpTo };
    itemTotal:     { flagBelow; reviewBelow };
    pointBiserial: { flagBelow; reviewBelow };
    discrimination:{ flagBelow; reviewBelow };
  };
  performanceLevels: { label; stars }[];  // per-assessment, best → lowest, N levels
  awardLevels:       { label }[];         // overall awards, best → lowest, N awards
  performanceCuts: number[];              // default cut-points (length L−1)
  awardCuts: number[];                    // default cut-points (length M−1)
}
```

- **N levels / N awards, not fixed at four.** Nothing reads a hardcoded level
  name or count: `computeItemStats` rates items from `quality`, and the
  score→level / score→award classification (`classifyByCuts`) reads the
  configured ordered sets and their cut-points. Cut-points are referenced *by
  the configured set*; the live per-cycle cuts still live with the boundary
  state, defaulting from `performanceCuts` / `awardCuts`.
- **Where the defaults live.** `DEFAULT_SCORING_CONFIG` (and the cloning
  `defaultScoringConfig()`) in `lib/engine/config.ts` is the single source of
  truth for the default thresholds and the grade/award vocabulary. The grade
  vocabulary constants in `lib/data/grading.ts` are *derived* from it, so there
  is exactly one definition.
- **Where it lives at runtime.** `ScoringConfig` is a new, **defaulted** input on
  `computeItemStats` (`ItemStatsInput.scoringConfig`). The provider assembles the
  live config (`this.quality` + the grading vocabulary), threads it into every
  engine item-stats call, and exposes it as a settings read-model
  (`DataProvider.getScoringConfig()`). It will persist in Supabase after the
  provider swap; the Settings editor that mutates it is the next prompt.
- **Parity-against-defaults guarantee.** The default config reproduces the
  previous hardcoded behaviour **byte-for-byte**, so the 177-item parity test
  (which runs with no config, i.e. the default) stays green — that is what keeps
  the maths guarded now that thresholds are configurable.
  `tests/engine.config.test.ts` proves the other direction: a changed quality
  threshold re-rates an item, an added/removed performance level changes the
  classification, and a changed cut-point moves a score between levels.

### Parity (the trust gate)

`tests/engine.parity.test.ts` feeds each assessment's de-identified responses
from `data/parity_fixtures.json` through the engine and asserts it reproduces the
data scientist's published p-value, item-total, point-biserial and discrimination
for **all 177 items across the five assessments** within rounding tolerance, with
ratings and overall review matching exactly. `computeScores` is separately
checked for self-consistency against the raw response matrix.

### Subject totals: MCQ + Essay + Alterations (the reshaped scoring model)

A student's **final mark for a subject** is a raw-mark sum of three components:

1. **MCQ** — 1 mark per question over the items **retained** after the cohort
   item-review (the Review step's psychometric exclusions). Unchanged maths.
2. **Essay** — **English and Arabic only**, marked offline and uploaded, out of
   **20**, added to the MCQ total (so a 40-item English subject becomes scored
   out of 60).
3. **Alterations** — per-student raw marks **added or subtracted** by human
   judgement, arising from the incident-log triage. Audit-logged.

`ParticipantScore` carries `mcq` / `essay` / `alterations`, the total (`raw`),
the subject `max` ( = retained MCQ item count + 20 when the subject has an essay)
and `pct`. `computeScores(responses, excludedItemIds, options?)` takes
`ScoreOptions` (`essayMarks`, `alterations`, `essayAssessmentIds`, `essayMax`);
empty defaults score a cycle **exactly as MCQ-only**. Performance-level
cut-points and the boundaries screen operate on this **summed total and its
max**; the overall award is derived from the five subject results by the
**confirmed Layer-2 rule** (`lib/engine/award.ts` · `deriveAward`): a
deterministic lookup from the pattern of the five subject performance levels
(Distinction / Advanced / Secondary / No Award, evaluated highest→lowest), plus
the per-student **D3-majority cap** (Layer 1b). It is **not** a cut on an
overall score. See "Award rule & D3 cap" below.

**The previous per-student exclusion model was removed entirely.** Nothing is
dropped from any student or from cohort statistics; alterations are additive.
`computeItemStats` is byte-identical to the baseline (the old empty per-student
path was a no-op), so the **177-item parity test still passes 177/177**
(`tests/engine.scoring-components.test.ts` pins the essay/alteration arithmetic
and the unchanged item stats).

**Essay importer** (`lib/data/parse-essays.ts`, Part 2): reads the per-subject
sheets (AFL → Arabic, ESL → English) keyed by ParticipantID, taking the
`TotalScore` column (the D1–D5 rubric columns are ignored); each student's mark
is the **mean** of their per-essay TotalScores (`// CONFIRM:` divisor). Optional,
non-blocking upload at Ingest (`uploadEssayMarks` / `loadSampleEssayMarks` /
`getEssayMarks`), matched by ParticipantID with unmatched IDs surfaced.

**Incident → alterations triage** (`lib/data/parse-incidents.ts`, Part 3): reads
the free-text `Incident_Log` (header ~row 3) and `Students Complaints` sheets
into a triage queue — **never auto-applied**. On the Adjustments step each
incident is decided per-student (roster suggestion from the free-text name +
`Exam` code, never auto-applied), whole-subject (bulk), or no-action, becoming an
alteration (`decideIncident` → `getAdjustments`) that feeds the roll-up and is
audit-logged.

## Ingest + validation (Sections 5 & 10)

`lib/ingest/` parses a Questionmark export (xlsx/csv via SheetJS) and:

- **repairs mojibake** — the Arabic arrives as UTF-8 bytes mis-decoded as
  CP1252; `repair.ts` reverses the CP1252 mapping and re-decodes as UTF-8,
  leaving ASCII and already-correct text untouched (`repairText`).
- **filters to Multiple Choice** only and **drops survey assessments**.
- **parses demand level** (`D1/D2/D3`) from the `MetaTags` field
  (`Demand Level==Dx||…`).
- **derives major/sub element** from the backslash-delimited
  `QuestionTopicPath`.
- assigns each participant a **sequential pseudonym** so downstream data carries
  no PII.
- tolerates the historical **Remove-column variants** (`Remove Item?`,
  `Remove item?`, `Remove?`, `Column1`) via `normalizeRemoveColumnHeader`.

`validate.ts` runs the Section 10 gates and returns a structured pass/warn/fail
report (`passed` is false on any hard-fail):

| Gate (`id`) | Checks |
| --- | --- |
| `schema` | Required Questionmark columns present. |
| `encoding` | No residual mojibake after repair. |
| `no_leak` | No survey / non-MCQ rows in the analysis set. |
| `demand_tag` | Every retained item has a D1/D2/D3 tag. |
| `result_status` | Every participant has a result status. |
| `duplicates` | No duplicate participant/item responses. |
| `reconciliation` | Per-participant item counts reconcile (warn-level). |

`tests/ingest.test.ts` runs the whole pipeline against the de-identified
`data/sample_qm_export.xlsx` (`in` sheet).

## Excel export (Section 9)

`lib/export/` builds three workbooks. Generation uses **`xlsx-js-style`** (a
drop-in SheetJS fork) so cell fills are written; the upstream community `xlsx`
build silently drops styles on write. Import/parsing still uses `xlsx`.

- **Item Analysis** — reconciled to the exact `MCQ_Item_Analysis` layout:
  - a **`README & Summary`** sheet (title, purpose, then one row per assessment
    with participant/item/row counts, the discrimination group size,
    Good/Review/Flag tallies and median statistics — header exported as
    `ITEM_ANALYSIS_SUMMARY_HEADERS`);
  - one sheet **per assessment** with row 1 title, row 2 meta
    (`Participants | Items | Rows analysed | Upper/Lower group size`), row 3
    reading guide, two blank rows, the **20-column header on row 6**
    (`ITEM_ANALYSIS_HEADERS`, including a **single** `Remove Item?` /
    `Reason for removing item` pair), then one row per item from row 7.
  - The five rating columns (P-Value, Item-Total, Point-Biserial, Discrimination
    ratings and Overall Item Review) carry **green/amber/red fills** per
    Good/Review/Flag (`RATING_STYLES`).
  - `assembleItemAnalysis(...)` joins engine `ItemStat[]` with response-level
    facts to derive Presented/Answered counts and average response time, and the
    per-assessment participant/row counts and group size.
  - **`Per-student exclusions` sheet** (appended after the per-assessment sheets):
    one row per confirmed per-student technical exclusion — columns
    `ParticipantID | ParticipantName | AssessmentName | QuestionId |
    QuestionWording | DemandLevel | Reason | DecidedBy | DecidedAt`
    (`PER_STUDENT_EXCLUSION_HEADERS`). When a cycle has none, the sheet is emitted
    with the header row plus a single "No per-student exclusions recorded…" note.
    (The per-student exclusion model was removed in the scoring rebuild, so on a
    live cycle this item-analysis sheet is now always the empty/note form; the
    **grades/performance-report workbooks emit an `Alterations` sheet instead** —
    see below.)
- **Overall Score Analysis** — reconciled to the canonical
  `MCQ_Overall_Score_Analysis` template, five sheets (`SCORE_ANALYSIS_SHEETS`):
  `Overall Scores Summary` (KPI blocks + per-assessment / major-element /
  demand-level summaries), `Overall Scores by Assessment`, `Overall Scores by
  Major Element`, `Overall Scores by Demand Level` (one row per participant ×
  assessment × group), and `Analysis` (per-assessment distinct question /
  participant counts + mean answer score). **All scores use retained items only**
  — `assembleScoreAnalysis(...)` drops both cohort-excluded items and per-student
  (participant, item) exclusions upfront (mirroring the engine's scoring), so each
  participant's total and percentage cover exactly the items that counted.
- **Students' Performance Report** — the grades download, reworked to match the
  original `Students_Performance_Report` file (`buildPerformanceReportWorkbook`,
  `PERFORMANCE_REPORT_SHEETS`). Three matched sheets, then the
  clearly-additional **`Alterations`** sheet (`ParticipantID | ParticipantName |
  Subject | Marks (+/-) | Reason | DecidedBy | DecidedAt | SourceIncident`,
  built from the decided incidents — a whole-subject decision expands to one row
  per student; empty cycle = header + note) and the `Audit Trail` sheet appended
  **after** them:
  - **`Class Performance`** — title, per-assessment group headers spanning each
    assessment's major-element columns, then one row per performance level whose
    cells are the **proportion of students at that level** for each
    assessment/major-element column, followed by the `Award Level Distribution`
    block (`Award Level | Number of Students | % of Class`).
  - **`Student Summary`** — one row per student: `Student Name | Award Level | the
    five subjects (by alias) | Open Profile` (`STUDENT_SUMMARY_HEADERS`), with a
    `Legend` block in the right-hand column (col J).
  - **`Student Profiles`** — a repeating per-student block: name + `Back`, `Award
    Level`, then `Subject | Subject Performance | Major Elements Performance` with
    one row per subject and a bulleted per-element level breakdown.
  - Performance-level cells carry the item-analysis semantic fills
    (`PERFORMANCE_STYLES`), keyed by the level's index in the configured set.
  - The provider read-model **`getPerformanceReport`** computes the per-student,
    per-assessment, **per-major-element** levels from real retained responses
    (the same per-assessment cut-points as the overall subject level); the grades
    download adds the exclusions + audit and calls the builder. The legacy
    `buildGradesWorkbook` (Grade Summary / Student Grades / …) remains in the
    module and under test for the auditable grade record.

`workbookToBuffer` serialises for download/storage. `tests/export.test.ts`
asserts the exact layouts, the README & Summary and per-student-exclusions sheets,
the rating + performance fills, the retained-only score aggregation and
percentage consistency, the cap columns, the audit trail, average response time
from the real sample export, and xlsx round-trips — all driven from real engine
output and a real `InMemoryDataProvider` (no hardcoded export fixtures).

## Frontend (UI) and the DataProvider

The six-screen flow is built against a single repository abstraction, the
**`DataProvider`** (`lib/data/provider.ts`) — the same discipline as the engine.
Components import only this interface and the read-model types in
`lib/data/types.ts`; they never touch the engine, ingest, export or Supabase
directly.

### Swap point

`InMemoryDataProvider` (`lib/data/in-memory-provider.ts`) seeds itself from
**genuine engine output** and keeps decisions (exclusions, boundaries, locks) in
memory. The live implementation, **`SupabaseDataProvider`**
(`lib/data/supabase-provider.ts`), satisfies the same interface, and
`lib/data/context.tsx` selects between them on `NEXT_PUBLIC_DATA_PROVIDER`
(`supabase` → live; anything else → in-memory). **No screen or component
changes** — only the provider.

#### SupabaseDataProvider — light list + lazy per-sitting providers

The `DataProvider` is **synchronous**; Supabase is async. Every sitting
(`exam_cycles` row) is a first-class citizen — there is no "active" or "newest"
sitting. (Design note: `docs/multi-sitting-provider.md`.) The provider holds:

1. A **directory** `InMemoryDataProvider` — the shared **workspace state**
   (grading config, quality thresholds, roles + action grid, element labels,
   incident config, centres, members, audit, signed-in user:
   `lib/data/workspace-state.ts`) plus the **light list of every sitting**: id,
   name, year, stored period, date, status, lock and real participant /
   assessment counts. It answers the Years pages and every workspace-level call
   and hosts no sitting's data.
2. **One `InMemoryDataProvider` per opened sitting**, built over the *same*
   `WorkspaceState` (shared by reference, never copied) and **replayed** with that
   sitting's stored decisions as database truth (ungated, unaudited — a read-only
   viewer sees the same grades as an admin). Every cycle-scoped call is **routed
   by `cycleId`** to that sitting's provider, so reading or editing sitting A never
   touches B and opening B never changes A.

Hydration (`lib/data/supabase-hydrate.ts`) is in two parts, using the real row
**UUIDs as the Seed ids** so write RPCs can pass ids straight through:

- `loadWorkspace` — the **light load** at sign-in: workspace config plus the list
  of all cycles, with counts from column-limited selects. It reads **no**
  per-cycle fact table (`responses`, `items`, `item_stats`, `sittings`, grades,
  scores).
- `hydrateCycle(cycleId)` — the **full load of one sitting**, called lazily when
  it is opened (the `app/cycles/[cycleId]` layout calls `ensureCycleLoaded`; the
  Overall calls `ensureYearLoaded` for the year's *locked* sittings). Concurrent
  callers share one load; a reload is built off to the side and swapped in, so a
  failed refresh keeps the old data. Item statistics come from `item_stats`;
  diagnostics are recomputed from `responses` via `lib/diagnostics`.

**Writes** apply optimistically to the sitting's provider (instant UI) **and** call
the `SECURITY DEFINER` RPCs over the RLS-scoped client — the only sanctioned path
for status/decision/computed columns. The database enforces authorization (RLS +
each function's role check), so an unauthorized write is rejected server-side even
though the optimistic local copy updated. A write refreshes **only what it
affects**: create → the light list (the new sitting is not opened; the one being
viewed is untouched); ingest / clear → that sitting; delete → drops its slot;
roles / centres → the workspace. The heavy Overall-**analytics** projection loads
on first use of `/analytics`, not at sign-in.

**Lock state** has one source of truth: `exam_cycles.status = 'locked'`
(`lock_grades` flips `grades.locked` only for rows that exist, and the app writes
none). It is read the same way for every sitting and restored through an ungated
setter. `lockCycle` sends the RPC only if the in-memory lock was accepted, and
re-reads the sitting if the server refuses.

Hydration is async; until the light load finishes the provider serves an empty
list, then bumps its version (`useSyncExternalStore`) so screens re-render.

#### Auth (real, `@supabase/ssr`)

Email/password (no Microsoft SSO yet). `lib/supabase/{client,server}.ts` are the
RLS-scoped clients (publishable key); `middleware.ts` refreshes the session
cookie each request (inert when Supabase isn't configured). **Invite-only:** the
signed-in user comes from the session and their role from the **`memberships`**
table; an `AccessGate` in `context.tsx` routes to `/signin` (no session) and
`/access-denied` (signed in but not a member). Provisioning = an admin adding a
`memberships` row.

#### Engine write path (server-side only)

Recompute must not run in the browser. `POST /api/cycles/:id/recompute`
(`lib/server/engine-write.ts`) authorizes the caller as a cycle `lead_admin` via
the session client, then reads responses/essays/alterations and runs the
**unchanged** engine with the **secret-key admin client**, writing `item_stats`
and `participant_scores` **directly** (the SECURITY DEFINER role-checks need an
`auth.uid()`, which the secret client lacks; the secret role bypasses RLS and the
`authenticated` column revokes, so it is the sanctioned privileged writer). The
secret key (`SUPABASE_SECRET_KEY`) is server-only — `lib/supabase/admin.ts` is
guarded by `import "server-only"`.

#### Environment & schema

New-format keys only: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (client), `SUPABASE_SECRET_KEY` (server) —
documented in `.env.example`. Migration **`0003`** extends `0001`/`0002` with the
tables + SECURITY DEFINER RPCs the current interface needs beyond the original
surface (essays, incidents, alterations, distinction, document settings, and a
`workspace_settings` blob store), plus `write_scores` (the participant-scores
writer `0001` lacked). See `supabase/RUNBOOK.md` to set `.env.local`, seed, and
run the RLS smoke test.

### Seeding with real data

`scripts/build-seed.mts` (run via `npm run seed`) runs the **real ingest +
engine** over `data/sample_qm_export.xlsx` and writes `lib/data/seed.generated.json`
(5 assessments, 193 items, 18 participants). The provider ships that to the
client and recomputes scores / distributions / grades **through the engine** on
every exclusion, boundary drag and lock — so the item-review KPIs, the live
histogram, the boundary band counts and the grade matrix are all real computed
numbers, not hand-typed mocks. Reactivity is via `useSyncExternalStore`
(`lib/data/context.tsx`).

For the **live** database, `scripts/seed-supabase.mts` (run via
`npm run seed:supabase`) runs the same ingest + engine over the sample export and
inserts the cycle (cycle, assessments, items, participants, responses) with the
secret-key admin client, then persists `item_stats` + `participant_scores`
through the shared engine write path — giving the deployed app a working demo
cycle. The owner is an existing Supabase auth user (granted a `lead_admin`
membership). See `supabase/RUNBOOK.md`.

### Screens (routes)

The left nav rail splits into three areas — **Cycles**, **Analytics**,
**Settings** — each with a secondary tab bar (subnav). Entry screens sit outside
the shell.

| Area | Screen | Route |
| --- | --- | --- |
| Entry | Sign-in (mocked Microsoft) | `/signin` |
| Entry | Access denied | `/access-denied` |
| Cycles | Cycles dashboard | `/` |
| Cycles | New cycle | `/cycles/new` |
| Cycles | Cycle overview (Pipeline) | `/cycles/[cycleId]` |
| Cycles | Data import (export + optional essay/incident uploads) | `/cycles/[cycleId]/import` |
| Cycles | Item review & scoring (hero) | `/cycles/[cycleId]/review/[assessmentId]` |
| Cycles | Adjustments (incident triage → alterations) | `/cycles/[cycleId]/adjustments` |
| Cycles | Scoring & grade boundaries | `/cycles/[cycleId]/boundaries` |
| Cycles | Grades & sign-off | `/cycles/[cycleId]/grades` |
| Cycles | Distinction safeguard | `/cycles/[cycleId]/grades/distinction` |
| Cycles | Diagnostics (speededness & timing) | `/cycles/[cycleId]/diagnostics` |
| Cycles | Audit log | `/cycles/[cycleId]/audit` |
| Cycles | Certificates / documents | `/cycles/[cycleId]/documents` |
| Analytics | Overall | `/analytics` |
| Settings | Users & access | `/settings/users` |
| Settings | Roles & permissions | `/settings/roles` |
| Settings | Configuration | `/settings/config` |

Shared shell (`components/shell/`): three-area nav rail, top bar, the secondary
subnav (`lib/ui/subnav.ts`) and the pipeline stepper on cycle screens. Design
system (`components/ui/`): buttons, chips, KPI/stat blocks, quality bars, status
marks + badges, avatars, toggles/checkboxes, dense tables, recharts histogram +
breakdown bars, and the analytics sparkline / stacked-award column — all ported
from the batch-1 and batch-2 design (`design/hf*.jsx`).

### Admin, audit & analytics (provider-backed, mostly MOCK)

- **Users & access / Roles & permissions** read-models + mutations live in the
  provider (`getMembers`, `getRoles`, `inviteMember`, `setMemberRole`,
  `removeMember`, `createRole`, `renameRole`, `setCapability`). Defaults: a **G12
  Lead** (full) and a **Data Scientist** (everything except sign-off/admin/create)
  with a capability matrix; the mocked signed-in user is the Lead. All mock —
  no directory.
- **Audit log** (`getAuditLog`): every consequential action — exclusions,
  boundary edits, lock/unlock, exports, document generation, duplicate
  resolution, new cycle — writes an entry via the provider's internal `audit(...)`.
  A few seeded entries (flagged `seeded`/"example") populate the list before any
  session action.
- **Analytics** (`getOverallAnalytics`): the **live
  cycle's aggregates are REAL** (computed from the engine — participants, cohort
  mean/median/σ, items excluded, mean item quality, award distribution,
  per-assessment means); **prior cycles are clearly-labelled MOCK** (a "MOCK
  PRIORS" banner + tags), since there's no real cross-cycle history. (This is the
  in-memory *demo*. The live provider's `/analytics` reads the persisted
  multi-cycle projection — loaded on first use, not at sign-in — and is
  otherwise unchanged; making it use real locked sittings is Phase 2.)
- **Configuration** (`getConfig` / `getScoringConfig`) — full CRUD, Lead/Admin
  only, with downstream warnings (see "Settings CRUD" below): the item-quality
  thresholds are **editable** (`QualityThresholdsEditor` → `setQualityThresholds`)
  and drive the engine via the live `ScoringConfig`; the grade-vocabulary editor
  supports **add / remove / rename / reorder** of performance and award levels
  plus cut-points and star mapping (`GradingDefaultsEditor` → `setGradingDefaults`),
  warning before a destructive save. The **Distinction-safeguard** block
  (threshold + top-difficulty demand) is real and drives the grading-stage
  safeguard; data-retention and branding are mock per-workspace settings.
- **Roles & permissions** — the capability grid plus add / rename / **delete**
  role (`deleteRole`, Lead-only, blocked while members are assigned).
- **New cycle** (`createCycle`): in-memory/demo mode records the intent in the
  audit log and resolves to the demo cycle; the Supabase provider persists the
  cycle + its chosen assessments (`create_cycle_with_assessments`, migration
  `0004`) and returns the real new cycle id. The picker is the canonical G12++
  subject catalog (`lib/data/subject-catalog.ts`).

### UI pass (navigation, responsiveness, item review, lock, Settings CRUD)

- **Navigation.** Nav-rail items reveal a label on hover/focus; the pipeline
  stepper is clickable — each stage links to its screen via `stageHref`
  (Data import → import, Score/Boundaries → boundaries, Export → documents),
  threaded from the `Shell`'s `cycleId`.
- **Responsive.** Two-column work areas reflow via `.hf-split` / `flexWrap` with
  sensible min-widths (boundaries, documents, analytics, cycle overview); tables
  scroll inside their card (`.hf-scroll-x`); dense paddings tighten under 820px.
- **Item review deep-dive.** The cohort summary moved to a collapsible strip
  across the top; the table is zoomable (density control) and truncates each
  question to its first line with a more/less control; the right panel is blank
  until a row is selected, then shows that item's full deep-dive (four statistics
  with rating **reasoning**, discrimination upper/lower groups, and an honest
  correct/incorrect/not-answered outcome split — the score export carries no
  per-option data) and is collapsible + drag-resizable. New read-model
  `getItemDetail`.
- **Grades / lock.** Grades are viewable any time after scoring without locking;
  locking is the publish/freeze step. A locked cycle stays fully navigable and
  read-only — `LockBanner` surfaces the state and the Lead-only, audit-logged
  **Re-open cycle** (unlock) on the editable screens.
- **Settings CRUD** (Lead/Admin only, audit-logged via the `config` audit type).
  Item-quality thresholds and the full performance/award level sets are editable
  (add/remove/rename/reorder, cut-points, stars); destructive saves surface the
  downstream impact first — a removed level/award still **in use** by current
  results, a new level without a star mapping, or a level/award count change
  (the export's fixed 4-colour `PERFORMANCE_STYLES` palette / certificate slots,
  see the `// DOWNSTREAM:` notes) — via a confirm dialog, with invalid sets
  blocked.

### Speededness & timing diagnostics (informational)

`lib/diagnostics/` computes, from the raw export's response-time and answer
columns, the team's notebook metrics — never affecting grading. Only
**actionable** lenses are surfaced; the old per-major-element / sub-element
("construct-level") breakdowns were removed as non-actionable. `getDiagnostics`
returns, per assessment, a `{ whole, byDemand, byItemSet, omissionByPosition }`
shape (`AssessmentDiagnostics`):

- **Speededness / omission / completion — whole assessment** (`whole.speeded`):
  omission = blank-answer presentations ÷ total; completion = 1 − omission; late
  items = the final 25% of unique items by presented order (ceil, min 1);
  **Speededness Index** = (max(0, lateOmission − earlyOmission) + max(0,
  earlyAccuracy − lateAccuracy)) ÷ 2, with the Good ≤0.05 / Review ≤0.15 / Flag
  bands (and omission ≤0.05/≤0.10, completion ≥0.95/≥0.90).
- **By demand level** (`byDemand`): the same speededness measures split by item
  difficulty D1/D2/D3 (from the `Demand Level==Dx` MetaTag) — the actionable lens
  that replaces the construct breakdown (e.g. high omission concentrated in D3
  flags time pressure on the hardest items). Fixed D1→D3 order, present levels
  only; untagged items are ignored.
- **By item set** (`byItemSet`): the same measures split by shared
  stimulus/passage (the `… Item Sets==<name>` MetaTag, `None`/absent → null,
  parsed by `parseItemSet`, persisted to `items.item_set` — migration
  `0010_items_item_set.sql`). A passage with high omission is too long/dense to
  work through in time — shorten or simplify it. Alphabetical, ungrouped items
  ignored; the section only renders for subjects that use item sets.
- **Omission rate by item position** (`omissionByPosition`): one row per item in
  presented order, carrying the item's demand level, with omission = blank ÷
  presentations. A rising tail is the classic speededness signature.
- **Timing–performance — whole assessment** (`whole.timing`): aggregate to
  student level (score %, median item time), then Pearson + Spearman with
  strength labels.

These are computed at **seed-build time** over the cleaned responses via the
shared `buildAssessmentDiagnostics()` helper (`scripts/build-seed.mts` →
`lib/data/seed.generated.json`, presentation order = export order, `// CONFIRM:`;
the same helper runs in the in-memory and Supabase-hydrate paths so all three
stay identical). Surfaced read-only on the **Diagnostics** cycle tab with
embedded plain-language interpretation for speededness and omission rate.
`tests/diagnostics.test.ts` pins the computations against hand-computed values;
`tests/diagnostics-page.render.test.ts` locks the actionable-only layout.

### Adjustments & Distinction safeguard (the workflow)

The pipeline stepper is seven stages: **Data import → Review → Adjustments →
Score → Boundaries → Grades → Export**. (Ingest and Validate were merged into a
single **Data import** step — `/cycles/[id]/import` — since they were always one
screen.)

- **Data import (`/cycles/[id]/import`).** The full-width window is three equal,
  expandable input cards — **01 Raw exam export (Required)**, **02 Essay marks
  (Optional)**, **03 Incident log (Optional)**. Open a card to upload its file and
  read its validation/match report inline; each header carries the card's status
  (export pass/warn/must-fix; the optional cards their match counts). Only the
  raw export is required, and its blocking issues (duplicate submissions, with
  Keep-latest / Keep-first / Exclude actions inline) must be resolved to continue;
  the optional files never block. Each optional file is parsed client-side and
  surfaces a matched/unmatched preview; a clearly-labelled `SAMPLE` can be loaded
  without a file. There is no right-hand sidebar — the mark-composition explainer
  lives in Grades.
- **Adjustments (`/cycles/[id]/adjustments`, `getAdjustments` / `decideIncident`).**
  Replaces the old per-student exclusion screen. Two tabs: **Incident triage**
  (each incident shown with full context; decided per-student / whole-subject
  bulk / no-action, with a subject defaulted from the exam code, raw marks ±, and
  a required reason — every decision audit-logged) and **Mark composition**
  (`getComposition`: per-student per-subject **MCQ + Essay + Alterations = total**
  out of max, expandable). The step is skippable when no incident log was added.
- **Provisional-grades warning.** Boundaries and Grades show a non-blocking
  `ProvisionalBanner` when an essay subject has no marks yet or incidents remain
  unreviewed — grades are provisional until those are in, never gated.
- **Distinction safeguard (`/grades/distinction`, `getDistinctionSafeguard`).**
  Runs on the candidates whose **subject-level pattern qualifies for Distinction**
  (★★★ in ≥3, rest ≥★): the **confirmed D3-majority rule** (Layer 1b) caps a
  student below Distinction unless they answered **correctly a MAJORITY of the
  AVAILABLE D3 items on every exam** — strictly more than half, computed
  dynamically per exam and recomputed after item exclusions (7 → 4, 6 → 4,
  5 → 3). It is **correct answers, not attempts**, against **available, not
  attempted** (`d3StatusFor` / `d3CapByParticipant`). The working is surfaced
  (`capReason`, and `distinctionCap` on the grade row: "3/7 D3 items correct;
  majority is 4"). A **Lead** can override with a recorded reason. Caps flow into
  the grade matrix (`getGrades`), and caps/overrides are audit-logged
  (`safeguard` type).
  - **Honest numbers.** Everything is computed from the real seeded cycle. That
    cohort's scores top out below the default Outstanding cut, so no student
    reaches the Distinction level-pattern by default and the safeguard renders an
    explicit empty state. Lowering the Outstanding performance cut-scores brings
    real candidates into the pattern; the genuine, score-based D3 cap still
    applies — no candidate counts are fabricated.

### Grade vocabulary (the real named levels)

The A–E placeholder from the batch-1 screens is replaced everywhere by the
production vocabulary (`lib/data/grading.ts`), and the schemes are generalised so
nothing hardcodes band names or counts:

- **Per-assessment performance level** (best → lowest): *Outstanding
  performance*, *Exceeds expectations*, *Meets expectations*, *Doesn't yet meet
  expectations* — **four bands → three cut-points**. Star mapping for reports:
  `***` / `**` / `*` / `` (blank).
- **Overall award** (best → lowest): *Distinction award*, *Advanced achievement
  award*, *Secondary achievement award*, *No Award* — a **separate four-band
  classification** with its own cut-points.
- A grading scheme is `{ levels[], cuts[] }` where `cuts[i]` is the minimum score
  for `levels[i]` and the lowest level is the remainder. `BoundaryModel`
  carries `levels`, a `cuts` array and `isAward`; `GradesModel` carries
  per-assessment `{ level, stars }` cells plus the overall `award`.
- **Labels, star mapping and default cut-points are configurable** in Settings →
  Grading defaults (`getGradingDefaults` / `setGradingDefaults`). The default
  vocabulary itself is now sourced from the engine's `DEFAULT_SCORING_CONFIG`
  (see "ScoringConfig" above) — one definition, shared by the engine and the
  grade read-models.
### Award rule & D3 cap (confirmed — `lib/engine/award.ts`)

The overall award is the **confirmed deterministic Layer-2 rule**, not a cut on
an overall score. `deriveAward(subjectLevels, d3Pass)` evaluates the pattern of
the five subject performance levels **highest → lowest, stop at first match**:

1. **Distinction** — ★★★ Outstanding in ≥3 subjects AND ≥★ Meets in every
   remaining subject AND the student passes the **D3-majority cap**. A
   Distinction-pattern student who fails the D3 majority falls through.
2. **Advanced** — ★★ Exceeds in ≥3 subjects.
3. **Secondary** — ★ Meets in ≥4 subjects.
4. **No Award** — otherwise.

The award levels are read positionally from the configured set, so the
vocabulary stays configurable; the counts are anchored (Outstanding = top,
Meets-or-better = any starred level). The **per-student D3 cap** is Layer 1b
(above). `getGradingDefaults().awardRuleUnconfirmed` is now `false`. Named tests:
`tests/engine.award.test.ts` (every tier, fall-through, D3-denied Distinction,
dynamic 5/6/7 thresholds) and `tests/grading.distinction.test.ts` (provider
integration: cap denies Distinction with visible reasoning, Lead override
restores it). These are all **downstream of item statistics** — parity stays
183/183.

The cohort-level half of the D3 rule (constraining the Outstanding cut so ≥½ D3
is implied) and the suggested-cut-score backsolver are **Wave 3b**, out of scope
here.

### Overall rollup — best-of across the year's sittings (`lib/data/overall.ts`)

A year holds a sitting per period (today February + May); each is a full,
independently signed-off pipeline run. **Overall** is the derived best-of view
used to issue certificates. `rollupOverall` is **comparison / aggregation only** —
it consumes each sitting's `GradesModel` and never touches scoring, cut scores, or
the safeguard:

1. For every **student × subject**, it takes the **best performance level** across
   the sittings, by level **rank** (best → lowest), *not* raw score. **Ties go to
   the latest sitting.** A subject present in only one sitting uses that sitting;
   students are matched across sittings by **Student ID** (`qm_participant_id`,
   the email). Each `OverallGradeCell` records its `source` and both raw
   per-sitting levels for provenance.
2. The **overall award** is derived from the rolled-up per-subject levels via the
   existing `deriveAward` rule (the award rule is **reused, not reinvented**). The
   per-sitting **D3 safeguard is NOT re-run** at the Overall level — each
   sitting's award is already its own signed-off, safeguard-checked result — so
   `deriveAward` is called with `d3Pass: true`. This is the value of best-of: a
   student who aced different subjects in different sittings can earn a higher
   *overall* award than either sitting alone.

**Only sittings whose grades are locked count.** An unlocked sitting is listed on
the Overall page as "not counted yet — grades not locked" (`OverallGradesModel.
sittings`) and its data is never fetched for the rollup.

**Real data per sitting.** Each sitting is its own cycle with its own assessment
rows (own uuids), so `getOverallGrades(yearId)` reads each locked sitting's
`getGrades` from the provider that holds it and re-keys the subjects to a
canonical key (`canonicalizeSubjects`, `subjectKeyOf`) before rolling up;
`rollupOrdered` takes the sittings as an ordered list (oldest → newest) so callers
never name a period. The year resolves by either id form (`y.id` or the real
`exam_years.id`). `ready` (final / certifiable) means every period has a sitting
and all are locked.

Provider: `getOverallGrades(yearId)` → `OverallGradesModel` (`/years/[yearId]/
overall`, reuses the Grades table layout with a source tag per cell);
`getOverallDocuments(yearId)` → `DocumentsModel` so **certificates issue from
Overall, not a single sitting** (`/years/[yearId]/overall/documents`). Tests:
`tests/overall.rollup.test.ts`, `tests/overall.live.test.ts` (two real locked
sittings), `tests/overall.ordered.test.ts`, `tests/overall.provider.test.ts` (demo),
`tests/overall-page.render.test.ts`, `tests/overall-live-page.render.test.ts`.
Parity is unaffected — **183/183** (aggregation over already-computed awards).

**Demo vs live.** The in-memory demo (no database) keeps its legacy *provisional*
view: only the seeded May sitting carries grades, so `demoFebruaryGrades`
**synthesizes a clearly-labelled February baseline** (`demo: true`, shown with a
banner) and unlocked sittings are shown provisionally. The live provider never
fabricates a sitting and applies the locked-only rule.

**Still tied to two periods (Phase 2):** `SittingKey` (`lib/data/periods.ts`) and
the `YearSummary` / `YearDetail` `february` / `may` slots; `OverallGradeCell`
(`source`, `februaryLevel`, `mayLevel`); `rollupOverall`'s two parameters
(`rollupOrdered` refuses more than two sittings loudly); the `sitting_period`
database enum.

### Element / sub-element results & the unofficial report

`getPerformanceReport` reports per-student levels at **major-element AND
sub-element** granularity (`PerfReportSubject.subElements`,
`PerfElementResult.subElements`), reading the construct structure from the item
tags (3–5 major elements per subject, **not** hardcoded). Surfaced in the Grades
per-student drill-down and the performance-report export (Student Profiles gains
a Sub-Elements column). The **unofficial report** (`DocKind "unofficial"`,
`StudentSummary.unofficial`) slots alongside the certificate + performance report
on the same document path, showing the achieved level at element/sub-element
granularity, **clearly marked unofficial** (internal/learner diagnostic).

### What is mocked in the UI (honestly labelled)

- **No Supabase / no persistence.** Exclusions, boundaries and locks live in the
  in-memory provider and **reset on reload**.
- **Auth / roles.** Sign-in (`/signin`, "Sign in with Microsoft") and the
  access-denied state are mocked — no real OAuth; sign-in goes straight in. The
  current user is the mocked **G12 Lead** (Rana Mansour, `InMemoryDataProvider.user`);
  members, roles and the capability matrix are mock fixtures
  (`lib/data/mock-admin.ts`). Role-gated controls read from this so real Microsoft
  Entra auth slots in later.
- **Admin areas.** Members/roles/audit/analytics/config and the new-cycle action
  are all mock (in-memory) — see "Admin, audit & analytics" above. Analytics
  priors and the data-retention/branding config are labelled `MOCK`; only the
  live cycle's analytics and the engine's quality thresholds are real.
- **Prior cycles + cross-cycle comparisons.** On live data every sitting is real
  and usable (see "SupabaseDataProvider"); in the in-memory *demo* the prior cycles
  are clearly-labelled `MOCK` rows. The "vs Jan 2026" boundary comparison
  is driven by a labelled fixture behind a `SHOW_CROSS_CYCLE` flag and tagged
  `MOCK` in the UI — no delta is computed against invented numbers as if real.
- **Duplicate-resolution** is detected by the real validator; the resolution
  action is a provider **stub** (records the choice, no row mutation). The sample
  export has no duplicates, so the panel doesn't appear on the live cycle.
- **"Start new cycle"** persists on the live (Supabase) provider — it creates the
  cycle and its assessments and navigates to the real new cycle. In-memory/demo
  mode resolves to the demo cycle (no DB).
- **Technical-errors data.** The upload + parse path is real, but the seed has no
  attached faults file. The `Load sample` button injects a small fixture flagged
  `SAMPLE` everywhere it appears; its incidents point at real seeded
  students/items so the resulting per-student exclusions are genuinely computed,
  not faked.
- **Quality index** (the 0–100 bar in item review) is a transparent composite of
  the four engine ratings (`scripts/build-seed.mts` `qualityIndex`), not a
  fabricated statistic.

## Document generation (certificates & reports) and its swap point

Per-student PDFs are generated from PowerPoint templates once grades are locked.
The UI depends only on the **`DocumentGenerator`** interface
(`lib/documents/generator.ts`) and the types in `lib/documents/types.ts` — never
on the Python renderer or LibreOffice directly.

- **Student Summary, not a spreadsheet.** `getDocuments(cycleId)` builds the
  Student Summary (name, `RESULTID` = ParticipantID, overall award, the five
  performance levels + stars) from the **locked-grades read-model**. It is empty
  until the cycle is locked. Subjects are mapped to the template's fixed
  **S1..S5 slots by an explicit alias** (S1 Applicable Math, S2 Scientific
  Thinking, S3 Arabic 1st, S4 English 2nd, S5 Life Success Skills) — by keyword,
  **not by position**, because the template order differs from the suite's.
- **Tokens.** Certificate: `{{NAME}}`, `{{AWARD}}`, `{{RESULTID}}`. Report:
  `{{NAME}}`, `{{S1..S5_LEVEL}}`/`{{S1..S5_STARS}}`, `{{RESULTID}}`. `{{RESULTID}}`
  **replaces the certificate's baked-in fixed ID**, and test centre / exam date /
  issue date are **per-cycle settings** (`setDocumentSettings`); the renderer
  normalises those baked/placeholder values to tokens before filling. Stars are
  derived from the level, never entered.
- **Dev implementation:** `HttpDocumentGenerator` POSTs the Student Summary +
  uploaded template(s) to `POST /api/documents/generate` (Node runtime), which
  shells out to `scripts/doc_gen.py` (adapted from the reference `gen.py`):
  python-pptx fill → LibreOffice (`soffice --convert-to pdf`) → one zip per type.
  Artifacts stream back through `GET /api/documents/download` (path-guarded).
  Verified end-to-end against both real templates and the seeded cycle —
  18 students × 2 docs = 36 PDFs, with the alias mapping and Result-ID
  replacement confirmed in the rendered output.
- **Fonts:** Barlow is fetched; **Georgia Pro Condensed** (certificate name line)
  is proprietary and detected-as-absent — the UI warns that a substitute will be
  used and surfaces the "embed fonts in the template" guidance.
- **Swap point / deployment:** **do not render in a Vercel serverless function** —
  LibreOffice is too heavy. Production implements the same `DocumentGenerator`
  against a **dedicated Python worker** (queue + object storage for artifacts);
  only `lib/documents/generator.ts` changes. This sits alongside the Supabase
  swap as the two production follow-ons.

## What is stubbed / deferred (backend)

- **The engine itself is the stub.** It is a faithful TS implementation, kept
  strictly behind `ComputationEngine` so the validated Python can replace it
  with zero caller changes (see the swap point above).
- **No auth wiring / middleware** beyond the Supabase client factories, and the
  Supabase-backed `DataProvider` is not written yet (the in-memory one stands in).
- **Server actions / RPC callers** for the transition functions are not written
  yet; the database functions they will call exist.
- **Certificates, essay marking, cross-cycle analytics, multi-workspace** —
  out of MVP scope (Section 7), and the schema is designed not to need rework.

## Divergences from the spec (and why)

1. **`rollUp` signature.** Section 8 sketches `rollUp(participantScores)`, but
   the by-major-element and by-demand-level breakdowns need item-level scores
   and item metadata that participant totals do not carry. `rollUp` therefore
   also takes `responses` and `items`. Same boundary, slightly richer input.
2. **Discrimination tie-break.** The spec says "ranked by total score excluding
   the item"; it does not specify tie handling. Reproducing the published
   numbers required breaking ties by the full total descending. This is
   documented in `lib/engine/stats.ts` and is the only detail beyond the spec's
   wording needed for exact parity.
3. **SheetJS source + styled writer.** The spec's CDN tarball for `xlsx` is
   blocked by the environment's network policy, so reading uses the public npm
   registry build (`xlsx@0.18.5`). The community build cannot *write* cell
   styles, so the colour-coded item-analysis fills are generated with
   `xlsx-js-style` — a drop-in SheetJS fork with the identical `XLSX.utils` API.
4. **Item-analysis layout** is reconciled to the exact `MCQ_Item_Analysis` file
   (20-column header, title/meta/guide preamble, README & Summary sheet, rating
   fills). The `MCQ_Overall_Score_Analysis` and grades workbooks still use a
   sensible canonical layout to be reconciled against their real templates when
   available.
5. **Demand-tag gate severity.** The "every item has a demand-level tag" gate is
   classified as a **warning** (fixable, evidence-for-review), not a hard fail —
   matching the design's treatment (hard-fail is reserved for duplicates /
   schema / encoding / survey leakage) and keeping a clean sample export
   validating so the seeded cycle is coherent. Behaviour only; the ingest
   interface is unchanged.

## Running things

```bash
npm install
npm run dev       # the app (in-memory provider, real engine)
npm run seed      # regenerate lib/data/seed.generated.json from the sample export
npm test          # 256 tests incl. the 177-item parity gate
npm run typecheck # tsc --noEmit, strict
npm run build     # next build
```

Database: copy `supabase/migrations/0001_init.sql` into the Supabase SQL editor
and run it once (see `supabase/README.md`). No CLI is required.
