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

const live = {
  health:        ()               => req("GET",  "/api/health"),
  meta:          ()               => req("GET",  "/api/meta"),
  listProjects:  ()               => req("GET",  "/api/projects"),
  getProject:    (id)             => req("GET",  `/api/projects/${id}`),
  getFiles:      (id)             => req("GET",  `/api/projects/${id}/files`),
  createProject: (payload)        => req("POST", "/api/projects", payload),
  refine:        (id, instruction)=> req("POST", `/api/projects/${id}/prompt`, { instruction }),
  publish:       (id)             => req("POST", `/api/projects/${id}/publish`),
  deleteProject: (id)             => req("DELETE", `/api/projects/${id}`),
};

// The exported client picks live or mock at module-load time.
export const api = isMock() ? mockApi : live;
