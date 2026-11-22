import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

// Saves a live report as a demo fixture (local dev only).
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return Response.json({ error: "Saving demos is only available in local dev." }, { status: 403 });
  const report = await req.json();
  const name = String(report?.extraction?.brand || "demo").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "demo";
  await fs.mkdir(path.join(process.cwd(), "data/demo"), { recursive: true });
  await fs.writeFile(path.join(process.cwd(), "data/demo", `${name}.json`), JSON.stringify({ ...report, mode: "live" }, null, 2));
  return Response.json({ saved: `data/demo/${name}.json` });
}

// Lists or serves cached demo runs recorded from real live checks.
export async function GET(req: Request) {
  const dir = path.join(process.cwd(), "data/demo");
  const name = new URL(req.url).searchParams.get("name");
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  if (!name) {
    const list = await Promise.all(
      files.map(async (f) => {
        const r = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
        return { name: f.replace(/\.json$/, ""), brand: r.extraction?.brand, verdict: r.verdict, input: r.input };
      })
    );
    return Response.json(list);
  }
  if (!/^[a-z0-9-]+$/.test(name) || !files.includes(`${name}.json`)) return Response.json({ error: "not found" }, { status: 404 });
  const report = JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), "utf8"));
  return Response.json({ ...report, mode: "cached" });
}
