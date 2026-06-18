<script setup lang="ts">
const FEATURES = [
  {
    img: "/illust-code.webp",
    title: "Des blocs sourcés, pas des chunks",
    body: "L'atome est le bloc typé — principe, règle, exception, procédure. Chaque bloc porte ses sources, ses liens (dépend de, contredit, remplace), son statut de vérification.",
  },
  {
    img: "/illust-access.webp",
    title: "Une base par périmètre de partage",
    body: "Une base par mission ou client, une base perso — pas de fourre-tout. Une organisation possède la base, ses membres y accèdent selon leur rôle.",
  },
  {
    img: "/illust-startup.webp",
    title: "Faite pour les agents, via MCP",
    body: "Les agents lisent doctrine-first (une carte compacte, puis le forage) et écrivent en proposant. Aucun LLM côté serveur : la lecture est déterministe.",
  },
];

const IDEAS = [
  { n: "01", title: "Le bloc est l'atome", body: "Adressable, sourcé, commenté, lié — la maille fine est la garantie d'auditabilité." },
  { n: "02", title: "Contrainte en haut, liberté en bas", body: "Une épine dorsale de sections stricte et peu profonde ; en dessous, les documents respirent." },
  { n: "03", title: "Doctrine-first", body: "L'agent charge la carte, puis fore — jamais de mur de texte non demandé." },
  { n: "04", title: "Serveur bête, agent intelligent", body: "L'intelligence est à l'écriture, la lecture est déterministe — on paie la structuration une fois." },
  { n: "05", title: "Propose-valide", body: "Rien n'entre sans revue ; les contradictions ne sont jamais auto-appliquées." },
  { n: "06", title: "Un savoir qui survit", body: "Sources ancrées aux blocs, journal d'intentions : la base évolue sans se dégrader." },
];

const STEPS = [
  { n: "01", title: "Connecter", body: "N'importe quel client MCP : claude.ai, Claude Code (plugin embarqué), Mistral Le Chat, ChatGPT. Coller l'URL du connecteur, OAuth au premier usage." },
  { n: "02", title: "Lire doctrine-first", body: "L'agent charge la carte de la base — préambule, arbre, conventions — puis cible 2-3 sections." },
  { n: "03", title: "Proposer", body: "Le savoir nouveau est proposé en change-set classé : confirme, enrichit, contredit, périme." },
  { n: "04", title: "Valider", body: "Vous revoyez, vous appliquez. Chaque mutation est journalisée avec son pourquoi." },
];
</script>

<template>
  <div class="home">
    <!-- Héro illustré -->
    <section class="hero">
      <picture class="hero-bg">
        <img src="/illust-collab.webp" alt="" />
      </picture>
      <div class="hero-veil" />
      <header class="hero-top">
        <span class="hbrand">Memento<small>mento.cc</small></span>
        <nav class="hnav">
          <router-link to="/plugin">Plugin Claude Code</router-link>
          <router-link to="/login" class="cta">Se connecter</router-link>
        </nav>
      </header>
      <div class="hero-body">
        <p class="eyebrow light">Substrat de connaissance pour agents · MCP</p>
        <h1>Memento mori,<br />note tout.</h1>
        <p class="lede">
          Une base de connaissance que des agents <b>lisent et maintiennent</b>, sous
          contrôle humain — structurée, sourcée, vivante et auditable.
        </p>
        <div class="actions">
          <router-link to="/login" class="btn-solar">Ouvrir le viewer</router-link>
          <router-link to="/plugin" class="btn-ghost">Brancher Claude Code →</router-link>
        </div>
      </div>
    </section>

    <main>
      <!-- Features illustrées -->
      <section class="feats">
        <p class="eyebrow">Ce que Memento fait</p>
        <div class="fgrid">
          <article v-for="f in FEATURES" :key="f.title" class="feat">
            <div class="fimg"><img :src="f.img" alt="" loading="lazy" /></div>
            <h2>{{ f.title }}</h2>
            <p>{{ f.body }}</p>
          </article>
        </div>
      </section>

      <!-- Six idées -->
      <section class="ideas">
        <p class="eyebrow">Les six idées</p>
        <div class="igrid">
          <article v-for="i in IDEAS" :key="i.n" class="idea">
            <span class="num">{{ i.n }}</span>
            <div>
              <h3>{{ i.title }}</h3>
              <p>{{ i.body }}</p>
            </div>
          </article>
        </div>
      </section>

      <!-- Comment ça marche -->
      <section class="steps">
        <p class="eyebrow">Comment ça marche</p>
        <div class="sgrid">
          <article v-for="s in STEPS" :key="s.n" class="step">
            <span class="snum">{{ s.n }}</span>
            <h3>{{ s.title }}</h3>
            <p>{{ s.body }}</p>
          </article>
        </div>
      </section>
    </main>

    <!-- CTA final illustré -->
    <section class="final">
      <picture class="final-bg"><img src="/illust-aerial.webp" alt="" loading="lazy" /></picture>
      <div class="final-veil" />
      <div class="final-body">
        <h2>Les bases sont privées, l'accès sur invitation.</h2>
        <div class="actions">
          <router-link to="/login" class="btn-solar">Se connecter</router-link>
          <a href="mailto:hello@mento.cc" class="btn-ghost">Demander un accès</a>
        </div>
      </div>
    </section>

    <footer class="foot">
      <span class="brand-foot">Memento</span>
      <span class="muted">un projet <a href="https://otomata.tech">Otomata</a></span>
    </footer>
  </div>
</template>

