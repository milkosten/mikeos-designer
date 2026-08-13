// app.js — mikeos-designer SPA controller. Vanilla ES modules, no framework.
import { auth } from "/assets/auth.js";
import { api, isMock, AuthError } from "/assets/api.js";
import { highlightHtml } from "/assets/highlight.js";
import { makeZip } from "/assets/zip.js";
import { mockApi } from "/assets/mock.js";

const CFG = window.DESIGNER_CONFIG;
const root = document.getElementById("root");

// Persist the interactive choice per session.
function loadInteractive() {
  try { return sessionStorage.getItem("designer.interactive") === "1"; } catch { return false; }
}
function saveInteractive(v) { try { sessionStorage.setItem("designer.interactive", v ? "1" : "0"); } catch {} }

// ---------- app state ----------
const state = {
  meta: null,
  projects: [],
  project: null,      // full current project { id,title,pages:[{file,html}],url,... }
  activeTab: "preview",  // preview | code
  activePage: 0,         // index into project.pages
  generating: false,
  progress: [],          // live [{stage,detail}] during generation
  interactive: loadInteractive(),
  editMode: false,       // click-to-edit ("Select") toggle
  // live streaming buffers, keyed by file -> accumulated html
  live: null,            // { files:{file:html}, current:file, order:[file] } during a stream
  brief: null,           // current editable brief object
  briefOpen: false,
  versions: null,        // cached versions list for the open project
  versionsOpen: false,
  booting: true,
};

// ---------- helpers ----------
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastHost;
function toast(msg, kind = "") {
  if (!toastHost) { toastHost = el("div", { class: "toasts" }); document.body.appendChild(toastHost); }
  const t = el("div", { class: "toast " + kind }, msg);
  toastHost.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 250); }, 3200);
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return "";
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return d.toLocaleDateString();
}

async function guard(fn, { authRetry = true } = {}) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof AuthError && authRetry && !isMock()) {
      toast("Session expired — signing you back in…");
      auth.clear();
      setTimeout(() => auth.login(), 600);
      return;
    }
    toast(e.message || "Something went wrong", "err");
    throw e;
  }
}

