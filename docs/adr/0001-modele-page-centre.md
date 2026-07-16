# ADR 0001 — Modèle page-centré (suppression des blocs et des liens typés)

- **Statut** : Proposé (à valider — point Memento du vendredi après Open Kos)
- **Date** : 2026-06-24
- **Spécification** : CDC v3 (page-centré) = le PRD de référence
- **Décideurs** : Jean-Baptiste Fleury, Alexis Laporte

> ADR volontairement **court** : le CDC v3 décrit le modèle en détail (il fait office de PRD).
> Cet ADR n'enregistre que **la décision, ses raisons et le registre de ce qu'on abandonne**.
> La principale conséquence (la décision comme objet de 1er ordre) est traitée par **[ADR 0002](0002-entites-serveur-deux-familles.md)**.

## Contexte

Le modèle v2.x était **bloc-centré** : une page = une pile de **blocs typés** (11 types) reliés par des **liens typés** (5 relations). Deux défauts structurels :

1. **Le bloc confondait deux axes** — *structure du texte* (découper en paragraphes) et *typage de l'information* (« ceci est une décision »). Résultat : la lecture était hachée en cartes au lieu d'un texte fluide.
2. **Les liens typés entre blocs** imposaient une charge cognitive trop forte au modèle qui écrit (graphe `mem_links` resté quasi vide en pratique) pour un bénéfice de lecture marginal.

## Décision

**Modèle page-centré.** Un seul concept de contenu : la **page** (un arbre ; fusion Dossier+Page). Une page = **prose pure** : `titre` + `description` (1 phrase) + `corps` (markdown). **Plus de blocs, plus de liens typés.**

- La **structure** = l'arbre de pages + les titres markdown (table des matières dérivée).
- Le **tissu connectif** = les **entités** (cf. [ADR 0002](0002-entites-serveur-deux-familles.md)), plus les liens de blocs.
- **Sources** et **entités** s'attachent à la page (ou à une portion via `locator`).
- **Doctrine = la description de la page racine** (HOW-TO lu par l'agent au `load`).

## Ce qu'on abandonne — et comment c'est mitigé

| Perdu avec les blocs/liens | Mitigation |
|---|---|
| La **DÉCISION** comme objet daté/supersédable/requêtable | **Re-modélisée en entité** (famille « événement »), pas en bloc — [ADR 0002](0002-entites-serveur-deux-familles.md). |
| Le lien typé **SUPERSEDES** | Devient une **arête entité↔entité** (graphe d'entités). |
| La **datation fine par affirmation** (`occurred_at` au bloc) | Datation au niveau **page** et **source**. *(Acté : acceptable — 1 page = 1 sujet.)* |
| La **citation/granularité au bloc** | L'unité citée/liée devient la **page** ; la recherche renvoie quand même le **passage** qui matche. |
| Les types RÈGLE / PROCÉDURE / NOTE | Redeviennent de la **prose autoritaire dans une page** (pas d'identité cross-page → pas d'entité). |

## Conséquences

- **+** Lecture fluide (le problème structure/typage est dissous) ; surface et schéma plus simples (`block`/`link` supprimés).
- **+** Gestion des droits uniforme (tout = page/nœud d'arbre) — cf. [ADR 0003](0003-une-base-par-org-acces-par-page.md).
- **−** Migration irréversible (suppression de la table `block`) → procédure détaillée au §14 du CDC v3 (dossier→page, blocs→`body` concaténés, liens→prose/entité, mentions ré-extraites par le NER).
- **−** Pas de retour arrière cheap : ré-introduire un objet typé intra-page = changement de schéma. C'est pourquoi la seule capacité à risque (le suivi des décisions) est explicitement re-logée en entité avant migration (0002), pas perdue.

## Points ouverts / déclencheurs

- Aucun bloquant propre à cet ADR. Les arbitrages vivants sont portés par 0002 (entités/décision) et 0003 (accès).
