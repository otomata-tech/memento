/**
 * Test fonctionnel de la recherche v3 page-chunkée (#57) contre une base v3 réelle.
 *
 * Couvre : récup lexicale (FTS pages) + sémantique CONTRÔLÉE (chunk = vecteur de la
 * requête), fusion RRF, exclusion des pages privées (filtre d'accès) et `deprecated`,
 * entités attachées au hit, scope `sources` (FTS verbatim via la page), `filters.page`
 * (restriction au sous-arbre). Renvoie bien le type `SearchHit` du contrat.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno test --allow-env --allow-net --config supabase/functions/deno.json \
 *       supabase/functions/_shared/search.v3.test.ts
 * Sans DATABASE_URL → skip.
 */
import postgres from "postgres";
import { type EmbedTexts, search } from "./search.v3.ts";

const DB = Deno.env.get("DATABASE_URL");
const DIM = 1024;

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(`assertion failed: ${m}`); }
const vecLit = (v: number[]) => `[${v.join(",")}]`;
function unit(seed: number): number[] {
  // vecteur déterministe non nul (pas de Math.random → reproductible)
  const v = new Array<number>(DIM);
  let n = 0;
  for (let i = 0; i < DIM; i++) { v[i] = Math.sin(seed * 13.7 + i * 0.91); n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
const QVEC = unit(42); // vecteur « de requête » fixe
const embedFixed: EmbedTexts = (texts) => Promise.resolve(texts.map(() => QVEC));
const embedNull: EmbedTexts = () => Promise.resolve(null);

Deno.test({
  name: "search v3 — fonctionnel (RRF, accès, sources, entités, sous-arbre)",
  ignore: !DB,
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const sql = postgres(DB!, { prepare: false });
  const tag = `stest-${crypto.randomUUID().slice(0, 8)}`;
  const ctx = { sub: "tester" };
  try {
    // Org A : `tester` en est MEMBRE → ses pages org/public sont énumérables.
    const [org] = await sql`insert into mem_orgs (slug, name) values (${tag}, ${tag}) returning id`;
    const [base] = await sql`insert into mem_bases (org_id, name) values (${org.id}, ${tag}) returning id`;
    await sql`insert into mem_memberships (org_id, user_id, role) values (${org.id}, ${ctx.sub}, 'member')`;

    const mkPageIn = async (baseId: string, title: string, body: string, vis: string, status = "active", parent: string | null = null) => {
      const [p] = await sql`
        insert into mem_pages (base_id, parent_id, title, description, body, visibility, status)
        values (${baseId}, ${parent}, ${title}, ${`à propos de ${title}`}, ${body}, ${vis}::mem_page_visibility, ${status}::mem_page_status)
        returning id`;
      return p.id as string;
    };
    const mkPage = (title: string, body: string, vis: string, status = "active", parent: string | null = null) =>
      mkPageIn(base.id, title, body, vis, status, parent);
    const mkChunk = (pageId: string, content: string, vec: number[]) =>
      sql`insert into mem_page_chunks (page_id, idx, content, model_version, embedding)
          values (${pageId}, 0, ${content}, 'test', ${vecLit(vec)}::halfvec)`;

    // Org A : page org pertinente (FTS + sémantique alignée), privée (exclue), deprecated
    // (exclue), org hors-sujet.
    const pubId = await mkPage("Migration pgvector", "on a retenu pgvector pour la recherche sémantique des pages", "org");
    await mkChunk(pubId, "pgvector recherche sémantique", QVEC); // chunk = vecteur requête → top kNN
    const privId = await mkPage("Secret pgvector", "pgvector recherche sémantique confidentielle", "private");
    await mkChunk(privId, "pgvector secret", QVEC);
    const depId = await mkPage("Vieux pgvector", "ancienne note pgvector recherche", "org", "deprecated");
    await mkChunk(depId, "obsolète", unit(7));
    const offId = await mkPage("Sujet sans rapport", "recette de cuisine au beurre", "org");
    await mkChunk(offId, "cuisine", unit(9));

    // Org B : `tester` n'en est PAS membre. Sa page est PUBLIC (lisible par lien) mais ne
    // doit JAMAIS être ÉNUMÉRÉE par la recherche d'un non-membre — le cœur du fix.
    const [orgB] = await sql`insert into mem_orgs (slug, name) values (${`${tag}-b`}, ${`${tag}-b`}) returning id`;
    const [baseB] = await sql`insert into mem_bases (org_id, name) values (${orgB.id}, ${`${tag}-b`}) returning id`;
    const otherPubId = await mkPageIn(baseB.id, "Public autre org", "pgvector recherche sémantique chez un tiers", "public");
    await mkChunk(otherPubId, "pgvector recherche sémantique", QVEC); // même vecteur requête → cosinus parfait

    // Entité mentionnée sur la page publique.
    const [ent] = await sql`
      insert into mem_entities (org_id, type, canonical_label, normalised_label, is_stub)
      values (${org.id}, 'outil', 'pgvector', 'pgvector', false) returning id`;
    await sql`insert into mem_mentions (page_id, entity_id, confidence) values (${pubId}, ${ent.id}, 0.9)`;

    // Source attachée à la page publique (pour scope 'sources').
    const [srcRow] = await sql`
      insert into mem_sources (base_id, kind, title, content)
      values (${base.id}, 'texte', 'Doc pgvector', 'extrait verbatim mentionnant pgvector et HNSW') returning id`;
    await sql`insert into mem_page_sources (page_id, source_id) values (${pubId}, ${srcRow.id})`;

    // ── 1. savoir lexical-only (embed null) : trouve la page publique, exclut privé/deprecated ──
    {
      const hits = await search(ctx, { q: "pgvector recherche", limit: 10 }, { embedTexts: embedNull });
      const ids = hits.map((h) => h.pageId);
      assert(ids.includes(pubId), "page de l'org du membre trouvée (lexical)");
      assert(!ids.includes(privId), "page privée EXCLUE (accès)");
      assert(!ids.includes(depId), "page deprecated EXCLUE");
      assert(!ids.includes(otherPubId), "page PUBLIC d'une AUTRE org NON listée (énumération ≠ lecture-par-lien)");
      const pub = hits.find((h) => h.pageId === pubId)!;
      assert(pub.matchedBy.includes("lexical") && !pub.matchedBy.includes("semantic"), "lexical-only");
      assert(pub.passage.includes("«"), "passage = headline FTS");
      assert(pub.entities.some((e) => e.label === "pgvector" && e.type === "outil"), "entité attachée au hit");
      assert(typeof pub.title === "string" && typeof pub.description === "string", "title+description renvoyés");
    }

    // ── 2. savoir hybride : le régime sémantique contribue (chunk = vecteur requête) ──
    {
      const hits = await search(ctx, { q: "pgvector recherche", limit: 10 }, { embedTexts: embedFixed });
      const pub = hits.find((h) => h.pageId === pubId)!;
      assert(pub, "page publique trouvée (hybride)");
      assert(pub.matchedBy.includes("semantic"), "le régime sémantique a matché");
      assert(!hits.some((h) => h.pageId === privId), "privé toujours exclu en sémantique (pas de fuite HNSW)");
      // cosinus parfait (même vecteur) MAIS autre org → exclu : l'énumération prime sur la proximité.
      assert(!hits.some((h) => h.pageId === otherPubId), "public autre-org exclu même à cosinus parfait");
    }

    // ── 3. scope 'sources' : FTS verbatim de la source, remontée via sa page ──
    {
      const hits = await search(ctx, { q: "HNSW verbatim", scope: "sources", limit: 10 }, { embedTexts: embedNull });
      assert(hits.some((h) => h.pageId === pubId), "source remonte via sa page");
      const pub = hits.find((h) => h.pageId === pubId)!;
      assert(pub.passage.toLowerCase().includes("hnsw"), "passage = extrait verbatim de la source");
    }

    // ── 4. filters.page : restriction au sous-arbre ──
    {
      const childId = await mkPage("Enfant pgvector", "détail pgvector recherche dans l'enfant", "public", "active", pubId);
      await mkChunk(childId, "détail", unit(11));
      const inSub = await search(ctx, { q: "pgvector recherche", filters: { page: pubId }, limit: 10 }, { embedTexts: embedNull });
      const ids = inSub.map((h) => h.pageId);
      assert(ids.includes(pubId) && ids.includes(childId), "page racine + enfant dans le sous-arbre");
      assert(!ids.includes(offId), "page hors sous-arbre exclue");
    }
  } finally {
    await sql`delete from mem_bases where name=${tag}`;
    await sql`delete from mem_orgs where slug=${tag}`;
    await sql.end();
  }
});
