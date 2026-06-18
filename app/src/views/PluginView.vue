<script setup lang="ts">
const SKILLS = [
  {
    cmd: "/memento",
    title: "Dispatcher de capture",
    body: "Point d'entrée. Réfléchit à la session, auto-détecte la couche préférée du projet (ligne « Memento KB: » du CLAUDE.md), route vers les bonnes couches, et surveille la taille en proposant un ménage si besoin.",
  },
  {
    cmd: "/memento:files",
    title: "Fichiers projet",
    body: "Capture versionnée dans le repo : la carte du projet (CLAUDE.md) et le détail par concept (docs/). Ce qui sert au repo, dans le repo.",
  },
  {
    cmd: "/memento:memory",
    title: "Mémoire locale",
    body: "Préférences, feedback récurrent, profil, références externes et pointeurs vers la base. Couche mono-poste : pour le cross-projet léger et les index, pas la donnée durable.",
  },
  {
    cmd: "/memento:distant",
    title: "Push vers la base",
    body: "Pousse les faits sélectionnés vers la KB : doctrine d'abord, proposition (fait → section → source), puis stage → GO explicite → apply. Jamais d'écriture aveugle.",
  },
  {
    cmd: "/memento:refactor",
    title: "Grand ménage",
    body: "Maintenance des couches à la demande : dédoublonnage, éviction de l'état périmé, extraction vers docs/, budgets de taille (CLAUDE.md ≤ 200 lignes).",
  },
  {
    cmd: "/memento:install",
    title: "Setup",
    body: "Vérifie le connecteur (OAuth au premier appel), fixe la KB par défaut, écrit le mapping projet → workspace dans le CLAUDE.md du projet.",
  },
];

const INSTALL = `{
  "extraKnownMarketplaces": {
    "memento-dev": {
      "source": { "source": "github", "repo": "otomata-tech/memento-plugin" }
    }
  },
  "enabledPlugins": { "memento@memento-dev": true }
}`;
</script>

<template>
  <div class="plugin">
    <header class="topbar">
      <router-link to="/" class="brand brand-link">Memento<small>mento.cc</small></router-link>
      <nav class="hnav">
        <router-link to="/">Accueil</router-link>
        <router-link to="/login" class="cta">Se connecter</router-link>
      </nav>
    </header>

    <main>
      <!-- Connecter (client-agnostic) — cible du menu « Connecter (MCP) » de l'app -->
      <section class="sect" id="connecter">
        <p class="eyebrow">Connecter</p>
        <h2>Brancher un client MCP</h2>
        <p class="lede">
          Memento est un <b>serveur MCP distant</b>, authentifié par OAuth. Branchez n'importe quel
          client compatible sur l'endpoint — votre compte (et son périmètre de partage) suit la connexion,
          rien à installer en local.
        </p>
        <pre class="code">https://mcp.mento.cc/mcp</pre>
        <ul class="clients">
          <li>
            <b>claude.ai · ChatGPT · Mistral Le Chat</b> — Réglages → Connecteurs → « Ajouter un
            connecteur personnalisé » → coller l'URL ci-dessus → s'authentifier (OAuth au 1er usage).
          </li>
          <li>
            <b>Claude Code (CLI)</b> — <code>claude mcp add memento https://mcp.mento.cc/mcp --transport http</code>,
            OAuth au premier appel. Ou installez le <b>plugin</b> (ci-dessous) : il câble le connecteur et les skills.
          </li>
        </ul>
      </section>

      <section class="hero">
        <p class="eyebrow">Plugin Claude Code</p>
        <h1>La mémoire de session,<br />jusqu'à la base partagée.</h1>
        <p class="lede">
          Le plugin <code>memento</code> donne à Claude Code une discipline de mémoire en
          couches : ce qui sert au repo va dans le repo, ce qui vous concerne va en mémoire
          globale, et les <b>faits de domaine que d'autres devront connaître</b> — humains
          ou agents — sont proposés à la base Memento. Le connecteur MCP est embarqué :
          installer le plugin suffit.
        </p>
      </section>

      <!-- Skills -->
      <section class="sect">
        <p class="eyebrow">Six skills</p>
        <div class="skills">
          <article v-for="s in SKILLS" :key="s.cmd" class="skill">
            <code class="cmd">{{ s.cmd }}</code>
            <h2>{{ s.title }}</h2>
            <p>{{ s.body }}</p>
          </article>
        </div>
      </section>

      <!-- Doctrine de routage -->
      <section class="sect">
        <p class="eyebrow">Où va quoi</p>
        <table class="route">
          <tbody>
            <tr>
              <td class="what">Gotchas de repo, commandes, conventions</td>
              <td class="where"><code>CLAUDE.md</code> du projet</td>
            </tr>
            <tr>
              <td class="what">Préférences et feedbacks de l'utilisateur</td>
              <td class="where">mémoire globale</td>
            </tr>
            <tr>
              <td class="what">Fait de mission, règle métier, décision qui fait doctrine</td>
              <td class="where"><b>KB Memento</b> — bloc sourcé (citation + ref joignable)</td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          Granularité des bases : un <b>périmètre de partage</b> par KB (une par
          mission/client, une perso) — pas une base par repo, pas de fourre-tout.
          Seul <code>/memento:distant</code> écrit dans la base, via la boucle
          propose-valide, après sélection et GO explicite.
        </p>
      </section>

      <!-- Installation -->
      <section class="sect">
        <p class="eyebrow">Installation</p>
        <ol class="steps">
          <li>
            <b>Accès.</b> Les bases sont privées (orgs/rôles) : il faut avoir été invité —
            <a href="mailto:hello@mento.cc">demander un accès</a>.
          </li>
          <li>
            <b>Déclarer le plugin</b> dans <code>~/.claude/settings.json</code> :
            <pre class="code">{{ INSTALL }}</pre>
          </li>
          <li>
            <b>Nouvelle session</b> : les skills apparaissent, le connecteur
            <code>https://mcp.mento.cc/mcp</code> est ajouté. Le premier appel d'un
            outil <code>mem_*</code> ouvre le flow OAuth (login + consentement).
          </li>
          <li>
            <b>Dans un projet</b> : <code>/memento:install</code> câble la KB du projet,
            puis <code>/memento</code> en fin de session.
          </li>
        </ol>
      </section>
    </main>

    <footer class="foot">
      <span class="brand-foot">Memento</span>
      <span class="muted">un projet <a href="https://otomata.tech">Otomata</a></span>
    </footer>
  </div>
