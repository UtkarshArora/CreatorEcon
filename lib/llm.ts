// Minimal Claude client (Messages API over fetch). Returns parsed JSON.
// If no key is configured, callers fall back to rule-based logic.
import type { ApiCall } from "./types";

export function llmAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function llmJson<T>(
  system: string,
  user: string,
  calls: ApiCall[],
  label: string,
  maxTokens = 2000
): Promise<T | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: maxTokens,
        system: system + "\n\nRespond with a single JSON object only. No prose, no code fences.",
        messages: [{ role: "user", content: user }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content: { type: string; text?: string }[] };
    const text = json.content.find((c) => c.type === "text")?.text ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(start, end + 1)) as T;
    calls.push({ endpoint: "LLM", label, ms: Date.now() - t0, ok: true });
    return parsed;
  } catch (e) {
    console.error("llm error", label, e);
    calls.push({ endpoint: "LLM", label, ms: Date.now() - t0, ok: false });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
