"use client";

/**
 * `useCan(action)` — does the signed-in user hold `action`, resolved against the
 * hydrated role × action grid?
 *
 * Same `can(...)` call shape as the other gates (e.g. the Audit page's
 * `can(p.getCurrentUser?.()?.role ?? "viewer", "general.audit")`), but passing the whole
 * user and the live grid. The bare-role form falls back to the SEEDED grid and to the
 * legacy `member_role` enum, so it misjudges a custom role (or an edited cell); this is
 * the client twin of the DB's `app.can_do`, which stays authoritative either way — a
 * wrong answer here only mis-draws a control, it never grants anything.
 */
import { useProviderData } from "@/lib/data/context";
import { can, resolveRoleActions, type ActionKey } from "@/lib/auth/actions";

export function useCan(action: ActionKey): boolean {
  return useProviderData((p) => {
    const user = p.getCurrentUser?.();
    if (!user) return false;
    const resolved = resolveRoleActions(p.getRoles?.() ?? [], p.getRoleActions?.() ?? {});
    return can(user, action, resolved);
  });
}
