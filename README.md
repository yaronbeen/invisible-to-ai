# 👻 invisible-to-ai

**Ask ChatGPT and Perplexity if they know your brand exists — live, in real time.**

ChatGPT and Perplexity are the new search box. When a buyer asks them
*"what's the best tool for X?"*, the AI names a handful of brands and cites a
handful of pages. If you're not in that answer, you don't exist.

This is a tiny, public tool that runs the check for you. Type your brand and a
buyer question, and it asks **both** ChatGPT and Perplexity *live*, then shows
you whether you were:

- **Named** in the answer,
- **Cited** as a trusted source (and at what rank), or
- **Invisible** — with the exact list of competitor pages winning instead.

> Part of a 3-tool series on AI brand visibility. See also the single-engine
> [ChatGPT checker](https://github.com/yaronbeen/bright-data-chatgpt-visibility-checker) and
> [Perplexity checker](https://github.com/yaronbeen/bright-data-perplexity-visibility-checker).
>
> Inspired by the playbook in
> *["My SaaS Was Invisible to ChatGPT. I Built a Scraping Pipeline to Fix It."](https://medium.com/@yaron.been/my-saas-was-invisible-to-chatgpt-i-built-a-scraping-pipeline-to-fix-it-4703bbed2345)*

---

## How it works

```
Browser ──► Cloudflare Worker (same-origin proxy) ──► Bright Data AI-Search scrapers
   ▲                                                          │
   └──────────────  results: answer + citations  ◄────────────┘
```

1. You enter a **brand**, a **buyer question**, and **your own Bright Data token**.
2. The Worker calls both scrapers via the synchronous `/scrape` endpoint
   (`Promise.all`). Perplexity usually returns inline (~30s); ChatGPT often
   returns a snapshot ID the page then polls (~60–90s).
3. It renders each engine's answer, the sources it actually cited, and a result.
4. Export the report as Markdown, JSON, or CSV.

Two Bright Data datasets run the queries — its AI-Search scrapers return each
model's answer plus the sources it cited:

| Engine | Dataset ID | Inputs |
| --- | --- | --- |
| ChatGPT | `gd_m7aof0k82r803d5bjm` | `url, prompt, country, web_search, additional_prompt` |
| Perplexity | `gd_m7dhdot1vw9a7gc1n` | `url, prompt, country, index` |

---

## Bring Your Own Key (BYOK) — zero secrets

**There is no API token in this repository or in the deployed Worker.**

Each visitor pastes their **own** Bright Data token in the UI. It's sent on each
request as `Authorization: Bearer <token>`, forwarded to Bright Data by the
Worker, and **not stored anywhere** — the Worker keeps no database, doesn't log
the token, and the page does not save it in your browser (no `localStorage`, no
cookies). Your key, your credits — each check runs two records (ChatGPT +
Perplexity) at about **US$0.0015 per record** on Bright Data pay-as-you-go.

Why a proxy at all? Bright Data's API doesn't send CORS headers, so a browser
can't call it directly. The Worker is a thin, stateless relay on the same origin
as the page; the `/api/*` endpoints are rate-limited per IP.

Create a Bright Data account at [brightdata.com](https://brightdata.com); the API
token lives in your account settings under *API keys*.

---

## Run it yourself

```bash
npm install
npm run dev        # wrangler dev -> http://localhost:8787
npm run deploy     # deploy to your Cloudflare account
```

No configuration needed — there are no secrets to set. The static front-end
lives in `public/index.html`; the proxy is `src/worker.js`.

### Try without a key

Click **"See a real sample"** on the page. It loads `public/sample.json` — a
real result (full answer text included) for the brand *ROASPIG* and the question
*"best AI ad creative tools in 2026"*. (Spoiler: ChatGPT lists AdCreative, Pencil and Creatify
and Perplexity leads with Predis.ai — neither names or cites ROASPIG.)

### Raw API example

The synchronous endpoint (good for quick scripts):

```bash
curl -H "Authorization: Bearer $BRIGHT_DATA_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"input":[{"url":"https://www.perplexity.ai","prompt":"best CRM for startups","country":"US","index":1}]}' \
     "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_m7dhdot1vw9a7gc1n&notify=false&include_errors=true"
```

The app itself calls the synchronous `/scrape` endpoint (it returns a `snapshot_id`
to poll for long ChatGPT jobs). Bright Data also offers a fully async flow:
`POST /datasets/v3/trigger` → poll `GET /datasets/v3/progress/{id}` →
download `GET /datasets/v3/snapshot/{id}?format=json`.

---

## Project structure

```
invisible-to-ai/
├── public/
│   ├── index.html     # the whole front-end (neo-brutalist, vanilla JS)
│   └── sample.json    # real sample result for the no-key demo
├── src/
│   └── worker.js      # stateless BYOK proxy: /api/check, /api/status, /api/result
├── wrangler.jsonc
├── package.json
└── .env.example
```

---

## What to do with a bad verdict

If you come back **invisible**, the competitor leaderboard *is* your to-do list.
The pages AI already trusts are where you need to appear — ideally in slot #1–2,
as a clean, quotable, atomic fact. You don't optimize the model; you optimize
what it retrieves. Full playbook in the
[article](https://medium.com/@yaron.been/my-saas-was-invisible-to-chatgpt-i-built-a-scraping-pipeline-to-fix-it-4703bbed2345).

---

Built with love by **[Yaron · nofluff.online](https://nofluff.online)** · powered by **Bright Data**.

MIT licensed — do whatever you want with it.
