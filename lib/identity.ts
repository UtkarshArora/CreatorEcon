import type { ApiCall, Extraction, Flag, Identity } from "./types";
import { YouClient, WebResult, domainOf } from "./you";
import { FREEMAIL, llmScamFlags, scanScamPatterns } from "./extract";
import { llmJson } from "./llm";

const NOT_OFFICIAL = [
  "wikipedia.org", "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com",
  "youtube.com", "reddit.com", "amazon.com", "crunchbase.com", "bloomberg.com", "glassdoor.com",
  "indeed.com", "trustpilot.com", "bbb.org", "yelp.com", "pinterest.com", "zoominfo.com", "pitchbook.com",
  "apps.apple.com", "play.google.com", "medium.com", "forbes.com", "cnbc.com", "nytimes.com",
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function root(domain: string) {
  const parts = domain.split(".");
  const twoPartTld = /^(co|com|org|net)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoPartTld ? -3 : -2).join(".");
}

function lev(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export interface OfficialSite {
  domain: string | null;
  url: string | null;
  title: string | null;
  about: string | null;
}

export async function findOfficialSite(you: YouClient, ex: Extraction, calls: ApiCall[]): Promise<OfficialSite> {
  const hint = ex.product ? ` ${ex.product}` : "";
  let results: WebResult[] = [];
  try {
    results = await you.search(`${ex.brand}${hint} official website`, { count: 8, label: "official site" });
  } catch {
    return { domain: null, url: null, title: null, about: null };
  }
  const candidates = results.filter((r) => {
    const d = domainOf(r.url);
    return d && !NOT_OFFICIAL.some((n) => d === n || d.endsWith("." + n));
  });
  if (!candidates.length) return { domain: null, url: null, title: null, about: null };

  // Let the LLM pick when the brand name is ambiguous; otherwise use a name match.
  const picked = await llmJson<{ index: number | null; about: string | null }>(
    `Pick the official website of the company a creator was pitched by. Prefer the company's own domain.
If the sender's email domain matches one of the candidates, that is strong evidence. Return {"index": number or null if none is the official site, "about": one sentence on what the company sells}.`,
    JSON.stringify({
      brand: ex.brand,
      product: ex.product,
      senderDomain: ex.senderDomain,
      candidates: candidates.map((c, i) => ({ index: i, url: c.url, title: c.title, description: c.description ?? c.snippets?.[0] })),
    }),
    calls,
    "pick official site",
    300
  );
  const b = norm(ex.brand);
  const byName = candidates.find((c) => norm(domainOf(c.url) ?? "").includes(b.slice(0, Math.max(4, Math.min(b.length, 8)))));
  const senderMatch = ex.senderDomain ? candidates.find((c) => root(domainOf(c.url) ?? "") === root(ex.senderDomain!)) : undefined;
  const chosen = senderMatch ? senderMatch : picked && picked.index !== null && candidates[picked.index] ? candidates[picked.index] : byName ?? (picked ? null : candidates[0]);
  if (!chosen) return { domain: null, url: null, title: null, about: picked?.about ?? null };
  return {
    domain: domainOf(chosen.url),
    url: chosen.url,
    title: chosen.title,
    about: picked?.about ?? chosen.description ?? chosen.snippets?.[0] ?? null,
  };
}

export async function checkIdentity(
  you: YouClient,
  input: string,
  ex: Extraction,
  site: OfficialSite,
  calls: ApiCall[]
): Promise<Identity> {
  const flags: Flag[] = [];
  let score = 0;
  const sender = ex.senderDomain;
  let senderStatus: Identity["senderStatus"] = "unknown";

  if (sender) {
    if (FREEMAIL.has(sender)) {
      senderStatus = "freemail";
      score += site.domain ? 30 : 15;
      flags.push({
        label: `Sent from a free ${sender} address`,
        detail: site.domain
          ? `${ex.brand}'s real domain is ${site.domain}. Brand partnership teams almost always email from the company domain.`
          : "Brand partnership teams almost always email from a company domain.",
        severity: site.domain ? 3 : 2,
        sourceUrl: site.url ?? undefined,
        sourceTitle: site.title ?? undefined,
      });
    } else if (site.domain) {
      const sr = root(sender);
      const or = root(site.domain);
      if (sr === or) {
        senderStatus = "verified";
      } else {
        const b = norm(ex.brand);
        const sLabel = sr.split(".")[0];
        const oLabel = or.split(".")[0];
        const looks = (b.length >= 4 && norm(sLabel).includes(b)) || lev(sLabel, oLabel) <= 2;
        senderStatus = looks ? "lookalike" : "unrelated";
        score += looks ? 50 : 20;
        flags.push({
          label: looks ? `Lookalike domain: ${sender}` : `Sender domain ${sender} is not ${ex.brand}'s`,
          detail: `${ex.brand}'s official site is ${site.domain}. ${looks ? "The sender's domain imitates it, a classic impersonation trick." : "Agencies sometimes email for brands, so ask them to confirm from a company address."}`,
          severity: looks ? 3 : 2,
          sourceUrl: site.url ?? undefined,
          sourceTitle: site.title ?? undefined,
        });
      }
    }
  }

  // Scam patterns in the email itself: rules plus LLM, de-duplicated by label.
  const isEmail = input.length > 120 || /\n/.test(input);
  if (isEmail) {
    const ruleFlags = scanScamPatterns(input);
    const aiFlags = await llmScamFlags(input, calls);
    const seen = new Set<string>();
    for (const f of [...ruleFlags, ...aiFlags]) {
      const k = norm(f.label).slice(0, 12);
      if (seen.has(k)) continue;
      seen.add(k);
      flags.push(f);
      score += f.severity === 3 ? 30 : 10;
    }
  }

  // Live web: scam reports for the sender domain and brand impersonation reports.
  const queries: Promise<{ kind: "domain" | "impersonation"; results: WebResult[] }>[] = [];
  if (sender && !FREEMAIL.has(sender) && senderStatus !== "verified") {
    queries.push(
      you.search(`"${sender}" scam OR phishing OR fake`, { count: 6, label: "sender domain scam reports" })
        .then((results) => ({ kind: "domain" as const, results }))
        .catch(() => ({ kind: "domain" as const, results: [] }))
    );
  }
  queries.push(
    you.search(`${ex.brand} fake brand deal email scam influencers impersonating`, { count: 6, freshness: "year", label: "impersonation reports" })
      .then((results) => ({ kind: "impersonation" as const, results }))
      .catch(() => ({ kind: "impersonation" as const, results: [] }))
  );
  for (const q of await Promise.all(queries)) {
    const text = (r: WebResult) => `${r.title} ${r.description ?? ""} ${(r.snippets ?? []).join(" ")}`.toLowerCase();
    if (q.kind === "domain") {
      const hit = q.results.find((r) => text(r).includes(sender!) && /scam|phish|fraud|fake/.test(text(r)));
      if (hit) {
        score += 40;
        flags.push({ label: `Scam reports mention ${sender}`, detail: hit.title, severity: 3, sourceUrl: hit.url, sourceTitle: hit.title });
      }
    } else {
      const b = ex.brand.toLowerCase();
      const hit = q.results.find((r) => text(r).includes(b) && /scam|impersonat|fake|phish/.test(text(r)));
      if (hit) {
        if (senderStatus !== "verified") score += 15;
        flags.push({
          label: `Scammers have impersonated ${ex.brand} before`,
          detail: senderStatus === "verified" ? "This email comes from the real domain, but stay alert." : hit.title,
          severity: senderStatus === "verified" ? 1 : 2,
          sourceUrl: hit.url,
          sourceTitle: hit.title,
        });
      }
    }
  }

  score = Math.min(100, score);
  return {
    officialDomain: site.domain,
    officialUrl: site.url,
    officialTitle: site.title,
    senderStatus,
    flags,
    scamScore: score,
    likelyScam: score >= 60,
  };
}
