/**
 * Regression: timingPerformance()'s per-student median-time input must include
 * EVERY scored (maxScore >= 1) response's responseTime, answered or not — QM
 * logs dwell time on a question even when the student leaves it blank, and the
 * ground-truth methodology's own definition ("Median Response Time per Item =
 * median of each student's AnswerResponseTimeSeconds inside the analysis unit")
 * applies no answered-only filter. "Number of Item Responses" = N participants
 * × N scored items EXACTLY, with zero responses excluded for being unanswered.
 *
 * A prior fix added `if (!r.answered) continue;` inside timingPerformance() to
 * fix a DIFFERENT, unrelated bug (a stale answered-flag issue). That line was
 * correct for speededness() (omission/completion genuinely should treat an
 * unanswered item as omitted — untouched here) but wrong inside
 * timingPerformance(), where it silently dropped unanswered items' response
 * times from the per-student median, understating each student's true
 * time-on-task and skewing Pearson/Spearman.
 *
 * The only exclusion that belongs in the median is a genuinely missing/
 * non-finite responseTime — real data absence, distinct from "left blank but
 * still timed". Both tests below derive their expected Pearson from the
 * exported `pearson()` reference implementation itself (not a hand-typed
 * magic number), so each one documents exactly which per-student median times
 * are — and are not — expected to feed the correlation.
 */
import { describe, it, expect } from "vitest";
import { timingPerformance, pearson, type DiagResponse } from "@/lib/diagnostics";

function r(
  participantId: string,
  itemId: string,
  answered: boolean,
  correct: boolean,
  responseTime: number | null,
): DiagResponse {
  return { participantId, itemId, demandLevel: null, itemSet: null, majorElement: null, order: 0, answered, correct, responseTime };
}

describe("timingPerformance() — unanswered-but-timed vs genuinely-missing responseTime", () => {
  it("includes an unanswered item's responseTime in the per-student median (QM still logs dwell time on a blank answer)", () => {
    // 3 students × 2 scored items. Q1 is answered by everyone; Q2 is left BLANK
    // by everyone but QM still recorded a response time for it.
    const records: DiagResponse[] = [
      r("s1", "Q1", true, false, 5), r("s1", "Q2", false, false, 100),
      r("s2", "Q1", true, true, 10), r("s2", "Q2", false, false, 5),
      r("s3", "Q1", true, true, 15), r("s3", "Q2", false, false, 50),
    ];

    // Ground truth: median draws from BOTH items (answered or not), and
    // "presented" counts every scored response — so scorePct is correct ÷ 2.
    const correctMedTimes = [median([5, 100]), median([10, 5]), median([15, 50])]; // [52.5, 7.5, 32.5]
    const correctScorePct = [0, 50, 50]; // 0/2, 1/2, 1/2
    const expectedPearson = pearson(correctMedTimes, correctScorePct);

    // What the buggy `if (!r.answered) continue;` would have produced instead:
    // Q2 dropped everywhere, so the median is just Q1's own time and scorePct
    // is correct ÷ 1 (only the answered item counted as "presented").
    const buggyMedTimes = [5, 10, 15];
    const buggyScorePct = [0, 100, 100];
    const buggyPearson = pearson(buggyMedTimes, buggyScorePct);

    const res = timingPerformance(records);
    expect(res.nStudents).toBe(3);
    // timingPerformance() rounds to 4dp internally (see `rnd()`), so compare
    // at that precision rather than the raw float.
    expect(res.pearson).toBeCloseTo(expectedPearson!, 4);
    // Guards against reintroducing the `!r.answered` filter: the two
    // computations must actually differ for this fixture, or the assertion
    // above wouldn't distinguish correct from buggy behaviour.
    expect(Math.abs(expectedPearson! - buggyPearson!)).toBeGreaterThan(0.05);
    expect(res.pearson).not.toBeCloseTo(buggyPearson!, 2);
  });

  it("excludes a genuinely null responseTime from the median, even when the item WAS answered", () => {
    // Same 3 students; Q1 has a real time for everyone, Q2 is answered by
    // everyone but its responseTime is genuinely missing (null) — real data
    // absence, not "blank but timed". Only Q1's time should feed the median.
    const records: DiagResponse[] = [
      r("s1", "Q1", true, false, 10), r("s1", "Q2", true, false, null),
      r("s2", "Q1", true, true, 20), r("s2", "Q2", true, true, null),
      r("s3", "Q1", true, false, 30), r("s3", "Q2", true, true, null),
    ];

    // Ground truth: medTime = Q1's own time (Q2 excluded — null, not a number).
    // "presented" still counts BOTH responses (a null time doesn't drop the
    // response itself, only its contribution to the median), so scorePct is
    // correct ÷ 2: s1 0/2, s2 2/2, s3 1/2.
    const expectedMedTimes = [10, 20, 30];
    const expectedScorePct = [0, 100, 50];
    const expectedPearson = pearson(expectedMedTimes, expectedScorePct);

    const res = timingPerformance(records);
    expect(res.nStudents).toBe(3);
    expect(res.pearson).toBeCloseTo(expectedPearson!, 4);
  });
});

/** Local median helper mirroring lib/diagnostics/index.ts's (even-length → average of the two middle values). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
