/**
 * invisible-to-ai — Cloudflare Worker
 * ----------------------------------------------------------------------------
 * A thin, stateless proxy in front of Bright Data's ChatGPT and Perplexity
 * AI-Search scrapers.
 *
 * Why a proxy? Bright Data's API sends no CORS headers, so a browser can't call
 * it directly. This Worker forwards the request server-side, on the same origin.
 *
 * Bring Your Own Key (BYOK): the visitor pastes THEIR OWN Bright Data token in
 * the UI. It is sent as `Authorization: Bearer <token>`, forwarded to Bright
 * Data, and never persisted by this Worker (no KV, no logging of the token).
 *
 * Abuse protection: POST /api/check is rate-limited per client IP (CHECK_RL).
 */

const DATASETS = {
  chatgpt: "gd_m7aof0k82r803d5bjm", // "ChatGPT Search - search by prompt"
  perplexity: "gd_m7dhdot1vw9a7gc1n", // "Perplexity Search - search by prompt"
};

const BD_BASE = "https://api.brightdata.com";
const scrapeUrl = (id) =>
  `${BD_BASE}/datasets/v3/scrape?dataset_id=${id}&notify=false&include_errors=true`;
const progressUrl = (sid) => `${BD_BASE}/datasets/v3/progress/${sid}`;
const snapshotUrl = (sid) => `${BD_BASE}/datasets/v3/snapshot/${sid}?format=json`;
const SNAPSHOT_RE = /^s[dn]_[a-z0-9]+$/i;

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(), ...extra },
  });
}

function getToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  return token.length >= 8 ? token : null;
}

function humanError(data, text, status) {
  if (status === 401 || /token expired|unauthorized/i.test(text)) {
    return "Your Bright Data token was rejected (expired or invalid). Check it and try again.";
  }
  if (data && typeof data.error === "string") return data.error;
  if (Array.isArray(data?.errors) && data.errors.length) {
    return data.errors.map((e) => (Array.isArray(e) ? e.join(": ") : String(e))).join("; ");
  }
  return text?.slice(0, 300) || `Bright Data error (HTTP ${status}).`;
}

async function rl(env, request, binding) {
  try {
    const b = env && env[binding];
    if (b && typeof b.limit === "function") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const { success } = await b.limit({ key: ip });
      return !success;
    }
  } catch {
    /* fail open */
  }
  return false;
}

function looksLikeRecord(rec) {
  return !!rec && typeof rec === "object" && !Array.isArray(rec) &&
    ("answer_text" in rec || "answer" in rec || "answer_text_markdown" in rec ||
     "citations" in rec || "sources" in rec || "search_sources" in rec);
}

// Sync-first: /scrape returns the data directly for fast jobs (Perplexity ~30s),
// or a 202 (or a 200 wrapper) + snapshot_id for long jobs (ChatGPT), which the
// client then polls.
async function runDataset(datasetId, input, token) {
  try {
    const r = await fetch(scrapeUrl(datasetId), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: [input] }),
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const snapId = (data && !Array.isArray(data) && data.snapshot_id) || null;
    if ((r.status === 202 || (r.ok && snapId && !looksLikeRecord(data))) && snapId) {
      return { done: false, snapshot_id: snapId };
    }
    if (!r.ok) return { error: humanError(data, text, r.status), status: r.status };

    const record = Array.isArray(data) ? data[0] : data;
    if (!looksLikeRecord(record)) return { error: "Bright Data returned an unexpected response." };
    return { done: true, record };
  } catch (e) {
    return { error: e?.message || "Failed to reach Bright Data." };
  }
}

async function handleCheck(request, env) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);

  if (await rl(env, request, "CHECK_RL")) {
    return json(
      { error: "Too many checks from your network. Please wait a minute and try again." },
      429,
      { "Retry-After": "60" }
    );
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request body." }, 400); }

  const prompt = String(body.prompt || "").trim();
  const brand = String(body.brand || "").trim();
  const country = String(body.country || "").trim().toUpperCase().slice(0, 2);

  if (!prompt) return json({ error: "Please enter a buyer question to ask the AIs." }, 400);
  if (prompt.length > 500) return json({ error: "Question is too long (max 500 characters)." }, 400);
  if (brand.length > 120) return json({ error: "Brand name is too long." }, 400);

  const chatgptInput = {
    url: "https://chatgpt.com/",
    prompt,
    country: "",
    web_search: true,
    additional_prompt: "",
  };
  const perplexityInput = {
    url: "https://www.perplexity.ai",
    prompt,
    country: /^[A-Z]{2}$/.test(country) ? country : "US",
    index: 1,
  };

  const [chatgpt, perplexity] = await Promise.all([
    runDataset(DATASETS.chatgpt, chatgptInput, token),
    runDataset(DATASETS.perplexity, perplexityInput, token),
  ]);

  if (chatgpt.error && perplexity.error && (chatgpt.status === 401 || perplexity.status === 401)) {
    return json({ error: chatgpt.error || perplexity.error }, 401);
  }

  return json({
    ok: true,
    brand,
    prompt,
    country: perplexityInput.country,
    engines: { chatgpt, perplexity },
  });
}

async function handleStatus(request, url, env) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);
  if (await rl(env, request, "POLL_RL")) return json({ error: "Too many requests — please slow down." }, 429, { "Retry-After": "30" });
  const id = url.searchParams.get("id") || "";
  if (!SNAPSHOT_RE.test(id)) return json({ error: "Invalid snapshot id." }, 400);
  try {
    const r = await fetch(progressUrl(id), { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { status: "unknown", raw: text }; }
    return json(data, r.ok ? 200 : r.status);
  } catch (e) {
    return json({ status: "unknown", error: e?.message || "status check failed" }, 200);
  }
}

async function handleResult(request, url, env) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);
  if (await rl(env, request, "POLL_RL")) return json({ error: "Too many requests — please slow down." }, 429, { "Retry-After": "30" });
  const id = url.searchParams.get("id") || "";
  if (!SNAPSHOT_RE.test(id)) return json({ error: "Invalid snapshot id." }, 400);
  try {
    const r = await fetch(snapshotUrl(id), { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    return new Response(text, {
      status: r.ok ? 200 : r.status,
      headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders() },
    });
  } catch (e) {
    return json({ error: e?.message || "Failed to download snapshot." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/api/health") return json({ ok: true });
    if (url.pathname === "/api/check" && request.method === "POST") return handleCheck(request, env);
    if (url.pathname === "/api/status" && request.method === "GET") return handleStatus(request, url, env);
    if (url.pathname === "/api/result" && request.method === "GET") return handleResult(request, url, env);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);

    return env.ASSETS.fetch(request);
  },
};
