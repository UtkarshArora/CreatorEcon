import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

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
