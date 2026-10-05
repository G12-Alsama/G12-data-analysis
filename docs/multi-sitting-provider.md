# Multi-sitting provider — design note (Phase 1)

Status: implemented on `G12_App_Improvement`. This note records the design the code
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
