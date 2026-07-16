-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Memento V3 — schéma page-centré (issue #53)                                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Rend RÉEL le contrat figé `server/src/schema.v3.ts` + les colonnes/fonctions
-- HORS Drizzle notées dans son en-tête. ADR 0001 (page-centré) / 0002 (entités
-- 2 familles) / 0003 (1 base par org, accès par page).
--
-- Le bloc « tables / contraintes / index » plus bas est le DDL CANONIQUE émis par
-- `drizzle-kit generate` depuis schema.v3.ts (noms de contraintes inclus) → zéro
-- drift drizzle-kit. Lignée SÉPARÉE de `server/drizzle/*` (v2) : self-contained,
-- produit une base v3 complète sur un `supabase db reset` neuf, v2 intacte.
--
-- DIMENSION D'EMBEDDING = 1024 (Mistral embed, hébergé, FR). Figée dans
-- halfvec(1024) (mem_page_chunks.embedding ET mem_entities.name_embedding).
-- Changer de dim plus tard = ALTER de colonne + ré-embarquement complet.
--
-- COLONNES HORS DRIZZLE (à exclure du diff drizzle-kit — c'est le SEUL drift attendu) :
--   mem_pages.body_fts          tsvector généré (french_unaccent) + GIN
--   mem_sources.fts             tsvector généré (french_unaccent) + GIN
--   mem_page_chunks.embedding   halfvec(1024) + index HNSW partiel
--   mem_entities.name_embedding halfvec(1024)
--   + index GIN trigram sur mem_entities.normalised_label, GIN sur aliases.

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- digest() sha256 (content_hash)
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- gin_trgm_ops (résolution floue d'entités)
CREATE EXTENSION IF NOT EXISTS vector;     -- halfvec + HNSW (recherche sémantique)
CREATE EXTENSION IF NOT EXISTS unaccent;   -- normalise_name + config FTS accent-insensible

-- ── Config FTS française accent-insensible (reprise de la v2, migration 0001) ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'french_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION french_unaccent ( COPY = french );
    ALTER TEXT SEARCH CONFIGURATION french_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, french_stem;
  END IF;
END $$;

-- ── Fonctions SQL ─────────────────────────────────────────────────────────────
-- normalise_name : LA clé de résolution d'entités (source unique). lower + unaccent
-- + ponctuation→espace + espaces collapsés + trim. IMMUTABLE (exigé par l'unique
-- index exact-match). unaccent() est STABLE → on l'appelle avec le dictionnaire
-- EXPLICITE pour qu'elle soit traitée IMMUTABLE.
CREATE OR REPLACE FUNCTION normalise_name(input text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT AS $$
  SELECT btrim(
    regexp_replace(
      regexp_replace(lower(unaccent('unaccent'::regdictionary, input)), '[^a-z0-9]+', ' ', 'g'),
      '\s+', ' ', 'g')
  )
$$;

-- content_hash : sha256 hex pour le dedup de sources (mem_sources.content_hash).
CREATE OR REPLACE FUNCTION content_hash(input text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURNS NULL ON NULL INPUT AS $$
  SELECT encode(digest(input, 'sha256'), 'hex')
$$;

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DDL canonique (drizzle-kit generate ← schema.v3.ts) — NE PAS éditer à la   ║
-- ║ main : régénérer depuis le contrat. Marqueurs --> statement-breakpoint     ║
-- ║ retirés (non requis par Supabase).                                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
CREATE TYPE "public"."mem_entity_review_status" AS ENUM('pending', 'merged', 'distinct');
CREATE TYPE "public"."mem_entity_type" AS ENUM('personne', 'entreprise', 'outil', 'decision');
CREATE TYPE "public"."mem_grant_mode" AS ENUM('read', 'write');
CREATE TYPE "public"."mem_ingestion_status" AS ENUM('PROPOSED', 'APPLYING', 'APPLIED', 'PARTIAL', 'REJECTED', 'CHANGES_REQUESTED');
CREATE TYPE "public"."mem_page_status" AS ENUM('active', 'deprecated');
CREATE TYPE "public"."mem_page_visibility" AS ENUM('private', 'org', 'public');
CREATE TYPE "public"."mem_source_kind" AS ENUM('url', 'file', 'texte');
CREATE TABLE "mem_bases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mem_bases_org_id_unique" UNIQUE("org_id")
);

CREATE TABLE "mem_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "mem_entity_type" NOT NULL,
	"canonical_label" text NOT NULL,
	"normalised_label" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"page_id" uuid,
	"is_stub" boolean DEFAULT true NOT NULL,
	"attributes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mem_entity_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_keep" uuid NOT NULL,
	"entity_drop" uuid NOT NULL,
	"score" real,
	"method" text,
	"status" "mem_entity_review_status" DEFAULT 'pending' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mem_ingestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"title" text NOT NULL,
	"status" "mem_ingestion_status" DEFAULT 'PROPOSED' NOT NULL,
	"proposal" jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"review_note" text,
	"client_key" text,
	"created_by" text,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"claimed_at" timestamp with time zone
);

CREATE TABLE "mem_memberships" (
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mem_memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);

CREATE TABLE "mem_mentions" (
	"page_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"span" text,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mem_mentions_page_id_entity_id_pk" PRIMARY KEY("page_id","entity_id")
);

CREATE TABLE "mem_orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"personal_for" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mem_orgs_slug_unique" UNIQUE("slug"),
	CONSTRAINT "mem_orgs_personal_for_unique" UNIQUE("personal_for")
);

CREATE TABLE "mem_page_chunks" (
	"page_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"content" text NOT NULL,
	"model_version" text NOT NULL,
	CONSTRAINT "mem_page_chunks_page_id_idx_pk" PRIMARY KEY("page_id","idx")
);

CREATE TABLE "mem_page_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"mode" "mem_grant_mode" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mem_page_sources" (
	"page_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"locator" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mem_page_sources_page_id_source_id_pk" PRIMARY KEY("page_id","source_id")
);

CREATE TABLE "mem_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"visibility" "mem_page_visibility" DEFAULT 'org' NOT NULL,
	"owner_id" text,
	"position" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone,
	"status" "mem_page_status" DEFAULT 'active' NOT NULL,
	"client_key" text,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mem_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"op" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"actor_kind" text DEFAULT 'human' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ingestion_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "mem_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_id" uuid NOT NULL,
	"kind" "mem_source_kind" NOT NULL,
	"title" text NOT NULL,
	"citation" text,
	"uri" text,
	"content" text,
	"content_hash" text,
	"trust_level" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "mem_bases" ADD CONSTRAINT "mem_bases_org_id_mem_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."mem_orgs"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mem_entities" ADD CONSTRAINT "mem_entities_org_id_mem_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."mem_orgs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_entities" ADD CONSTRAINT "mem_entities_page_id_mem_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."mem_pages"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mem_entity_reviews" ADD CONSTRAINT "mem_entity_reviews_org_id_mem_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."mem_orgs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_entity_reviews" ADD CONSTRAINT "mem_entity_reviews_entity_keep_mem_entities_id_fk" FOREIGN KEY ("entity_keep") REFERENCES "public"."mem_entities"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_entity_reviews" ADD CONSTRAINT "mem_entity_reviews_entity_drop_mem_entities_id_fk" FOREIGN KEY ("entity_drop") REFERENCES "public"."mem_entities"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_ingestions" ADD CONSTRAINT "mem_ingestions_base_id_mem_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."mem_bases"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_memberships" ADD CONSTRAINT "mem_memberships_org_id_mem_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."mem_orgs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_mentions" ADD CONSTRAINT "mem_mentions_page_id_mem_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."mem_pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_mentions" ADD CONSTRAINT "mem_mentions_entity_id_mem_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."mem_entities"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_page_chunks" ADD CONSTRAINT "mem_page_chunks_page_id_mem_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."mem_pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_page_grants" ADD CONSTRAINT "mem_page_grants_base_id_mem_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."mem_bases"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_page_grants" ADD CONSTRAINT "mem_page_grants_page_id_mem_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."mem_pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_page_sources" ADD CONSTRAINT "mem_page_sources_page_id_mem_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."mem_pages"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_page_sources" ADD CONSTRAINT "mem_page_sources_source_id_mem_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."mem_sources"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mem_pages" ADD CONSTRAINT "mem_pages_base_id_mem_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."mem_bases"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_pages" ADD CONSTRAINT "mem_pages_parent_id_mem_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."mem_pages"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mem_revisions" ADD CONSTRAINT "mem_revisions_base_id_mem_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."mem_bases"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mem_sources" ADD CONSTRAINT "mem_sources_base_id_mem_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."mem_bases"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "mem_entities_org_type_norm" ON "mem_entities" USING btree ("org_id","type","normalised_label");
CREATE INDEX "mem_entity_reviews_org_status" ON "mem_entity_reviews" USING btree ("org_id","status");
CREATE INDEX "mem_ingestions_base_status" ON "mem_ingestions" USING btree ("base_id","status");
CREATE UNIQUE INDEX "mem_ingestions_base_client_key" ON "mem_ingestions" USING btree ("base_id","client_key");
CREATE INDEX "mem_memberships_user" ON "mem_memberships" USING btree ("user_id");
CREATE INDEX "mem_mentions_entity" ON "mem_mentions" USING btree ("entity_id");
CREATE UNIQUE INDEX "mem_page_grants_page_user" ON "mem_page_grants" USING btree ("page_id","user_id");
CREATE INDEX "mem_page_grants_user" ON "mem_page_grants" USING btree ("user_id");
CREATE INDEX "mem_pages_base_parent_pos" ON "mem_pages" USING btree ("base_id","parent_id","position");
CREATE UNIQUE INDEX "mem_pages_base_client_key" ON "mem_pages" USING btree ("base_id","client_key");
CREATE INDEX "mem_revisions_target" ON "mem_revisions" USING btree ("base_id","target_type","target_id","created_at");
CREATE INDEX "mem_revisions_ingestion" ON "mem_revisions" USING btree ("ingestion_id");
CREATE UNIQUE INDEX "mem_sources_base_kind_uri_hash" ON "mem_sources" USING btree ("base_id","kind","uri","content_hash");
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ Colonnes / index HORS DRIZZLE (cf. en-tête schema.v3.ts)                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- mem_pages.body_fts : tsvector(french_unaccent) généré (title+description+body) + GIN.
ALTER TABLE "mem_pages" ADD COLUMN "body_fts" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('french_unaccent',
      coalesce("title", '') || ' ' || coalesce("description", '') || ' ' || coalesce("body", ''))
  ) STORED;
CREATE INDEX "mem_pages_body_fts" ON "mem_pages" USING GIN ("body_fts");

-- mem_sources.fts : tsvector(french_unaccent) généré (title+citation+content) + GIN.
ALTER TABLE "mem_sources" ADD COLUMN "fts" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('french_unaccent',
      coalesce("title", '') || ' ' || coalesce("citation", '') || ' ' || coalesce("content", ''))
  ) STORED;
