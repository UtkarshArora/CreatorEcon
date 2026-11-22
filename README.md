# BrandCheck

**Know the brand before you sign.** Paste a sponsorship email and BrandCheck checks that the sender is really the brand, then searches the live web for unpaid creators, lawsuits, recalls, FTC actions, money trouble and backlash. You get a green / yellow / red verdict in about 20 seconds, with every flag linked to its source and the questions to ask the brand.

Built at the You.com Creator Economy Hack (Creator Business track).

## How it works

0. **Or check your inbox.** "Check my inbox" reads unread emails from a dedicated Gmail over IMAP (app password, no OAuth, messages are not marked read) and runs each one through the same check. It then writes the verdict back into Gmail: a `BrandCheck/Red|Yellow|Green|Scam|Unknown` label on the original email (IMAP) and the report filed as a reply in the same thread, sent only to the inbox owner (SMTP, same app password).
1. **Read the deal.** An LLM extracts the brand, sender address, offer and payment terms (rule-based fallback if no LLM key).
2. **Is the email real?** You.com Search finds the brand's official site. The sender domain is compared with it (free-mail, lookalike or unrelated domain), You.com Search looks for scam reports on the sender domain and past impersonation of the brand, and rules + LLM flag scam patterns in the text (upfront fees, downloads, Telegram/WhatsApp, account codes, urgency). A likely scam returns a red **Possible scam** verdict straight away.
3. **Parallel risk checks** with You.com Search: Reddit reports of unpaid creators, payment complaints, lawsuits / FTC / recalls (3-year window), layoffs and money trouble (past year), recent backlash (past year).
4. **Read the sources.** You.com Contents pulls the full text of the top risk pages so flags can quote the source.
5. **Cited overview.** You.com Answer writes a short cited summary of the brand (Research API as a fallback).
6. **Fixed rubric.** The LLM only labels each source: is it about this company (same-name companies are filtered out), severity 0–3, does it directly affect creators, what year it happened, and a neutral one-line claim. The verdict is computed in code:
   - **Red** only for scam signals, or recent (≤18 months), creator-relevant, sourced problems: unpaid-creator reports from 2+ independent sites or a news report, or an FTC endorsement action, recall or fraud finding from a non-forum source. Ordinary lawsuits (privacy, IP, AI data use, employment) are context only.
   - Coverage of the same story is grouped and classified once, so one event can't be "serious" on one site and "context" on another.
   - **Yellow** for recent caution-level issues, an unverified sender, or **Not enough public info** (no official site or too few results).
   - **Green** otherwise. Old news and ordinary big-company lawsuits, layoffs or criticism are shown for context but don't move the verdict, so established brands don't come back red.
   - Every flag cites a link or a quote from the pasted email.

**Gmail add-on:** `gmail-addon/` has an Apps Script add-on that shows the verdict in Gmail's sidebar when you open an email. See its README.

## You.com endpoints

| Endpoint | What it powers |
|---|---|
| Search (`POST ydc-index.io/v1/search`) | Official-site lookup, sender-domain scam reports, impersonation reports, 5 parallel risk queries with freshness windows and domain filters |
| Contents (`POST ydc-index.io/v1/contents`) | Full text of the top risk sources, quoted in the verdict card |
| Answer (`POST api.you.com/v1/answer`) | Cited brand overview |
| Research (`POST api.you.com/v1/research`) | Fallback overview if Answer fails |
| Inference Router (`POST api.you.com/v1/chat/completions`) | Optional (`YDC_LLM_ROUTER=1`): LLM steps for deal extraction, scam-phrase review, official-site pick and source classification. Anthropic is the default and the fallback |

Every report shows a "How this was checked" table listing each call, its purpose, result count and latency.

## Run it

```bash
cp .env.example .env.local   # add YDC_API_KEY; optional ANTHROPIC_API_KEY, IMAP_USER, IMAP_APP_PASSWORD
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
