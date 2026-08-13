// app.js — mikeos-designer SPA controller. Vanilla ES modules, no framework.
import { auth } from "/assets/auth.js";
import { api, isMock, AuthError } from "/assets/api.js";
import { highlightHtml } from "/assets/highlight.js";
import { makeZip } from "/assets/zip.js";
import { mockApi } from "/assets/mock.js";

const CFG = window.DESIGNER_CONFIG;
const root = document.getElementById("root");

// ---------- app state ----------
const state = {
  meta: null,
  projects: [],
  project: null,      // full current project { id,title,pages:[{file,html}],url,... }
  activeTab: "preview",  // preview | code
  activePage: 0,         // index into project.pages
  generating: false,
  editMode: false,       // click-to-edit ("Select") toggle
  // chat conversation thread: [{ role:"user"|"assistant", text, steps:[...], kind }]
  messages: [],
  // live streaming buffers, keyed by file -> accumulated html
  live: null,            // { files:{file:html}, current:file, order:[file] } during a stream
  brief: null,           // current editable brief object
  briefOpen: false,
  versions: null,        // cached versions list for the open project
  versionsOpen: false,
  booting: true,
};

// mutable id for the assistant message currently being narrated by the SSE stream
let liveMsg = null;

// append a message to the thread; returns the message object (so a stream can mutate it live)
function pushMessage(role, fields = {}) {
  const m = { role, text: "", steps: [], kind: "", ...fields };
  state.messages.push(m);
  return m;
}

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
    // Drop the click-to-edit instruction into the chat as a user message, then refine.
    const label = `${v}  ·  <${tag}>`;
    pushMessage("user", { text: label });
    onEdit(v, { selector, outer_html: outerHtml, file: currentFile(), userText: label });
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
  scrollThread();
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

