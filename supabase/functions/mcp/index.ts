/**
 * Memento MCP — Supabase Edge Function (Deno + SDK officiel @modelcontextprotocol/sdk).
 * Les 6 verbes de lecture `mem_*`, au-dessus de la couche services partagée (`../_shared/`).
 *
 * Transport : WebStandardStreamableHTTPServerTransport (Request/Response web → compatible
 * runtime Edge). STATELESS (sessionIdGenerator: undefined) : serveur + transport neufs par
 * requête, adapté aux isolates éphémères de l'Edge. La réponse `initialize` sort en SSE
 * (text/event-stream) — requis par le client MCP de claude.ai (mcp-lite renvoyait du JSON,
 * d'où l'échec du handshake).
 *
 * Local : DATABASE_URL=... deno run -A supabase/functions/mcp/index.ts
 * Deploy : supabase functions deploy mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { listWorkspaces, getDoctrine } from "../_shared/workspaces.ts";
import { getSection } from "../_shared/sections.ts";
import { getDocument, getBlock } from "../_shared/documents.ts";
import { hybridSearch, searchPublic } from "../_shared/search.ts";
import { listItems, countItems } from "../_shared/list.ts";
import { neighborhood } from "../_shared/graph.ts";
import { similarBlocks } from "../_shared/semantic.ts";
import { resolveWorkspaceBySlug, resolveWorkspaceById, resolveSectionIds } from "../_shared/paths.ts";
import { docUrl } from "../_shared/urls.ts";
import {
  authenticate,
  protectedResourceMetadata,
  wwwAuthenticate,
  isDiscoveryPath,
  authServerMetadata,
} from "../_shared/auth.ts";
import { assertAccess, assertWorkspaceAdmin, resolveWorkspaceId, AccessError, safeErrorMessage } from "../_shared/access.ts";
import { assertWithinLimit, RateLimitError } from "../_shared/ratelimit.ts";
import { setDefaultWorkspace, pinWorkspace, unpinWorkspace } from "../_shared/prefs.ts";
import { contextMap, wsContext, accessibleWorkspaceRefs } from "../_shared/context.ts";
import { setDoctrine, updateWorkspace, archiveWorkspace } from "../_shared/workspace_mgmt.ts";
import { listMyOrgs, createWorkspace, createOrg, transferWorkspace } from "../_shared/admin.ts";
import { listGrants, grantAccess, revokeGrant, setVisibility } from "../_shared/grants.ts";
import { listAccounts } from "../_shared/platform.ts";
// Surface MCP v2 (#18) : plus de verbes de mutation directs — toute écriture de
// contenu passe par mem_stage_changes (op-codes → apply). Les handlers de write.ts
// restent appelés par OPS à l'apply ; mcp n'en utilise plus que les commentaires.
import { addComment, resolveComment } from "../_shared/write.ts";
import {
  createSection, renameSection, deleteSection, reorder, moveDocuments, splitSection, mergeSections,
} from "../_shared/restructure.ts";
import { listRevisions } from "../_shared/revisions.ts";
import { logUsage, listUsageLogs, USAGE_KINDS } from "../_shared/usage_log.ts";
import { withCallLog } from "../_shared/calllog.ts";
import {
  stageChanges, getIngestion, listIngestions, applyIngestion, rejectIngestion,
} from "../_shared/ingestion.ts";
import { blockType, sourceKind, linkRelation, commentTarget } from "../_shared/db.ts";

const BT = blockType.enumValues as [string, ...string[]];
const SK = sourceKind.enumValues as [string, ...string[]];
const LR = linkRelation.enumValues as [string, ...string[]];
const CT = commentTarget.enumValues as [string, ...string[]];

const INSTRUCTIONS = `Memento — base de connaissance structurée, sourcée, multi-KB.

Ce préambule EST ta doctrine globale (comment Memento marche) ; chaque KB porte EN PLUS
sa propre doctrine — mem_doctrine(workspace).

STRUCTURE : une **org** = un tenant (annuaire de membres : équipe, mission, client —
chacun a aussi son org perso) ; une **KB** (workspace) = une base de savoir appartenant
à UNE org, qui PORTE SON PÉRIMÈTRE : visibility "org" (tous les membres de l'org, leur
rôle d'org par défaut), "private" (accès explicites seuls) ou "public" (lisible/cherchable
par tous, l'org garde la curation), plus des **grants** individuels par KB (élever un membre
en curator, inviter un externe — mem_grant ; un grant donne lecture ou écriture, JAMAIS la
gouvernance). Ton rôle effectif sur une KB = max(grant, rôle d'org si visibility=org|public) ;
curator+ = écriture, member = lecture. La gouvernance (partager, visibility, archiver,
transférer) = admin de l'ORG propriétaire uniquement. myRole null = base de ton org gérable
mais non lisible (private sans grant).

DÉMARRAGE (important — le serveur est sans état) :
1. Oriente-toi avec CE préambule (ci-dessus + ci-dessous), puis appelle mem_workspaces :
   ta carte = orgs (→ ton rôle → KB) + "shared" (KB partagées hors tes orgs) +
   "pinned" (KB publiques d'autres orgs que tu as épinglées) + ta KB par défaut ("default").
2. Pour TROUVER une info, préfère mem_search(workspace:"*") — il cherche dans TOUT ton
   univers (orgs + shared + pinned) — plutôt que de parcourir l'arbo à la main.
3. Tu veux suivre une KB publique d'une autre org ? mem_pin_workspace({workspace}) : elle
   rejoint "pinned" et le périmètre de recherche. mem_unpin_workspace pour l'enlever.
4. Ambigu ? Fixe la KB par défaut : mem_use_workspace({workspace}) (persistée, ≠ épingle).
   Les verbes à "workspace" peuvent l'omettre → KB par défaut ; un "workspace" explicite prime.
5. Les réponses échoent "workspace" ET "org" : VÉRIFIE-les, et annonce à l'utilisateur où tu
   lis/écris (surtout avant une écriture). En cas de doute, demande-lui.
6. Créer : mem_create_workspace exige "org" (choisis-la dans mem_workspaces ; mem_orgs ne
   sert qu'au détail des membres).

PROTOCOLE doctrine-first : sur une KB ciblée, mem_doctrine (préambule + arbre + conventions)
AVANT tout drill. Cible 2-3 sections, puis mem_section / mem_document / mem_block, ou
mem_search (hybride : mots exacts + paraphrases). Ne charge jamais toute la base.

ROUTAGE recherche vs énumération : mem_search est top-k, JAMAIS exhaustif. Pour
« tout / lesquels / combien / quoi de neuf depuis » → mem_list / mem_count
(déterministes, recall 100 %) et mem_revisions({since}) pour le delta de session.

ÉCRITURE : réservée aux rôles admin/curator de l'org. Ne mute jamais en aveugle —
propose via mem_stage_changes (→ revue humaine), puis mem_apply_ingestion. Les
contradictions ne sont jamais auto-appliquées.

FEEDBACK (quasi obligatoire) : dès que Memento te surprend — erreur inattendue,
recherche qui rate un contenu qui devrait exister, verbe/capacité manquant,
paramètre ambigu, description trompeuse — signale-le via mem_log_usage AVANT de
contourner. Une ligne suffit ; ça n'écrit rien dans la KB et ne bloque jamais
ton travail. C'est ainsi que l'outil s'améliore.`;

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const idOrPath = { id: z.string().optional(), path: z.string().optional() };

// Bornes anti-DoS sur les entrées d'écriture (taille de contenu + cardinalité des
// batchs) : l'isolate Edge a une mémoire limitée et la KB peut stocker du contenu
// volumineux. Le SDK MCP rejette tôt (avant tout I/O) ce qui dépasse.
const MAX_CONTENT = 200_000; // contenu d'un bloc / markdown d'un document
const MAX_TEXT = 20_000;     // champs texte courts (préambule mis à part : long)
const MAX_BATCH = 500;       // items d'un tableau d'ids / de changes
const longStr = z.string().max(MAX_CONTENT);
const textStr = z.string().max(MAX_TEXT);

/** Enrobe un handler : traduit un refus d'accès en résultat d'erreur lisible.
 *  `args` est typé `any` : le SDK valide déjà la forme à l'exécution via le inputSchema Zod. */
