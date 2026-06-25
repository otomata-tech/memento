# ADR 0002 — Résolution d'entités côté serveur : deux familles (NER-extraites & agent-posées)

- **Statut** : Proposé (à valider — point Memento du vendredi après Open Kos)
- **Date** : 2026-06-24
- **Contexte amont** : CDC v3 (page-centré) · ADR 0001 (modèle page-centré, suppression des blocs/liens)
- **Décideurs** : Jean-Baptiste Fleury, Alexis Laporte

## Contexte

La v3 supprime les **blocs** et les **liens typés** : une page = prose pure. Le **tissu connectif** du savoir passe donc entièrement par les **entités**, désormais objet de **1er ordre, au niveau org** (table dédiée, distincte du contenu, pointant en option vers une page-fiche).

Deux exigences en découlent :

1. **Extraire / résoudre les entités côté serveur** (cohérence quel que soit l'agent qui écrit ; coût et latence maîtrisés) — sans violer l'invariant *0 LLM serveur en lecture*.
2. **Ne pas perdre le suivi des décisions.** La suppression des blocs retire la DÉCISION comme objet daté / supersédable / requêtable (ex-`decision_status`, ex-lien `SUPERSEDES`). Or le template « Mémoire de projet » repose dessus. **C'est le seul arbitrage réellement à risque de la v3** (irréversible : on supprime la table `block`).

## Décision

### 1. Les entités forment **deux familles**

| Famille | Qui les pose | Types | Mécanisme |
|---|---|---|---|
| **entités NER** | le **serveur** (NLP), async après l'`apply` | **personne · entreprise · outil** | extraction GLiNER + escalier de résolution déterministe |
| **entités logiques** | l'**agent**, via un op `propose_changes` | **décision** (1ʳᵉ), puis réunion · contrat · tâche (différés) | l'agent les déclare en distillant, avec leurs métadonnées |

**Raison de la coupure** : une personne/entreprise/outil est un **span nommé** → le NER la trouve. Une **décision est une proposition** (« on retient pgvector plutôt que X »), pas un nom propre → **le NER ne l'extrait pas de façon fiable**. C'est précisément le genre d'objet qui **mérite l'attention explicite de l'agent**. On n'essaie donc pas de la deviner côté serveur : l'agent la pose.

### 2. La **décision** redevient un objet de 1er ordre — comme entité, pas comme bloc

C'est la résolution de l'arbitrage D3 : **la décision migre du bloc vers l'entité** (famille « événement »), sans réintroduire aucun bloc.

- Type d'entité `decision` ; métadonnées propres à la famille « événement » dans un **`attributes jsonb`** sur `entity` (évite une colonne vide à 95 % des entités) : `status ∈ {proposee, actee, supersedee}`, et `occurred_at` **si** on veut le digest-par-date — **différable** (la date peut d'abord venir de la source attachée).
- **SUPERSEDES = un *link de span*** : un lien posé sur le texte énonçant la décision B, **ciblant la décision A** (qu'on sort de l'actif via `status=supersedee`). **Pas de table entité↔entité** (aucun intérêt) — on **réutilise les links de page/sélection** déjà prévus. → dépend de la **question ouverte** ci-dessous.
- **Requêtable** : `list(entities, type=decision, …)` (filtré sur `status`/`occurred_at`) → restaure le digest « qu'a-t-on décidé cette semaine ».
- **La page reste prose pure** : la phrase de décision vit dans le `body` ; l'entité-décision la **pointe** (mention + métadonnées), exactement comme une personne mentionnée dans le texte + sa fiche.

**Discipline (on ne ré-ouvre pas tout)** : parmi les ex-types de blocs, **seule la décision** gagne le statut d'entité — parce qu'elle a un **cycle de vie** + des **références croisées**. RÈGLE / PROCÉDURE / NOTE restent de la **prose autoritaire dans une page** (pas d'identité cross-page → pas d'entité).

### 3. Typologie NER : **3 types**, pas 9

Set retenu : **personne · entreprise · outil** (la portée actée en réunion), et **non** les 9 types du CDC (+ produit, projet, lieu, date, événement, concept). Justification empirique ci-dessous : au-delà de 3, la **confusion inter-labels augmente** (org↔outil↔produit). Les autres types (lieu, date, projet…) = **différés**, à activer sur usage prouvé.

