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
  progress: [],          // live [{stage,detail}] during generation
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
      el("small", {}, isMock() ? "· mock mode" : "· designer.osmike.com")),
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
  const titleEl = el("input", { type: "text", id: "title", placeholder: "Project title (optional)" });

  const styleSel = el("select", { id: "style" });
  if (state.meta) {
    for (const s of state.meta.styles) styleSel.appendChild(el("option", { value: s.id, title: s.description }, s.name));
  } else {
    styleSel.appendChild(el("option", {}, "Loading…"));
    styleSel.disabled = true;
  }

  const genBtn = el("button", { class: "btn primary block", disabled: state.generating || !state.meta,
    onclick: () => onGenerate(promptEl.value, styleSel.value, titleEl.value) },
    state.generating ? el("span", { class: "spin" }) : null,
    state.generating ? " Generating…" : "Generate");

  // refine
  const refineInput = el("input", { type: "text",
    placeholder: state.project ? "Tell it what to change…" : "Generate a project first",
    disabled: !state.project || state.generating });
  const refineBtn = el("button", { class: "btn", disabled: !state.project || state.generating,
    onclick: () => { const v = refineInput.value.trim(); if (v) { refineInput.value = ""; onRefine(v); } } });
  refineBtn.textContent = "Send";
  refineInput.addEventListener("keydown", (e) => { if (e.key === "Enter") refineBtn.click(); });

  return el("div", { class: "left" },
    el("div", { class: "scroll" },
      el("div", { class: "field" },
        el("label", {}, "What do you want to build?"),
        promptEl),
      el("div", { class: "field" },
        el("label", {}, "Design style", el("span", { class: "hint" }, " · the page type is detected automatically")),
        styleSel),
      el("div", { class: "field" }, el("label", {}, "Title"), titleEl),
      genBtn,
      el("div", { class: "divider" }),
      el("div", { class: "section-title" }, "Refine"),
      el("div", { class: "refine" }, refineInput, refineBtn),
      el("div", { class: "divider" }),
      el("div", { class: "section-title" }, "My projects",
        el("span", { class: "count" }, state.projects.length ? `(${state.projects.length})` : "")),
      projectsList()));
}

function projectsList() {
  if (!state.projects.length) return el("div", { class: "empty" }, "No projects yet. Generate your first site above.");
  const list = el("div", { class: "projects" });
  for (const p of state.projects) {
    const active = state.project && state.project.id === p.id;
    list.appendChild(el("div", { class: "proj" + (active ? " active" : ""),
      onclick: () => openProject(p.id) },
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
  const head = el("div", { class: "right-head" },
    el("div", { class: "tabs" },
      tabBtn("Preview", "preview"),
      tabBtn("Code", "code")),
    el("div", { class: "spacer" }),
    state.project ? urlPill() : null,
    state.project ? el("button", { class: "btn sm", onclick: onPublish }, "Publish") : null,
    state.project ? el("button", { class: "btn sm", onclick: onDownload }, "Download") : null);

  const body = el("div", { class: "right-body" });
  if (state.generating) {
    body.appendChild(progressView());               // live stage-by-stage progress
  } else if (!state.project) {
    body.appendChild(placeholder());
  } else {
    if (state.activeTab === "preview") body.appendChild(previewIframe(state.project, state.activePage));
    else body.appendChild(codeView());
  }

  // multi-page sub-tab bar sits between head and body
  const wrap = el("div", { class: "right" }, head);
  if (state.project && state.project.pages.length > 1) wrap.appendChild(pageBar());
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
      onclick: () => { state.activePage = i; render(); } }, pg.file));
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

function placeholder() {
  return el("div", { class: "placeholder" },
    el("div", { class: "inner" },
      el("div", { class: "big" }, "✦"),
      el("h2", {}, "Your site will appear here"),
      el("p", {}, "Write a prompt on the left and hit Generate. You'll get a live preview and the full HTML, ready to refine, publish, or download.")));
}

function genOverlay() {
  return el("div", { class: "gen-overlay" },
    el("div", { class: "box" },
      el("div", { class: "spin" }),
      el("div", {}, state.project ? "Refining your site…" : "Building your site…")));
}

// Live stage-by-stage progress shown in the middle panel during generation.
function progressView() {
  const box = el("div", { class: "gen-progress", id: "gen-progress" });
  box.appendChild(el("div", { class: "gen-title" },
    el("span", { class: "spin" }),
    el("span", {}, state.project ? "Refining your design…" : "Building your design…")));
  const list = el("div", { class: "gen-steps" });
  const steps = state.progress;
  if (!steps.length) {
    list.appendChild(el("div", { class: "gen-step active" },
      el("span", { class: "gs-dot" }), el("span", { class: "gs-label" }, "Starting…")));
  } else {
    steps.forEach((s, i) => {
      const isLast = i === steps.length - 1;
      list.appendChild(el("div", { class: "gen-step " + (isLast ? "active" : "done") },
        el("span", { class: "gs-dot" }, isLast ? "" : "✓"),
        el("span", { class: "gs-label" }, s.stage + (s.detail ? "  ·  " + s.detail : ""))));
    });
  }
  box.appendChild(list);
  return box;
}
function renderProgress() {
  const old = document.getElementById("gen-progress");
  if (old) old.replaceWith(progressView());
}

// ---------- actions ----------
async function loadMeta() {
  try { state.meta = await api.meta(); }
  catch (e) { toast("Could not load styles/types: " + (e.message || e), "err"); }
}
async function loadProjects() {
  await guard(async () => { state.projects = (await api.listProjects()) || []; });
}

async function onGenerate(prompt, style, title) {
  prompt = (prompt || "").trim();
  if (!prompt) { toast("Describe what you want first.", "err"); return; }
  state.generating = true; state.progress = []; render();
  await guard(async () => {
    // page_type "auto" -> the GPU infers it; stream stage progress into the middle panel
    const payload = { prompt, page_type: "auto", style, title: title || undefined };
    const onProg = (evt) => { state.progress.push(evt); renderProgress(); };
    const proj = api.createProjectStream
      ? await api.createProjectStream(payload, onProg)
      : await api.createProject(payload);
    state.project = proj; state.activePage = 0; state.activeTab = "preview";
    await loadProjects();
    toast(proj.page_type ? `Built a ${proj.page_type}.` : "Site generated.", "ok");
  });
  state.generating = false; state.progress = []; render();
}

async function onRefine(instruction) {
  if (!state.project) return;
  state.generating = true; render();
  await guard(async () => {
    const proj = await api.refine(state.project.id, instruction);
    state.project = proj;
    if (state.activePage >= proj.pages.length) state.activePage = 0;
    await loadProjects();
    toast("Applied your change.", "ok");
  });
  state.generating = false; render();
}

async function openProject(id) {
  await guard(async () => {
    const proj = await api.getProject(id);
    state.project = proj; state.activePage = 0; state.activeTab = "preview";
    render();
  });
}

async function onDelete(id) {
  if (!confirm("Delete this project? This cannot be undone.")) return;
  await guard(async () => {
    await api.deleteProject(id);
    if (state.project && state.project.id === id) state.project = null;
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
