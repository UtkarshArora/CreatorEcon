import type { ApiCall, CategoryId, Evidence, Extraction } from "./types";
import { YouClient, WebResult, domainOf } from "./you";
import { llmJson } from "./llm";
import type { OfficialSite } from "./identity";

export const CATEGORY_META: Record<CategoryId, { name: string; short: string }> = {
  payment: { name: "Payment risk", short: "Do they pay creators?" },
  legal: { name: "Lawsuits, recalls & FTC", short: "Legal and safety trouble" },
  finance: { name: "Money trouble", short: "Layoffs, debt, shutdowns" },
  backlash: { name: "Recent backlash", short: "Controversy and boycotts" },
};

function dateRange(yearsBack: number) {
  const to = new Date();
  const from = new Date();
  from.setFullYear(to.getFullYear() - yearsBack);
  const f = (d: Date) => d.toISOString().slice(0, 10);
  return `${f(from)}to${f(to)}`;
}

function queriesFor(cat: CategoryId, brand: string): { q: string; opts: Parameters<YouClient["search"]>[1] }[] {
  const b = `"${brand}"`;
  switch (cat) {
    case "payment":
      return [
        { q: `${b} brand deal influencer never paid OR unpaid OR "didn't pay" OR "late payment"`, opts: { count: 8, include_domains: ["reddit.com"], label: "Reddit: unpaid creators" } },
        { q: `${b} influencer creators not paid complaints sponsorship`, opts: { count: 6, freshness: dateRange(2), label: "creator payment complaints" } },
      ];
    case "legal":
      return [
        { q: `${b} lawsuit OR "class action" OR FTC OR settlement OR recall`, opts: { count: 8, freshness: dateRange(3), label: "lawsuits, FTC, recalls" } },
      ];
    case "finance":
      return [
        { q: `${b} layoffs OR bankruptcy OR "shutting down" OR "unpaid invoices" OR "cash crunch"`, opts: { count: 6, freshness: "year", label: "layoffs and money trouble" } },
      ];
    case "backlash":
      return [
        { q: `${b} backlash OR boycott OR controversy OR "under fire"`, opts: { count: 6, freshness: "year", label: "recent backlash news" } },
      ];
  }
}

export interface RawHit {
  category: CategoryId;
  r: WebResult;
}

export async function runCategorySearches(you: YouClient, ex: Extraction) {
  const cats: CategoryId[] = ["payment", "legal", "finance", "backlash"];
  const searched: Record<CategoryId, string[]> = { payment: [], legal: [], finance: [], backlash: [] };
  const hits: RawHit[] = [];
  const failures: string[] = [];
  await Promise.all(
    cats.flatMap((cat) =>
      queriesFor(cat, ex.brand).map(async ({ q, opts }) => {
        searched[cat].push(opts?.label ?? q);
        try {
          const res = await you.search(q, opts);
          res.forEach((r) => hits.push({ category: cat, r }));
        } catch (e) {
          failures.push(`${opts?.label}: ${(e as Error).message}`);
        }
      })
    )
  );
  // de-dupe by URL, first category wins
  const seen = new Set<string>();
  const unique = hits.filter((h) => (seen.has(h.r.url) ? false : (seen.add(h.r.url), true)));
  return { hits: unique, searched, failures };
}

const RISK_WORDS = /lawsuit|sued|class action|ftc|settle|recall|fined|penalt|never paid|unpaid|didn'?t pay|not paid|late pay|scam|fraud|bankrupt|layoff|laid off|shut(ting)? down|boycott|backlash|controvers|investigat|warning letter|deceptive/i;
const SERIOUS_WORDS = /never paid|didn'?t pay|unpaid|ftc (settle|order|complaint|action)|class action|recall|bankrupt|fraud|scam|fined|criminal|chapter (7|11)/i;

const textOf = (r: WebResult) => `${r.title} ${r.description ?? ""} ${(r.snippets ?? []).join(" ")} ${(r.contents?.highlights ?? []).join(" ")}`;

export function brandMentioned(r: WebResult, brand: string) {
  return textOf(r).toLowerCase().includes(brand.toLowerCase());
}