CREATE INDEX "mem_sources_fts" ON "mem_sources" USING GIN ("fts");

-- mem_page_chunks.embedding : halfvec(1024) (Mistral embed) + HNSW cosine PARTIEL.
-- Partiel sur `embedding IS NOT NULL` : un chunk non encore vectorisé est exclu de
-- l'index → kNN l'ignore, dégradation propre (cf. v2 migration 0006). Le filtrage
-- « page active » du contrat n'est PAS exprimable en index partiel ici (le statut
-- vit sur mem_pages, pas sur le chunk) → il se fait dans le JOIN de la requête ;
-- les chunks sont (re)chunkés à l'apply/update, donc rattachés à des pages vivantes.
ALTER TABLE "mem_page_chunks" ADD COLUMN "embedding" halfvec(1024);
CREATE INDEX "mem_page_chunks_embedding_hnsw"
  ON "mem_page_chunks" USING hnsw ("embedding" halfvec_cosine_ops)
  WHERE "embedding" IS NOT NULL;

-- mem_entities.name_embedding : halfvec(1024) + résolution floue (trigram + aliases).
ALTER TABLE "mem_entities" ADD COLUMN "name_embedding" halfvec(1024);
CREATE INDEX "mem_entities_norm_trgm"
  ON "mem_entities" USING GIN ("normalised_label" gin_trgm_ops);
