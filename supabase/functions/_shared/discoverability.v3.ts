/**
 * V3 — Découvrabilité (#66, CDC §10). Le préambule serveur (servi à TOUT client) et un
 * prompt système recommandé à coller chez l'hôte : faire que l'agent PENSE à Memento.
 *
 * Contraintes (cf. v2) : **client-agnostique** (jamais « Claude »/« claude.ai » → « l'agent »),
 * et **AUCUN backtick** dans le préambule (il est injecté dans un template literal au
 * transport → un backtick casserait le bundle au déploiement). Test garde-fou ci-contre.
 */

/** Préambule MCP servi à chaque client (2ᵉ arg de McpServer). Nudge fort vers `load`. */
export const V3_INSTRUCTIONS =
  "Memento — base de connaissances page-centrée de l'organisation, via MCP. " +
  "En début de conversation, dès qu'il s'agit de MÉMORISER ou de RETROUVER une information, " +
  "appelle d'abord 'load' (l'épine : guide de la base + arbre des pages + entités saillantes) pour te repérer, " +
  "puis 'search' (hybride sémantique+lexical) plutôt que d'énumérer. " +
  "Écrire ne mute jamais directement : 'propose_changes' crée une proposition, 'apply' la valide " +
  "(en équipe, la Revue est le gate ; 'review_ingestion' pour renvoyer/rejeter). " +
  "Lecture déterministe, 0 inférence serveur ; ne réponds pas de mémoire sur un fait de l'organisation " +
  "sans avoir cherché dans Memento d'abord.";

/** Prompt système recommandé — à coller dans la config de l'hôte (instruction custom). */
export const RECOMMENDED_SYSTEM_PROMPT =
  "Tu as accès à Memento, la base de connaissances de l'organisation (via MCP). " +
  "Dès qu'une information doit être mémorisée ou retrouvée, utilise Memento : appelle 'load' en " +
  "début de conversation pour charger la carte de la base, puis 'search'. Pour écrire, 'propose_changes' " +
  "puis 'apply'. Ne réponds pas de mémoire sur des faits de l'organisation sans avoir interrogé Memento.";
