// ---------------------------------------------------------------------------
// Pure helpers for the AI-visibility checker.
//
// This is the single source of truth: the page (public/index.html) imports it
// as a module, and the test suite (test/lib.test.js) imports the very same file
// — so the tests exercise the exact code that ships. No DOM, no network in here.
// ---------------------------------------------------------------------------

export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Only allow http(s) links to render (blocks javascript:/data: from scraped output).
export const safeUrl = (u) => { u = String(u || "").trim(); return /^https?:\/\//i.test(u) ? u : ""; };

export const domainOf = (s) => {
  if (!s) return "";
  try { let u = String(s).trim(); if (!/^https?:\/\//i.test(u)) u = "https://" + u; return new URL(u).hostname.replace(/^www\./, ""); }
  catch { return String(s).replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0]; }
};

// The registrable name (second-level label) of a host, handling a few multi-part TLDs.
export function registrableSld(domain) {
  const host = String(domain || "").toLowerCase().replace(/^www\./, "");
  const L = host.split(".").filter(Boolean);
  if (L.length < 2) return host;
  const two = L.slice(-2).join(".");
  const multi = ["co.uk", "com.au", "co.jp", "co.in", "com.br", "co.nz", "co.za", "com.mx", "co.il", "org.uk", "ne.jp", "or.jp"];
  if (multi.includes(two) && L.length >= 3) return L[L.length - 3];
  return L[L.length - 2];
}

// Is this domain the user's brand? Match the registrable name (or the whole bare host) —
// NOT any sub-label, so "roaspig" != "roaspig.evil.com" and "com" != every .com.
export function isYou(domain, brand) {
  if (!brand) return false;
  const b = brand.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (b.length < 3) return false;
  const host = String(domain || "").toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  const sld = registrableSld(host).replace(/[^a-z0-9]+/g, "");
  return (sld && sld === b) || host.replace(/[^a-z0-9]+/g, "") === b;
}

export const plainAnswer = (r) => (r && (r.answer_text || r.answer || r.answer_text_markdown || "")) || "";
export const mdAnswer = (r) => (r && (r.answer_text_markdown || r.answer_text || r.answer || "")) || "";

// Normalize a URL to host+path (drops query/hash/trailing slash) so utm-tagged dupes collapse.
export function normKey(u) {
  try { const x = new URL(/^https?:/i.test(u) ? u : "https://" + u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); }
  catch { return String(u || "").toLowerCase().trim(); }
}

// The sources the engine actually cited. Uses the first non-empty authoritative array,
// respects an explicit `cited:false`, keeps the source's real position, and re-ranks 1..n.
export function citationsOf(rec) {
  if (!rec) return [];
  let src = [];
  for (const arr of [rec.citations, rec.sources, rec.search_sources, rec.references]) {
    if (Array.isArray(arr) && arr.length) { src = arr; break; }
  }
  const out = [], seen = new Set();
  for (const c of src) {
    if (!c || c.cited === false) continue;
    const raw = c.url || c.link || "";
    const url = safeUrl(raw);
    const domain = domainOf(url) || (c.domain ? domainOf(c.domain) : "");
    if (!domain && !url) continue;
    const key = normKey(raw || domain || c.title || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let pos = Number(c.position != null ? c.position : c.rank);
    if (!Number.isFinite(pos) || pos < 1) pos = out.length + 1;
    out.push({ url, title: c.title || c.name || "", domain, position: pos });
  }
  out.sort((a, b) => a.position - b.position);
  return out.map((c, i) => ({ ...c, position: i + 1 }));
}

// Whole-word brand match in the answer text (so "Meta" doesn't match "metadata").
export function brandInText(text, brand) {
  if (!brand || !text) return false;
  const b = brand.trim();
  if (b.length < 2) return false;
  const pat = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s\-]+/g, "[\\s\\-]*");
  try { return new RegExp("(^|[^A-Za-z0-9])" + pat + "(?=[^A-Za-z0-9]|$)", "i").test(text); }
  catch { return text.toLowerCase().includes(b.toLowerCase()); }
}

export const brandCitedPos = (cites, brand) => { for (const c of cites) if (isYou(c.domain, brand)) return c.position; return null; };

// Escape, then highlight the brand (whole-word), then apply light markdown for readability.
export function renderAnswer(md, brand) {
  let h = esc(md);
  if (brand && brand.trim().length >= 2) {
    const pat = brand.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s\-]+/g, "[\\s\\-]*");
    try { h = h.replace(new RegExp("(^|[^A-Za-z0-9])(" + pat + ")(?=[^A-Za-z0-9]|$)", "gi"), (m, a, g) => a + "<mark>" + g + "</mark>"); } catch {}
  }
  return h.replace(/^#{1,6}\s*(.+)$/gm, "<strong>$1</strong>")
          .replace(/\*\*([^*\n]{1,160})\*\*/g, "<strong>$1</strong>")
          .replace(/^\s*[-*]\s+/gm, "• ").replace(/[ \t]{3,}/g, "  ")
          .replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
}

// Neutralize spreadsheet formula injection from scraped titles/domains in CSV export.
export function csvCell(x) { let s = String(x == null ? "" : x); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; }
