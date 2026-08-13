// api.js — thin client for designer-api.osmike.com. Sends Bearer on all calls
// except health/meta. Includes a ?mock=1 stub so the full UI can run with no backend.
import { auth } from "./auth.js";
import { mockApi } from "./mock.js";

const CFG = window.DESIGNER_CONFIG;

export function isMock() {
  const q = new URLSearchParams(location.search);
  return CFG.MOCK === true || q.get("mock") === "1";
}

// Thrown so the UI can distinguish an auth failure (re-login) from other errors.
export class AuthError extends Error {}

async function req(method, path, body) {
  const headers = { "Accept": "application/json" };
  const t = auth.token();
  if (t) headers["Authorization"] = "Bearer " + t;
  const opts = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(CFG.API_BASE + path, opts);
  } catch (e) {
    throw new Error("Network error reaching designer-api. " + (e && e.message || ""));
  }
  if (r.status === 401 || r.status === 403) throw new AuthError("Session expired");
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!r.ok) {
    const msg = (data && (data.detail || data.error || data.message)) || ("HTTP " + r.status);
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

// Generic Server-Sent-Events POST/PUT helper. Streams `data: {json}\n\n` frames,
// calling onEvent(evt) for EVERY event (progress|brief|page_start|token|page_done|
// done|error) and resolving with the final project from the `done` event. Uses fetch
// (not EventSource) so we can send the Bearer token and a JSON body.
//
//   method:  "POST" | "PUT"
//   path:    e.g. "/api/projects/stream"
//   payload: request body object
//   onEvent: (evt) => void   — evt.type distinguishes the frame
async function sseRequest(method, path, payload, onEvent) {
  const headers = { "Content-Type": "application/json", "Accept": "text/event-stream" };
  const t = auth.token();
  if (t) headers["Authorization"] = "Bearer " + t;
  let r;
  try {
    r = await fetch(CFG.API_BASE + path, { method, headers, body: JSON.stringify(payload || {}) });
  } catch (e) { throw new Error("Network error reaching designer-api. " + (e && e.message || "")); }
  if (r.status === 401 || r.status === 403) throw new AuthError("Session expired");
  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => "");
    let d = null; try { d = JSON.parse(text); } catch { /* */ }
    throw new Error((d && (d.detail || d.message)) || ("HTTP " + r.status));
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", project = null, err = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.type === "done") project = evt.project;
        else if (evt.type === "error") err = evt.message;
        if (onEvent) { try { onEvent(evt); } catch { /* UI callback must not kill the stream */ } }
      }
    }
  }
  if (err) throw new Error(err);
  if (!project) throw new Error("Generation ended without a result.");
  return project;
}

// Backwards-compatible create stream. onEvent receives every SSE frame.
function createProjectStream(payload, onEvent) {
  return sseRequest("POST", "/api/projects/stream", payload, onEvent);
}

const live = {
  health:        ()               => req("GET",  "/api/health"),
  meta:          ()               => req("GET",  "/api/meta"),
  listProjects:  ()               => req("GET",  "/api/projects"),
  getProject:    (id)             => req("GET",  `/api/projects/${id}`),
  getFiles:      (id)             => req("GET",  `/api/projects/${id}/files`),
  // Persist the chat thread (compact [{role,text}]) so a reload/reopen restores it.
  saveMessages:  (id, messages)   => req("PUT",  `/api/projects/${id}/messages`, { messages }),
  createProject: (payload)        => req("POST", "/api/projects", payload),
  createProjectStream,
  // Fast targeted refine — streams the revised page(s) live.
  editStream:    (id, payload, onEvent) => sseRequest("POST", `/api/projects/${id}/edit`, payload, onEvent),
  // Brief (the "how I understood it").
  getBrief:      (id)             => req("GET",  `/api/projects/${id}/brief`),
  putBriefStream:(id, brief, onEvent) => sseRequest("PUT", `/api/projects/${id}/brief`, { brief }, onEvent),
  // Restyle — same content, new style.
  restyleStream: (id, style, onEvent) => sseRequest("POST", `/api/projects/${id}/restyle`, { style }, onEvent),
  // Version history.
  versions:      (id)             => req("GET",  `/api/projects/${id}/versions`),
  revert:        (id, versionId)  => req("POST", `/api/projects/${id}/revert`, { version_id: versionId }),
  publish:       (id)             => req("POST", `/api/projects/${id}/publish`),
  deleteProject: (id)             => req("DELETE", `/api/projects/${id}`),
};

// The exported client picks live or mock at module-load time.
export const api = isMock() ? mockApi : live;
