import { runCheck } from "@/lib/pipeline";
import type { StreamEvent } from "@/lib/types";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const maxDuration = 60;

// Streams NDJSON progress events, ending with the full report.
export async function POST(req: Request) {
  const { input, force, saveAs } = (await req.json()) as { input?: string; force?: boolean; saveAs?: string };
  if (!input || !input.trim()) return Response.json({ error: "Paste a deal email or a brand name." }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: StreamEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        const report = await runCheck(input.slice(0, 12000), emit, { force });
        emit({ type: "report", data: report });
        // Record a demo fixture locally (dev only): POST with saveAs="red" etc.
        if (saveAs && process.env.NODE_ENV !== "production" && /^[a-z0-9-]+$/.test(saveAs)) {
          await fs.writeFile(path.join(process.cwd(), "data/demo", `${saveAs}.json`), JSON.stringify(report, null, 2));
        }
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