// Start a fresh, empty project (clears the current one + the chat thread).
function newProject() {
  state.project = null;
  state.activePage = 0;
  state.activeTab = "preview";
  state.brief = null; state.briefOpen = false;
  state.versions = null; state.versionsOpen = false;
  state.editMode = false;
  state.messages = [];
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

// ----- left panel: the chat conversation -----
function leftPanel() {
  const thread = el("div", { class: "chat-thread", id: "chat-thread" });

  if (!state.messages.length) {
    thread.appendChild(chatIntro());
  } else {
    for (const m of state.messages) thread.appendChild(chatBubble(m));
  }

  return el("div", { class: "left chat" }, thread, composer());
}

// The friendly empty-state intro: an assistant bubble + clickable example chips.
function chatIntro() {
  const chips = el("div", { class: "chat-examples" });
  for (const ex of EXAMPLE_PROMPTS) {
    chips.appendChild(el("button", { class: "chat-chip", disabled: state.generating || !state.meta,
      title: "Build this", onclick: () => sendMessage(ex) }, ex));
  }
  return el("div", { class: "msg assistant" },
    el("div", { class: "avatar" }, "D"),
    el("div", { class: "bubble" },
      el("p", {}, "Hi! Describe the site or app you want and I'll build it live — you'll see it appear in the preview. Here are some ideas to get started:"),
      chips));
}

// Render one chat message (user right-aligned, assistant left with avatar + live steps).
function chatBubble(m) {
  if (m.role === "user") {
    return el("div", { class: "msg user" }, el("div", { class: "bubble" }, m.text));
  }
  const bubble = el("div", { class: "bubble" + (m.kind === "error" ? " error" : "") });
  // live checklist inside the assistant bubble (progress + page steps)
  if (m.steps && m.steps.length) bubble.appendChild(stepList(m.steps));
  if (m.text) bubble.appendChild(el("div", { class: "msg-text", html: mdInline(m.text) }));
  return el("div", { class: "msg assistant" }, el("div", { class: "avatar" }, "D"), bubble);
}

// A compact live checklist: prior steps are ✓, the last (while streaming) shows a spinner.
function stepList(steps) {
  const list = el("div", { class: "chat-steps" });
  steps.forEach((s, i) => {
    const isLast = i === steps.length - 1;
    const pending = isLast && s.pending !== false;
    list.appendChild(el("div", { class: "chat-step " + (pending ? "active" : "done") },
      pending ? el("span", { class: "spin sm" }) : el("span", { class: "chk" }, "✓"),
      el("span", { class: "cs-label", html: mdInline(s.label) })));
  });
  return list;
}

// A very small inline-markdown renderer (**bold** + `code`) → escaped, safe HTML.
function mdInline(s) {
  let out = esc(s == null ? "" : s);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

// The composer pinned at the bottom of the left: style control + textarea + Send.
function composer() {
  const styleSel = el("select", { id: "style", class: "chat-style", title: "Design style",
    disabled: state.generating || !state.meta || !!state.project });
  if (state.meta) {
    for (const s of state.meta.styles) styleSel.appendChild(el("option", { value: s.id, title: s.description }, s.name));
    if (state.project && state.project.style) styleSel.value = state.project.style;
  } else {
    styleSel.appendChild(el("option", {}, "Loading…"));
  }
  // once a project exists the style is changed via Restyle in the preview toolbar, not create
  if (state.project) styleSel.title = "Use Restyle in the preview toolbar to change the look";

  const ta = el("textarea", { id: "prompt", class: "chat-input", rows: 1,
    placeholder: state.project ? "Tell me what to change…" : "Describe the site or app you want…",
    disabled: state.generating });

  const send = () => {
    const v = ta.value.trim();
    if (!v) return;
    ta.value = ""; autoGrow(ta);
    sendMessage(v, styleSel.value);
  };
  const sendBtn = el("button", { class: "btn primary chat-send", title: "Send",
    disabled: state.generating || !state.meta,
    onclick: send },
    state.generating ? el("span", { class: "spin" }) : el("span", { html: "&#8593;" }));

  ta.addEventListener("input", () => autoGrow(ta));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  return el("div", { class: "composer" },
    el("div", { class: "composer-tools" },
      el("label", { class: "style-lbl" }, "Style"),
      styleSel),
    el("div", { class: "composer-row" }, ta, sendBtn));
}

// Grow the composer textarea with its content, up to a cap.
function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
}

// Keep the thread scrolled to the newest message.
function scrollThread() {
  const t = document.getElementById("chat-thread");
  if (t) t.scrollTop = t.scrollHeight;
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
    (state.project && !state.generating) ? restyleControl() : null,
    el("div", { class: "spacer" }),
    state.project ? urlPill() : null,
    state.project ? versionHistory() : null,
    state.project ? el("button", { class: "btn sm", onclick: onPublish }, "Publish") : null,
    state.project ? el("button", { class: "btn sm", onclick: onDownload }, "Download") : null);

  const body = el("div", { class: "right-body" });
  if (state.generating) {
    // Live preview building up in the middle (the narration now lives in the chat).
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

function placeholder() {
  return el("div", { class: "placeholder" },
    el("div", { class: "inner" },
      el("div", { class: "big" }, "✦"),
      el("h2", {}, "Your design will appear here"),
      el("p", {}, "Describe the site or app you want in the chat on the left — you'll watch it build here, live.")));
}

// ---------- live streaming view (middle): the preview builds up from tokens ----------
// The build narration lives in the chat now; the middle is purely the streaming preview.
function liveView() {
  const box = el("div", { class: "live-view", id: "live-view" });
  const frame = el("iframe", { class: "preview-frame live-frame", id: "live-frame", title: "Live preview",
    sandbox: "allow-scripts allow-forms allow-popups allow-same-origin" });
  frame.srcdoc = (state.live && state.live.current && state.live.files[state.live.current]) ||
    "<!doctype html><body style='font-family:system-ui;color:#888;display:grid;place-items:center;height:100vh'>Building your design…</body>";
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
}

// ---------- actions ----------
async function loadMeta() {
  try { state.meta = await api.meta(); }
  catch (e) { toast("Could not load styles/types: " + (e.message || e), "err"); }
}
async function loadProjects() {
  await guard(async () => { state.projects = (await api.listProjects()) || []; });
}

// Repaint just the live assistant bubble in place (cheap; avoids a full render()).
function refreshLiveMsg() {
  if (!liveMsg) return;
  const idx = state.messages.indexOf(liveMsg);
  const thread = document.getElementById("chat-thread");
  if (idx < 0 || !thread) return;
  const node = thread.children[idx];
  if (node) { node.replaceWith(chatBubble(liveMsg)); scrollThread(); }
}

// Mark all steps done, then add a new active (pending) step to the live bubble.
function addStep(label) {
  if (!liveMsg) return;
  const steps = liveMsg.steps;
  for (const s of steps) s.pending = false;
  // Don't add a duplicate of the step we're already on (e.g. the seeded first step
  // matching the backend's first `progress` event).
  if (steps.length && steps[steps.length - 1].label === label) {
    steps[steps.length - 1].pending = true;
  } else {
    steps.push({ label, pending: true });
  }
  refreshLiveMsg();
}
// Update the label of the current (last) step without adding a new one.
function setStep(label) {
  if (!liveMsg || !liveMsg.steps.length) { addStep(label); return; }
  liveMsg.steps[liveMsg.steps.length - 1].label = label;
  refreshLiveMsg();
}

// A short, friendly one-line summary of the brief for the chat.
function briefLine(b) {
  b = b || {};
  // brand may be an object {name,tagline,tone} (backend) or a plain string (mock)
  const brand = b.brand;
  const name = (brand && typeof brand === "object" ? brand.name : brand)
    || (state.project && state.project.title) || "your site";
  const tagline = (brand && typeof brand === "object" ? brand.tagline : b.tagline) || "";
  let line = `Here's the plan — **${esc(name)}**` + (tagline ? ` — ${esc(tagline)}` : "") + ".";
  const files = Array.isArray(b.pages) ? b.pages.map((p) => p && p.file).filter(Boolean)
    : (Array.isArray(b.files) ? b.files : []);
  if (files.length > 1) line += ` ${files.length} pages: ${files.join(", ")}.`;
  else if (files.length === 1) line += " One page.";
  const dm = b.data_model;
  if (dm) {
    const storage = (dm && typeof dm === "object" && dm.storage) ? dm.storage : "localStorage";
    line += ` With a local database (${storage}).`;
  }
  return line;
}

// Shared SSE event handler: narrates into the live assistant bubble AND streams the
// tokens into the middle preview. `liveMsg` is the assistant message being written.
function makeStreamHandler() {
  state.live = { files: {}, current: null, order: [] };
  return (evt) => {
    switch (evt.type) {
      case "progress": {
        const label = evt.stage + (evt.detail ? " · `" + evt.detail + "`" : "");
        addStep(label); updateLiveFrame(true); break;
      }
      case "brief":
        state.brief = evt.brief;
        addStep(briefLine(evt.brief));
        break;
      case "page_start":
        state.live.current = evt.file;
        if (!state.live.order.includes(evt.file)) state.live.order.push(evt.file);
        if (state.live.files[evt.file] == null) state.live.files[evt.file] = "";
        addStep("Building `" + evt.file + "`…");
        updateLiveFrame(true); break;
      case "token":
        if (state.live.files[evt.file] == null) state.live.files[evt.file] = "";
        state.live.files[evt.file] += (evt.delta || "");
        state.live.current = evt.file;
        updateLiveFrame(false); break;
      case "page_done":
        setStep("`" + evt.file + "`");
        updateLiveFrame(true); break;
      case "error":
        break; // surfaced by the promise rejection → finalized as an error bubble
    }
  };
}

// The one entry point for the composer (and example chips). First message with no
// project → create; every message after → refine. Both narrate live in the chat.
function sendMessage(text, style) {
  text = (text || "").trim();
  if (!text || state.generating) return;
  pushMessage("user", { text });
  if (state.project) onEdit(text, {});
  else onGenerate(text, style || currentStyle());
}
function currentStyle() {
  const styleEl = document.getElementById("style");
  return (styleEl && styleEl.value) ||
    (state.meta && state.meta.styles[0] && state.meta.styles[0].id) || "modern";
}

// Finalize the live assistant bubble (collapse spinner) with a summary line.
function finalizeLiveMsg(text, kind) {
  if (!liveMsg) return;
  for (const s of liveMsg.steps) s.pending = false;
  if (text) liveMsg.text = text;
  if (kind) liveMsg.kind = kind;
  liveMsg = null;
}

async function onGenerate(prompt, style, title) {
  prompt = (prompt || "").trim();
  if (!prompt) return;
  state.generating = true; state.editMode = false; state.brief = null;
  liveMsg = pushMessage("assistant", { steps: [{ label: "Understanding your request", pending: true }] });
  render();
  await guard(async () => {
    // page_type "auto" -> the GPU infers it; stream events into the live preview + chat
    const payload = { prompt, page_type: "auto", style, title: title || undefined };
    const onEvent = makeStreamHandler();
    const proj = api.createProjectStream
      ? await api.createProjectStream(payload, onEvent)
      : await api.createProject(payload);
    applyProject(proj);
    const n = proj.pages ? proj.pages.length : 1;
    const js = proj.pages && proj.pages.some((p) => /<script/i.test(p.html || "")) ? ", interactive" : "";
    finalizeLiveMsg(`✓ Built **${proj.title || "your site"}** — ${n} page${n === 1 ? "" : "s"}${js}. Tell me what to change.`);
    await loadProjects();
    toast(proj.page_type ? `Built a ${proj.page_type}.` : "Site generated.", "ok");
  }).catch((e) => { finalizeLiveMsg("Sorry — I couldn't build that. " + (e && e.message ? e.message : "Please try again."), "error"); });
  state.generating = false; state.live = null; liveMsg = null; render();
}

// Fast targeted refine / click-to-edit — both go through /edit (SSE), narrated in chat.
// If `userText` is omitted (e.g. click-to-edit), we append the instruction as a user bubble.
async function onEdit(instruction, { selector, outer_html, file, userText } = {}) {
  if (!state.project) return;
  if (userText === undefined && !state.messages.some((m) => m.role === "user" && m.text === instruction)) {
    pushMessage("user", { text: instruction });
  }
  state.generating = true;
  liveMsg = pushMessage("assistant", { steps: [{ label: "Applying your change", pending: true }] });
  render();
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
    finalizeLiveMsg("✓ Done. Anything else to change?");
    await loadProjects();
    if (state.versionsOpen) state.versions = await api.versions(proj.id).catch(() => state.versions);
    toast("Applied your change.", "ok");
  }).catch((e) => { finalizeLiveMsg("Sorry — that change didn't apply. " + (e && e.message ? e.message : ""), "error"); });
  state.generating = false; state.live = null; liveMsg = null; render();
}

