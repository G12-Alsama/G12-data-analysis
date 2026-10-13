/**
 * Assemble the ready-to-render `ItemAnalysisInput` from engine statistics and
 * response-level facts. Derives the per-item Presented/Answered counts and
 * average response time (which the engine's stats do not carry), and the
 * per-assessment participant/row counts and discrimination group size.
 */

import type { ItemStat } from "@/lib/engine";
import { DEFAULT_SCORING_CONFIG, discriminationGroupSize } from "@/lib/engine";
import { canonicalSubjectLabel } from "@/lib/data/subject-catalog";
import { isScoredItem } from "@/lib/clean/flags";
import { roundOrNull } from "./sheet-utils";
import type {
  AssembleItemAnalysisArgs,
  ItemAnalysisBlock,
  ItemAnalysisInput,
  ItemAnalysisRow,
  ItemResponseFact,
} from "./types";

interface ItemFactAgg {
  presented: number;
  answered: number;
  timeSum: number;
  timeCount: number;
}

export function assembleItemAnalysis(args: AssembleItemAnalysisArgs): ItemAnalysisInput {
  const { cycleName, assessments, stats, facts, reviews, items } = args;

  // A maxScore:0 item is a stimulus/instruction page, not a real question
  // (STIMULUS_ITEM — see lib/clean/flags.ts). Excluded HERE, before anything
  // downstream (a row, a count, a median, a group size) ever sees it. Only
  // items we positively KNOW are unscored are excluded — a caller that
  // supplies no item metadata at all gets the previous, unfiltered behaviour.
  const unscoredItemIds = new Set(
    (items ?? []).filter((it) => !isScoredItem({ maxScore: it.maxScore ?? 1 })).map((it) => it.itemId),
  );

  // Group stats and facts by assessment, dropping unscored items first.
  const statsByAssessment = new Map<string, ItemStat[]>();
  for (const s of stats) {
    if (unscoredItemIds.has(s.itemId)) continue;
    const bucket = statsByAssessment.get(s.assessmentId) ?? [];
    bucket.push(s);
    statsByAssessment.set(s.assessmentId, bucket);
  }

  const factsByAssessment = new Map<string, ItemResponseFact[]>();
  for (const f of facts) {
    if (unscoredItemIds.has(f.itemId)) continue;
    const bucket = factsByAssessment.get(f.assessmentId) ?? [];
    bucket.push(f);
    factsByAssessment.set(f.assessmentId, bucket);
  }

  const blocks: ItemAnalysisBlock[] = [];

  for (const assessment of assessments) {
    const aStats = statsByAssessment.get(assessment.id) ?? [];
    const aFacts = factsByAssessment.get(assessment.id) ?? [];

    // Per-item aggregation of facts.
    const perItem = new Map<string, ItemFactAgg>();
    const participants = new Set<string>();
    for (const f of aFacts) {
      participants.add(f.participantId);
      let agg = perItem.get(f.itemId);
      if (!agg) {
        agg = { presented: 0, answered: 0, timeSum: 0, timeCount: 0 };
        perItem.set(f.itemId, agg);
      }
      agg.presented += 1;
      if (f.answered) agg.answered += 1;
      if (f.responseTime !== null && Number.isFinite(f.responseTime)) {
        agg.timeSum += f.responseTime;
        agg.timeCount += 1;
      }
    }

    const rows: ItemAnalysisRow[] = aStats.map((stat) => {
      const agg = perItem.get(stat.itemId);
      const review = reviews?.[stat.itemId];
      const presented = agg?.presented ?? stat.n;
      const answered = agg?.answered ?? stat.n;
      const avgResponseTime =
        agg && agg.timeCount > 0 ? roundOrNull(agg.timeSum / agg.timeCount, 1) : null;
      return {
        stat,
        participantsPresented: presented,
        participantsAnswered: answered,
        avgResponseTime,
        notes: review?.notes ?? null,
        exclude: review?.exclude ?? false,
        removeReason: review?.reason ?? null,
      };
    });

    const participantCount = participants.size;
    blocks.push({
      id: assessment.id,
      // Sheet titles/tabs must always read from the canonical English subject
      // label, never a raw or local-script name straight off the QM export
      // (e.g. an Arabic-script assessment name) — see canonicalSubjectLabel.
      name: canonicalSubjectLabel(assessment.name),
      participants: participantCount,
      rowsAnalysed: aFacts.length,
      groupSize: discriminationGroupSize(participantCount),
      rows,
    });
  }

  return {
    cycleName,
    blocks,
    qualityThresholds: args.qualityThresholds ?? DEFAULT_SCORING_CONFIG.quality,
  };
}
