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
  if (!brand) brand = mostMentionedName(text);
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

const STOP = new Set(
  ("Hi Hello Hey Dear I We Our You Your The This That Thanks Thank Best Regards Cheers Subject From To Re Fwd " +
   "Creator Creators Partnerships Partnership Partner Partners Team Manager Influencer Marketing Campaign Campaigns Brand " +
   "Paid Collaboration Sponsorship Offer Program Opportunity Opportunities Congratulations Please Looking Download Message " +
   "YouTube Instagram TikTok Google Telegram WhatsApp Windows PDF USD FTC Reel Reels Stories Story Short Shorts Monday Tuesday " +
   "Wednesday Thursday Friday Saturday Sunday Q1 Q2 Q3 Q4 Brandi Daniel Priya Alex Maya New Explore Cooperation Malaysia Singapore " +
   "Budget Deliverables Payout Accept If It Just One Flat Nothing").split(" ")
);

// Rule-based brand guess: the capitalised name mentioned most, with the From line and subject counted double.
function mostMentionedName(text: string): string | null {
  const counts = new Map<string, number>();
  const add = (chunk: string, w: number) => {
    for (const m of chunk.matchAll(/\b[A-Z][A-Za-z0-9]{2,}\b/g)) {
      const tok = m[0];
      if (STOP.has(tok)) continue;
      counts.set(tok, (counts.get(tok) ?? 0) + w);
    }
  };
  const head = (text.match(/^(from|subject):.*$/gim) ?? []).join(" ").replace(/<[^>]+>/g, " ");
  add(head, 2);
  add(text.replace(/^(from|subject):.*$/gim, " ").replace(/\S+@\S+/g, " "), 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return n >= 2 ? best : null;
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
  { re: /(log|sign) ?in with (google|facebook|instagram|youtube|tiktok)|connect your (youtube|google|instagram) account|verify (channel|account) ownership|verify your (account|identity)|share your (login|password|2fa|verification code)/i, label: "Asks for account access", detail: "No sponsor needs your login or 2FA code.", severity: 3 },
  { re: /act (fast|now)|within 24 hours|expires in \d+ hours|limited spots|slots are limited|first[- ]come|respond immediately|urgent|keep (it|this|the terms) (confidential|secret)/i, label: "Pressure to act fast", detail: "Artificial urgency is used to stop you from checking.", severity: 2 },
  { re: /our company has paid attention|we will send you (our|the) terms|(hi|hello|dear) (dear )?creator\b|your channel has been selected|lacks popularity/i, label: "Generic, copy-paste pitch", detail: "Doesn't name you or your content and holds back the terms, typical of mass scam outreach.", severity: 2 },
  { re: /\$\s?\d{2,3},?\d{3}.{0,40}(one|single|1) (post|story|video)/i, label: "Pay looks too good", detail: "Offer is far above typical rates for a single post.", severity: 2 },
];

export function scanScamPatterns(input: string): Flag[] {
  return SCAM_PATTERNS.flatMap((p) => {
    const m = input.match(p.re);
    if (!m) return [];
    const i = m.index ?? 0;
    const quote = input.slice(Math.max(0, i - 30), i + m[0].length + 30).replace(/\s+/g, " ").trim();
    return [{ label: p.label, detail: `${p.detail} ("…${quote}…")`, severity: p.severity, fromEmail: true }];
  });
}

export async function llmScamFlags(input: string, calls: ApiCall[]): Promise<Flag[]> {
  const res = await llmJson<{ flags: { label: string; detail: string; severity: number; quote?: string }[] }>(
    `You are a fraud analyst protecting content creators from fake brand-deal emails.
List concrete scam signals present IN THE TEXT (not speculation): requests for upfront payment or fees, downloading apps/files/briefs, moving to Telegram/WhatsApp, requests for logins or codes, unusual payment (crypto, gift cards, checks to deposit then refund), extreme urgency, pay wildly above market, generic greeting that ignores the creator's content, mismatched brand/sender details.
Do NOT flag normal business practice: net-30/net-60 payment, affiliate links, contracts or briefs sent through a partnerships platform, asking for availability or rates, FTC #ad disclosure, product seeding, scheduling a call.
Return {"flags":[{"label": short, "detail": one sentence, "severity": 2 or 3, "quote": exact short quote from the email}]}. Return {"flags":[]} if none.`,
    input.slice(0, 8000),
    calls,
    "scam patterns"
  );
  // Every flag must cite the email: drop flags whose quote is not actually in the text.
  const flat = input.replace(/\s+/g, " ").toLowerCase();
  return (res?.flags ?? [])
    .filter((f) => f.quote && flat.includes(f.quote.replace(/\s+/g, " ").toLowerCase().slice(0, 40)))
    .slice(0, 6)
    .map((f) => ({
      label: f.label,
      detail: `${f.detail} ("${f.quote}")`,
      severity: (f.severity >= 3 ? 3 : 2) as 2 | 3,
      fromEmail: true,
    }));
}
