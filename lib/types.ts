export type Verdict = "green" | "yellow" | "red";

export type CategoryId = "payment" | "legal" | "finance" | "backlash";

export interface ApiCall {
  endpoint: "Search" | "Contents" | "Answer" | "Research" | "LLM";
  label: string;
  ms: number;
  ok: boolean;
  results?: number;
  cached?: boolean;
}

export interface Extraction {
  brand: string;
  senderEmail: string | null;
  senderDomain: string | null;
  offer: string | null;
  paymentTerms: string | null;
  product: string | null;
}

export interface Flag {
  label: string;
  detail: string;
  severity: 1 | 2 | 3; // 1 info, 2 caution, 3 serious
  sourceUrl?: string;
  sourceTitle?: string;
  fromEmail?: boolean; // evidence is a quote from the pasted email itself
}

export interface Identity {
  officialDomain: string | null;
  officialUrl: string | null;
  officialTitle: string | null;
  senderStatus:
    | "verified" // sender domain matches official domain
    | "freemail" // gmail/outlook etc.
    | "lookalike" // looks like the brand but is not the official domain
    | "unrelated" // different domain, not obviously lookalike
    | "unknown"; // no sender domain or no official domain found
  flags: Flag[];
  scamScore: number; // 0..100
  likelyScam: boolean;
}

export interface Evidence {
  id: string;
  category: CategoryId;
  title: string;
  url: string;
  date: string | null;
  snippet: string;
  passage?: string; // full-text passage pulled via Contents
  // classification
  aboutBrand: boolean;
  severity: 0 | 1 | 2 | 3;
  claim: string;
  creatorImpact: boolean; // directly affects a creator working with / paid by the brand
  year: number | null; // year of the reported event
  counted?: 0 | 1 | 2 | 3; // severity after rubric caps (what the verdict used)
  note?: string; // why it was capped
}

export interface CategoryResult {
  id: CategoryId;
  name: string;
  score: 0 | 1 | 2 | 3; // 0 clean, 1 minor, 2 caution, 3 serious
  summary: string;
  evidence: Evidence[];
  searched: string[];
}

export interface Report {
  id: string;
  createdAt: string;
  input: string;
  extraction: Extraction;
  identity: Identity;
  verdict: Verdict;
  verdictKind: "scam" | "risk" | "thin" | "clean";
  headline: string;
  reasons: string[];
  categories: CategoryResult[];
  overview: { text: string; citations: { url: string; title?: string }[] } | null;
  questions: string[];
  calls: ApiCall[];
  durationMs: number;
  mode: "live" | "cached" | "partial";
  warnings: string[];
}

export type StreamEvent =
  | { type: "step"; id: string; label: string; status: "running" | "done" | "error"; note?: string }
  | { type: "extraction"; data: Extraction }
  | { type: "identity"; data: Identity }
  | { type: "report"; data: Report }
  | { type: "error"; message: string };
