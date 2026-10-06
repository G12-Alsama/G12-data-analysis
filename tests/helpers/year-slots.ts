import type { SittingKey, SittingRef } from "@/lib/data/types";

/** A year's sitting for one period (tests address slots by period, not by field). */
export function slotOf(year: { sittings: SittingRef[] }, period: SittingKey): SittingRef {
  const s = year.sittings.find((x) => x.sitting === period);
  if (!s) throw new Error(`year has no ${period} slot (it shows: ${year.sittings.map((x) => x.sitting).join(", ")})`);
  return s;
}
