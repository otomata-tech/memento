/**
 * Memento V3 — verbe `admin` UNIQUE (issues #71, #31). Regroupe la gestion org/équipe
 * derrière un seul verbe `admin({action, …})` pour tenir le budget de surface : le
 * noyau (v3.ts) reste à 8 verbes, l'admin est « hors noyau », chargé à la demande.
 *
 * Pur aiguillage action → `_shared/admin.v3.ts` (où vivent l'autz et la logique).
 * Partagé par les deux faces : surface MCP (v3_server.ts) et REST (api-v3).
 */
import * as admin from "../_shared/admin.v3.ts";

export const ADMIN_ACTIONS = [
  "orgs", "create_org", "rename_base", "invite_member", "set_role", "remove_member",
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** Aiguille sur l'action ; chaque branche lit les champs qu'elle attend dans `args`. */
export function v3Admin(sub: string, args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? "");
  switch (action) {
    case "orgs":
      return admin.adminOrgs(sub);
    case "create_org":
      return admin.createOrg(sub, args as unknown as { name: string; slug?: string; baseName?: string });
    case "rename_base":
      return admin.renameBase(sub, args as unknown as { baseId: string; name: string });
    case "invite_member":
      return admin.inviteMember(sub, args as unknown as { orgSlug: string; email: string; role?: string });
    case "set_role":
      return admin.setRole(sub, args as unknown as { orgSlug: string; userId: string; role: string });
    case "remove_member":
      return admin.removeMember(sub, args as unknown as { orgSlug: string; userId: string });
    default:
      throw new Error(`unknown admin action: ${action || "(missing)"}`);
  }
}
