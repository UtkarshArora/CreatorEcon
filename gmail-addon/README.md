# BrandCheck Gmail add-on

Open a sponsorship email in Gmail and the BrandCheck sidebar shows the verdict, sender check, risk checks, sources and questions to ask. It calls the deployed app's `/api/addon` endpoint (fast mode, about 10–20 s).

## 1. Deploy the app (public URL)

```bash
npm i -g vercel        # or use npx vercel
vercel                 # log in when asked, accept defaults
```
In the Vercel dashboard → Project → Settings → Environment Variables, add `YDC_API_KEY`, `ANTHROPIC_API_KEY` and `ADDON_TOKEN` (any long random string). Then `vercel --prod`.
Check it: `curl -X POST https://YOUR-APP.vercel.app/api/addon -H 'content-type: application/json' -H 'x-brandcheck-token: YOUR_TOKEN' -d '{"input":"Shein"}'`

## 2. Install the add-on (test deployment, your account only)

1. Go to https://script.google.com → **New project**, name it BrandCheck.
2. **Project Settings** (gear) → tick **Show "appsscript.json" manifest file in editor**.
3. Paste `appsscript.json` and `Code.gs` from this folder over the defaults.
4. In `Code.gs`, set `BACKEND_URL` (your Vercel URL, no trailing slash) and `ADDON_TOKEN`.
5. **Deploy → Test deployments → Application: Gmail → Install → Done**.
6. Open Gmail (refresh), open a sponsorship email, click the BrandCheck icon in the right sidebar, and **Authorize access** the first time.

Scopes: read the open message only, run as a Gmail add-on, call the BrandCheck backend.
