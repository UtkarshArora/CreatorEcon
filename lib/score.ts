// Fixed, explainable rubric. The LLM only classifies individual sources;
// the verdict itself is computed here so it is consistent run to run.
import type { CategoryId, CategoryResult, Evidence, Extraction, Identity, Report, Verdict } from "./types";
import { CATEGORY_META } from "./checks";

const ORDER: CategoryId[] = ["payment", "legal", "finance", "backlash"];

export function buildCategories(evidence: Evidence[], searched: Record<CategoryId, string[]>): CategoryResult[] {
  return ORDER.map((id) => {
    const ev = evidence
      .filter((e) => e.category === id && e.aboutBrand && e.severity > 0)
      .sort((a, b) => b.severity - a.severity || (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0));
    // Two independent caution-level sources about payment count as serious.
    let score = (ev[0]?.severity ?? 0) as CategoryResult["score"];
    const strong = ev.filter((e) => e.severity >= 2).length;
    if (score === 2 && strong >= 3) score = 3;
    // A single forum post is not enough for a red flag on its own.
    if (score === 3 && strong < 2 && /reddit\.com|quora\.com|forum/.test(ev[0].url)) score = 2;
    const summary =
      score === 0
        ? "Nothing concerning found in live results."
        : score === 1
          ? "Minor or older mentions only."
          : score === 2
            ? `${ev.filter((e) => e.severity >= 2).length} source(s) worth reading before you sign.`
            : `Serious: ${ev.filter((e) => e.severity >= 2).length} source(s) report problems.`;
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
  const idCaution = identity.flags.filter((f) => f.severity >= 2);

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
