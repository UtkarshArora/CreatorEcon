import { runCheck } from "@/lib/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

// JSON endpoint for the Gmail add-on. Protected by a shared token (ADDON_TOKEN) sent as x-brandcheck-token.
export async function POST(req: Request) {
  const token = process.env.ADDON_TOKEN;
  if (!token || req.headers.get("x-brandcheck-token") !== token) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { input } = (await req.json()) as { input?: string };
  if (!input?.trim()) return Response.json({ error: "Empty email" }, { status: 400 });
  try {
    const r = await runCheck(input.slice(0, 12000), () => {}, { fast: true });
    const sources = [
      ...r.identity.flags.filter((f) => f.sourceUrl).map((f) => ({ label: f.label, url: f.sourceUrl! })),
      ...r.categories.flatMap((c) => c.evidence.filter((e) => (e.counted ?? 0) >= 2).map((e) => ({ label: `${c.name}: ${e.claim}`, url: e.url }))),
    ].slice(0, 6);
    return Response.json({
      brand: r.extraction.brand,
      verdict: r.verdict,
      verdictKind: r.verdictKind,
      headline: r.headline,
      reasons: r.reasons,
      sender: { email: r.extraction.senderEmail, status: r.identity.senderStatus, officialDomain: r.identity.officialDomain },
      flags: r.identity.flags.map((f) => ({ label: f.label, severity: f.severity })),
      categories: r.categories.map((c) => ({ name: c.name, score: c.score, summary: c.summary })),
      sources,
      questions: r.questions,
      seconds: Math.round(r.durationMs / 100) / 10,
      youCalls: r.calls.filter((c) => c.endpoint !== "LLM").length,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
