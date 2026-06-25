/**
 * Memento V3 — FACE REST (ADR 0009 « deux faces ») des verbes v3.
 *
 * Expose en JSON HTTP les MÊMES handlers `v3*` que la surface MCP (`mcp/v3.ts`),
 * sans dupliquer la moindre logique métier ni la moindre garde d'accès : ce module
 * n'est qu'un adaptateur de transport (parse requête → handler → JSON).
 *
 * Consommée par le client front figé `app/src/api.v3.ts` (mêmes chemins, mêmes
 * formes de retour). Caddy proxifie `/api/v3/*` → `functions/v1/api-v3/v3/*`
 * (same-origin) ; le verbe = DERNIER segment du pathname, robuste au préfixe.
 *
 * Auth : `authenticate(req)` (Bearer du token Supabase, resource-server RFC 9728),
 * réutilisé tel quel depuis `_shared/auth.ts`.
 */
import { authenticate } from "../_shared/auth.ts";
import { AccessError, safeErrorMessage } from "../_shared/access.v3.ts";
import {
  v3Apply, v3Bases, v3Count, v3Digest, v3Get, v3List, v3Load,
  v3ProposeChanges, v3ReviewIngestion, v3Search, v3Share,
} from "../mcp/v3.ts";

const CORS = { "access-control-allow-origin": "*" } as const;

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      },
    });
  }

  if (url.pathname.endsWith("/health")) return new Response("ok", { headers: CORS });

  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ error: auth.message }, auth.status);
  const sub = auth.claims.sub ?? "";

  // Verbe = dernier segment, robuste au préfixe Caddy (/functions/v1/api-v3/v3/<verbe>).
  const verb = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const q = url.searchParams;

  try {
    let result: unknown;
    if (req.method === "GET") {
      switch (verb) {
        case "bases":
          result = await v3Bases(sub);
          break;
        case "load":
          result = await v3Load(sub, {
            base: q.get("base") ?? undefined,
            depth: q.get("depth") ? Number(q.get("depth")) : undefined,
          });
          break;
        case "search": {
          const base = q.get("base") ?? undefined;
          const limit = q.get("limit");
          result = await v3Search(sub, {
            q: q.get("q") ?? "",
            scope: (q.get("scope") as "savoir" | "sources" | "both" | null) ?? undefined,
            limit: limit ? Number(limit) : undefined,
            filters: base ? { base } : undefined,
          });
          break;
        }
        case "get": {
          const include = q.get("include");
          result = await v3Get(sub, {
            id: q.get("id") ?? "",
            kind: (q.get("kind") as "page" | "entity") ?? "page",
            include: include ? String(include).split(",") : undefined,
          });
          break;
        }
        case "list": {
          const filters = q.get("filters");
          const limit = q.get("limit");
          result = await v3List(sub, {
            // deno-lint-ignore no-explicit-any
            kind: (q.get("kind") ?? "pages") as any,
            base: q.get("base") ?? undefined,
            filters: filters ? JSON.parse(filters) : undefined,
            limit: limit ? Number(limit) : undefined,
          });
          break;
        }
        case "count": {
          const filters = q.get("filters");
          result = await v3Count(sub, {
            // deno-lint-ignore no-explicit-any
            kind: (q.get("kind") ?? "pages") as any,
            base: q.get("base") ?? undefined,
            filters: filters ? JSON.parse(filters) : undefined,
          });
          break;
        }
        case "digest": {
          const sinceDays = q.get("sinceDays");
          result = await v3Digest(sub, {
            base: q.get("base") ?? undefined,
            sinceDays: sinceDays ? Number(sinceDays) : undefined,
          });
          break;
        }
        default:
          return jsonResponse({ error: `unknown verb: ${verb}` }, 404);
      }
    } else if (req.method === "POST") {
      const body = await req.json();
      switch (verb) {
        case "propose":
          result = await v3ProposeChanges(sub, body);
          break;
        case "apply":
          result = await v3Apply(sub, body);
          break;
        case "review":
          result = await v3ReviewIngestion(sub, body);
          break;
        case "share":
          result = await v3Share(sub, body);
          break;
        default:
          return jsonResponse({ error: `unknown verb: ${verb}` }, 404);
      }
    } else {
      return jsonResponse({ error: "method not allowed" }, 405);
    }
    return jsonResponse(result);
  } catch (e) {
    if (e instanceof AccessError) return jsonResponse({ error: e.message }, 403);
    console.error("[api-v3] verb failed:", verb, e);
    return jsonResponse({ error: safeErrorMessage(e) }, 500);
  }
});