// ---------- click-to-edit: build a CSS selector for a clicked element ----------
function cssSelectorFor(node) {
  if (!node || node.nodeType !== 1) return "";
  if (node.id) return "#" + CSS.escape(node.id);
  const parts = [];
  let n = node;
  for (let depth = 0; n && n.nodeType === 1 && depth < 5; depth++) {
    let sel = n.tagName.toLowerCase();
    const parent = n.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter((c) => c.tagName === n.tagName);
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(n) + 1})`;
    }
    parts.unshift(sel);
    if (n.id) { parts[0] = "#" + CSS.escape(n.id); break; }
    n = parent;
    if (n && (n.tagName === "BODY" || n.tagName === "HTML")) break;
  }
  return parts.join(" > ");
}

// Wire click-to-edit into a (same-origin) preview iframe once it loads.
function wireSelectMode(frame) {
  const attach = () => {
    let doc;
    try { doc = frame.contentDocument; } catch { doc = null; }
    if (!doc || !doc.body) return; // cross-origin / not ready — degrade gracefully
    doc.body.classList.toggle("mkd-select-on", state.editMode);
    // (Re)inject a tiny style for the hover outline.
    let st = doc.getElementById("mkd-select-style");
    if (!st) {
      st = doc.createElement("style"); st.id = "mkd-select-style";
      st.textContent = ".mkd-select-on * { cursor: crosshair !important; }" +
        ".mkd-hover-outline { outline: 2px solid #6d8bff !important; outline-offset: 1px; }";
      doc.head && doc.head.appendChild(st);
    }
    if (frame._mkdWired) return;
    frame._mkdWired = true;
    let last = null;
    doc.addEventListener("mouseover", (e) => {
      if (!state.editMode) return;
      if (last) last.classList.remove("mkd-hover-outline");
      last = e.target; if (last && last.classList) last.classList.add("mkd-hover-outline");
    }, true);
    doc.addEventListener("mouseout", () => { if (last) last.classList.remove("mkd-hover-outline"); }, true);
    doc.addEventListener("click", (e) => {
      if (!state.editMode) return;
      e.preventDefault(); e.stopPropagation();
      const node = e.target;
      const selector = cssSelectorFor(node);
      let outer = "";
      try { outer = node.outerHTML.slice(0, 600); } catch {}
      openSelectPrompt(node, selector, outer);
    }, true);
  };
  frame.addEventListener("load", attach);
  // srcdoc frames may already be loaded
  setTimeout(attach, 60);
}

// A small inline prompt anchored to the clicked element.
function openSelectPrompt(node, selector, outerHtml) {
  const existing = document.getElementById("mkd-select-pop");
  if (existing) existing.remove();
  const tag = (node && node.tagName ? node.tagName.toLowerCase() : "element");
  const input = el("input", { type: "text", placeholder: `Change this <${tag}>…`, autofocus: true });
  const pop = el("div", { class: "select-pop", id: "mkd-select-pop" },
    el("div", { class: "sp-head" }, `Editing <${tag}>`,
      el("button", { class: "sp-x", title: "Cancel", onclick: () => pop.remove() }, "×")),
    el("div", { class: "sp-sel", title: selector }, selector || "(selector unavailable)"),
    el("div", { class: "sp-row" }, input,
      el("button", { class: "btn primary sm", onclick: () => go() }, "Apply")));
  const go = () => {
    const v = input.value.trim();
    if (!v) return;
    pop.remove();
    state.editMode = false;
    onEdit(v, { selector, outer_html: outerHtml, file: currentFile() });
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") pop.remove(); });
  document.body.appendChild(pop);
  setTimeout(() => input.focus(), 20);
}

function currentFile() {
  if (!state.project) return undefined;
  const pg = state.project.pages[state.activePage] || state.project.pages[0];
  return pg && pg.file;
}

// The preview URL for a page. In production the project is a real hosted site;
// in mock mode there is no host, so we render into the iframe via srcdoc.
function previewIframe(project, pageIndex) {
  const page = project.pages[pageIndex] || project.pages[0];
  const frame = el("iframe", { class: "preview-frame", title: "Preview",
    sandbox: "allow-scripts allow-forms allow-popups allow-same-origin" });
  if (isMock()) {
    frame.srcdoc = mockApi._htmlFor(project.id, page.file);
  } else {
    // project.url ends with "/"; append the page file (index.html for the first page).
    const base = project.url.endsWith("/") ? project.url : project.url + "/";
    frame.src = base + page.file;
  }
  wireSelectMode(frame);
  return frame;
}

// ---------- rendering ----------
function render() {
  root.innerHTML = "";
  if (state.booting) { root.appendChild(bootScreen()); return; }
  if (!isMock() && !auth.isAuthed()) { root.appendChild(loginScreen()); return; }
  root.appendChild(topbar());
  root.appendChild(el("div", { class: "split" }, leftPanel(), rightPanel()));
}

function bootScreen() {
  return el("div", { class: "login" },
    el("div", { class: "card" },
      el("div", { class: "logo-lg" }, "D"),
      el("div", { class: "spin", style: "margin:0 auto" })));
}

function loginScreen() {
  return el("div", { class: "login" },
    el("div", { class: "card" },
      el("div", { class: "logo-lg" }, "D"),
      el("h1", {}, "MikeOS Designer"),
      el("p", {}, "Describe a website. Watch it get built. Publish it in one click."),
      el("button", { class: "btn primary block", onclick: () => auth.login() },
        "Login with MikeOS")));
}

// Start a fresh, empty project (clears the current one; render() rebuilds empty inputs).
function newProject() {
  state.project = null;
  state.activePage = 0;
  state.activeTab = "preview";
  state.brief = null; state.briefOpen = false;
  state.versions = null; state.versionsOpen = false;
  state.editMode = false;
  render();
  toast("New project — describe what you want on the left.");
}

// Dropdown of previous designs + a "New project" button.
function projectSwitcher() {
  const sel = el("select", { class: "proj-select", title: "Open one of your previous designs",
    onchange: (e) => { const id = e.target.value; if (id) openProject(id); } });
  sel.appendChild(el("option", { value: "" },
    state.projects.length ? `Previous designs (${state.projects.length})` : "No saved designs yet"));
  for (const p of state.projects) {
    const when = p.updated_at ? "  ·  " + fmtDate(p.updated_at) : "";
    const opt = el("option", { value: p.id }, (p.title || p.id) + when);
    if (state.project && state.project.id === p.id) opt.selected = true;
    sel.appendChild(opt);
  }
  return el("div", { class: "proj-switcher" },
    sel,
    el("button", { class: "btn sm", title: "Start a new empty project",
      onclick: () => newProject() }, "＋ New project"));
}

function topbar() {
  const u = isMock() ? { name: "Demo user (mock)" } : auth.user();
  return el("div", { class: "topbar" },
    el("div", { class: "brand" },
      el("div", { class: "logo" }, "D"),
      el("span", {}, "MikeOS Designer"),
      isMock() && el("small", {}, "· mock mode")),
    projectSwitcher(),
    el("div", { class: "spacer" }),
    el("div", { class: "who" },
      el("span", { class: "dot" }),
      el("span", {}, u ? u.name : "signed in")),
    !isMock() && el("button", { class: "btn ghost sm", onclick: () => auth.logout() }, "Sign out"));
}

// ----- left panel -----
function leftPanel() {
  const promptEl = el("textarea", { id: "prompt",
    placeholder: "Describe the website you want…\n\ne.g. A landing page for a specialty coffee roaster in Malmö, warm tones, a menu section and a contact form." });

  const styleSel = el("select", { id: "style" });
  if (state.meta) {
    for (const s of state.meta.styles) styleSel.appendChild(el("option", { value: s.id, title: s.description }, s.name));
  } else {
    styleSel.appendChild(el("option", {}, "Loading…"));
    styleSel.disabled = true;
  }

  // Interactive toggle (persisted per session).
  const interactiveToggle = el("label", { class: "switch", title: "Allow self-contained JavaScript so the page is a real clickable prototype" },
    el("input", { type: "checkbox", id: "interactive",
      onchange: (e) => { state.interactive = e.target.checked; saveInteractive(state.interactive); } }),
    el("span", { class: "track" }, el("span", { class: "knob" })),
    el("span", { class: "switch-label" }, "Interactive"));
  const cb = interactiveToggle.querySelector("input");
  cb.checked = state.interactive;

  const genBtn = el("button", { class: "btn primary block", disabled: state.generating || !state.meta,
    onclick: () => onGenerate(promptEl.value, styleSel.value) },
    state.generating ? el("span", { class: "spin" }) : null,
    state.generating ? " Generating…" : "Generate");

  // refine — only shown once a project exists (it's how you change it by prompt)
  const refineInput = el("input", { type: "text", placeholder: "Tell it what to change…",
    disabled: state.generating });
  const refineBtn = el("button", { class: "btn", disabled: state.generating,
    onclick: () => { const v = refineInput.value.trim(); if (v) { refineInput.value = ""; onEdit(v, {}); } } });
  refineBtn.textContent = "Send";
  refineInput.addEventListener("keydown", (e) => { if (e.key === "Enter") refineBtn.click(); });

  return el("div", { class: "left" },
    el("div", { class: "scroll" },
      el("div", { class: "field" },
        el("label", {}, "What do you want to build?"),
        promptEl),
      el("div", { class: "field" },
        el("label", {}, "Design style"),
        styleSel),
      interactiveToggle,
      genBtn,
      state.project ? el("div", { class: "divider" }) : null,
      state.project ? el("div", { class: "section-title" }, "Change it") : null,
      state.project ? el("div", { class: "refine-hint" }, "Type a change, or use the Select tool in the preview to click an element.") : null,
      state.project ? el("div", { class: "refine" }, refineInput, refineBtn) : null,
      state.project ? restyleControl() : null,
      state.project ? briefPanel() : null,
      el("div", { class: "divider" }),
      el("div", { class: "section-title" }, "My projects",
        el("span", { class: "count" }, state.projects.length ? `(${state.projects.length})` : "")),
      projectsList()));
}

// Phase 4: a small style dropdown that re-renders the SAME content in a new style.
function restyleControl() {
  if (!state.meta) return null;
  const sel = el("select", { class: "restyle-select", disabled: state.generating,
    title: "Re-render the same content in a different style",
    onchange: (e) => { const s = e.target.value; if (s && s !== state.project.style) onRestyle(s); e.target.value = state.project.style; } });
  for (const s of state.meta.styles) {
    const o = el("option", { value: s.id }, "Restyle → " + s.name);
    if (state.project.style === s.id) o.selected = true;
    sel.appendChild(o);
  }
  return el("div", { class: "restyle" }, sel);
}

// Phase 5: version history (list + revert).
function versionHistory() {
  const btn = el("button", { class: "btn sm block-left", disabled: state.generating,
    onclick: () => toggleVersions() },
    (state.versionsOpen ? "▾ " : "▸ ") + "History");
  const wrap = el("div", { class: "history" }, btn);
  if (state.versionsOpen) {
    const body = el("div", { class: "history-body" });
    if (!state.versions) body.appendChild(el("div", { class: "empty" }, "Loading…"));
    else if (!state.versions.length) body.appendChild(el("div", { class: "empty" }, "No versions yet."));
    else for (const v of state.versions) {
      body.appendChild(el("div", { class: "ver" },
        el("div", { class: "ver-meta" },
          el("div", { class: "ver-note" }, v.note || v.version_id),
          el("div", { class: "ver-when" }, fmtDate(v.created_at))),
        el("button", { class: "btn sm", disabled: state.generating,
          onclick: () => onRevert(v.version_id) }, "Revert")));
    }
    wrap.appendChild(body);
  }
  return wrap;
}

async function toggleVersions() {
  state.versionsOpen = !state.versionsOpen;
  if (state.versionsOpen && state.project) {
    state.versions = null; render();
    await guard(async () => { state.versions = (await api.versions(state.project.id)) || []; });
  }
  render();
}

// Phase 4: editable Brief panel ("how I understood it").
function briefPanel() {
  const b = state.brief;
  const head = el("button", { class: "brief-head", onclick: () => { state.briefOpen = !state.briefOpen; render(); } },
    el("span", {}, (state.briefOpen ? "▾ " : "▸ ") + "Brief"),
    el("span", { class: "brief-sub" }, "how I understood it"));
  const wrap = el("div", { class: "brief" }, head);
  if (!state.briefOpen) return wrap;
  if (!b) { wrap.appendChild(el("div", { class: "empty" }, "No brief yet — generate or open a project.")); return wrap; }

  const brand = el("input", { type: "text", value: b.brand || "", disabled: state.generating });
  const tagline = el("input", { type: "text", value: b.tagline || "", disabled: state.generating });
  const tone = el("input", { type: "text", value: b.tone || "", disabled: state.generating });
  const sections = el("textarea", { class: "brief-sections", disabled: state.generating },
    (Array.isArray(b.sections) ? b.sections.join("\n") : (b.sections || "")));

  const rebuild = el("button", { class: "btn sm", disabled: state.generating, onclick: () => {
    const next = {
      brand: brand.value.trim(),
      tagline: tagline.value.trim(),
      tone: tone.value.trim(),
      sections: sections.value.split("\n").map((s) => s.trim()).filter(Boolean),
    };
    onRebuildBrief(next);
  } }, "Rebuild from brief");

  wrap.appendChild(el("div", { class: "brief-body" },
    briefField("Brand", brand),
    briefField("Tagline", tagline),
    briefField("Tone", tone),
    briefField("Section outline (one per line)", sections),
    el("div", { class: "brief-actions" }, rebuild)));
  return wrap;
}
function briefField(label, input) {
  return el("div", { class: "field" }, el("label", {}, label), input);
}

function projectsList() {
  if (!state.projects.length) return el("div", { class: "empty" }, "No projects yet. Generate your first site above.");
  const list = el("div", { class: "projects cards" });
  for (const p of state.projects) {
    const active = state.project && state.project.id === p.id;
    const thumb = p.thumbnail
      ? el("img", { class: "thumb", src: p.thumbnail, alt: "", loading: "lazy" })
      : el("div", { class: "thumb thumb-ph" }, "✦");
    list.appendChild(el("div", { class: "proj card" + (active ? " active" : ""),
      onclick: () => openProject(p.id) },
      thumb,
      el("div", { class: "meta" },
        el("div", { class: "name" }, p.title || "Untitled"),
        el("div", { class: "sub" }, `${p.page_type || "page"} · ${p.style || ""} · ${fmtDate(p.updated_at)}`)),
      el("button", { class: "del", title: "Delete",
        onclick: (e) => { e.stopPropagation(); onDelete(p.id); } }, "×")));
  }
  return list;
}

// ----- right panel -----
function rightPanel() {
  const selectBtn = (state.project && !state.generating)
    ? el("button", { class: "btn sm" + (state.editMode ? " on" : ""), title: "Click an element in the preview to edit it",
        onclick: () => { state.editMode = !state.editMode; render(); } },
        state.editMode ? "◉ Selecting" : "◎ Select")
    : null;

  const head = el("div", { class: "right-head" },
    el("div", { class: "tabs" },
      tabBtn("Preview", "preview"),
      tabBtn("Code", "code")),
    selectBtn,
    el("div", { class: "spacer" }),
    state.project ? urlPill() : null,
    state.project ? versionHistory() : null,
    state.project ? el("button", { class: "btn sm", onclick: onPublish }, "Publish") : null,
    state.project ? el("button", { class: "btn sm", onclick: onDownload }, "Download") : null);

  const body = el("div", { class: "right-body" });
  if (state.generating) {
    // Phase 1: live preview building up, with the stage list beside it.
    body.appendChild(liveView());
  } else if (!state.project) {
    body.appendChild(placeholder());
  } else {
    if (state.activeTab === "preview") body.appendChild(previewIframe(state.project, state.activePage));
    else body.appendChild(codeView());
  }

  // multi-page sub-tab bar sits between head and body
  const wrap = el("div", { class: "right" }, head);
  if (!state.generating && state.project && state.project.pages.length > 1) wrap.appendChild(pageBar());
  wrap.appendChild(body);
  return wrap;
}

function tabBtn(label, id) {
  return el("button", { class: "tab" + (state.activeTab === id ? " active" : ""),
    onclick: () => { state.activeTab = id; render(); } }, label);
}

function pageBar() {
  const bar = el("div", { class: "pagebar" });
  state.project.pages.forEach((pg, i) => {
    bar.appendChild(el("button", { class: "pagetab" + (state.activePage === i ? " active" : ""),
      onclick: () => { state.activePage = i; state.editMode = false; render(); } }, pg.file));
  });
  return bar;
}

function urlPill() {
  const url = state.project.url || "";
  return el("div", { class: "url-pill", title: url },
    isMock() ? el("span", {}, url) : el("a", { href: url, target: "_blank", rel: "noopener" }, url));
}

function codeView() {
  const page = state.project.pages[state.activePage] || state.project.pages[0];
  const pre = el("pre");
  const code = el("code", { html: highlightHtml(page.html || "") });
  pre.appendChild(code);
  return el("div", { class: "code-wrap" }, pre);
}

const EXAMPLE_PROMPTS = [
  "A CI/CD pipeline dashboard for a self-hosted DevOps tool — success rate, build durations, and a recent-builds table",
  "The account settings screen for a team chat app — profile, notifications, and billing sections",
  "A signup / onboarding screen for a habit-tracking app, with a short value pitch beside the form",
  "A pricing page for a SaaS uptime monitor — three tiers and a feature comparison table",
  "A distraction-free writing app: a document editor with a sidebar of documents",
  "An inbox screen for a support ticketing tool — a message list with a reading pane and status labels",
];

// Fill the prompt on the left with an example and generate it (one-click test).
function useExample(text) {
  const p = document.getElementById("prompt");
  if (p) p.value = text;
  const styleEl = document.getElementById("style");
  const style = (styleEl && styleEl.value) ||
    (state.meta && state.meta.styles[0] && state.meta.styles[0].id) || "modern";
  onGenerate(text, style);
}

function placeholder() {
  const examples = el("div", { class: "examples" });
  for (const ex of EXAMPLE_PROMPTS) {
    examples.appendChild(el("button", { class: "example", title: "Generate this",
      onclick: () => useExample(ex) }, ex));
  }
  return el("div", { class: "placeholder" },
    el("div", { class: "inner" },
      el("div", { class: "big" }, "✦"),
      el("h2", {}, "Your design will appear here"),
      el("p", {}, "Describe what you want on the left and hit Generate — or try one of these:"),
      examples,
      el("p", { class: "examples-hint" }, "Tip: the page type is detected automatically; pick a Design style on the left to change the look.")));
}

// ---------- Phase 1: live streaming view (preview builds up + stage list) ----------
function liveView() {
  const box = el("div", { class: "live-view", id: "live-view" });
  // stage list (compact, top)
  const steps = el("div", { class: "live-steps" });
  const title = el("div", { class: "gen-title" },
    el("span", { class: "spin" }),
    el("span", {}, state.live && state.live.current
      ? `Building ${state.live.current}…`
      : (state.project ? "Refining your design…" : "Building your design…")));
  steps.appendChild(title);
  const list = el("div", { class: "gen-steps" });
  const stps = state.progress;
  if (!stps.length) {
    list.appendChild(el("div", { class: "gen-step active" },
      el("span", { class: "gs-dot" }), el("span", { class: "gs-label" }, "Starting…")));
  } else {
    stps.forEach((s, i) => {
      const isLast = i === stps.length - 1;
      list.appendChild(el("div", { class: "gen-step " + (isLast ? "active" : "done") },
        el("span", { class: "gs-dot" }, isLast ? "" : "✓"),
        el("span", { class: "gs-label" }, s.stage + (s.detail ? "  ·  " + s.detail : ""))));
    });
  }
  steps.appendChild(list);
  box.appendChild(steps);

  // live preview iframe — updated via srcdoc as tokens arrive
  const frame = el("iframe", { class: "preview-frame live-frame", id: "live-frame", title: "Live preview",
    sandbox: "allow-scripts allow-forms allow-popups allow-same-origin" });
  frame.srcdoc = (state.live && state.live.current && state.live.files[state.live.current]) || "<!doctype html><body style='font-family:system-ui;color:#888;display:grid;place-items:center;height:100vh'>Waiting for the first lines…</body>";
  box.appendChild(el("div", { class: "live-preview" }, frame));
  return box;
}

// Throttled live srcdoc updates while tokens stream in.
let liveThrottle = 0;
function updateLiveFrame(force) {
  const now = Date.now();
  if (!force && now - liveThrottle < 250) return;
  liveThrottle = now;
  const frame = document.getElementById("live-frame");
  if (frame && state.live && state.live.current) {
    const html = state.live.files[state.live.current] || "";
    if (html) frame.srcdoc = html;
  }
  // also refresh the title/steps
  const lv = document.getElementById("live-view");
  if (lv) lv.replaceWith(liveView());
}
function renderProgress() { updateLiveFrame(false); }

// ---------- actions ----------
async function loadMeta() {
  try { state.meta = await api.meta(); }
  catch (e) { toast("Could not load styles/types: " + (e.message || e), "err"); }
}
async function loadProjects() {
  await guard(async () => { state.projects = (await api.listProjects()) || []; });
}

// Shared SSE event handler: fills the live buffers + stage list as frames arrive.
function makeStreamHandler() {
  state.live = { files: {}, current: null, order: [] };
  return (evt) => {
    switch (evt.type) {
      case "progress":
        state.progress.push(evt); updateLiveFrame(true); break;
      case "brief":
        state.brief = evt.brief; break;
      case "page_start":
        state.live.current = evt.file;
        if (!state.live.order.includes(evt.file)) state.live.order.push(evt.file);
        if (state.live.files[evt.file] == null) state.live.files[evt.file] = "";
        updateLiveFrame(true); break;
      case "token":
        if (state.live.files[evt.file] == null) state.live.files[evt.file] = "";
        state.live.files[evt.file] += (evt.delta || "");
        state.live.current = evt.file;
        updateLiveFrame(false); break;
      case "page_done":
        updateLiveFrame(true); break;
      case "error":
        break; // surfaced by the promise rejection
    }
  };
}

async function onGenerate(prompt, style, title) {
  prompt = (prompt || "").trim();
  if (!prompt) { toast("Describe what you want first.", "err"); return; }
  state.generating = true; state.progress = []; state.editMode = false;
  state.brief = null; render();
  await guard(async () => {
    // page_type "auto" -> the GPU infers it; stream events into the live preview
    const payload = { prompt, page_type: "auto", style, interactive: state.interactive, title: title || undefined };
    const onEvent = makeStreamHandler();
    const proj = api.createProjectStream
      ? await api.createProjectStream(payload, onEvent)
      : await api.createProject(payload);
    applyProject(proj);
    await loadProjects();
    toast(proj.page_type ? `Built a ${proj.page_type}.` : "Site generated.", "ok");
  });
  state.generating = false; state.progress = []; state.live = null; render();
}

// Phase 2: fast targeted refine / click-to-edit — both go through /edit (SSE).
async function onEdit(instruction, { selector, outer_html, file } = {}) {
  if (!state.project) return;
  state.generating = true; state.progress = []; render();
  await guard(async () => {
    const body = { instruction };
    if (file) body.file = file;
    if (selector) body.selector = selector;
    if (outer_html) body.outer_html = outer_html;
    const onEvent = makeStreamHandler();
    const proj = api.editStream
      ? await api.editStream(state.project.id, body, onEvent)
      : await api.refine(state.project.id, instruction);
    applyProject(proj);
    await loadProjects();
    if (state.versionsOpen) state.versions = await api.versions(proj.id).catch(() => state.versions);
    toast("Applied your change.", "ok");
  });
  state.generating = false; state.progress = []; state.live = null; render();
}

// Phase 4: rebuild from an edited brief (SSE).
async function onRebuildBrief(brief) {
  if (!state.project) return;
  state.generating = true; state.progress = []; render();
  await guard(async () => {
    const onEvent = makeStreamHandler();
    const proj = await api.putBriefStream(state.project.id, brief, onEvent);
    applyProject(proj);
    await loadProjects();
    toast("Rebuilt from your brief.", "ok");
  });
  state.generating = false; state.progress = []; state.live = null; render();
}

// Phase 4: restyle — same content, new look (SSE).
async function onRestyle(style) {
  if (!state.project) return;
  state.generating = true; state.progress = []; render();
  await guard(async () => {
    const onEvent = makeStreamHandler();
    const proj = await api.restyleStream(state.project.id, style, onEvent);
    applyProject(proj);
    await loadProjects();
    toast("Restyled to " + style + ".", "ok");
  });
  state.generating = false; state.progress = []; state.live = null; render();
}

// Phase 5: revert to a prior version.
async function onRevert(versionId) {
  if (!state.project) return;
  await guard(async () => {
    const proj = await api.revert(state.project.id, versionId);
    applyProject(proj);
    state.versions = await api.versions(proj.id).catch(() => state.versions);
    await loadProjects();
    toast("Reverted to " + versionId + ".", "ok");
    render();
  });
}

// Adopt a project into state, keeping activePage valid and syncing brief.
function applyProject(proj) {
  state.project = proj;
  if (state.activePage >= proj.pages.length) state.activePage = 0;
  state.activeTab = "preview";
  if (proj.brief) state.brief = proj.brief;
}

async function openProject(id) {
  await guard(async () => {
    const proj = await api.getProject(id);
    state.project = proj; state.activePage = 0; state.activeTab = "preview";
    state.editMode = false;
    state.brief = proj.brief || null;
    state.versions = null; state.versionsOpen = false;
    // If the project object didn't include a brief, fetch it.
    if (!state.brief && api.getBrief) {
      try { const r = await api.getBrief(id); state.brief = (r && r.brief) || null; } catch {}
    }
    render();
  });
}

async function onDelete(id) {
  if (!confirm("Delete this project? This cannot be undone.")) return;
  await guard(async () => {
    await api.deleteProject(id);
    if (state.project && state.project.id === id) { state.project = null; state.brief = null; }
    await loadProjects();
    toast("Project deleted.");
    render();
  });
}

async function onPublish() {
  if (!state.project) return;
  await guard(async () => {
    const res = await api.publish(state.project.id);
    const url = (res && res.url) || state.project.url;
    state.project.url = url;
    if (res && res.visibility) state.project.visibility = res.visibility;
    render();
    try { await navigator.clipboard.writeText(url); toast("Published! Link copied: " + url, "ok"); }
    catch { toast("Published: " + url, "ok"); }
  });
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onDownload() {
  if (!state.project) return;
  const pages = state.project.pages || [];
  const slug = (state.project.title || state.project.id || "site").replace(/[^\w-]+/g, "-").toLowerCase();
  if (pages.length <= 1) {
    const p = pages[0];
    if (!p) return;
    downloadBlob(new Blob([p.html], { type: "text/html" }), p.file || "index.html");
    toast("Downloaded " + (p.file || "index.html"));
  } else {
    const zip = makeZip(pages.map((p) => ({ name: p.file, data: p.html })));
    downloadBlob(zip, slug + ".zip");
    toast(`Downloaded ${pages.length} pages as ${slug}.zip`);
  }
}

// ---------- boot ----------
async function boot() {
  render();  // shows boot spinner

  // If we're on the OAuth callback, finish the exchange first.
  if (location.pathname === "/auth/callback" || new URLSearchParams(location.search).has("code")) {
    if (!isMock()) {
      const ok = await auth.handleCallback();
      // clean the URL back to the app root regardless of outcome
      history.replaceState(null, "", "/");
      if (!ok) { state.booting = false; render(); return; }
    } else {
      history.replaceState(null, "", "/");
    }
  }

  if (!isMock() && !auth.isAuthed()) { state.booting = false; render(); return; }

  await loadMeta();
  await loadProjects();
  state.booting = false;
  render();
}

boot();
