/**
 * Migration de données v2 (bloc-centré) → v3 (page-centré) — #58, CDC §14.
 * Cross-DB : lit V2_DATABASE_URL, écrit V3_DATABASE_URL. Idempotent par client_key.
 * Dry-run sur le harness ; jamais la prod en direct.
 *
 * Mapping : org→base (1/org) · workspace→page racine · section→page (arbre) ·
 * document→page (body = blocs concaténés, type→markdown) · SUPERSEDES→note prose
 * sur la page cible · sources→mem_sources+page_sources · descriptions = summary v2.
 * Mentions (entités NER) = backfill séparé post-migration (déféré).
 */
import postgres from "postgres";

const v2 = postgres(Deno.env.get("V2_DATABASE_URL")!, { prepare: false });
const v3 = postgres(Deno.env.get("V3_DATABASE_URL")!, { prepare: false });

const render = (type: string, content: string): string => {
  switch (type) {
    case "REGLE": return `**Règle.** ${content}`;
    case "PRINCIPE": return `**Principe.** ${content}`;
    case "PROCEDURE": return `**Procédure.** ${content}`;
    case "MISE_EN_GARDE": return `> ⚠️ ${content}`;
    case "DEFINITION": return `**Définition.** ${content}`;
    case "EXEMPLE": return `*Exemple :* ${content}`;
    case "QUESTION": return `**Question ouverte.** ${content}`;
    default: return content; // PROSE, etc.
  }
};
const vis = (v: string) => (["org", "private", "public"].includes(v) ? v : "org");