CREATE INDEX "mem_entities_aliases_gin"
  ON "mem_entities" USING GIN ("aliases");

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ RLS — filet grossier (PLACEHOLDER). La résolution FINE est un AUTRE lot    ║
-- ║ (issue Accès) : ne PAS l'implémenter ici.                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
-- Modèle (repris de la v2, migration 0005) : le schéma `public` est exposé par
-- PostgREST aux rôles anon/authenticated. Le runtime (Edge Functions) se connecte
-- en propriétaire des tables et CONTOURNE la RLS. Donc : RLS activée + aucune
-- policy = deny-all pour anon/authenticated, runtime inchangé. Les fonctions
-- ci-dessous sont des STUBS que l'issue Accès remplira ; tant qu'elles renvoient
-- le vide, seules les pages `public` sont lisibles via PostgREST — filet sûr.

CREATE OR REPLACE FUNCTION mem_current_sub() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
$$;

-- STUB (issue Accès) : renverra les bases dont mem_current_sub() est membre de l'org.
CREATE OR REPLACE FUNCTION accessible_base_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM mem_bases WHERE false   -- placeholder : ensemble vide
$$;

-- STUB (issue Accès) : résolution FINE des pages visibles (visibilité + grants +
-- héritage dans l'arbre). NE PAS implémenter ici.
CREATE OR REPLACE FUNCTION accessible_page_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT id FROM mem_pages WHERE false    -- placeholder : ensemble vide
$$;

-- Filet : RLS activée partout (deny-all par défaut).
ALTER TABLE "mem_orgs"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_memberships"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_bases"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_pages"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_page_chunks"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_sources"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_page_sources"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_entities"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_mentions"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_page_grants"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_entity_reviews"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_ingestions"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mem_revisions"       ENABLE ROW LEVEL SECURITY;

-- Policy PLACEHOLDER de lecture sur mem_pages (la table sur laquelle le prédicat du
-- contrat est écrit) — TEMPLATE pour le lot Accès, branchée sur les stubs. Les
-- autres tables de contenu restent en deny-all jusqu'au lot Accès.
CREATE POLICY "mem_pages_read_placeholder" ON "mem_pages"
  FOR SELECT
  USING (
    "visibility" = 'public'
    OR "base_id" IN (SELECT accessible_base_ids())
    OR "id"      IN (SELECT accessible_page_ids())
  );
