/**
 * Memento — embeddable agent widget.
 *
 * One <script> tag turns any page into a chat that answers from a PUBLIC Memento
 * KB, and from it alone (engine: supabase/functions/agent, streamed over SSE).
 * Self-contained: no framework, no dependency, styles isolated in a Shadow DOM.
 *
 *   <script src="https://me.mento.cc/agent-widget.js"
 *           data-workspace="oto-ninja-faq"
 *           data-kb-name="oto.ninja — FAQ"
 *           data-title="Une question ?"
 *           data-accent="#b8541f"></script>
 *
 * Modes:
 *   - default            → floating launcher (bottom-right) + pop-up panel.
 *   - data-target="#sel" → mounts the panel inline inside that element (no launcher).
 *
 * Config (all data-* on the script tag, all optional but data-workspace):
 *   data-workspace  REQUIRED — public KB slug the agent answers from.
 *   data-kb-name    header label (default: the slug).
 *   data-title      panel headline (default: "Une question ?").
 *   data-greeting   first assistant hint (default: derived from kb-name).
 *   data-placeholder input placeholder (default: "Votre question…").
 *   data-accent     accent color (default: warm terracotta).
 *   data-base       agent base URL (default: the script's own origin).
 *   data-target     CSS selector → inline mount instead of floating launcher.
 *   data-position   "right" (default) | "left" — launcher side, float mode only.
 */
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;
  var d = script.dataset;
  var WORKSPACE = (d.workspace || "").trim();
  if (!WORKSPACE) {
    console.error("[memento-agent] data-workspace is required");
    return;
  }
  var KB_NAME = d.kbName || WORKSPACE;
  var TITLE = d.title || "Une question ?";
  var GREETING = d.greeting ||
    ('Posez votre question : je réponds à partir du contenu de « ' + KB_NAME + ' », et de lui seul.');
  var PLACEHOLDER = d.placeholder || "Votre question…";
  var ACCENT = d.accent || "#b8541f";
  var POSITION = d.position === "left" ? "left" : "right";
  var TARGET = d.target || null;
  // Base URL: explicit data-base, else the origin the script was served from.
  var BASE = (d.base || new URL(script.src).origin).replace(/\/+$/, "");

  // ── Minimal, safe markdown → HTML (the agent replies in markdown) ─────────
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function renderMd(src) {
    var blocks = esc(src || "").split(/\n{2,}/);
    var html = "";
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i].trim();
      if (!b) continue;
      var lines = b.split("\n");
      var isList = lines.every(function (l) { return /^\s*[-*]\s+/.test(l); });
      if (isList) {
        html += "<ul>" + lines.map(function (l) {
          return "<li>" + inline(l.replace(/^\s*[-*]\s+/, "")) + "</li>";
        }).join("") + "</ul>";
      } else {
        html += "<p>" + lines.map(inline).join("<br>") + "</p>";
      }
    }
    return html;
  }
  function inline(s) {
    // links [text](url) — only http(s), opened in a new tab
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_m, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
    });
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return s;
  }

  // ── SSE: POST /agent/chat, stream token/status/error events ───────────────
  function chat(message, history, onEvent) {
    return fetch(BASE + "/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ workspace: WORKSPACE, message: message, history: history }),
    }).then(function (res) {
      if (!res.ok || !res.body) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.error || ("agent → " + res.status));
        });
      }
      var reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += r.value;
          var chunks = buf.split("\n\n");
          buf = chunks.pop() || "";
          for (var i = 0; i < chunks.length; i++) {
            var event = "message", data = "";
            var ls = chunks[i].split("\n");
            for (var j = 0; j < ls.length; j++) {
              if (ls[j].indexOf("event:") === 0) event = ls[j].slice(6).trim();
              else if (ls[j].indexOf("data:") === 0) data += ls[j].slice(5).trim();
            }
            if (!data) continue;
            try {
              var p = JSON.parse(data);
              if (event === "token") onEvent({ type: "token", text: p.text || "" });
              else if (event === "status") onEvent({ type: "status" });
              else if (event === "error") onEvent({ type: "error", message: p.message || "error" });
            } catch (e) { /* partial chunk */ }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  // ── Styles (scoped to the shadow root) ────────────────────────────────────
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".launcher{position:fixed;bottom:22px;z-index:2147483000;width:56px;height:56px;border-radius:50%;",
    "border:none;cursor:pointer;background:var(--accent);color:#fff;box-shadow:0 6px 22px rgba(0,0,0,.22);",
    "font-size:24px;line-height:1;display:flex;align-items:center;justify-content:center;transition:transform .15s}",
    ".launcher:hover{transform:scale(1.06)}",
    ".launcher.right{right:22px}.launcher.left{left:22px}",
    ".panel{display:flex;flex-direction:column;background:#fdfcfa;color:#2c2112;",
    "border:1px solid #e7e0d4;overflow:hidden}",
    ".panel.float{position:fixed;bottom:90px;z-index:2147483000;width:380px;max-width:calc(100vw - 32px);",
    "height:560px;max-height:calc(100vh - 130px);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.24)}",
    ".panel.float.right{right:22px}.panel.float.left{left:22px}",
    ".panel.inline{width:100%;height:100%;min-height:440px;border-radius:12px}",
    ".head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--accent);color:#fff}",
    ".head .mark{font-size:16px}",
    ".head .t{flex:1;min-width:0}",
    ".head .t .kb{font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.85}",
    ".head .t .ti{font-size:15px;font-weight:700;margin-top:1px}",
    ".head .x{background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;opacity:.85;padding:2px 4px}",
    ".head .x:hover{opacity:1}",
    ".body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.55}",
    ".hint{color:#7a6f5e;font-style:italic;margin:0}",
    ".msg{display:flex}.msg.user{justify-content:flex-end}",
    ".bubble{max-width:86%;padding:9px 12px;border-radius:12px;border:1px solid #e7e0d4}",
    ".bubble.user{background:var(--accent);color:#fff;border-color:var(--accent)}",
    ".bubble.bot{background:#fff}",
    ".bubble p{margin:0 0 8px}.bubble p:last-child{margin:0}",
    ".bubble a{color:var(--accent);text-decoration:underline}",
    ".bubble.user a{color:#fff}",
    ".bubble code{font-family:ui-monospace,monospace;font-size:12.5px;background:#f1ece2;padding:1px 4px;border-radius:3px}",
    ".bubble ul{margin:4px 0 8px;padding-left:20px}",
    ".status{color:#7a6f5e;font-style:italic;font-size:13px;margin:0}",
    ".err{color:#a23b2c;font-size:13px;margin:0}",
    ".foot{display:flex;gap:8px;padding:12px 14px;border-top:1px solid #e7e0d4;background:#fdfcfa}",
    ".foot textarea{flex:1;resize:none;font:inherit;font-size:13.5px;line-height:1.5;padding:9px 11px;",
    "border:1px solid #e7e0d4;border-radius:9px;background:#fff;color:#2c2112}",
    ".foot textarea:focus{outline:2px solid var(--accent);border-color:var(--accent)}",
    ".foot button{border:none;border-radius:9px;background:var(--accent);color:#fff;font:inherit;",
    "font-size:13px;font-weight:600;padding:0 16px;cursor:pointer}",
    ".foot button:disabled{opacity:.5;cursor:default}",
    ".dots:after{content:'…';animation:dot 1.2s steps(4,end) infinite}",
    "@keyframes dot{0%{content:'.'}33%{content:'..'}66%{content:'…'}}",
  ].join("");

  // ── DOM construction ──────────────────────────────────────────────────────
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function buildPanel(root, variant, onClose) {
    var panel = el("div", "panel " + variant + (variant === "float" ? " " + POSITION : ""));

    var head = el("div", "head");
    head.appendChild(el("span", "mark", "✦"));
    var t = el("div", "t");
    t.appendChild(el("div", "kb", KB_NAME));
    t.appendChild(el("div", "ti", TITLE));
    head.appendChild(t);
    if (variant === "float") {
      var x = el("button", "x", "✕");
      x.setAttribute("aria-label", "Fermer");
      x.onclick = onClose;
      head.appendChild(x);
    }
    panel.appendChild(head);

    var body = el("div", "body");
    var hint = el("p", "hint", GREETING);
    body.appendChild(hint);
    panel.appendChild(body);

    var foot = el("div", "foot");
    var ta = el("textarea");
    ta.rows = 2;
    ta.placeholder = PLACEHOLDER;
    var send = el("button", null, "Envoyer");
    foot.appendChild(ta);
    foot.appendChild(send);
    panel.appendChild(foot);

    var history = [];
    var busy = false;

    function scrollDown() { body.scrollTop = body.scrollHeight; }

    function submit() {
      var text = ta.value.trim();
      if (!text || busy) return;
      if (hint.parentNode) hint.remove();
      ta.value = "";
      busy = true;
      send.disabled = true;

      addMsg("user", text);
      var bot = addMsg("bot", "");
      var acc = "";
      var status = el("p", "status dots", "Recherche dans la base");
      body.appendChild(status);
      scrollDown();

      var priorHistory = history.slice();
      chat(text, priorHistory, function (ev) {
        if (ev.type === "token") {
          if (status.parentNode) status.remove();
          acc += ev.text;
          bot.innerHTML = renderMd(acc);
          scrollDown();
        } else if (ev.type === "error") {
          if (status.parentNode) status.remove();
          var e = el("p", "err", ev.message);
          body.appendChild(e);
        }
      }).catch(function (e) {
        if (status.parentNode) status.remove();
        body.appendChild(el("p", "err", e && e.message ? e.message : "Erreur"));
      }).then(function () {
        if (status.parentNode) status.remove();
        if (!acc) bot.innerHTML = "<p class='hint'>(pas de réponse)</p>";
        else { history.push({ role: "user", content: text }); history.push({ role: "assistant", content: acc }); }
        busy = false;
        send.disabled = false;
        scrollDown();
      });
    }

    function addMsg(role, content) {
      var wrap = el("div", "msg " + role);
      var bubble = el("div", "bubble " + (role === "user" ? "user" : "bot"));
      if (role === "user") bubble.textContent = content;
      else bubble.innerHTML = renderMd(content);
      wrap.appendChild(bubble);
      body.appendChild(wrap);
      return bubble;
    }

    send.onclick = submit;
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    });

    root.appendChild(panel);
    return panel;
  }

  // ── Mount ─────────────────────────────────────────────────────────────────
  function mount() {
    var host = el("div");
    document.body.appendChild(host);
    var shadow = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    var style = el("style");
    style.textContent = CSS.replace(/var\(--accent\)/g, ACCENT);
    shadow.appendChild(style);

    if (TARGET) {
      // Inline mode: render into the target element (the host div is just a CSS carrier).
      var target = document.querySelector(TARGET);
      if (!target) { console.error("[memento-agent] data-target not found:", TARGET); return; }
      var inlineHost = el("div");
      target.appendChild(inlineHost);
      var inlineShadow = inlineHost.attachShadow ? inlineHost.attachShadow({ mode: "open" }) : inlineHost;
      var s2 = el("style");
      s2.textContent = CSS.replace(/var\(--accent\)/g, ACCENT);
      inlineShadow.appendChild(s2);
      buildPanel(inlineShadow, "inline", null);
      host.remove();
      return;
    }

    // Float mode: launcher toggles the panel.
    var launcher = el("button", "launcher " + POSITION, "✦");
    launcher.setAttribute("aria-label", "Ouvrir l'assistant");
    shadow.appendChild(launcher);
    var panel = null;
    launcher.onclick = function () {
      if (panel) { panel.remove(); panel = null; launcher.textContent = "✦"; return; }
      panel = buildPanel(shadow, "float", function () { panel.remove(); panel = null; launcher.textContent = "✦"; });
      launcher.textContent = "✕";
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