// Phase 4: rebuild from an edited brief (SSE), narrated in chat.
async function onRebuildBrief(brief) {
  if (!state.project) return;
  state.generating = true;
  liveMsg = pushMessage("assistant", { steps: [{ label: "Rebuilding from the brief", pending: true }] });
  render();
  await guard(async () => {
    const onEvent = makeStreamHandler();
    const proj = await api.putBriefStream(state.project.id, brief, onEvent);
    applyProject(proj);
    finalizeLiveMsg("✓ Rebuilt from the updated brief.");
    await loadProjects();
    toast("Rebuilt from your brief.", "ok");
  }).catch((e) => { finalizeLiveMsg("Sorry — the rebuild failed. " + (e && e.message ? e.message : ""), "error"); });
  state.generating = false; state.live = null; liveMsg = null; render();
}

// Phase 4: restyle — same content, new look (SSE), narrated in chat.
async function onRestyle(style) {
  if (!state.project) return;
  state.generating = true;
  pushMessage("user", { text: "Restyle → " + style });
  liveMsg = pushMessage("assistant", { steps: [{ label: "Re-rendering in the new style", pending: true }] });
  render();
  await guard(async () => {
    const onEvent = makeStreamHandler();
    const proj = await api.restyleStream(state.project.id, style, onEvent);
    applyProject(proj);
    finalizeLiveMsg(`✓ Restyled to **${style}**.`);
    await loadProjects();
    toast("Restyled to " + style + ".", "ok");
  }).catch((e) => { finalizeLiveMsg("Sorry — restyle failed. " + (e && e.message ? e.message : ""), "error"); });
  state.generating = false; state.live = null; liveMsg = null; render();
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
    // Seed a fresh thread so the user can keep chatting to refine this project.
    state.messages = [pushSeed(`Opened **${proj.title || "your project"}**. What should I change?`)];
    render();
  });
}
// A standalone assistant message (not pushed to state until assigned).
function pushSeed(text) { return { role: "assistant", text, steps: [], kind: "" }; }

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
