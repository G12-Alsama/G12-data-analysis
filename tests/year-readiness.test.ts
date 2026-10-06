/**
 * "Ready for certificates" depends on the year's EXPECTED periods (exam_years.expected_periods,
 * migration 0051), not on a hard-coded February + May pair.
 *
 * Rule: a year is ready when every expected period has a LOCKED sitting. A year with no
 * configuration (the default, and every year that exists today) expects February + May, so
 * existing data must behave EXACTLY as it did when that pair was hard-coded — pinned below
 * against the old formula for every combination.
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { liveProvider } from "@/tests/helpers/fake-supabase-live";
import { buildDb, CENTRE, YEAR, type SittingSpec } from "@/tests/helpers/multi-cycle-db";
import { slotOf } from "./helpers/year-slots";
import { ExpectedPeriods } from "@/components/years/ExpectedPeriods";

vi.mock("server-only", () => ({}));

const FEB = "cyc-feb";
const MAY = "cyc-may";
const sitting = (id: string, key: string, status: string): SittingSpec => ({
  id, name: `${key} 2026`, sitting: key, status, students: { "a@s.edu": [1, 1, 1, 0] },
});
const yearRow = (extra: Record<string, unknown> = {}) => [{ id: YEAR, name: "2026", region: "eu-west", test_centre_id: CENTRE, ...extra }];

async function open(specs: SittingSpec[], year?: Record<string, unknown>) {
  const { provider, fake } = await liveProvider(buildDb(specs, year ? { exam_years: yearRow(year) } : {}));
  await provider.ensureYearLoaded(YEAR);
  return { provider, fake };
}

describe("default expectation (February + May): existing data behaves exactly as before", () => {
  const STATES = [undefined, "in_review", "locked"] as const; // not started / started unlocked / locked
  for (const feb of STATES) {
    for (const may of STATES) {
      const oldRule = feb === "locked" && may === "locked"; // the hard-coded pair
      it(`February ${feb ?? "absent"} · May ${may ?? "absent"} → ready=${oldRule}`, async () => {
        const specs = [
          ...(feb ? [sitting(FEB, "february", feb)] : []),
          ...(may ? [sitting(MAY, "may", may)] : []),
        ];
        if (specs.length === 0) return; // no sitting → no year to open
        const { provider } = await open(specs);
        expect(provider.getYear(YEAR)!.overall.ready).toBe(oldRule);
        expect(provider.getOverallGrades(YEAR)!.ready).toBe(oldRule);
        expect(provider.getOverallGrades(YEAR)!.locked).toBe(oldRule);
        expect(provider.getYear(YEAR)!.expectedPeriods).toEqual(["february", "may"]);
        // both tiles always show, as before
        expect(provider.getYear(YEAR)!.sittings.map((s) => s.sitting)).toEqual(["february", "may"]);
      });
    }
  }

  it("a database without the 0051 column (code deployed first) behaves as the default", async () => {
    const { provider } = await open([sitting(FEB, "february", "locked"), sitting(MAY, "may", "locked")]); // no expected_periods on the row
    expect(provider.getYear(YEAR)!.expectedPeriods).toEqual(["february", "may"]);
    expect(provider.getYear(YEAR)!.overall.ready).toBe(true);
  });

  it("an unusable stored value falls back to the default rather than making the year unfinishable", async () => {
    const { provider } = await open([sitting(MAY, "may", "locked")], { expected_periods: ["junk"] });
    expect(provider.getYear(YEAR)!.expectedPeriods).toEqual(["february", "may"]);
    expect(provider.getYear(YEAR)!.overall.ready).toBe(false);
  });
});

describe("a configured expectation", () => {
  it("expecting only May: a locked May alone makes the year ready, and no empty February tile is shown", async () => {
    const { provider } = await open([sitting(MAY, "may", "locked")], { expected_periods: ["may"] });
    const year = provider.getYear(YEAR)!;
    expect(year.expectedPeriods).toEqual(["may"]);
    expect(year.overall.ready).toBe(true);
    expect(year.sittings.map((s) => s.sitting)).toEqual(["may"]);
    expect(provider.getOverallGrades(YEAR)!.ready).toBe(true);
  });

  it("an unlocked sitting in a period the year does NOT expect neither blocks nor counts", async () => {
    const { provider } = await open(
      [sitting(FEB, "february", "in_review"), sitting(MAY, "may", "locked")],
      { expected_periods: ["may"] },
    );
    const model = provider.getOverallGrades(YEAR)!;
    expect(model.ready).toBe(true);
    expect(model.sittings!.map((s) => [s.key, s.status, s.expected])).toEqual([
      ["february", "not_locked", false],
      ["may", "counted", true],
    ]);
  });

  it("a LOCKED sitting in a non-expected period still counts toward the rollup", async () => {
    const { provider } = await open(
      [sitting(FEB, "february", "locked"), sitting(MAY, "may", "locked")],
      { expected_periods: ["may"] },
    );
    expect(provider.getOverallGrades(YEAR)!.sittings!.map((s) => s.status)).toEqual(["counted", "counted"]);
  });

  it("an expected period with NO sitting holds the year back, and says so", async () => {
    const { provider } = await open([sitting(MAY, "may", "locked")], { expected_periods: ["february", "may"] });
    const model = provider.getOverallGrades(YEAR)!;
    expect(model.ready).toBe(false);
    expect(model.note).toMatch(/February: no sitting/);
    expect(slotOf(provider.getYear(YEAR)!, "february")).toMatchObject({ started: false, expected: true });
  });
});

describe("setYearExpectedPeriods", () => {
  it("sends the real year id with a sorted, de-duplicated list, then shows the new expectation", async () => {
    const { provider, fake } = await open([sitting(MAY, "may", "locked")]);
    expect(provider.getYear(YEAR)!.overall.ready).toBe(false); // default expects February too
    await provider.setYearExpectedPeriods(YEAR, ["may", "may"]);
    const call = fake.calls.find((c) => c.name === "set_year_expected_periods")!;
    expect(call.args).toEqual({ p_year_id: YEAR, p_periods: ["may"] });
    expect(provider.getYear(YEAR)!.expectedPeriods).toEqual(["may"]);
    expect(provider.getYear(YEAR)!.overall.ready).toBe(true);
    await provider.setYearExpectedPeriods(YEAR, ["may", "february"]);
    expect(fake.calls.filter((c) => c.name === "set_year_expected_periods")[1]!.args.p_periods).toEqual(["february", "may"]);
    expect(provider.getYear(YEAR)!.overall.ready).toBe(false);
  });

  it("rejects an empty list before calling the server, and an unknown year", async () => {
    const { provider, fake } = await open([sitting(MAY, "may", "locked")]);
    await expect(provider.setYearExpectedPeriods(YEAR, [])).rejects.toThrow(/at least one period/);
    await expect(provider.setYearExpectedPeriods("no-such-year", ["may"])).rejects.toThrow(/no database record/);
    expect(fake.calls.some((c) => c.name === "set_year_expected_periods")).toBe(false);
  });

  it("surfaces the server's refusal and leaves the expectation unchanged", async () => {
    const { provider, fake } = await open([sitting(MAY, "may", "locked")]);
    fake.failRpc("set_year_expected_periods", "not authorized");
    await expect(provider.setYearExpectedPeriods(YEAR, ["may"])).rejects.toThrow(/not authorized/);
    expect(provider.getYear(YEAR)!.expectedPeriods).toEqual(["february", "may"]);
  });
});

describe("ExpectedPeriods control", () => {
  const html = (canEdit: boolean) =>
    renderToStaticMarkup(createElement(ExpectedPeriods, { expected: ["february", "may"], canEdit, onChange: async () => {} }));
  it("an editor sees one toggle per registry period, set for the expected ones", () => {
    const out = html(true);
    expect(out).toContain("February");
    expect(out).toContain("May");
    expect((out.match(/hf-chip on/g) ?? []).length).toBe(2);
  });
  it("a viewer sees the expectation as text, with no toggles", () => {
    const out = html(false);
    expect(out).toContain("February, May");
    expect(out).not.toContain("<button");
  });
});
