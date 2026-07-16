# ADR 0003 — Une base par org & accès par page

- **Statut** : Proposé (à valider — point Memento du vendredi après Open Kos)
- **Date** : 2026-06-24
- **Contexte amont** : ADR 0001 (page-centré) · ADR 0002 (entités niveau org)
- **Décideurs** : Jean-Baptiste Fleury, Alexis Laporte

## Contexte

Le modèle v2.x distinguait org (tenant) et **N bases (workspaces)** par org, avec un partage par base et des **groupes** + grants. Avec le pivot page-centré (0001) et les entités au **niveau org** (0002), on simplifie l'architecture d'accès — sans fermer la porte à la collaboration future.

## Décision

### 1. Une seule base par org

`base.org_id UNIQUE` : **1 org = 1 base = la mémoire de l'org**. Le multi-base est **différé** (éviter la fragmentation prématurée ; on observe l'usage avant d'autoriser plusieurs mémoires dans une org).

→ Conséquence : les **entités vivent au niveau org** (0002), partagées par toute la base. Le « perso » n'est pas une base à part, c'est une **page privée** dans la base commune → mêmes entités, même recherche, **zéro silo**.

### 2. Accès **par page** (pas par section, pas par groupe en v1)

Tout est une page (0001) → l'accès se pose **sur une page** et **hérite dans l'arbre** :

- **3 visibilités par page** : `private` (proprio + users explicitement invités) · `org` (tous les membres) · `public` (**tous les utilisateurs Memento**).
- **+ grants par utilisateur** (`page_grant` : inviter des users précis, mode `read`/`write`).
- **Pas de groupes en v1** (différé — « un peu plus tard » ; en attendant, grants par utilisateur).
- **Héritage** : une page sans accès explicite applique le **plus proche ancêtre explicite** ; restriction descendante permise ; `move_page` recalcule. **`public` n'est JAMAIS hérité** (sinon publier une racine exposerait tout le sous-arbre) — explicite par page.

### 3. Publication = geste sensible, **public = lien seul**

- `set_visibility(public)` passe par un **gate** (confirmation/droit).
- Une page publique est **accessible par lien seul** : **non listée, non cherchable** par les non-membres (anti-fuite de noms via titre/description). Lisible uniquement par son lien direct.
- L'agent **demande confirmation** avant de modifier un contenu `partagé`/`public` (anti-modification accidentelle).

### 4. Défense par couches (DB grossière + appli fine)

- **RLS (filet DB)** : une page est lisible **ssi** `base_id ∈ accessible_base(user)` **OU** `visibility='public'` **OU** `id ∈ page_grant(user)`. *(Le filet par base seul casserait le partage public/cross-org → les 3 conditions sont explicites.)*
- **Appli (`accessible_page_ids`, choke-point `assertAccess`)** = le fin : CTE récursif sur `parent_id` (pages des bases membres en `org` ∪ pages grantées ∪ pages `private` dont l'user est proprio). **Les pages `public` d'autres orgs n'y sont PAS** (accessibles par lien seul, jamais énumérées).
- Verrouillé par un **test négatif** (page privée d'autrui inaccessible via MCP/API/public).

## Conséquences

- **+** Architecture d'accès simple : un seul axe (la page), un seul `assertAccess`, gestion classique compte/grant.
- **+** Pas de fragmentation prématurée ; perso intégré (zéro silo d'entités/recherche).
- **−** **Pas de partage par groupe en v1** → pour une équipe, granularité plus grossière (par utilisateur). Différé, déclencheur = besoin prouvé.
- **−** Multi-base différé → une org qui voudrait cloisonner plusieurs mémoires devra attendre (ou utiliser la visibilité de pages).

## Point ouvert à acter — entités cross-client (org de conseil)

Avec **entités au niveau org** + **1 base/org**, une org de **conseil** (plusieurs clients) aurait **toutes les entités clients dans un même namespace org-level**. Les **pages** privées cloisonnent le *contenu*, mais le **registre d'entités** (noms, alias, fiches) reste **org-wide** → risque de fuite croisée (un référent d'un client voit, via l'autocomplétion/le graphe d'entités, des noms d'un autre client).

**Options** (à trancher) :
1. **Assumer** : 1 org = 1 périmètre de confiance ; une org de conseil crée **1 org par client** (cohérent avec « 1 org = 1 base = la mémoire de l'org »). ← *simple, recommandé par défaut*
2. **Scoper la visibilité des entités** par accès aux pages qui les mentionnent (l'entité n'apparaît que si l'user a accès à ≥1 page la mentionnant) — plus juste, plus coûteux (jointure accès↔mentions sur chaque listing d'entités).
3. **Multi-base par org** (lève le différé) pour cloisonner par client dans une même org.

**Déclencheur** : dès qu'une org de conseil réelle onboarde plusieurs clients dans Memento. *(Par défaut : option 1 — 1 org/client.)*

## Différé — déclencheurs

| Élément | Déclencheur |
|---|---|
| Groupes (partage à un groupe d'utilisateurs) | besoin prouvé ; en v1, grants par utilisateur |
| Multi-base par org | besoin de cloisonner plusieurs mémoires (ou entités cross-client, cf. ci-dessus) |
| Partage infra-page (par portion) | besoin prouvé ; en v1, au niveau page (`page_source.locator` pour l'ancrage de source) |

## Amendement (2026-06-26) — `org_admin` gouverne toute page de son org

Le lot #61 avait tranché « `private` est personnel : l'org_admin ne franchit PAS un gate
`private` d'autrui » (gouvernance ≠ accès au contenu privé). **Un test du viewer a montré
que cette règle crée une trappe à sens unique** : passer une page en `private` la rend
injoignable par l'admin qui l'a flippée (il n'en est pas le `owner`), donc **non
restaurable**. Aggravé par la migration v2→v3 : les pages migrées ont **`owner_id = NULL`**
(une page de KB partagée n'a pas de propriétaire personnel — `owner_id` ne sert qu'au cas
`private`). Sur une page sans propriétaire, `private` = visible de **personne** → contenu
définitivement perdu.

**Décision** : on **révise #61**. Un **admin de l'org propriétaire de la base** a un accès
effectif `write` sur **toute page de l'org**, quelle que soit sa visibilité (prioritaire sur
le gate `private`). `private` garde son sens vis-à-vis des **membres non-admin** (caché) ;
l'org_admin, lui, gouverne — cohérent avec `assertCanSetVisibility` qui réservait déjà
PUBLIER à owner|org_admin, et avec la hiérarchie RBAC (ADR 0025 `org_admin ⊇ member`). Une
page « sans propriétaire » reste **normale** pour du contenu d'org collectif (seul le combo
`private` + `owner_id NULL` était dégénéré, et seule la migration pouvait le produire — une
page créée par un humain via `create_page` reçoit toujours `owner_id = sub`).

**Implémentation** : migration append-only `20260625161500_v3_org_admin_override.sql`
(redéfinit `page_read_mode`, dont dérivent `is_page_accessible`/`accessible_page_ids`/
`page_can_write`/RLS — zéro duplication). Test de régression dans `access.v3.test.ts`
(alice org_admin lit+écrit+dé-privatise une page privée de bob). Appliquée prod v3 le 2026-06-26.
