import type { ApiCall, Report, StreamEvent } from "./types";
import { YouClient } from "./you";
import { extractDeal } from "./extract";
import { checkIdentity, findOfficialSite } from "./identity";
import { brandMentioned, classifyEvidence, enrichWithContents, runCategorySearches } from "./checks";
import { buildCategories, decide, questionsFor } from "./score";
import { llmAvailable } from "./llm";

type Emit = (e: StreamEvent) => void;

export async function runCheck(input: string, emit: Emit, opts: { force?: boolean } = {}): Promise<Report> {
  const t0 = Date.now();
  const key = process.env.YDC_API_KEY;
  if (!key) throw new Error("YDC_API_KEY is not set. Add it to .env.local, or try a demo run.");
  const you = new YouClient(key);
  const llmCalls: ApiCall[] = [];
  const warnings: string[] = [];
  if (!llmAvailable()) warnings.push("No LLM key configured: using rule-based extraction and scoring.");

  const step = (id: string, label: string, status: "running" | "done" | "error", note?: string) =>
    emit({ type: "step", id, label, status, note });

  // 1. Extract
  step("extract", "Reading the deal email", "running");
  const extraction = await extractDeal(input, llmCalls);
  emit({ type: "extraction", data: extraction });
  step("extract", "Reading the deal email", "done", extraction.brand);

  // 2. Identity / fake-email layer (official site lookup feeds both)
  step("identity", `Verifying the sender is really ${extraction.brand}`, "running");
  const site = await findOfficialSite(you, extraction, llmCalls);

  // Start the risk searches and overview in parallel with the identity check.
  const searchesP = runCategorySearches(you, extraction);
  const overviewP = you
    .answer(
      `What does ${extraction.brand}${site.domain ? ` (${site.domain})` : ""} sell, and in the last 12 months are there reports of it not paying influencers, lawsuits, recalls, layoffs or controversies?`,
      "cited brand overview"
    )
    .then((a) => ({
      text: a.answer,
      citations: (a.citations ?? []).map((c) => ({ url: c.source, title: a.results?.web?.find((w) => w.url === c.source)?.title })),
    }))
    .catch(async () => {
      try {
        const r = await you.research(`Brief background check on the company ${extraction.brand}${site.domain ? ` (${site.domain})` : ""} for a creator considering a sponsorship: what it sells, payment reputation with creators, legal issues, finances, recent controversy.`, "lite", "research fallback");
        return { text: r.output.content, citations: (r.output.sources ?? []).map((s) => ({ url: s.url, title: s.title })) };
      } catch {
        return null;
      }
    });

  const identity = await checkIdentity(you, input, extraction, site, llmCalls);
  emit({ type: "identity", data: identity });
  step("identity", `Verifying the sender is really ${extraction.brand}`, identity.likelyScam ? "error" : "done",
    identity.senderStatus === "verified" ? `Matches ${identity.officialDomain}` : identity.likelyScam ? "Possible scam" : identity.senderStatus);

  if (identity.likelyScam && !opts.force) {
    const d = decide(extraction, identity, [], 0);
    const report: Report = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      input,
      extraction,
      identity,
      ...d,
      categories: [],
      overview: null,
      questions: questionsFor(extraction, identity, [], "scam"),
      calls: [...you.calls, ...llmCalls],
      durationMs: Date.now() - t0,
      mode: "live",
      warnings,
    };
    searchesP.catch(() => {});
    return report;
  }

  // 3. Parallel risk checks
  step("search", "Searching payment complaints, lawsuits, money trouble, backlash", "running");
  const { hits, searched, failures } = await searchesP;
  if (failures.length) warnings.push(`${failures.length} search(es) failed; results may be incomplete.`);
  step("search", "Searching payment complaints, lawsuits, money trouble, backlash", failures.length === 4 ? "error" : "done", `${hits.length} results`);

  step("read", "Reading the top sources in full", "running");
  const passages = await enrichWithContents(you, hits, extraction.brand);
  step("read", "Reading the top sources in full", "done", `${passages.size} pages`);

  step("score", "Scoring with the BrandCheck rubric", "running");
  const evidence = await classifyEvidence(hits, passages, extraction, site, llmCalls);
  const categories = buildCategories(evidence, searched);
  const mentions = hits.filter((h) => brandMentioned(h.r, extraction.brand)).length;
  const overview = await overviewP;
  const d = decide(extraction, identity, categories, mentions);
  step("score", "Scoring with the BrandCheck rubric", "done");

  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    input,
    extraction,
    identity,
    ...d,
    categories,
    overview,
    questions: questionsFor(extraction, identity, categories, d.verdictKind),
    calls: [...you.calls, ...llmCalls],
    durationMs: Date.now() - t0,
    mode: failures.length ? "partial" : "live",
    warnings,
  };
}