async function run() {
  // 0. Orgs + memberships (les bases v3 référencent mem_orgs)
  for (const o of await v2`select id, slug, name, personal_for from mem_orgs`) {
    await v3`insert into mem_orgs (id, slug, name, personal_for) values (${o.id},${o.slug},${o.name},${o.personal_for})
             on conflict (id) do nothing`;
  }
  for (const m of await v2`select org_id, user_id, role from mem_memberships`) {
    await v3`insert into mem_memberships (org_id, user_id, role) values (${m.org_id},${m.user_id},${m.role})
             on conflict do nothing`;
  }

  // 1. org → base (1/org)
  const baseByOrg = new Map<string, string>();
  for (const o of await v2`select id, name from mem_orgs`) {
    const [b] = await v3`insert into mem_bases (org_id, name) values (${o.id}, ${o.name})
                         on conflict (org_id) do update set name = excluded.name returning id`;
    baseByOrg.set(o.id, b.id);
  }

  const pageBySection = new Map<string, string>();
  const pageByWorkspace = new Map<string, string>();
  const pageByDocument = new Map<string, string>();
  const docOfBlock = new Map<string, string>(); // block_id → document_id

  // 2. workspace → page racine (sous la base de son org)
  for (const w of await v2`select id, name, summary, org_id, visibility from mem_workspaces where archived_at is null`) {
    const baseId = baseByOrg.get(w.org_id)!;
    const [p] = await v3`insert into mem_pages (base_id, parent_id, title, description, body, visibility, depth, client_key)
      values (${baseId}, null, ${w.name}, ${w.summary ?? ""}, '', ${vis(w.visibility)}, 0, ${"ws:" + w.id})
      on conflict (base_id, client_key) do update set title = excluded.title returning id`;
    pageByWorkspace.set(w.id, p.id);
  }

  // 3. section → page (arbre, par profondeur croissante)
  const sections = await v2`select id, workspace_id, parent_id, title, summary, position, depth
                            from mem_sections order by depth asc, position asc`;
  for (const s of sections) {
    const baseId = baseByOrg.get((await v2`select org_id from mem_workspaces where id = ${s.workspace_id}`)[0].org_id)!;
    const parent = s.parent_id ? pageBySection.get(s.parent_id)! : pageByWorkspace.get(s.workspace_id)!;
    const [p] = await v3`insert into mem_pages (base_id, parent_id, title, description, body, visibility, position, depth, client_key)
      values (${baseId}, ${parent}, ${s.title}, ${s.summary ?? ""}, '', 'org', ${s.position}, ${s.depth + 1}, ${"sec:" + s.id})
      on conflict (base_id, client_key) do update set title = excluded.title returning id`;
    pageBySection.set(s.id, p.id);
  }

  // 4. document → page (body = blocs concaténés, type→markdown)
  for (const d of await v2`select d.id, d.section_id, d.title, d.summary, d.status, d.position, s.workspace_id
                           from mem_documents d join mem_sections s on s.id = d.section_id`) {
    const baseId = baseByOrg.get((await v2`select org_id from mem_workspaces where id = ${d.workspace_id}`)[0].org_id)!;
    const parent = pageBySection.get(d.section_id)!;
    const blocks = await v2`select id, type, content from mem_blocks where document_id = ${d.id} order by position asc`;
    for (const b of blocks) docOfBlock.set(b.id, d.id);
    const body = blocks.map((b) => render(b.type, b.content)).join("\n\n");
    const status = d.status === "DEPRECATED" ? "deprecated" : "active";
    const [p] = await v3`insert into mem_pages (base_id, parent_id, title, description, body, visibility, position, depth, status, client_key)
      values (${baseId}, ${parent}, ${d.title}, ${d.summary ?? ""}, ${body}, 'org', ${d.position},
              ${(await v2`select depth from mem_sections where id = ${d.section_id}`)[0].depth + 2}, ${status}, ${"doc:" + d.id})
      on conflict (base_id, client_key) do update set body = excluded.body returning id`;
    pageByDocument.set(d.id, p.id);
  }

  // 5. SUPERSEDES → note prose sur la page cible (granularité bloc perdue : décision à valider)
  let supersedes = 0;
  for (const l of await v2`select from_block_id, to_block_id, note, relation from mem_links where relation = 'SUPERSEDES'`) {
    const targetDoc = docOfBlock.get(l.to_block_id);
    const fromDoc = docOfBlock.get(l.from_block_id);
    if (!targetDoc) continue;
    const targetPage = pageByDocument.get(targetDoc)!;
    const fromTitle = fromDoc ? (await v2`select title from mem_documents where id = ${fromDoc}`)[0]?.title : "ailleurs";
    const note = `\n\n> ⚠️ **Élément remplacé** (${l.note ?? ""}) — voir « ${fromTitle} ».`;
    await v3`update mem_pages set body = body || ${note} where id = ${targetPage}`;
    supersedes++;
  }

  // 6. sources → mem_sources (base-scoped) + page_sources
  const srcKind = (k: string) => (k === "URL" ? "url" : k === "FILE" ? "file" : "texte");
  const v3SourceByV2 = new Map<string, string>();
  for (const bs of await v2`select bs.block_id, bs.source_id, bs.locator, s.kind, s.title, s.ref, s.citation
                            from mem_block_sources bs join mem_sources s on s.id = bs.source_id`) {
    const doc = docOfBlock.get(bs.block_id);
    if (!doc) continue;
    const page = pageByDocument.get(doc)!;
    const baseId = (await v3`select base_id from mem_pages where id = ${page}`)[0].base_id;
    let sid = v3SourceByV2.get(bs.source_id);
    if (!sid) {
      const kind = srcKind(bs.kind);
      const [s] = await v3`insert into mem_sources (base_id, kind, title, uri, citation)
        values (${baseId}, ${kind}, ${bs.title}, ${kind === "url" ? bs.ref : null}, ${bs.citation}) returning id`;
      sid = s.id; v3SourceByV2.set(bs.source_id, sid);
    }
    await v3`insert into mem_page_sources (page_id, source_id, locator) values (${page}, ${sid}, ${bs.locator})
             on conflict do nothing`;
  }

  return {
    bases: baseByOrg.size, workspaces: pageByWorkspace.size, sections: pageBySection.size,
    documents: pageByDocument.size, supersedes, sources: v3SourceByV2.size,
  };
}

const stats = await run();
console.log("Migration OK:", JSON.stringify(stats));
await v2.end(); await v3.end();
