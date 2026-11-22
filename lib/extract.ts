import type { ApiCall, Extraction, Flag } from "./types";
import { llmJson } from "./llm";

const EMAIL_RE = /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i;

export async function extractDeal(input: string, calls: ApiCall[]): Promise<Extraction> {
  const fallback = ruleExtract(input);
  const llm = await llmJson<Partial<Extraction>>(
    `You read brand sponsorship emails sent to content creators and extract structured facts.
Fields: brand (the company the sender claims to represent, as its common public name), senderEmail, senderDomain (domain part of the sender address), offer (one short sentence: what they want and what they pay), paymentTerms (exact terms if stated, else null), product (product or campaign, else null).
Use null when a field is not present. If the input is only a brand name or URL, put it in brand.`,
    input.slice(0, 8000),
    calls,
    "extract deal"
  );
  if (!llm || !llm.brand) return fallback;
  const senderEmail = llm.senderEmail ?? fallback.senderEmail;
  return {
    brand: String(llm.brand).trim(),
    senderEmail,
    senderDomain: (llm.senderDomain ?? senderEmail?.split("@")[1] ?? fallback.senderDomain)?.toLowerCase() ?? null,
    offer: llm.offer ?? fallback.offer,
    paymentTerms: llm.paymentTerms ?? null,
    product: llm.product ?? null,
  };
}

function ruleExtract(input: string): Extraction {
  const text = input.trim();
  const fromLine = text.match(/^from:.*$/im)?.[0] ?? "";
  const emailMatch = fromLine.match(EMAIL_RE) ?? text.match(EMAIL_RE);
  const senderEmail = emailMatch?.[0]?.toLowerCase() ?? null;
  const senderDomain = emailMatch?.[1]?.toLowerCase() ?? null;

  let brand: string | null = null;
  // Short input: treat as brand name or URL.
  if (text.length < 80 && !text.includes("\n")) {
    brand = text.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
    if (brand.includes(".")) brand = brand.split(".")[0];
  }
  if (!brand) {
    const m =
      text.match(/(?:on behalf of|here at|team at|work(?:ing)? with|partnership with|from the)\s+([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,2})/) ??
      text.match(/^subject:.*?([A-Z][\w&'.-]+(?:\s+[A-Z][\w&'.-]+)?)\s*(?:x|×|partnership|collab)/im);
    brand = m?.[1] ?? null;
  }
  if (!brand && senderDomain && !FREEMAIL.has(senderDomain)) brand = senderDomain.split(".")[0];
  brand = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Unknown brand";

  const money = text.match(/\$\s?[\d,]+(?:\.\d+)?(?:\s?(?:k|K))?/);
  return {
    brand,
    senderEmail,
    senderDomain,
    offer: money ? `Paid collaboration, ${money[0]} mentioned` : null,
    paymentTerms: text.match(/net[- ]?\d{2}|upfront|after (?:the )?(?:post|campaign)/i)?.[0] ?? null,
    product: null,
  };
}

export const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "ymail.com",
  "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com",
  "yandex.com", "qq.com", "163.com",
]);

// Patterns common in fake brand-deal emails (sources: FTC creator scam alerts, creator reports).
const SCAM_PATTERNS: { re: RegExp; label: string; detail: string; severity: 2 | 3 }[] = [
  { re: /telegram|whatsapp|signal app|wechat/i, label: "Moves the chat off email", detail: "Asks to continue on Telegram/WhatsApp, a common pattern in fake brand deals.", severity: 3 },
  { re: /(pay|cover|deposit|fee).{0,40}(shipping|registration|onboarding|verification|upfront|first)|processing fee|refundable deposit/i, label: "Asks you to pay", detail: "Real sponsors never ask creators to pay a fee or deposit.", severity: 3 },
  { re: /\.(exe|apk|scr|zip|rar)\b|download (our|the) (app|software|tool|brief)|install (our|the) (app|software)|password[- ]protected/i, label: "Asks you to download or install something", detail: "Malware-laced 'campaign briefs' are a known account-takeover tactic.", severity: 3 },
  { re: /gift ?card|crypto|bitcoin|usdt|wire transfer|western union|zelle first/i, label: "Unusual payment method", detail: "Payment via gift cards, crypto or wire before work is a scam signal.", severity: 3 },
  { re: /log ?in with|verify your (account|identity)|share your (login|password|2fa|verification code)/i, label: "Asks for account access", detail: "No sponsor needs your login or 2FA code.", severity: 3 },
  { re: /act (fast|now)|within 24 hours|limited spots|respond immediately|urgent/i, label: "Pressure to act fast", detail: "Artificial urgency is used to stop you from checking.", severity: 2 },
  { re: /\$\s?\d{2,3},?\d{3}.{0,40}(one|single|1) (post|story|video)/i, label: "Pay looks too good", detail: "Offer is far above typical rates for a single post.", severity: 2 },
];

export function scanScamPatterns(input: string): Flag[] {
  return SCAM_PATTERNS.filter((p) => p.re.test(input)).map((p) => ({ label: p.label, detail: p.detail, severity: p.severity }));
}

export async function llmScamFlags(input: string, calls: ApiCall[]): Promise<Flag[]> {
  const res = await llmJson<{ flags: { label: string; detail: string; severity: number; quote?: string }[] }>(
    `You are a fraud analyst protecting content creators from fake brand-deal emails.
List concrete scam signals present IN THE TEXT (not speculation): requests for upfront payment or fees, downloading apps/files/briefs, moving to Telegram/WhatsApp, requests for logins or codes, unusual payment (crypto, gift cards, checks to deposit then refund), extreme urgency, pay wildly above market, generic greeting that ignores the creator's content, mismatched brand/sender details.
Return {"flags":[{"label": short, "detail": one sentence, "severity": 2 or 3, "quote": exact short quote from the email}]}. Return {"flags":[]} if none.`,
    input.slice(0, 8000),
    calls,
    "scam patterns"
  );
  return (res?.flags ?? []).slice(0, 6).map((f) => ({
    label: f.label,
    detail: f.quote ? `${f.detail} ("${f.quote}")` : f.detail,
    severity: f.severity >= 3 ? 3 : 2,
  }));
}
