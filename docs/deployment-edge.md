# Topologie edge (prod)

La prod est hébergée sur **Cloudflare Pages** (projet `memento-viewer`, branche de
production `main`) + **Supabase Edge Functions**. Aucun serveur applicatif : le viewer
est une SPA statique, les fonctions edge portent la logique.

## Domaines

| Domaine | Rôle |
|---|---|
| `mento.cc` / `www.mento.cc` | Showcase (landing marketing : `/`, `/plugin`) |
| `me.mento.cc` | App (viewer page-centré + login + OAuth) — canonique |
| `mcp.mento.cc` | Endpoint MCP (connecteur, pas de SPA humaine) |

`me.mento.cc` et `mcp.mento.cc` sont servis par le **même** projet CF Pages ; c'est le
routage (chemin) qui distingue app et MCP.

## Reverse-proxy = CF Pages Functions (`app/functions/`)

Les Pages Functions répliquent le reverse-proxy Caddy historique (retiré). Elles
`fetch()` la fonction Supabase cible ; l'URL Supabase vient de `ctx.env.SUPABASE_URL`
(jamais codée en dur). Helper commun : `app/functions/_proxy.ts` (`proxyTo`).

| Chemin entrant | Cible Supabase | Fichier |
|---|---|---|
| `/mcp` | `/functions/v1/mcp/mcp` (query droppée) | `app/functions/mcp.ts` |
| `/.well-known/*` | `/functions/v1/mcp{pathname}` (discovery OAuth) | `app/functions/.well-known/[[path]].ts` |
| `/api/*` | `/functions/v1/api{pathname sans /api}` (miroir REST du viewer) | `app/functions/api/[[path]].ts` |
| `/agent/*` | `/functions/v1{pathname}` (chat SSE) | `app/functions/agent/[[path]].ts` |
| `/ingest/*` | PostHog EU (analytics, contourne les ad-blockers) | `app/functions/ingest/[[path]].ts` |

> **Renommer une fonction Supabase** (ex. l'ancien `mcp-v3` → `mcp` au cutover main)
> n'impacte **pas** l'URL publique : seule la cible de proxy ci-dessus change. La
> métadonnée OAuth (`resource`, `www-authenticate`) dérive de l'env `MEMENTO_PUBLIC_URL`,
> pas du slug de fonction. Déployer en 2 temps (fonction d'abord, proxy ensuite) pour ne
> jamais exposer une fenêtre où le proxy pointe vers un slug pas encore déployé.

## Fonctions Supabase

- **`mcp`** — surface MCP (transport `mcp/v3_server.ts` + logique `mcp/v3.ts`). Auth OAuth
  (resource-server RFC 9728). Déployée `--no-verify-jwt` (l'auth est faite dans le code).
- **`api`** — face REST du viewer (miroir des verbes MCP, ADR 0009). Lecture publique
  anonyme tolérée sur les GET (scope public seul, `sub=""`).

DB : schéma `memento_v3` du projet Supabase de prod (search_path posé dans
`_shared/db.v3.ts`). Migrations `supabase/migrations/` appliquées à la main (cf.
[`deploy.md`](deploy.md)).

## Déploiement

Push sur `main`, déclenchement par path (cf. `CLAUDE.md` § CI) : `app/**`→CF Pages,
`supabase/functions/**`→`api`+`mcp`, `ner/**`→box NER. Tous gated `repository_owner`.
