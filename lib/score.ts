// Fixed, explainable rubric. The LLM only classifies individual sources;
// the verdict itself is computed here so it is consistent run to run.
import type { CategoryId, CategoryResult, Evidence, Extraction, Identity, Report, Verdict } from "./types";
import { CATEGORY_META } from "./checks";

const ORDER: CategoryId[] = ["payment", "legal", "finance", "backlash"];

const FORUM = /reddit\.com|quora\.com|forum|community\.|trustpilot|sitejabber|complaintsboard/;
const RECENT_MONTHS = 18;

function ageMonths(e: Evidence): number | null {
  const t = Date.parse(e.date ?? "");
  if (!Number.isNaN(t)) return (Date.now() - t) / (1000 * 60 * 60 * 24 * 30.4);
  if (e.year) return (new Date().getFullYear() - e.year) * 12;
  return null;
}
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

// Apply rubric caps to one source. Returns the severity the verdict may use and why it was capped.
export function countedSeverity(e: Evidence): { counted: Evidence["severity"]; note?: string } {
  let s = e.severity;
  let note: string | undefined;
  if (s <= 0) return { counted: 0 };
  const age = ageMonths(e);
  if (age === null || age > RECENT_MONTHS) {
    if (s > 1) note = age === null ? "Undated, shown for context only" : "Older than 18 months, shown for context only";
    s = Math.min(s, 1) as Evidence["severity"];
  }
  if (!e.creatorImpact && s > 1) {
    note = "Doesn't affect creators directly, shown for context only";
    s = 1;
  }
  return { counted: s, note };
}

// Red needs recent, creator-relevant, credible evidence:
// - payment: 2+ independent sites at caution or worse, or a serious report from a non-forum source
// - legal: a serious report from a non-forum source
// Money trouble and backlash can raise caution (yellow) but never make a brand red on their own.
export function buildCategories(evidence: Evidence[], searched: Record<CategoryId, string[]>): CategoryResult[] {
  return ORDER.map((id) => {
    const ev = evidence
      .filter((e) => e.category === id && e.aboutBrand && e.severity > 0)
      .map((e) => ({ ...e, ...countedSeverity(e) }))
      .sort((a, b) => (b.counted ?? 0) - (a.counted ?? 0) || b.severity - a.severity || (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0));
    const strong = ev.filter((e) => (e.counted ?? 0) >= 2);
    const sites = new Set(strong.map((e) => hostOf(e.url)));
    const seriousNews = strong.some((e) => e.counted === 3 && !FORUM.test(e.url));
    let score: CategoryResult["score"] = 0;
    if (strong.length) score = 2;
    else if (ev.length) score = 1;
    if (id === "payment" && strong.length && (sites.size >= 2 || seriousNews)) score = 3;
    if (id === "legal" && seriousNews) score = 3;
    if (id === "finance" || id === "backlash") {
      // yellow only with a serious recent event, or 2+ independent sites
      score = strong.some((e) => e.counted === 3) || sites.size >= 2 ? 2 : ev.length ? 1 : 0;
    }
    const summary =
      score === 0
        ? "Nothing concerning found in live results."
        : score === 1
          ? "Only older, minor or non-creator issues. Shown for context."
          : score === 2
            ? `${strong.length} recent source(s) worth reading before you sign.`
            : `Serious: ${strong.length} recent source(s) from ${sites.size} site(s) report problems.`;
    return { id, name: CATEGORY_META[id].name, score, summary, evidence: ev.slice(0, 5), searched: searched[id] };
  });
}

export function decide(
  ex: Extraction,
  identity: Identity,
  categories: CategoryResult[],
  mentions: number
): Pick<Report, "verdict" | "verdictKind" | "headline" | "reasons"> {
  const reasons: string[] = [];
  if (identity.likelyScam) {
    identity.flags.filter((f) => f.severity === 3).slice(0, 3).forEach((f) => reasons.push(f.label));
    return {
      verdict: "red",
      verdictKind: "scam",
      headline: `Possible scam: this email may not be from ${ex.brand}`,
      reasons,
    };
  }
  const serious = categories.filter((c) => c.score === 3);
  const caution = categories.filter((c) => c.score === 2);
  const idCaution = identity.flags.filter((f) => f.severity >= 2 && (f.sourceUrl || f.fromEmail));

  let verdict: Verdict = "green";
  let kind: Report["verdictKind"] = "clean";
  if (serious.length) {
    verdict = "red";
    kind = "risk";
  } else if (caution.length || idCaution.length) {
    verdict = "yellow";
    kind = "risk";
  } else if (!identity.officialDomain || mentions < 3) {
    verdict = "yellow";
    kind = "thin";
  }

  serious.forEach((c) => reasons.push(`${c.name}: ${c.evidence[0]?.claim ?? c.summary}`));
  caution.forEach((c) => reasons.push(`${c.name}: ${c.evidence[0]?.claim ?? c.summary}`));
  idCaution.forEach((f) => reasons.push(f.label));
  if (kind === "thin") reasons.push(identity.officialDomain ? `Only ${mentions} public result(s) mention ${ex.brand}.` : `No official website found for ${ex.brand}.`);
  if (kind === "clean") reasons.push(`No payment complaints, lawsuits, money trouble or backlash found across ${mentions} live results.`);

  const headline =
    kind === "thin"
      ? `Not enough public info on ${ex.brand}`
      : verdict === "red"
        ? `High risk: think twice about ${ex.brand}`
        : verdict === "yellow"
          ? `Proceed with caution with ${ex.brand}`
          : `${ex.brand} looks safe to work with`;
  return { verdict, verdictKind: kind, headline, reasons: reasons.slice(0, 5) };
}

export function questionsFor(ex: Extraction, identity: Identity, categories: CategoryResult[], kind: Report["verdictKind"]): string[] {
  const q: string[] = [];
  const cat = (id: CategoryId) => categories.find((c) => c.id === id)?.score ?? 0;
  if (kind === "scam") {
    return [
      identity.officialDomain
        ? `Contact ${ex.brand} through ${identity.officialDomain} directly and ask if this campaign is real.`
        : `Ask for a contract on company letterhead and the sender's LinkedIn profile.`,
      "Never pay a fee, download a 'brief', or share login codes to get a deal.",
      "Ask them to continue on email from the company domain, not Telegram or WhatsApp.",
    ];
  }
  if (identity.senderStatus !== "verified" && identity.officialDomain)
    q.push(`Can you confirm this offer from an @${identity.officialDomain} address, or name the agency you work for?`);
  if (cat("payment") >= 1 || kind === "thin")
    q.push("Will you pay 50% upfront and the rest within 15 days of posting, in writing?");
  else q.push(`What are the payment terms (net-15/30), and who sends the payment: ${ex.brand} or an agency?`);
  if (cat("legal") >= 2) q.push("Is the product I'd promote affected by the lawsuit/recall I found? Can I see your claims substantiation?");
  if (cat("finance") >= 2) q.push("Is this campaign's budget already approved and funded, given recent layoffs or restructuring?");
  if (cat("backlash") >= 2) q.push("Can I approve the final talking points and leave the deal if the controversy escalates?");
  if (kind === "thin") q.push("Can you share your registered business name, address and a creator you've worked with before?");
  q.push("What usage rights and exclusivity do you need, and for how long?");
  q.push("Who handles FTC disclosure (#ad) requirements, and can I see the contract before I start?");
  return q.slice(0, 6);
}
