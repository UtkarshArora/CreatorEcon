// LLM client. Primary: You.com Inference Router (OpenAI-compatible, same YDC_API_KEY).
// Fallback: Anthropic Messages API. Returns parsed JSON, or null so callers use rule-based logic.
import type { ApiCall } from "./types";

export function llmAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.YDC_API_KEY);
}

const ROUTER_MODEL = () => process.env.YDC_LLM_MODEL || "kimi-k3";
const CLAUDE_MODEL = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

function parseJson<T>(text: string): T {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function viaRouter(system: string, user: string, maxTokens: number): Promise<string> {
  return withTimeout(30000, async (signal) => {
    const res = await fetch("https://api.you.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.YDC_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ROUTER_MODEL(),
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`router ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error("router: empty response");
    return text;
  });
}

async function viaAnthropic(system: string, user: string, maxTokens: number): Promise<string> {
  return withTimeout(25000, async (signal) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: CLAUDE_MODEL(), max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
      signal,
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content: { type: string; text?: string }[]; stop_reason?: string };
    if (json.stop_reason === "max_tokens") throw new Error("anthropic: output cut off at max_tokens");
    return json.content.find((c) => c.type === "text")?.text ?? "";
  });
}

export async function llmJson<T>(
  system: string,
  user: string,
  calls: ApiCall[],
  label: string,
  maxTokens = 2000
): Promise<T | null> {
  const sys = system + "\n\nRespond with a single JSON object only. No prose, no code fences.";
  // Anthropic is the default; the You.com Inference Router is opt-in (YDC_LLM_ROUTER=1) and goes first when on.
  const providers: { name: string; model: string; run: () => Promise<string> }[] = [];
  const router = { name: "You.com Inference Router", model: ROUTER_MODEL(), run: () => viaRouter(sys, user, maxTokens) };
  if (process.env.YDC_API_KEY && process.env.YDC_LLM_ROUTER === "1") providers.push(router);
  if (process.env.ANTHROPIC_API_KEY)
    providers.push({ name: "Anthropic", model: CLAUDE_MODEL(), run: () => viaAnthropic(sys, user, maxTokens) });
  if (!providers.length && process.env.YDC_API_KEY) providers.push(router);

  for (const p of providers) {
    const t0 = Date.now();
    try {
      const raw = await p.run();
      let parsed: T;
      try {
        parsed = parseJson<T>(raw);
      } catch {
        throw new Error(`bad JSON from model: ${raw.slice(0, 80)}`);
      }
      calls.push({ endpoint: "LLM", label, ms: Date.now() - t0, ok: true, provider: `${p.name} · ${p.model}` });
      return parsed;
    } catch (e) {
      console.error("llm error", p.name, label, e);
      const msg = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
      calls.push({ endpoint: "LLM", label, ms: Date.now() - t0, ok: false, provider: `${p.name} · ${p.model}`, error: msg.slice(0, 160) });
    }
  }
  return null;
}