export async function enrichWithContents(you: YouClient, hits: RawHit[], brand: string) {
  // Pull full text for the most risk-looking non-Reddit pages so flags can quote the source.
  const picks = hits
    .filter((h) => brandMentioned(h.r, brand) && RISK_WORDS.test(textOf(h.r)) && !/reddit\.com/.test(h.r.url))
    .slice(0, 4);
  const passages = new Map<string, string>();
  if (!picks.length) return passages;
  try {
    const docs = await you.contents(picks.map((p) => p.r.url), "full text of top sources");
    for (const d of docs) {
      if (!d.markdown) continue;
      passages.set(d.url, bestPassage(d.markdown, brand));
    }
  } catch {
    /* snippets are enough to proceed */
  }
  return passages;
}

function bestPassage(md: string, brand: string) {
  const sentences = md.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const b = brand.toLowerCase();
  let best = "";
  let bestScore = -1;
  for (let i = 0; i < sentences.length; i++) {
    const win = sentences.slice(i, i + 2).join(" ");
    if (win.length > 600) continue;
    const lw = win.toLowerCase();
    const s = (lw.includes(b) ? 2 : 0) + (RISK_WORDS.test(win) ? 2 : 0) + (SERIOUS_WORDS.test(win) ? 1 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = win;
    }
  }
  return best.slice(0, 500);
}

function monthsAgo(date: string | null) {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60 * 24 * 30);
}

export async function classifyEvidence(
  hits: RawHit[],
  passages: Map<string, string>,
  ex: Extraction,
  site: OfficialSite,
  calls: ApiCall[]
): Promise<Evidence[]> {
  const items = hits.slice(0, 40).map((h, i) => ({
    id: `e${i}`,
    category: h.category,
    title: h.r.title,
    url: h.r.url,
    date: h.r.page_age ?? null,
    snippet: (h.r.description || h.r.snippets?.[0] || h.r.contents?.highlights?.[0] || "").slice(0, 400),
    passage: passages.get(h.r.url),
  }));

  const llm = await llmJson<{ items: { id: string; aboutBrand: boolean; severity: number; claim: string; category?: CategoryId }[] }>(
    `You vet brands for content creators. For each search result decide:
- aboutBrand: true only if it is about THIS company (match the official domain and description; reject companies, people or products that merely share the name).
- severity: 0 = not a risk / irrelevant / positive, 1 = minor or old/resolved, 2 = caution (credible complaint, ongoing issue), 3 = serious (multiple non-payment reports, FTC action, recall, major lawsuit, bankruptcy) .
- claim: one neutral sentence stating what the source reports, attributed ("Reddit users report...", "Reuters reports..."). Never state allegations as fact.
- category: one of payment, legal, finance, backlash (keep the given one unless clearly wrong).
Results older than 2 years should rarely be above 1. Return {"items":[...]} with every id.`,
    JSON.stringify({
      brand: ex.brand,
      officialDomain: site.domain,
      about: site.about,
      today: new Date().toISOString().slice(0, 10),
      results: items,
    }),
    calls,
    "classify evidence",
    4000
  );
  const byId = new Map((llm?.items ?? []).map((x) => [x.id, x]));

  return items.map((it) => {
    const c = byId.get(it.id);
    if (c) {
      return {
        ...it,
        category: c.category && CATEGORY_META[c.category] ? c.category : it.category,
        aboutBrand: Boolean(c.aboutBrand),
        severity: Math.max(0, Math.min(3, Math.round(c.severity))) as Evidence["severity"],
        claim: c.claim || it.title,
      };
    }
    // Rule-based fallback.
    const text = `${it.title} ${it.snippet} ${it.passage ?? ""}`;
    const about = text.toLowerCase().includes(ex.brand.toLowerCase()) || (site.domain ? text.includes(site.domain) : false);
    let sev: number = !about ? 0 : SERIOUS_WORDS.test(text) ? 3 : RISK_WORDS.test(text) ? 2 : 0;
    const age = monthsAgo(it.date);
    if (age !== null && age > 24 && sev > 0) sev -= 1;
    return { ...it, aboutBrand: about, severity: sev as Evidence["severity"], claim: it.title };
  });
}

export function hostLabel(url: string) {
  const d = domainOf(url) ?? url;
  return d;
}
