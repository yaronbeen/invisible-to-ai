// Integration tests for the merged Worker (src/worker.js), which fans a single
// check out to BOTH the ChatGPT and Perplexity datasets in parallel.
// We import the real module and drive it with WHATWG Request/env objects,
// stubbing global fetch so no network call ever leaves the machine.
// Run with: npm test  (node --test, zero dependencies).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";

const ORIGIN = "https://example.workers.dev";
const TOKEN = "tok_12345678"; // >= 8 chars so getToken() accepts it
const SNAP = "sd_abc123";
const DS_CHATGPT = "gd_m7aof0k82r803d5bjm";
const DS_PERPLEXITY = "gd_m7dhdot1vw9a7gc1n";

const baseEnv = () => ({
  ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }) },
});

function req(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request(ORIGIN + path, init);
}

let calls;
const realFetch = globalThis.fetch;
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler) {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}

// Default success stub: every trigger returns a snapshot id keyed by dataset.
function stubBothOk() {
  stubFetch((url) => {
    const ds = new URL(url).searchParams.get("dataset_id");
    const id = ds === DS_CHATGPT ? "sd_cg1" : "sd_px1";
    return new Response(JSON.stringify({ snapshot_id: id }), { status: 200 });
  });
}

test("GET /api/health returns 200 ok", async () => {
  const res = await worker.fetch(req("/api/health"), baseEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("responses carry no CORS allow-origin header (same-origin design)", async () => {
  const res = await worker.fetch(req("/api/health"), baseEnv());
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("OPTIONS /api/check preflight returns 204", async () => {
  const res = await worker.fetch(req("/api/check", { method: "OPTIONS" }), baseEnv());
  assert.equal(res.status, 204);
});

test("POST /api/check without a token returns 401", async () => {
  const res = await worker.fetch(req("/api/check", { method: "POST", body: { prompt: "x" } }), baseEnv());
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /token/i);
});

test("POST /api/check with empty prompt returns 400", async () => {
  const res = await worker.fetch(req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "  " } }), baseEnv());
  assert.equal(res.status, 400);
});

test("POST /api/check with an over-long prompt returns 400", async () => {
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "x".repeat(501) } }),
    baseEnv()
  );
  assert.equal(res.status, 400);
});

test("POST /api/check fans out to BOTH datasets and returns a snapshot per engine", async () => {
  stubBothOk();
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM", brand: "roaspig", country: "gb" } }),
    baseEnv()
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.brand, "roaspig");
  assert.equal(data.country, "GB");
  assert.equal(data.engines.chatgpt.snapshot_id, "sd_cg1");
  assert.equal(data.engines.chatgpt.done, false);
  assert.equal(data.engines.perplexity.snapshot_id, "sd_px1");
  assert.equal(data.engines.perplexity.done, false);

  // Two trigger calls, one per dataset, each with the right input shape.
  assert.equal(calls.length, 2);
  const cg = calls.find((c) => c.url.includes(DS_CHATGPT));
  const px = calls.find((c) => c.url.includes(DS_PERPLEXITY));
  assert.ok(cg && px, "both datasets were triggered");
  const cgInput = JSON.parse(cg.opts.body).input[0];
  const pxInput = JSON.parse(px.opts.body).input[0];
  assert.equal(cgInput.country, ""); // ChatGPT scraper requires empty country
  assert.equal(cgInput.web_search, true);
  assert.equal(pxInput.country, "GB"); // normalized from "gb"
  assert.equal(pxInput.index, 1);
});

test("POST /api/check returns 401 when BOTH engines reject the token", async () => {
  stubFetch(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM" } }),
    baseEnv()
  );
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /rejected|expired|invalid/i);
});

test("POST /api/check still returns 200 when only ONE engine errors (partial result)", async () => {
  stubFetch((url) => {
    const ds = new URL(url).searchParams.get("dataset_id");
    if (ds === DS_CHATGPT) return new Response(JSON.stringify({ snapshot_id: "sd_cg1" }), { status: 200 });
    return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
  });
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM" } }),
    baseEnv()
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.engines.chatgpt.snapshot_id, "sd_cg1");
  assert.ok(data.engines.perplexity.error, "the failing engine surfaces its error");
});

test("POST /api/check is blocked by the rate limiter (429)", async () => {
  const env = { ...baseEnv(), CHECK_RL: { limit: async () => ({ success: false }) } };
  const res = await worker.fetch(
    req("/api/check", { method: "POST", token: TOKEN, body: { prompt: "best CRM" } }),
    env
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
});

test("GET /api/status rejects a malformed snapshot id (400)", async () => {
  const res = await worker.fetch(req("/api/status?id=not-a-real-id", { token: TOKEN }), baseEnv());
  assert.equal(res.status, 400);
});

test("GET /api/status passes through Bright Data progress", async () => {
  stubFetch(() => new Response(JSON.stringify({ status: "running" }), { status: 200 }));
  const res = await worker.fetch(req(`/api/status?id=${SNAP}`, { token: TOKEN }), baseEnv());
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "running");
  assert.match(calls[0].url, /\/datasets\/v3\/progress\//);
});

test("GET /api/result passes through the snapshot JSON", async () => {
  stubFetch(() => new Response(JSON.stringify([{ answer_text: "hi" }]), { status: 200 }));
  const res = await worker.fetch(req(`/api/result?id=${SNAP}`, { token: TOKEN }), baseEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.match(calls[0].url, /\/datasets\/v3\/snapshot\//);
});

test("GET /api/result without a token returns 401", async () => {
  const res = await worker.fetch(req(`/api/result?id=${SNAP}`), baseEnv());
  assert.equal(res.status, 401);
});

test("unknown /api/* path returns 404", async () => {
  const res = await worker.fetch(req("/api/nope"), baseEnv());
  assert.equal(res.status, 404);
});

test("non-/api/ path is served by the ASSETS binding", async () => {
  const res = await worker.fetch(req("/"), baseEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});
