# BrandCheck

**Know the brand before you sign.** Paste a sponsorship email and BrandCheck checks that the sender is really the brand, then searches the live web for unpaid creators, lawsuits, recalls, FTC actions, money trouble and backlash. You get a green / yellow / red verdict in about 20 seconds, with every flag linked to its source and the questions to ask the brand.

Built at the You.com Creator Economy Hack (Creator Business track).

## How it works

1. **Read the deal.** An LLM extracts the brand, sender address, offer and payment terms (rule-based fallback if no LLM key).
2. **Is the email real?** You.com Search finds the brand's official site. The sender domain is compared with it (free-mail, lookalike or unrelated domain), You.com Search looks for scam reports on the sender domain and past impersonation of the brand, and rules + LLM flag scam patterns in the text (upfront fees, downloads, Telegram/WhatsApp, account codes, urgency). A likely scam returns a red **Possible scam** verdict straight away.
3. **Parallel risk checks** with You.com Search: Reddit reports of unpaid creators, payment complaints, lawsuits / FTC / recalls (3-year window), layoffs and money trouble (past year), recent backlash (past year).
4. **Read the sources.** You.com Contents pulls the full text of the top risk pages so flags can quote the source.
5. **Cited overview.** You.com Answer writes a short cited summary of the brand (Research API as a fallback).
6. **Fixed rubric.** The LLM only labels each source (is it about this company? severity 0–3? neutral one-line claim). The verdict is computed in code: any serious category → red; any caution → yellow; no official site or too few results → yellow **Not enough public info**; otherwise green. Same-name companies are filtered out, results older than 2 years are down-weighted, and a single forum post can't make a brand red on its own.

## You.com endpoints

| Endpoint | What it powers |
|---|---|
| Search (`POST ydc-index.io/v1/search`) | Official-site lookup, sender-domain scam reports, impersonation reports, 5 parallel risk queries with freshness windows and domain filters |
| Contents (`POST ydc-index.io/v1/contents`) | Full text of the top risk sources, quoted in the verdict card |
| Answer (`POST api.you.com/v1/answer`) | Cited brand overview |
| Research (`POST api.you.com/v1/research`) | Fallback overview if Answer fails |

Every report shows a "How this was checked" table listing each call, its purpose, result count and latency.

## Run it

```bash
cp .env.example .env.local   # add YDC_API_KEY (and optionally ANTHROPIC_API_KEY)
npm install
npm run dev                  # http://localhost:3000
```

**Demo fallback:** `?demo=1` (or the "Cached demo runs" buttons) serves reports saved in `data/demo/` from real live runs. To record one locally, POST to `/api/check` with `{"input": "...", "saveAs": "red"}`.

## Handling bad or missing data

- Thin results give a yellow "Not enough public info" verdict, never a false green.
- Every flag must carry a source URL.
- Failed searches are reported as partial results; the Answer overview falls back to Research.
- With no LLM key, extraction and classification fall back to rules.

BrandCheck reports what public sources say and links every claim. It is not legal or financial advice.
