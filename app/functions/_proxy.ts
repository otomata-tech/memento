// Proxy commun des Pages Functions vers les Edge Functions Supabase.
// Réplique le reverse-proxy Caddy retiré (cf. docs/deployment-edge.md) :
//   /mcp*           → /functions/v1/mcp           (SSE, query droppée comme Caddy)
//   /.well-known/*  → /functions/v1/mcp{pathname} (discovery OAuth)
//   /api/*          → /functions/v1{pathname}     (miroir REST du viewer)
// Le Host doit valoir l'hôte Supabase (sinon le gateway ne route pas la function) ;
// on retire le Host entrant et fetch() le redérive de l'URL cible. Le corps et la
// réponse sont streamés tels quels — équivaut au flush_interval -1 de Caddy (SSE).
//
// `supabase` = URL du projet Supabase (https://<ref>.supabase.co), fournie par
// l'env du projet Pages (`ctx.env.SUPABASE_URL`) — jamais codée en dur (fork-friendly).

export function proxyTo(supabase: string, targetPath: string, request: Request, keepSearch: boolean): Promise<Response> {
  if (!supabase) throw new Error("SUPABASE_URL absente de l'env du projet Pages");
  const url = new URL(request.url);
  const target = supabase + targetPath + (keepSearch ? url.search : "");

  const headers = new Headers(request.headers);
  headers.delete("host"); // redérivé de target par le runtime

  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half"; // requis pour streamer un body de requête
  }

  return fetch(target, init).then((resp) => new Response(resp.body, resp));
}