<style scoped>
.home { min-height: 100%; display: flex; flex-direction: column; background: var(--color-bg); }
main { width: 100%; max-width: 1080px; margin: 0 auto; padding: 0 24px; }
.eyebrow.light { color: rgba(254, 252, 245, 0.75); }

/* ── Héro illustré (structure mento.cc, tokens Otomata) ── */
.hero { position: relative; color: var(--color-bg); overflow: hidden; }
.hero-bg img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.hero-veil { position: absolute; inset: 0;
  background: linear-gradient(to right, rgba(44, 33, 18, 0.88), rgba(44, 33, 18, 0.62) 55%, rgba(44, 33, 18, 0.30)); }
.hero-top { position: relative; display: flex; align-items: center; gap: 22px;
  max-width: 1080px; margin: 0 auto; padding: 18px 24px; }
.hbrand { font-family: var(--font-display); font-weight: 700; font-size: 18px; letter-spacing: -0.02em; }
.hbrand small { font-family: var(--font-sans); font-weight: 500; font-size: 12px; margin-left: 8px; opacity: 0.7; }
.hnav { margin-left: auto; display: flex; align-items: center; gap: 18px; }
.hnav a { font-size: 13.5px; font-weight: 600; color: rgba(254, 252, 245, 0.9); }
.hnav a:hover { color: #fff; text-decoration: none; }
.hnav a.cta { border: 1px solid rgba(254, 252, 245, 0.7); padding: 6px 14px; }
.hnav a.cta:hover { background: var(--color-bg); color: var(--color-ink); }
.hero-body { position: relative; max-width: 1080px; margin: 0 auto; padding: 84px 24px 96px; }
.hero h1 { font-family: var(--font-display); font-weight: 650; margin: 14px 0 20px;
  font-size: clamp(44px, 7.5vw, 76px); line-height: 0.97; letter-spacing: -0.025em; }
.hero .lede { max-width: 540px; font-size: 17px; line-height: 1.6; color: rgba(254, 252, 245, 0.88); margin: 0 0 30px; }
.hero .lede b { color: #fff; }

.actions { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.btn-solar { background: var(--color-primary); color: var(--color-primary-ink); padding: 11px 22px; font-weight: 700; font-size: 14.5px; }
.btn-solar:hover { background: var(--color-bg); color: var(--color-ink); text-decoration: none; }
.btn-ghost { font-weight: 600; font-size: 14.5px; color: inherit; border-bottom: 2px solid var(--color-primary); padding-bottom: 2px; }
.btn-ghost:hover { text-decoration: none; color: var(--color-primary); }

/* ── Features illustrées ── */
.feats { padding: 52px 0 12px; }
.fgrid { margin-top: 22px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 28px; }
.feat .fimg { border: 1px solid var(--color-hair); aspect-ratio: 16/10; overflow: hidden; }
.feat .fimg img { width: 100%; height: 100%; object-fit: cover; display: block; }
.feat h2 { font-family: var(--font-display); font-size: 18px; font-weight: 650; letter-spacing: -0.01em; margin: 14px 0 7px; }
.feat p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--color-ink-soft); }

/* ── Six idées (compactes) ── */
.ideas { border-top: 1px solid var(--color-hair); margin-top: 44px; padding: 40px 0 8px; }
.igrid { margin-top: 22px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px 36px; }
.idea { display: flex; gap: 14px; align-items: baseline; }
.idea .num { font-family: var(--font-mono); font-size: 11px; color: var(--color-primary-ink); background: var(--color-primary-soft); padding: 2px 7px; flex: none; }
.idea h3 { font-family: var(--font-display); font-size: 15.5px; font-weight: 650; margin: 0 0 3px; }
.idea p { margin: 0; font-size: 13px; line-height: 1.55; color: var(--color-ink-soft); }

/* ── Étapes numérotées ── */
.steps { border-top: 1px solid var(--color-hair); margin-top: 44px; padding: 40px 0 56px; }
.sgrid { margin-top: 22px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--color-hair); border: 1px solid var(--color-hair); }
.step { background: var(--color-surface); padding: 20px 18px 24px; }
.step .snum { font-family: var(--font-display); font-size: 34px; font-weight: 650; color: var(--color-primary); line-height: 1; }
.step h3 { font-family: var(--font-display); font-size: 16px; font-weight: 650; margin: 10px 0 6px; }
.step p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--color-ink-soft); }

/* ── CTA final illustré ── */
.final { position: relative; color: var(--color-bg); overflow: hidden; }
.final-bg img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.final-veil { position: absolute; inset: 0; background: rgba(44, 33, 18, 0.72); }
.final-body { position: relative; max-width: 1080px; margin: 0 auto; padding: 64px 24px; }
.final h2 { font-family: var(--font-display); font-size: clamp(24px, 3.5vw, 34px); font-weight: 650; letter-spacing: -0.015em; margin: 0 0 22px; max-width: 560px; }

.foot { border-top: 1px solid var(--color-hair); padding: 18px 24px; display: flex; align-items: baseline; gap: 14px; max-width: 1080px; margin: 0 auto; width: 100%; }
.brand-foot { font-family: var(--font-display); font-weight: 700; font-size: 15px; }
.foot .muted { font-size: 12.5px; }

@media (max-width: 860px) {
  .fgrid { grid-template-columns: 1fr; }
  .igrid { grid-template-columns: 1fr; }
  .sgrid { grid-template-columns: 1fr 1fr; }
  .hero-body { padding: 56px 24px 64px; }
}
@media (max-width: 520px) {
  .sgrid { grid-template-columns: 1fr; }
}
</style>
