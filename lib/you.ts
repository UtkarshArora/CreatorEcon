// Thin You.com API client. Every call is logged so the UI can show which
// endpoints powered a report.
import type { ApiCall } from "./types";

const INDEX = "https://ydc-index.io";
const API = "https://api.you.com";

export interface WebResult {
  url: string;
  title: string;
  description?: string;
  snippets?: string[];
  page_age?: string;
  contents?: { highlights?: string[]; markdown?: string };
  favicon_url?: string;
}

type AnswerRes = { answer: string; citations: { source: string }[]; results?: { web?: WebResult[] } };
type ResearchRes = { output: { content: string; sources?: { url: string; title?: string }[] } };

export class YouClient {
  calls: ApiCall[] = [];
  constructor(private key: string) {}

  private async post<T>(
    base: string,
    path: string,
    body: unknown,
    endpoint: ApiCall["endpoint"],
    label: string,
    timeoutMs: number,
    count: (r: T) => number
  ): Promise<T> {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "X-API-Key": this.key, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as T;
      this.calls.push({ endpoint, label, ms: Date.now() - t0, ok: true, results: count(json) });
      return json;
    } catch (e) {
      this.calls.push({ endpoint, label, ms: Date.now() - t0, ok: false });
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(
    query: string,
    opts: {
      count?: number;
      freshness?: string;
      include_domains?: string[];
      highlights?: boolean;
      label?: string;
    } = {}
  ): Promise<WebResult[]> {
    const body: Record<string, unknown> = { query, count: opts.count ?? 8, country: "US" };
    if (opts.freshness) body.freshness = opts.freshness;
    if (opts.include_domains) body.include_domains = opts.include_domains;
    if (opts.highlights) body.extraction = { extraction_mode: "highlights", highlights: { total_max_tokens: 2048 } };
    const json = await this.post<{ results?: { web?: WebResult[] } }>(
      INDEX,
      "/v1/search",
      body,
      "Search",
      opts.label ?? query,
      12000,
      (r) => r.results?.web?.length ?? 0
    );
    return json.results?.web ?? [];
  }

  async contents(urls: string[], label = "full text"): Promise<{ url: string; title?: string; markdown?: string | null }[]> {
    if (!urls.length) return [];
    const json = await this.post<{ url: string; title?: string; markdown?: string | null }[]>(
      INDEX,
      "/v1/contents",
      { urls, formats: ["markdown"], crawl_timeout: 8 },
      "Contents",
      label,
      15000,
      (r) => (Array.isArray(r) ? r.length : 0)
    );
    return Array.isArray(json) ? json : [];
  }

  async answer(query: string, label = "overview"): Promise<AnswerRes> {
    return this.post<AnswerRes>(
      API,
      "/v1/answer",
      { query: query.slice(0, 400) },
      "Answer",
      label,
      25000,
      (r) => r.citations?.length ?? 0
    );
  }

  async research(
    input: string,
    effort: "lite" | "standard" = "lite",
    label = "research"
  ): Promise<ResearchRes> {
    return this.post<ResearchRes>(
      API,
      "/v1/research",
      { input, research_effort: effort },
      "Research",
      label,
      30000,
      (r) => r.output?.sources?.length ?? 0
    );
  }
}

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
