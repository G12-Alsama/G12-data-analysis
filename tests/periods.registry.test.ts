/**
 * The period registry is the single source of truth for sitting periods.
 *
 *  - it is internally sound (every calendar month belongs to exactly one period),
 *  - it matches the DB enum `sitting_period` declared by the migrations (a registry key
 *    with no enum value would fail at insert time; an enum value with no registry entry
 *    would be invisible to the app),
 *  - no app code outside the registry re-spells the periods,
 *  - and adding a period is genuinely "one registry entry": the same pipeline code runs over
 *    a registry with a third period.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPECTED_PERIODS,
  PERIOD_DEFS,
  SITTING_ORDER,
  createPeriodRegistry,
  isSittingKey,
  joinPeriodLabels,
  periodLabel,
  periodOfMonth,
  periodRank,
  periodShortLabel,
  sortPeriods,
  validatePeriodDefs,
  type PeriodDef,
} from "@/lib/data/periods";

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "supabase", "migrations");

/** The values of `sitting_period` as the migrations (in order) build it. */
function enumValuesFromMigrations(): string[] {
  const values: string[] = [];
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !f.endsWith(".rollback.sql")).sort();
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS, f), "utf8");
    for (const m of sql.matchAll(/create\s+type\s+(?:public\.)?sitting_period\s+as\s+enum\s*\(([^)]*)\)/gi)) {
      for (const v of m[1]!.matchAll(/'([^']+)'/g)) if (!values.includes(v[1]!)) values.push(v[1]!);
    }
    for (const m of sql.matchAll(/alter\s+type\s+(?:public\.)?sitting_period\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'/gi)) {
      if (!values.includes(m[1]!)) values.push(m[1]!);
    }
  }
  return values;
}

describe("period registry", () => {
  it("is internally sound and ordered oldest → newest", () => {
    expect(validatePeriodDefs(PERIOD_DEFS)).toBeNull();
    expect([...SITTING_ORDER]).toEqual(["february", "may"]);
    expect(periodRank("february")).toBeLessThan(periodRank("may"));
    expect(periodLabel("may")).toBe("May");
    expect(periodShortLabel("february")).toBe("Feb");
    expect(isSittingKey("may")).toBe(true);
    expect(isSittingKey("august")).toBe(false);
    expect([...DEFAULT_EXPECTED_PERIODS]).toEqual(["february", "may"]);
  });

  it("maps every calendar month to exactly one period (Jan–Apr → February, May–Dec → May)", () => {
    expect([1, 2, 3, 4].map(periodOfMonth)).toEqual(["february", "february", "february", "february"]);
    expect([5, 6, 7, 8, 9, 10, 11, 12].every((m) => periodOfMonth(m) === "may")).toBe(true);
  });

  it("rejects a registry that is not sound", () => {
    const base: PeriodDef = { key: "a", label: "A", shortLabel: "A", month: 1, order: 1, covers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], expectedByDefault: true };
    expect(validatePeriodDefs([base])).toBeNull();
    expect(validatePeriodDefs([])).toMatch(/no periods/);
    expect(validatePeriodDefs([base, { ...base, order: 2 }])).toMatch(/duplicate period key/);
    expect(validatePeriodDefs([base, { ...base, key: "b" }])).toMatch(/duplicate period order/);
    expect(validatePeriodDefs([base, { ...base, key: "b", order: 2 }])).toMatch(/covered by both/);
    expect(validatePeriodDefs([{ ...base, covers: [1] }])).toMatch(/covered by no period/);
    expect(validatePeriodDefs([{ ...base, month: 13 }])).toMatch(/month must be 1–12/);
    expect(() => createPeriodRegistry([{ ...base, covers: [] }])).toThrow(/Invalid period registry/);
  });

  it("matches the sitting_period enum declared by the migrations, in both directions", () => {
    const inDb = enumValuesFromMigrations();
    expect(inDb.length).toBeGreaterThan(0);
    expect([...SITTING_ORDER].filter((k) => !inDb.includes(k))).toEqual([]); // registry key without an enum value
    expect(inDb.filter((v) => !(SITTING_ORDER as readonly string[]).includes(v))).toEqual([]); // enum value the app can't see
  });

  it("the exam_years default expected list equals the registry default", () => {
    const sql = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && !f.endsWith(".rollback.sql"))
      .map((f) => readFileSync(path.join(MIGRATIONS, f), "utf8"))
      .join("\n");
    const m = sql.match(/expected_periods\s+public\.sitting_period\[\]\s+not\s+null\s+default\s+'\{([^}]*)\}'/i);
    expect(m, "an exam_years.expected_periods column with a literal default").not.toBeNull();
    expect(m![1]!.split(",").map((x) => x.trim())).toEqual([...DEFAULT_EXPECTED_PERIODS]);
  });

  it("no app code outside the registry names the periods as string literals", () => {
    // Allowed homes: the registry itself, and the documented two-slot analytics projection.
    const allow = new Set([
      "lib/data/periods.ts",
      "lib/data/overall-analytics.ts",
      "lib/data/supabase-hydrate.ts", // OACell slots (analytics projection)
      "lib/data/seed.ts",
    ]);
    // The /analytics UI ("Feb"/"May" exam lens, Sat Feb → Sat May sections) is the documented
    // two-slot exception — see docs/multi-sitting-provider.md §1.
    const allowDir = "components/ui/overall/";
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = path.relative(ROOT, full).split(path.sep).join("/");
          if (allow.has(rel) || rel.startsWith(allowDir)) continue;
          // Comments may talk about the periods; only code may not.
          const text = readFileSync(full, "latin1").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
          if (/["'`](february|may)["'`]/.test(text)) offenders.push(rel);
        }
      }
    };
    for (const d of ["app", "lib", "components"]) walk(path.join(ROOT, d));
    expect(offenders).toEqual([]);
  });
});

describe("adding a period is one registry entry", () => {
  const three: PeriodDef[] = [
    ...PERIOD_DEFS.map((d) => ({ ...d, covers: d.key === "may" ? [5, 6, 7] : [...d.covers] })),
    { key: "august", label: "August", shortLabel: "Aug", month: 8, order: 3, covers: [8, 9, 10, 11, 12], expectedByDefault: false },
  ];
  const reg = createPeriodRegistry(three);

  it("orders, labels and maps months from the entry alone", () => {
    expect([...reg.SITTING_ORDER]).toEqual(["february", "may", "august"]);
    expect(reg.periodRank("august")).toBe(2);
    expect(reg.periodLabel("august")).toBe("August");
    expect(reg.periodOfMonth(9)).toBe("august");
    expect(reg.periodOfMonth(6)).toBe("may");
    expect(reg.sortPeriods(["august", "february"])).toEqual(["february", "august"]);
    expect(reg.joinPeriodLabels(["february", "may", "august"])).toBe("February, May and August");
    // existing years keep expecting only February + May
    expect([...reg.DEFAULT_EXPECTED_PERIODS]).toEqual(["february", "may"]);
  });

  it("module helpers behave on the real registry", () => {
    expect(sortPeriods(["may", "february"])).toEqual(["february", "may"]);
    expect(joinPeriodLabels(["february", "may"])).toBe("February and May");
    expect(joinPeriodLabels(["may"])).toBe("May");
  });
});
