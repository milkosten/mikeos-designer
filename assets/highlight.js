// highlight.js — tiny self-contained HTML syntax highlighter (no dependencies).
// Read-only display only. Escapes everything first, then wraps tokens in spans.
// Handles: comments, <!DOCTYPE>, tags, attribute names, quoted attr values.

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightHtml(src) {
  src = String(src == null ? "" : src);
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    // comment
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const stop = end === -1 ? n : end + 3;
      out += `<span class="tok-cmt">${esc(src.slice(i, stop))}</span>`;
      i = stop; continue;
    }
    // doctype / declaration
    if (src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      const stop = end === -1 ? n : end + 1;
      out += `<span class="tok-doct">${esc(src.slice(i, stop))}</span>`;
      i = stop; continue;
    }
    // a tag: < ... >
    if (src[i] === "<") {
      const end = src.indexOf(">", i);
      const stop = end === -1 ? n : end + 1;
      out += highlightTag(src.slice(i, stop));
      i = stop; continue;
    }
    // text until next '<'
    const next = src.indexOf("<", i);
    const stop = next === -1 ? n : next;
    out += esc(src.slice(i, stop));
    i = stop;
  }
  return out;
}

function highlightTag(tag) {
  // tag looks like "<div class="x">" or "</div>" or "<br/>"
  const m = /^<\s*\/?\s*([a-zA-Z0-9-]+)/.exec(tag);
  if (!m) return `<span class="tok-punct">${esc(tag)}</span>`;
  const name = m[1];
  const nameStart = tag.indexOf(name);
  const before = tag.slice(0, nameStart);            // "<" or "</"
  let rest = tag.slice(nameStart + name.length);     // attrs + ">"

  let html = `<span class="tok-punct">${esc(before)}</span>`;
  html += `<span class="tok-tag">${esc(name)}</span>`;

  // tokenize the attribute region
  let j = 0;
  const L = rest.length;
  while (j < L) {
    const c = rest[j];
    if (c === '"' || c === "'") {
      const close = rest.indexOf(c, j + 1);
      const stop = close === -1 ? L : close + 1;
      html += `<span class="tok-str">${esc(rest.slice(j, stop))}</span>`;
      j = stop; continue;
    }
    if (c === ">" || c === "/" || c === "=") {
      html += `<span class="tok-punct">${esc(c)}</span>`;
      j++; continue;
    }
    if (/[a-zA-Z_:@-]/.test(c)) {
      let k = j + 1;
      while (k < L && /[a-zA-Z0-9_:.@-]/.test(rest[k])) k++;
      html += `<span class="tok-attr">${esc(rest.slice(j, k))}</span>`;
      j = k; continue;
    }
    html += esc(c);
    j++;
  }
  return html;
}
