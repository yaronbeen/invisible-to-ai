/**
 * invisible-to-ai — Cloudflare Worker
 * ----------------------------------------------------------------------------
 * A thin, stateless proxy in front of Bright Data's AI-Search scrapers.
 *
 * Why a proxy at all?
 *   Bright Data's API does not send CORS headers, so a browser cannot call it
 *   directly. This Worker sits on the same origin as the page and forwards the
 *   request server-side.
 *
 * Bring Your Own Key (BYOK):
 *   The visitor pastes THEIR OWN Bright Data API token in the UI. It is sent on
 *   every request as `Authorization: Bearer <token>` and forwarded verbatim to
 *   Bright Data. It is never stored, never logged, never written to KV.
 *
 *   => There are no secrets in this repo or in the deployed Worker.
 *
 * Endpoints:
 *   POST /api/check?      { prompt, brand, country }  -> triggers both scrapers
 *   GET  /api/status?id=  sd_xxx                       -> snapshot progress
 *   GET  /api/result?id=  sd_xxx                       -> snapshot data (json)
 *   GET  /api/health                                   -> { ok: true }
 */

const DATASETS = {
  chatgpt: "gd_m7aof0k82r803d5bjm", // "ChatGPT Search - search by prompt"
  perplexity: "gd_m7dhdot1vw9a7gc1n", // "Perplexity Search - search by prompt"
};

const BD_BASE = "https://api.brightdata.com";
const scrapeUrl = (id) =>
  `${BD_BASE}/datasets/v3/scrape?dataset_id=${id}&notify=false&include_errors=true`;
const triggerUrl = (id) =>
  `${BD_BASE}/datasets/v3/trigger?dataset_id=${id}&notify=false&include_errors=true`;
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

// Sync-first: /scrape returns the data directly for fast jobs (Perplexity ~30s),
// or a 202 + snapshot_id for long jobs (ChatGPT), which the client then polls.
async function triggerDataset(datasetId, input, token) {
  try {
    const r = await fetch(scrapeUrl(datasetId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: [input] }),
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (r.status === 202 && data && data.snapshot_id) {
      return { done: false, snapshot_id: data.snapshot_id };
    }
    if (!r.ok) {
      return { error: humanError(data, text, r.status), status: r.status };
    }
    return { done: true, record: Array.isArray(data) ? data[0] : data };
  } catch (e) {
    return { error: e?.message || "Failed to reach Bright Data." };
  }
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

async function handleCheck(request) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const prompt = String(body.prompt || "").trim();
  const brand = String(body.brand || "").trim();
  const country = String(body.country || "").trim().toUpperCase().slice(0, 2);

  if (!prompt) return json({ error: "Please enter a buyer question to ask the AIs." }, 400);
  if (prompt.length > 500) return json({ error: "Question is too long (max 500 characters)." }, 400);
  if (brand.length > 120) return json({ error: "Brand name is too long." }, 400);

  // ChatGPT scraper rejects an explicit country -> always send empty.
  const chatgptInput = {
    url: "https://chatgpt.com/",
    prompt,
    country: "",
    web_search: true,
    additional_prompt: "",
  };
  // Perplexity scraper expects a country code (defaults to US).
  const perplexityInput = {
    url: "https://www.perplexity.ai",
    prompt,
    country: /^[A-Z]{2}$/.test(country) ? country : "US",
    index: 1,
  };

  const [chatgpt, perplexity] = await Promise.all([
    triggerDataset(DATASETS.chatgpt, chatgptInput, token),
    triggerDataset(DATASETS.perplexity, perplexityInput, token),
  ]);

  // If both engines failed for the same auth reason, return an error status
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

async function handleStatus(request, url) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);
  const id = url.searchParams.get("id") || "";
  if (!SNAPSHOT_RE.test(id)) return json({ error: "Invalid snapshot id." }, 400);

  try {
    const r = await fetch(progressUrl(id), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { status: "unknown", raw: text };
    }
    return json(data, r.ok ? 200 : r.status);
  } catch (e) {
    return json({ status: "unknown", error: e?.message || "status check failed" }, 200);
  }
}

async function handleResult(request, url) {
  const token = getToken(request);
  if (!token) return json({ error: "Missing Bright Data API token." }, 401);
  const id = url.searchParams.get("id") || "";
  if (!SNAPSHOT_RE.test(id)) return json({ error: "Invalid snapshot id." }, 400);

  try {
    const r = await fetch(snapshotUrl(id), {
      headers: { Authorization: `Bearer ${token}` },
    });
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
    if (url.pathname === "/api/check" && request.method === "POST") return handleCheck(request);
    if (url.pathname === "/api/status" && request.method === "GET") return handleStatus(request, url);
    if (url.pathname === "/api/result" && request.method === "GET") return handleResult(request, url);
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);

    // Everything else -> static front-end (public/index.html).
    return env.ASSETS.fetch(request);
  },
};