</template>

<style scoped>
.plugin { min-height: 100%; display: flex; flex-direction: column; background: var(--color-bg); }
main { flex: 1; width: 100%; max-width: 880px; margin: 0 auto; padding: 0 24px; }

.brand-link { color: var(--color-ink); }
.brand-link:hover { text-decoration: none; }
.hnav { margin-left: auto; display: flex; align-items: center; gap: 18px; }
.hnav a { font-size: 13.5px; font-weight: 600; color: var(--color-mute); }
.hnav a:hover { color: var(--color-ink); text-decoration: none; }
.hnav a.cta { border: 1px solid var(--color-ink); color: var(--color-ink); padding: 6px 14px; }
.hnav a.cta:hover { background: var(--color-ink); color: var(--color-bg); }

.hero { padding: 64px 0 44px; }
.hero h1 {
  font-family: var(--font-display); font-weight: 650; margin: 14px 0 20px;
  font-size: clamp(34px, 5.5vw, 54px); line-height: 1.02; letter-spacing: -0.02em;
}
.lede { max-width: 640px; font-size: 16px; line-height: 1.65; color: var(--color-ink-soft); margin: 0; }
.lede b { color: var(--color-ink); }
.lede code, .note code, .steps code { font-family: var(--font-mono); font-size: 0.88em; background: var(--color-paper-2); padding: 1px 5px; }

#connecter { padding-top: 44px; }
#connecter h2 { font-family: var(--font-display); font-weight: 650; font-size: 26px; letter-spacing: -0.015em; margin: 12px 0 14px; }
.clients { margin: 16px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 10px; }
.clients li { font-size: 14.5px; line-height: 1.6; color: var(--color-ink-soft); }
.clients b { color: var(--color-ink); }
.clients code { font-family: var(--font-mono); font-size: 0.88em; background: var(--color-paper-2); padding: 1px 5px; }

.sect { border-top: 1px solid var(--color-hair); padding: 36px 0 44px; }

.skills { margin-top: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--color-hair); border: 1px solid var(--color-hair); }
.skill { background: var(--color-surface); padding: 20px 20px 24px; }
.skill .cmd { font-family: var(--font-mono); font-size: 12px; color: var(--color-primary-ink); background: var(--color-primary-soft); padding: 2px 8px; }
.skill h2 { font-family: var(--font-display); font-size: 17px; font-weight: 650; margin: 12px 0 7px; }
.skill p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--color-ink-soft); }

.route { margin-top: 20px; width: 100%; border-collapse: collapse; font-size: 14px; }
.route td { border: 1px solid var(--color-hair); padding: 10px 14px; background: var(--color-surface); }
.route .what { color: var(--color-ink-soft); }
.route .where { font-weight: 600; white-space: nowrap; }
.note { margin: 16px 0 0; font-size: 13.5px; line-height: 1.65; color: var(--color-ink-soft); max-width: 660px; }

.steps { margin: 20px 0 0; padding-left: 20px; display: flex; flex-direction: column; gap: 14px; font-size: 14.5px; line-height: 1.6; color: var(--color-ink-soft); }
.steps b { color: var(--color-ink); }
.code {
  font-family: var(--font-mono); font-size: 12.5px; line-height: 1.55;
  background: var(--color-ink); color: var(--color-bg);
  padding: 14px 16px; margin: 10px 0 0; overflow-x: auto;
}

.foot { border-top: 1px solid var(--color-hair); padding: 18px 24px; display: flex; align-items: baseline; gap: 14px; max-width: 880px; margin: 0 auto; width: 100%; }
.brand-foot { font-family: var(--font-display); font-weight: 700; font-size: 15px; }
.foot .muted { font-size: 12.5px; }

@media (max-width: 720px) {
  .skills { grid-template-columns: 1fr; }
  .route .where { white-space: normal; }
}
</style>