### 4. Escalier de résolution (serveur, déterministe + adjudicateur optionnel)

Pour chaque mention (NER-extraite ou agent-posée), **async après l'apply** :

1. `normalise_name` → **exact-match** `ON CONFLICT (org_id, type, normalised_label)` (auto-lié, 0 LLM).
2. Sinon candidats = `pg_trgm` + **Jaro-Winkler** (côté serveur TS/Deno ou PL/pgSQL — `pg_similarity` absent de Supabase Cloud) **∪** kNN sur `name_embedding`.
3. **Seuil de confiance** : `> haut` → auto-lié · `bas` → **file de revue · Entités** (`entity_review`) · rien → **stub**.
4. **Petit LLM adjudicateur = un palier optionnel**, **au write seulement**, **sur le seul résidu** (après exact-match), batché, modèle cheap, async. Tranche les cas durs (sigles, coréférence). **Jamais en lecture.** Désactivable → on retombe sur escalier + revue.

## Preuve (test GLiNER, 2026-06-24)

Smoke test sur 4 textes FR réalistes (réunion / SAV / veille / carte d'entreprise), `urchade/gliner_multi-v2.1`, CPU :

- **GLiNER n'est pas un LLM** (encodeur bi-directionnel famille BERT, ~200M) → conforme au « détecter sans recourir à un LLM ».
- **Latence ~100–170 ms/page** (chargement modèle 36 s one-time → garder chaud) → compatible **async au write**.
- **Qualité (types personne/entreprise/outil)** : personnes 0.94–0.99 (toutes captées) ; entreprises et outils bien détectés (Lumera, Tiple, Otomata, Slack, Pennylane, Google Drive…).
- **Erreurs = ambiguïtés de type à confiance basse** : « Notion » → entreprise vs outil (0.69) ; « DAF » (un rôle) → entreprise (0.63) ; « TEMPO » (offre) → outil (0.61). **Toutes < 0.7** → un seuil les route proprement vers la revue / l'adjudicateur. Empiriquement, l'escalier + l'adjudicateur sur résidu sont **justifiés, pas en remplacement**.
- **9 types ↑ la confusion** (Memento oscille outil/org, TEMPO outil/produit) → confirme le choix de **3 types**.

⚠️ **Méthodo** : smoke test (4 phrases construites), pas un benchmark. Précision/recall réels = corpus FR étiqueté requis (→ #35, couche d'éval recall@k).

## Conséquences

- **+** D3 résolu **sans réintroduire de bloc** : la décision est requêtable/datée/supersédable, la page reste prose pure.
- **+** Le graphe (SUPERSEDES, et plus tard réunion→décisions) vit sur les entités → cohérent avec « le tissu connectif = les entités ».
- **+** NER choisi et mesuré (GLiNER) → le P0 pivot est levé côté faisabilité.
- **−** La décision-entité est une **entité logique** (posée par l'agent, pas NER) → besoin d'un op `propose_changes` dédié + de la discipline d'agent (doctrine).
- **−** Schéma : +1 colonne `attributes jsonb` sur `entity` (porte `status`, `occurred_at`… pour la famille événement) + 1 type `decision`. Pas de table de liens neuve (SUPERSEDES = link de span, cf. question ouverte).
- **−** Dépendance d'un service **Python** pour GLiNER (hors Edge Deno) → composant NLP séparé, appelé en async.

## Points ouverts / déclencheurs

- **❓ QUESTION (à trancher avec JB) — un *link* de page/sélection peut-il cibler une *entité* (ou une page), pas seulement une source ?** Si **oui** : tout le cycle de décision (SUPERSEDES) tient sans table neuve, via les links de span existants → c'est l'hypothèse retenue ici. Si **non** : il faudra soit étendre la cible des links, soit réintroduire une mini-table de relation. *(Le schéma du CDC v3 ne porte aujourd'hui que `page_source` ; la cible « entité/page » des links est un verbal pas encore mis au propre.)*
- **Modèle de l'adjudicateur** (cheap, async) : à choisir/mesurer.
- **Corpus FR étiqueté** pour P/R réels (#35).
- **Tuning du seuil** auto-link vs revue.
- **Types d'entités 2ᵉ niveau** (réunion, contrat, tâche ; lieu/date/projet) : différés, déclencheur = usage prouvé.