function guarded(fn: (args: any) => Promise<any>) {
  return async (args: any) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof AccessError) {
        return { content: [{ type: "text" as const, text: `Accès refusé : ${e.message}` }], isError: true };
      }
      if (e instanceof RateLimitError) {
        return { content: [{ type: "text" as const, text: e.message }], isError: true };
      }
      // On ne propage jamais l'erreur brute (fuite de schéma DB / système externe) :
      // détail loggé côté serveur, message sûr renvoyé à l'agent.
      console.error("[mcp] verbe échec:", e);
      return { content: [{ type: "text" as const, text: `Erreur : ${safeErrorMessage(e)}` }], isError: true };
    }
  };
}

/** Construit un serveur MCP frais (un par requête en mode stateless), scopé au user `sub`. */
function buildServer(sub: string): McpServer {
  const server = new McpServer({ name: "memento", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  // Journal des appels (otomata-calllog, table tool_calls) : registerTool est
  // intercepté UNE fois — tous les verbes passent par withCallLog sans toucher
  // aux ~50 déclarations.
  const register = server.registerTool.bind(server);
  // deno-lint-ignore no-explicit-any
  server.registerTool = ((name: string, cfg: any, handler: any) =>
    register(name, cfg, withCallLog(name, sub, handler))) as typeof server.registerTool;

  server.registerTool("mem_workspaces", {
    description:
      "TA CARTE DE CONTEXTE — point de départ. Topologie complète : tes orgs (tenants, dont ton org perso `personal:true`) → leurs KB visibles avec TON rôle effectif et `visibility` (org|private|public), " +
      "+ `shared` (KB partagées avec toi hors de tes orgs), + `pinned` (KB publiques d'autres orgs que tu as épinglées — mem_pin_workspace), + ta KB par défaut (`default`). " +
      "Sers-t'en pour choisir la cible ; change le défaut avec mem_use_workspace. Pour TROUVER une info plutôt que parcourir : mem_search(workspace:\"*\").",
    inputSchema: {},
  }, guarded(async () => json(await contextMap(sub))));

  server.registerTool("mem_use_workspace", {
    description:
      "Fixe ta KB par défaut (persistée). Les verbes qui acceptent `workspace` l'utiliseront quand tu l'omets. " +
      "Un `workspace` explicite reste toujours prioritaire. À appeler en début de session pour cadrer le contexte.",
    inputSchema: { workspace: z.string().describe("slug de la KB, ex: demo") },
  }, guarded(async ({ workspace }) => {
    // Vérifie l'accès AVANT de fixer le défaut : on ne confirme pas l'existence
    // d'une KB d'un autre tenant et on n'en écho pas l'org.
    await assertAccess(sub, { workspace });
    const w = await setDefaultWorkspace(sub, workspace);
    const { org } = await wsContext(sub, w.slug);
    return json({ default: w.slug, name: w.name, org, message: `KB par défaut : ${w.name} (${w.slug}, org ${org})` });
  }));

  server.registerTool("mem_pin_workspace", {
    description:
      "Épingle une KB dans ton univers (typiquement une KB publique d'une autre org) : elle apparaît dans `pinned` de mem_workspaces " +
      "et entre dans le périmètre de mem_search(workspace:\"*\"). Distinct de la KB par défaut (mem_use_workspace). Idempotent.",
    inputSchema: { workspace: z.string().describe("slug de la KB à épingler") },
  }, guarded(async ({ workspace }) => {
    await assertAccess(sub, { workspace }); // lisible (les KB publiques le sont par tous)
    const w = await pinWorkspace(sub, workspace);
    return json({ pinned: w.slug, name: w.name, message: `KB épinglée : ${w.name} (${w.slug})` });
  }));

  server.registerTool("mem_unpin_workspace", {
    description: "Retire une KB de tes épinglées (la sort de `pinned` et du périmètre de recherche globale).",
    inputSchema: { workspace: z.string().describe("slug de la KB à désépingler") },
  }, guarded(async ({ workspace }) => {
    return json({ unpinned: (await unpinWorkspace(sub, workspace)).slug });
  }));

  server.registerTool("mem_set_doctrine", {
    description:
      "Écrit le préambule de doctrine (méta-instructions, markdown) d'une KB — la boussole lue par mem_doctrine. " +
      "À poser sur une KB neuve (sinon sa carte est vide). Réservé admin/curator. `workspace` optionnel = KB par défaut.",
    inputSchema: { workspace: z.string().optional(), preamble: longStr },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    return json({ workspace: ws, org, ...(await setDoctrine({ workspace: ws, preamble: args.preamble }, sub)) });
  }));

  server.registerTool("mem_update_workspace", {
    description: "Modifie les métadonnées d'une KB (nom et/ou résumé). Le slug reste stable. Réservé admin/curator.",
    inputSchema: { workspace: z.string().optional(), name: z.string().optional(), summary: z.string().optional() },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    return json({ workspace: ws, org, ...(await updateWorkspace({ workspace: ws, name: args.name, summary: args.summary }, sub)) });
  }));

  server.registerTool("mem_archive_workspace", {
    description: "Archive (masque) une KB, ou la réactive (`archived:false`). Réversible. Réservé aux admins de l'org propriétaire.",
    inputSchema: { workspace: z.string().optional(), archived: z.boolean().optional() },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertWorkspaceAdmin(sub, ws);
    return json({ workspace: ws, org, ...(await archiveWorkspace({ workspace: ws, archived: args.archived }, sub)) });
  }));

  server.registerTool("mem_grants", {
    description:
      "Le « qui a accès » d'une KB : visibility (org|private), grants individuels (email, rôle, pending) " +
      "ET accès hérités de l'org (`inherited`, si visibility=org). Réservé aux admins de l'org propriétaire.",
    inputSchema: { workspace: z.string().optional().describe("slug de la KB ; omis = KB par défaut") },
  }, guarded(async (args) => {
    const { workspace: ws } = await wsContext(sub, args.workspace);
    return json(await listGrants(sub, { workspace: ws }));
  }));

  server.registerTool("mem_grant", {
    description:
      "Donne (ou met à jour) l'accès d'une personne à UNE KB, par email — y compris un EXTERNE à l'org (guest) : " +
      "compte inexistant → provisionné + email d'invitation. Rôle : member (lecture) | curator (écriture) — " +
      "jamais la gouvernance (partager/transférer restent à l'org-admin). Réservé aux admins de l'org propriétaire. " +
      "Pour ajouter quelqu'un à TOUTES les KB d'une org → invitation d'org (mem_orgs).",
    inputSchema: {
      workspace: z.string().optional().describe("slug de la KB ; omis = KB par défaut"),
      email: z.string().describe("email de la personne"),
      role: z.enum(["curator", "member"]).optional().describe("défaut member (lecture)"),
    },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    return json({ org, ...(await grantAccess(sub, { workspace: ws, email: args.email, role: args.role })) });
  }));

  server.registerTool("mem_revoke_grant", {
    description:
      "Retire un accès explicite à une KB (par userId, cf. mem_grants). Réservé aux admins de l'org propriétaire.",
    inputSchema: {
      workspace: z.string().optional().describe("slug de la KB ; omis = KB par défaut"),
      userId: z.string().describe("sub du user (cf. mem_grants)"),
    },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    return json({ org, ...(await revokeGrant(sub, { workspace: ws, userId: args.userId })) });
  }));

  server.registerTool("mem_set_visibility", {
    description:
      "Change le périmètre d'une KB : `org` (tous les membres de l'org, rôle d'org par défaut), `private` " +
      "(grants explicites seuls — un grant curator t'est posé au passage pour que tu continues de la lire), " +
      "ou `public` (lisible et cherchable par TOUS, anonyme inclus : galerie publique + mem_public_search ; " +
      "ton org garde l'écriture). Réservé aux admins de l'org propriétaire.",
    inputSchema: {
      workspace: z.string().optional().describe("slug de la KB ; omis = KB par défaut"),
      visibility: z.enum(["org", "private", "public"]),
    },
  }, guarded(async (args) => {
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    return json({ org, ...(await setVisibility(sub, { workspace: ws, visibility: args.visibility })) });
  }));

  server.registerTool("mem_orgs", {
    description:
      "Détail de tes organisations : MEMBRES (email, rôle, pending) en plus des KB. " +
      "Pour simplement choisir une org/KB cible, mem_workspaces suffit (topologie légère).",
    inputSchema: {},
  }, guarded(async () => json(await listMyOrgs(sub))));

  server.registerTool("mem_accounts", {
    description:
      "VUE PLATEFORME (réservée aux opérateurs MEMENTO_PLATFORM_ADMINS) : tous les comptes auth — " +
      "email, date de création, dernier login, provider, appartenances aux orgs (null = compte sans org, " +
      "le signup est ouvert). Pour les membres d'une org précise, mem_orgs suffit.",
    inputSchema: {},
  }, guarded(async () => json(await listAccounts(sub))));

  server.registerTool("mem_create_org", {
    description:
      "Crée une organisation = un périmètre de partage (mission/client, perso) ; tu en deviens admin. " +
      "Enchaîne avec mem_create_workspace({org}) pour y créer des KB. Slug dérivé du nom sauf si fourni.",
    inputSchema: {
      name: z.string().describe("nom lisible, ex: Demo KB"),
      slug: z.string().optional().describe("slug souhaité ; défaut = dérivé du nom"),
    },
  }, guarded(async (args) => json(await createOrg(sub, args))));

  server.registerTool("mem_create_workspace", {
    description:
      "Crée une KB (workspace) vide rattachée à une org dont tu es admin (ton org perso marche toujours). " +
      "`visibility` : org (défaut, tous les membres de l'org), private (toi seul, puis mem_grant), " +
      "ou public (lisible/cherchable par tous — bascule plutôt après coup via mem_set_visibility). " +
      "Le slug est dérivé du nom (unique tous orgs confondus) sauf si fourni. " +
      "Enchaîne avec mem_set_doctrine pour poser la boussole, sinon la carte est vide.",
    inputSchema: {
      org: z.string().describe("slug de l'org propriétaire, ex: otomata"),
      name: z.string().describe("nom lisible de la KB"),
      summary: z.string().optional().describe("résumé court (objet de la KB)"),
      slug: z.string().optional().describe("slug souhaité ; défaut = dérivé du nom"),
      visibility: z.enum(["org", "private", "public"]).optional().describe("défaut org"),
    },
  }, guarded(async (args) =>
    json(await createWorkspace(sub, {
      orgSlug: args.org, name: args.name, summary: args.summary, slug: args.slug, visibility: args.visibility,
    })),
  ));

  server.registerTool("mem_transfer_workspace", {
    description:
      "Transfère une KB vers une autre org = change de TENANT (ex. promouvoir une KB de ton org perso vers " +
      "l'org d'équipe). Le périmètre (visibility/grants) suit la KB ; le contenu ne bouge pas. Pour ajuster " +
      "QUI voit la KB sans changer d'org → mem_grant/mem_set_visibility. " +
      "Réservé aux admins des DEUX orgs (source et destination).",
    inputSchema: {
      workspace: z.string().describe("slug de la KB à transférer"),
      toOrg: z.string().describe("slug de l'org de destination"),
    },
  }, guarded(async (args) => json(await transferWorkspace(sub, args))));

  server.registerTool("mem_doctrine", {
    description:
      "POINT D'ENTRÉE doctrine-first. Carte compacte d'une KB : préambule (méta-instructions), arbre des sections (titres + résumés + compteurs, SANS contenu) et conventions. À appeler en premier pour cibler 2-3 sections avant tout drill. `workspace` optionnel : par défaut, ta KB courante (cf. mem_use_workspace).",
    inputSchema: { workspace: z.string().optional().describe("slug de la KB ; omis = KB par défaut") },
  }, guarded(async ({ workspace }) => {
    const { workspace: ws, org } = await wsContext(sub, workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await getDoctrine(ws)) });
  }));

  server.registerTool("mem_section", {
    description:
      "Déplie une zone de l'arbre : sous-sections + documents (titre, résumé, statut, compteurs). Ne rend PAS les blocs. Par `id` ou `path`.",
    inputSchema: idOrPath,
  }, guarded(async (args) => {
    await assertAccess(sub, args.path ? { path: args.path } : { id: args.id, kind: "section" });
    return json(await getSection(args));
  }));

  server.registerTool("mem_document", {
    description:
      "Rend un document : blocs ordonnés (id, type, contenu) + sources, liens et commentaires par bloc. Par `id` ou `path`. " +
      "`document.url` = LE lien viewer à donner à l'humain (bloc précis : y suffixer `?block=<id>`) — ne jamais fabriquer d'URL soi-même.",
    inputSchema: idOrPath,
  }, guarded(async (args) => {
    await assertAccess(sub, args.path ? { path: args.path } : { id: args.id, kind: "document" });
    return json(await getDocument(args));
  }));

  server.registerTool("mem_block", {
    description:
      "Rend un bloc isolé avec ses sources, liens (entrants + sortants) et commentaires. Pour inspecter un hit de recherche. " +
      "`url` = LE lien viewer à donner à l'humain — ne jamais fabriquer d'URL soi-même.",
    inputSchema: { id: z.string() },
  }, guarded(async ({ id }) => {
    await assertAccess(sub, { id, kind: "block" });
    return json(await getBlock(id));
  }));

  server.registerTool("mem_neighborhood", {
    description:
      "Traverse le graphe de liens autour d'un bloc : sous-graphe (nœuds = blocs avec extrait + document/section, arêtes = liens typés) jusqu'à `depth` sauts (1-3, défaut 1). " +
      "Filtres : `relations` (REFERENCES|DEPENDS_ON|CONTRADICTS|SUPERSEDES|RELATED), `direction` out|in|both (défaut both). " +
      "Usages : voir ce qui dépend d'un principe avant de le modifier, suivre une chaîne de contradictions, explorer le voisinage d'un hit. Forer ensuite avec mem_block.",
    inputSchema: {
      blockId: z.string(),
      depth: z.number().int().min(1).max(3).optional(),
      relations: z.array(z.enum(LR)).optional(),
      direction: z.enum(["out", "in", "both"]).optional(),
    },
  }, guarded(async (args) => {
    // Un lien ne traverse jamais deux workspaces (invariant §4) : l'accès au bloc
    // racine couvre tout le sous-graphe.
    await assertAccess(sub, { id: args.blockId, kind: "block" });
    return json(await neighborhood(args));
  }));

  server.registerTool("mem_search", {
    description:
      "LA recherche — hybride par défaut : full-text français (mots exacts) + sémantique (paraphrases, kNN embeddings), fusion RRF. Chaque hit : blockId, matchedBy, snippet/excerpt, doc, `url` (LE lien viewer à donner à l'humain — ne jamais fabriquer d'URL), {workspace, org} + métadonnées de jugement (docStatus, verifiedAt, updatedAt, sourceCount, superseded/contradicted). " +
      "Les blocs de documents DEPRECATED sont déclassés (pas exclus) — `includeDeprecated` pour un classement pur. `lexicalTotal` = vrai nombre de correspondants, `hasMore` indique s'il faut élargir. ATTENTION : top-k, jamais exhaustif — pour « tout / combien / depuis » → mem_list/mem_count. " +
      "`workspace` omis = KB par défaut ; `\"*\"` = TOUT ton univers — tes orgs + KB partagées + KB publiques épinglées (« où ai-je noté ça ? » — `sectionPath` y est refusé). `likeBlockId` (à la place de `q`) = blocs proches d'un bloc-ancre (dédup, suggestions de liens, ciblage d'ingestion). " +
      "`mode` lexical|semantic pour forcer un seul régime (rarement utile). Si l'embedding est indisponible, dégrade en lexical et le signale (`modes`). Drill ensuite avec mem_block.",
    inputSchema: {
      q: z.string().optional().describe("requête texte (mots-clés ou phrase — les deux régimes s'en nourrissent)"),
      likeBlockId: z.string().optional().describe("bloc-ancre : renvoie les blocs sémantiquement proches (exclut q)"),
      workspace: z.string().optional().describe('slug de KB ; omis = KB par défaut ; "*" = toutes tes KB'),
      mode: z.enum(["hybrid", "lexical", "semantic"]).optional(),
      blockType: z.string().optional(),
      sectionPath: z.string().optional(),
      docKind: z.string().optional(),
      includeDeprecated: z.boolean().optional().describe("true = ne pas déclasser les blocs de documents DEPRECATED"),
      maxHits: z.number().int().min(1).max(100).optional(),
    },
  }, guarded(async (args) => {
    // Mode bloc-ancre : sémantique pur, scopé à la KB du bloc — mêmes filtres
    // que la recherche (aucun filtre accepté-puis-ignoré).
    if (args.likeBlockId) {
      await assertAccess(sub, { id: args.likeBlockId, kind: "block" });
      const wsId = await resolveWorkspaceId({ id: args.likeBlockId, kind: "block" });
      const ws = await resolveWorkspaceById(wsId!);
      const sectionIds = args.sectionPath
        ? await resolveSectionIds(ws.id, ws.slug, args.sectionPath)
        : null;
      const similar = await similarBlocks({
        workspaceIds: [ws.id],
        blockId: args.likeBlockId,
        k: args.maxHits,
        blockType: args.blockType,
        docKind: args.docKind,
        sectionIds,
      });
      return json({
        ...similar,
        hits: similar.hits.map((h) => ({ ...h, url: docUrl(ws.slug, h.document.id, h.blockId) })),
      });
    }
    if (!args.q?.trim()) throw new Error("`q` ou `likeBlockId` requis");

    // Cible : une KB (explicite/défaut) ou toutes ("*").
    let targets: { id: string; slug: string; org: string }[];
    let scope: Record<string, unknown>;
    if (args.workspace === "*") {
      await assertWithinLimit(sub, "search_global"); // fan-out coûteux (full-text + kNN sur N KB)
      targets = await accessibleWorkspaceRefs(sub);
      scope = { scope: "all" };
    } else {
      const { workspace: ws, org } = await wsContext(sub, args.workspace);
      await assertAccess(sub, { workspace: ws });
      const { id } = await resolveWorkspaceBySlug(ws);
      targets = [{ id, slug: ws, org }];
      scope = { workspace: ws, org };
    }
    return json({ ...scope, ...(await hybridSearch({ workspaces: targets, ...args, q: args.q })) });
  }));

  server.registerTool("mem_public_search", {
    description:
      "RECHERCHE PUBLIQUE — full-text sur TOUTES les KB publiques de Memento (pas seulement les tiennes), " +
      "sans appartenance requise. Pour découvrir du savoir partagé ouvertement par d'autres orgs. " +
      "Chaque hit est étiqueté {workspace, org} + `url` viewer ; épingle ensuite une KB trouvée via " +
      "mem_use_workspace, ou lis-la par slug (mem_doctrine/mem_document). Lexical seul (déterministe).",
    inputSchema: {
      q: z.string().describe("requête texte (mots-clés ou phrase)"),
      blockType: z.string().optional(),
      docKind: z.string().optional(),
      maxHits: z.number().int().min(1).max(100).optional(),
    },
  }, guarded(async (args) => {
    if (!args.q?.trim()) throw new Error("`q` requis");
    await assertWithinLimit(sub, "search_public");
    return json({ scope: "public", ...(await searchPublic(args)) });
  }));

  server.registerTool("mem_list", {
    description:
      "Énumération DÉTERMINISTE — recall 100 %, le complément de mem_search (top-k). Pour « liste tout », « lesquels », « qu'est-ce qui a changé depuis » → mem_list ; pour « combien » → mem_count. JAMAIS mem_search pour de l'exhaustif. " +
      "`kind` blocks (défaut) | documents. Lignes compactes (id, type, excerpt 100c, docPath, statuts, dates, compteurs) + `totalCount` (vrai nombre de correspondants), `hasMore`, `cursor` (keyset — repasse-le tel quel pour la page suivante). Tri : updated_at décroissant (le plus récent d'abord). " +
      "Filtres combinables : blockType, docStatus, verified, hasSource, sectionPath, docKind, updatedSince/updatedUntil. Ex. « toutes les REGLE non vérifiées » = {blockType:\"REGLE\", verified:false}. Drill ensuite avec mem_block/mem_document.",
    inputSchema: {
      workspace: z.string().optional().describe("slug de KB ; omis = KB par défaut"),
      kind: z.enum(["blocks", "documents"]).optional(),
      blockType: z.string().optional(),
      docStatus: z.enum(["ACTIVE", "DEPRECATED"]).optional(),
      verified: z.boolean().optional().describe("true = vérifiés seulement, false = non vérifiés seulement"),
      hasSource: z.boolean().optional(),
      sectionPath: z.string().optional(),
      docKind: z.string().optional(),
      updatedSince: z.string().optional().describe("ISO 8601 — ex. 2026-06-08T00:00:00Z"),
      updatedUntil: z.string().optional(),
      cursor: z.string().optional().describe("curseur opaque renvoyé par la page précédente"),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await listItems({ ...rest, workspace: ws })) });
  }));

  server.registerTool("mem_count", {
    description:
      "Compte/agrège SANS énumérer — mêmes filtres que mem_list, SQL pur, exact par construction. Pour « combien de blocs sans source », « répartition par type/section » → ce verbe, jamais mem_search. " +
      "`groupBy` type|docStatus|section|docKind → ventilation triée par effectif (section = chemin slugifié).",
    inputSchema: {
      workspace: z.string().optional().describe("slug de KB ; omis = KB par défaut"),
      kind: z.enum(["blocks", "documents"]).optional(),
      groupBy: z.enum(["type", "docStatus", "section", "docKind"]).optional(),
      blockType: z.string().optional(),
      docStatus: z.enum(["ACTIVE", "DEPRECATED"]).optional(),
      verified: z.boolean().optional(),
      hasSource: z.boolean().optional(),
      sectionPath: z.string().optional(),
      docKind: z.string().optional(),
      updatedSince: z.string().optional(),
      updatedUntil: z.string().optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await countItems({ ...rest, workspace: ws })) });
  }));

  // ── Commentaires (revue) ────────────────────────────────────────────────────
  server.registerTool("mem_comment", {
    description:
      "Annote un bloc/document/section. targetType ∈ BLOCK|DOCUMENT|SECTION. `authorKind` human|agent (défaut human).",
    inputSchema: {
      targetType: z.enum(CT), targetId: z.string(), body: z.string(),
      authorKind: z.string().optional(),
    },
  }, guarded(async (args) => {
    const kind = args.targetType.toLowerCase() as "block" | "document" | "section";
    await assertAccess(sub, { id: args.targetId, kind }, { write: true });
    return json(await addComment(args, sub));
  }));

  server.registerTool("mem_resolve_comment", {
    description: "Marque un commentaire comme résolu (horodatage).",
    inputSchema: { id: z.string() },
  }, guarded(async ({ id }) => {
    await assertAccess(sub, { id, kind: "comment" }, { write: true });
    return json(await resolveComment({ id }));
  }));

  // ── Restructuration (Lot 4) — composite, atomique, dry_run ──────────────────
  server.registerTool("mem_create_section", {
    description: "Crée une section (racine si pas de `parentId`). Profondeur d'arbre ≤ 3. `workspace` optionnel = KB par défaut.",
    inputSchema: {
      workspace: z.string().optional(), parentId: z.string().optional(),
      title: z.string(), summary: z.string().optional(), position: z.number().int().optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    return json({ workspace: ws, org, ...(await createSection({ ...rest, workspace: ws }, sub)) });
  }));

  server.registerTool("mem_rename_section", {
    description: "Renomme une section (titre et/ou résumé). Le slug reste stable (les chemins ne cassent pas).",
    inputSchema: { id: z.string(), title: z.string().optional(), summary: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "section" }, { write: true });
    return json(await renameSection(args, sub));
  }));

  server.registerTool("mem_delete_section", {
    description: "Supprime une section VIDE (ni documents, ni sous-sections). Sinon, déplacer/fusionner d'abord.",
    inputSchema: { id: z.string(), reason: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "section" }, { write: true });
    return json(await deleteSection(args, sub));
  }));

  server.registerTool("mem_reorder", {
    description: "Réordonne les enfants d'un parent : `orderedChildIds` = tous des sections (même parent) OU tous des documents (même section).",
    inputSchema: { parentId: z.string().optional(), orderedChildIds: z.array(z.string()).max(MAX_BATCH) },
  }, guarded(async (args) => {
    // L'autorisation est faite DANS reorder, liée aux entités réelles (sections/docs résolus),
    // pas à un anchor fourni par le caller — sinon bypass cross-workspace (cf. revue sécu).
    return json(await reorder(args, sub));
  }));

  server.registerTool("mem_move_documents", {
    description: "Déplace des documents vers une section cible (dédup des slugs). `dryRun:true` pour prévisualiser sans muter.",
    inputSchema: { documentIds: z.array(z.string()).max(MAX_BATCH), targetSectionId: z.string(), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.targetSectionId, kind: "section" }, { write: true });
    return json(await moveDocuments(args, sub));
  }));

  server.registerTool("mem_split_section", {
    description: "Scinde une section : crée une nouvelle section sœur et y déplace `documentIdsToMove`. `dryRun:true` pour prévisualiser.",
    inputSchema: { id: z.string(), newSectionTitle: z.string(), documentIdsToMove: z.array(z.string()).max(MAX_BATCH), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "section" }, { write: true });
    return json(await splitSection(args, sub));
  }));

  server.registerTool("mem_merge_sections", {
    description: "Fusionne des sections (sans sous-sections) dans une cible : déplace leurs documents puis supprime les sources. `dryRun:true` pour prévisualiser.",
    inputSchema: { sourceIds: z.array(z.string()).max(MAX_BATCH), targetId: z.string(), dryRun: z.boolean().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.targetId, kind: "section" }, { write: true });
    return json(await mergeSections(args, sub));
  }));

  server.registerTool("mem_revisions", {
    description:
      "Journal des mutations curées d'un workspace (op, motif, acteur, avant/après), du plus récent au plus ancien. Filtres : `targetType` (block|document|section), `targetId`, `since` (« qu'est-ce qui a changé depuis ma dernière session ? »), `limit`. `total`/`hasMore` = vrai compte de correspondants.",
    inputSchema: {
      workspace: z.string().optional(),
      targetType: z.string().optional(),
      targetId: z.string().optional(),
      since: z.string().optional().describe("ISO 8601 — ne renvoie que les révisions postérieures"),
      limit: z.number().int().positive().optional(),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await listRevisions({ ...rest, workspace: ws })) });
  }));

  // ── Boucle propose-valide (Lot 5) ───────────────────────────────────────────
  server.registerTool("mem_stage_changes", {
    description:
      "Propose un change-set (ne mute RIEN) → crée un MemIngestion PROPOSED, revu par un humain avant application. " +
      "La réponse échoue `url` = LE lien de revue (Boucle) à donner à l'humain — ne jamais fabriquer d'URL soi-même. " +
      "`changes[]` = [{op, payload, class?, target?, rationale?}]. " +
      "op ∈ add_document|add_block|update_block|set_block_type|delete_block|attach_source|detach_source|verify_block|move_block|link_blocks|deprecate_document. " +
      "`payload` = les arguments du verbe correspondant. class ∈ CONFIRM|ENRICH|CONTRADICT|OBSOLETE (CONTRADICT n'est jamais auto-appliqué). " +
      "`clientKey` (recommandé) = clé d'idempotence ET de révision : si une ingestion ouverte (PROPOSED/PARTIAL/CHANGES_REQUESTED) " +
      "porte déjà ce clientKey, ton nouvel appel REMPLACE son change-set et la rouvre en PROPOSED (`superseded: true`) — c'est ainsi qu'on répond à un renvoi : " +
      "relis le feedback via mem_ingestion_get, puis re-stage avec le MÊME clientKey. Une ingestion clôturée (APPLIED/REJECTED) reste un no-op (`deduplicated: true`). " +
      "La réponse signale les blocs quasi identiques déjà en base pour chaque add_block proposé (`similarExisting`) — préfère CONFIRM/verify sur l'existant à un doublon.",
    inputSchema: {
      workspace: z.string().optional(),
      title: z.string(),
      summary: z.string().optional(),
      sourceId: z.string().optional(),
      clientKey: z.string().optional().describe("clé d'idempotence (unique par workspace) — fournis-la pour des retries sûrs"),
      changes: z.array(z.object({
        op: z.string(),
        payload: z.record(z.string(), z.any()).optional(),
        class: z.enum(["CONFIRM", "ENRICH", "CONTRADICT", "OBSOLETE"]).optional(),
        target: z.string().optional(),
        rationale: z.string().optional(),
      })).max(MAX_BATCH),
    },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws }, { write: true });
    return json({ workspace: ws, org, ...(await stageChanges({ ...rest, workspace: ws }, sub)) });
  }));

  server.registerTool("mem_ingestion_list", {
    description: "Liste les ingestions d'une KB (compteurs par classe + état). Filtre `status` (PROPOSED|APPLIED|REJECTED|PARTIAL|CHANGES_REQUESTED). " +
      "status=CHANGES_REQUESTED → les ingestions qu'un humain t'a renvoyées pour révision : relis-les (mem_ingestion_get), traite le feedback, re-stage avec le même clientKey. `workspace` optionnel = KB par défaut.",
    inputSchema: { workspace: z.string().optional(), status: z.string().optional() },
  }, guarded(async (args) => {
    const { workspace: _w, ...rest } = args;
    const { workspace: ws, org } = await wsContext(sub, args.workspace);
    await assertAccess(sub, { workspace: ws });
    return json({ workspace: ws, org, ...(await listIngestions({ ...rest, workspace: ws })) });
  }));

  server.registerTool("mem_ingestion_get", {
    description: "Revue d'une ingestion : le diff classé op par op, avec l'état (applied/error) de chacune. " +
      "Si elle t'a été renvoyée (status CHANGES_REQUESTED), lis `reviewNote` (note globale) et `changes[].feedback[]` (retours par changement) : c'est ce qu'il faut corriger avant de re-stage avec le même clientKey.",
    inputSchema: { id: z.string() },
  }, guarded(async ({ id }) => {
    await assertAccess(sub, { id, kind: "ingestion" });
    return json(await getIngestion(id));
  }));

  server.registerTool("mem_apply_ingestion", {
    description:
      "Applique une ingestion PROPOSED/PARTIAL, transactionnellement par op (une MemRevision par op, liée à l'ingestion). " +
      "Sans `acceptIds`, applique tout SAUF les ops CONTRADICT (tenues en attente). Avec `acceptIds`, n'applique que ce sous-ensemble (→ APPLIED si tout passe, sinon PARTIAL).",
    inputSchema: { id: z.string(), acceptIds: z.array(z.string()).optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "ingestion" }, { write: true });
    return json(await applyIngestion(args, sub));
  }));

  server.registerTool("mem_reject_ingestion", {
    description: "Rejette une ingestion (→ REJECTED). `reason` recommandé.",
    inputSchema: { id: z.string(), reason: z.string().optional() },
  }, guarded(async (args) => {
    await assertAccess(sub, { id: args.id, kind: "ingestion" }, { write: true });
    return json(await rejectIngestion(args, sub));
  }));

  // ── Log d'usage (feedback produit) — ouvert à TOUT user authentifié ─────────
  server.registerTool("mem_log_usage", {
    description:
      "QUASI OBLIGATOIRE — signale un problème rencontré avec Memento lui-même, dès qu'il survient : " +
      "erreur inattendue, recherche qui rate un contenu qui devrait exister, verbe/capacité manquant, " +
      "paramètre ambigu, description/doc trompeuse, friction de workflow. " +
      "kind ∈ bug (erreur/comportement cassé) | unexpected (résultat surprenant) | missing (capacité absente) | " +
      "friction (faisable mais pénible) | docs (description trompeuse) | other. " +
      "Une ligne suffit (`summary`) ; mets le contexte utile dans `detail` (args de l'appel, message d'erreur, attendu vs obtenu). " +
      "N'écrit RIEN dans la KB, ne demande aucun rôle, n'échoue jamais sur le contexte — logge puis continue ton travail.",
    inputSchema: {
      kind: z.enum(USAGE_KINDS),
      summary: textStr.describe("le problème en une phrase"),
      detail: textStr.optional().describe("contexte : args de l'appel, erreur exacte, attendu vs obtenu"),
      verb: z.string().optional().describe("verbe mem_* concerné, ex: mem_search"),
      workspace: z.string().optional().describe("slug de la KB concernée si pertinent (texte libre, jamais bloquant)"),
    },
  }, guarded(async (args) => json(await logUsage(args, sub))));

  server.registerTool("mem_usage_logs", {
    description:
      "Lit le log d'usage (signalements mem_log_usage), du plus récent au plus ancien. " +
      "Sans `workspace` : tes propres signalements. Avec `workspace` : tous ceux de la KB (réservé admin/curator). " +
      "Filtres : `verb`, `kind`. Pour dépouiller le feedback et prioriser les améliorations de l'outil.",
    inputSchema: {
      workspace: z.string().optional(),
      verb: z.string().optional(),
      kind: z.enum(USAGE_KINDS).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, guarded(async (args) => json(await listUsageLogs(args, sub))));

  return server;
}

// Catalogue fédéré (service-à-service) : la LISTE des outils memento — manifeste
// product-level, identique pour tous — servie à un pair de confiance (oto) via un
// secret partagé, SANS OAuth user. Permet à oto de monter ses outils fédérés au
// boot sans dépendre d'un token OAuth personnel révocable (otomata#16). On extrait
// le manifeste via un transport in-memory : c'est exactement la sortie `tools/list`
// du SDK (conversion zod → JSON Schema incluse), sans contexte user (sub vide : on
// ne liste que les schémas, aucun handler n'est invoqué).
async function federationCatalog(): Promise<Response> {
  // Imports DYNAMIQUES : isolent ce chemin du chargement du module — si le SDK
  // résolvait mal ces specifiers, seul /federation/catalog échouerait, jamais le
  // serveur MCP principal (les 52 outils restent servis).
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer("");
  const client = new Client({ name: "federation-catalog", version: "1.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const { tools } = await client.listTools();
    return new Response(JSON.stringify({ tools }), {
      headers: { "content-type": "application/json" },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8000) }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/health")) return new Response("ok");

  // Découverte OAuth, servie SANS auth (RFC 9728 / 8414).
  const disc = isDiscoveryPath(url.pathname);
  if (disc === "prm") {
    return new Response(JSON.stringify(protectedResourceMetadata()), {
      headers: { "content-type": "application/json" },
    });
  }
  if (disc === "as") return authServerMetadata();

  // Catalogue fédéré : authentifié par le SECRET DE SERVICE partagé avec oto
  // (MEMENTO_FEDERATION_SECRET), pas par l'OAuth user. Avant authenticate().
  if (url.pathname.endsWith("/federation/catalog")) {
    const secret = Deno.env.get("MEMENTO_FEDERATION_SECRET");
    const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!secret || !got || got !== secret) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }
    return await federationCatalog();
  }

  const auth = await authenticate(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.message }), {
      status: auth.status,
      headers: { "content-type": "application/json", "www-authenticate": wwwAuthenticate() },
    });
  }

  if (url.pathname.endsWith("/mcp") || url.pathname === "/") {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await buildServer(auth.claims.sub ?? "").connect(transport);
    return transport.handleRequest(req);
  }
  return new Response("not found", { status: 404 });
});
