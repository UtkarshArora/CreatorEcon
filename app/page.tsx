"use client";

import { useEffect, useRef, useState } from "react";
import type { CategoryResult, Evidence, Flag, Report, StreamEvent, Extraction, Identity } from "@/lib/types";
import { SAMPLES } from "@/lib/samples";

type Step = { id: string; label: string; status: "running" | "done" | "error"; note?: string };
type HistoryItem = { brand: string; verdict: Report["verdict"]; input: string; at: string; paid?: "yes" | "late" | "no" };

const HISTORY_KEY = "brandcheck.history.v1";
const SCORE_LABEL = ["Clear", "Minor", "Caution", "Serious"];

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function when(date: string | null) {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}
function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveHistory(h: HistoryItem[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 20)));
  } catch {}
}

type InboxItem = { uid: number; from: string; subject: string; date: string | null; input: string; status: "queued" | "checking" | "done" | "error"; report?: Report; error?: string };

// Runs a check and returns only the final report (used for inbox batch checks).
async function checkToReport(input: string): Promise<Report> {
  const res = await fetch("/api/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input }) });
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
  const text = await res.text();
  let report: Report | null = null;
  let err: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line) as StreamEvent;
    if (ev.type === "report") report = ev.data;
    if (ev.type === "error") err = ev.message;
  }
  if (!report) throw new Error(err ?? "No report returned");
  return report;
}

export default function Home() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demos, setDemos] = useState<{ name: string; brand: string; verdict: string }[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const resultRef = useRef<HTMLDivElement>(null);
  const [inbox, setInbox] = useState<InboxItem[] | null>(null);
  const [inboxMsg, setInboxMsg] = useState<string | null>(null);
  const [inboxBusy, setInboxBusy] = useState(false);

  async function checkInbox() {
    setInboxBusy(true);
    setInboxMsg("Reading unread emails…");
    setInbox(null);
    try {
      const res = await fetch("/api/inbox");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Could not read the inbox");
      const items: InboxItem[] = j.emails.map((e: Omit<InboxItem, "status">) => ({ ...e, status: "queued" }));
      setInbox(items);
      setInboxMsg(items.length ? `${items.length} unread email(s) in ${j.account}` : `No unread emails in ${j.account}`);
      // Two at a time keeps it quick without hammering the APIs.
      let next = 0;
      const update = (uid: number, patch: Partial<InboxItem>) => setInbox((cur) => cur?.map((x) => (x.uid === uid ? { ...x, ...patch } : x)) ?? cur);
      const worker = async () => {
        while (next < items.length) {
          const it = items[next++];
          update(it.uid, { status: "checking" });
          try {
            const r = await checkToReport(it.input);
            update(it.uid, { status: "done", report: r });
            remember(r);
          } catch (e) {
            update(it.uid, { status: "error", error: (e as Error).message });
          }
        }
      };
      await Promise.all([worker(), worker()]);
    } catch (e) {
      setInboxMsg((e as Error).message);
    } finally {
      setInboxBusy(false);
    }
  }

  function openReport(r: Report) {
    reset();
    setInput(r.input);
    setExtraction(r.extraction);
    setIdentity(r.identity);
    setReport(r);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  useEffect(() => {
    setHistory(loadHistory());
    fetch("/api/demo").then((r) => r.json()).then(setDemos).catch(() => {});
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo) loadDemo(demo === "1" ? null : demo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    setSteps([]);
    setExtraction(null);
    setIdentity(null);
    setReport(null);
    setError(null);
  }

  function remember(r: Report) {
    const h = [
      { brand: r.extraction.brand, verdict: r.verdict, input: r.input, at: r.createdAt, paid: history.find((x) => x.brand === r.extraction.brand)?.paid },
      ...loadHistory().filter((x) => x.brand.toLowerCase() !== r.extraction.brand.toLowerCase()),
    ];
    setHistory(h);
    saveHistory(h);
  }

  async function loadDemo(name: string | null) {
    reset();
    try {
      let n = name;
      if (!n) {
        const list = await fetch("/api/demo").then((r) => r.json());
        n = list[0]?.name;
      }
      if (!n) throw new Error("No cached demo runs recorded yet.");
      const r: Report = await fetch(`/api/demo?name=${n}`).then((x) => x.json());
      setInput(r.input);
      setExtraction(r.extraction);
      setIdentity(r.identity);
      setReport(r);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function run(text = input, force = false) {
    if (!text.trim() || busy) return;
    reset();
    setBusy(true);
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text, force }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as StreamEvent;
          if (ev.type === "step")
            setSteps((s) => {
              const idx = s.findIndex((x) => x.id === ev.id);
              const next = { id: ev.id, label: ev.label, status: ev.status, note: ev.note };
              if (idx < 0) return [...s, next];
              const copy = [...s];
              copy[idx] = next;
              return copy;
            });
          else if (ev.type === "extraction") setExtraction(ev.data);
          else if (ev.type === "identity") setIdentity(ev.data);
          else if (ev.type === "report") {
            setReport(ev.data);
            remember(ev.data);
            setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
          } else if (ev.type === "error") setError(ev.message);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function setPaid(brand: string, paid: HistoryItem["paid"]) {
    const h = history.map((x) => (x.brand === brand ? { ...x, paid } : x));
    setHistory(h);
    saveHistory(h);
  }

  return (
    <main className="wrap">
      <header className="top">
        <div className="logo">
          <span className="logo-mark" aria-hidden>✓</span>BrandCheck
        </div>
        <span className="pill">Live web data by You.com</span>
      </header>

      <h1>Know the brand before you sign.</h1>
      <p className="sub">
        Paste a sponsorship email. BrandCheck checks the sender is real, then searches the live web for unpaid creators,
        lawsuits, recalls, money trouble and backlash, and gives you a cited verdict in about 20 seconds.
      </p>

      <section className="card stack">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={"Paste the full deal email (with the From: line), or just a brand name"}
          aria-label="Deal email or brand name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
          }}
        />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="chips">
            {SAMPLES.map((s) => (
              <button key={s.label} className="chip" onClick={() => setInput(s.input)} type="button">
                {s.label}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => run()} disabled={busy || !input.trim()}>
            {busy ? "Checking…" : "Run background check"}
          </button>
        </div>
        <div className="row tiny muted" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <button className="btn-ghost" onClick={checkInbox} disabled={inboxBusy} type="button">
            {inboxBusy ? "Checking inbox…" : "✉ Check my inbox"}
          </button>
          {inboxMsg ?? "Scan unread sponsorship emails in your connected inbox."}
        </div>
        {inbox && inbox.length > 0 && (
          <div>
            {inbox.map((it) => (
              <div key={it.uid} className="flag" style={{ alignItems: "center", flexWrap: "wrap" }}>
                {it.report ? (
                  <span className={`score s${it.report.verdict === "green" ? 0 : it.report.verdict === "yellow" ? 2 : 3}`}>
                    {it.report.verdictKind === "scam" ? "scam" : it.report.verdictKind === "thin" ? "no info" : it.report.verdict}
                  </span>
                ) : (
                  <span className={`dot ${it.status === "checking" ? "running" : it.status === "error" ? "error" : ""}`} />
                )}
                <div style={{ flex: 1, minWidth: 180 }}>
                  <div className="small"><strong>{it.subject}</strong></div>
                  <div className="tiny muted">{it.from}{it.report ? ` · ${it.report.headline}` : it.error ? ` · ${it.error}` : it.status === "checking" ? " · checking…" : ""}</div>
                </div>
                {it.report && <button className="btn-ghost" onClick={() => openReport(it.report!)}>Open</button>}
              </div>
            ))}
          </div>
        )}
        {demos.length > 0 && (
          <div className="row tiny muted">
            Cached demo runs:
            {demos.map((d) => (
              <button key={d.name} className="btn-ghost" onClick={() => loadDemo(d.name)} type="button">
                {d.brand} ({d.verdict})
              </button>
            ))}
          </div>
        )}
      </section>

      {(steps.length > 0 || error) && (
        <section className="card" style={{ marginTop: 16 }}>
          {steps.length > 0 && (
            <ul className="steps">
              {steps.map((s) => (
                <li key={s.id}>
                  <span className={`dot ${s.status}`} />
                  <span>
                    {s.label}
                    {s.note && <span className="muted small"> · {s.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {error && <div className="error" style={{ marginTop: steps.length ? 10 : 0 }}>{error}</div>}
        </section>
      )}

      <div ref={resultRef} />
      {report && <ReportView report={report} onForce={() => run(report.input, true)} />}
      {!report && identity && extraction && <IdentityCard identity={identity} brand={extraction.brand} sender={extraction.senderEmail} />}

      {history.length > 0 && (
        <section style={{ marginTop: 28 }}>
          <p className="section-title">Your watchlist</p>
          <div className="card">
            {history.map((h) => (
              <div key={h.brand} className="flag" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <span className={`score s${h.verdict === "green" ? 0 : h.verdict === "yellow" ? 2 : 3}`}>{h.verdict}</span>
                <strong style={{ flex: 1, minWidth: 120 }}>{h.brand}</strong>
                <span className="tiny muted">checked {new Date(h.at).toLocaleDateString()}</span>
                <select
                  aria-label={`Did ${h.brand} pay on time?`}
                  value={h.paid ?? ""}
                  onChange={(e) => setPaid(h.brand, (e.target.value || undefined) as HistoryItem["paid"])}
                  className="btn-ghost"
                >
                  <option value="">Paid on time?</option>
                  <option value="yes">Paid on time</option>
                  <option value="late">Paid late</option>
                  <option value="no">Never paid</option>
                </select>
                <button className="btn-ghost" onClick={() => { setInput(h.input); run(h.input); }} disabled={busy}>
                  Re-check
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <footer className="tiny muted" style={{ marginTop: 36 }}>
        BrandCheck shows what public sources report and links every claim. It is not legal or financial advice.
      </footer>
    </main>
  );
}

function ReportView({ report, onForce }: { report: Report; onForce: () => void }) {
  const r = report;
  const kindLabel = r.verdictKind === "scam" ? "Possible scam" : r.verdictKind === "thin" ? "Not enough info" : r.verdict === "green" ? "Looks safe" : r.verdict === "yellow" ? "Caution" : "High risk";
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <section className={`verdict ${r.verdict}`}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="badge"><span className="light" />{kindLabel}</span>
          <span className="tiny muted">
            {r.mode === "cached" ? "Cached run · " : r.mode === "partial" ? "Partial results · " : ""}
            {(r.durationMs / 1000).toFixed(1)}s · {r.calls.filter((c) => c.endpoint !== "LLM" || c.provider?.startsWith("You.com")).length} You.com calls
          </span>
        </div>
        <h2>{r.headline}</h2>
        {r.extraction.offer && <div className="small" style={{ color: "var(--text)" }}>Offer: {r.extraction.offer}</div>}
        {r.reasons.length > 0 && (
          <ul>
            {r.reasons.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        )}
        {r.warnings.length > 0 && <p className="tiny muted" style={{ marginBottom: 0 }}>{r.warnings.join(" ")}</p>}
      </section>

      <IdentityCard identity={r.identity} brand={r.extraction.brand} sender={r.extraction.senderEmail} />

      {r.verdictKind === "scam" && (
        <div className="row">
          <button className="btn-ghost" onClick={onForce}>Run the full brand check anyway</button>
        </div>
      )}

      {r.categories.length > 0 && (
        <section>
          <p className="section-title">Risk checks</p>
          <div className="grid">
            {r.categories.map((c) => <CategoryCard key={c.id} c={c} />)}
          </div>
        </section>
      )}

      {r.questions.length > 0 && (
        <section className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <p className="section-title" style={{ margin: 0 }}>Questions to ask the brand</p>
            <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(r.questions.map((q) => `• ${q}`).join("\n"))}>Copy</button>
          </div>
          <ol className="qs" style={{ marginTop: 10 }}>
            {r.questions.map((q, i) => <li key={i}>{q}</li>)}
          </ol>
        </section>
      )}

      {r.overview && (
        <section className="card">
          <p className="section-title">What the web says (You.com Answer)</p>
          <div className="overview">{r.overview.text.replace(/\[\[[\d,\s]+\]\]/g, "").trim()}</div>
          {r.overview.citations.length > 0 && (
            <div className="row tiny" style={{ marginTop: 10 }}>
              {r.overview.citations.slice(0, 6).map((c, i) => (
                <a key={i} href={c.url} target="_blank" rel="noreferrer" className="chip">{c.title ? c.title.slice(0, 48) : host(c.url)}</a>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <details>
          <summary className="section-title" style={{ display: "list-item" }}>How this was checked: {r.calls.length} API calls</summary>
          <table className="calls" style={{ marginTop: 8 }}>
            <thead><tr><th>Endpoint</th><th>Purpose</th><th>Results</th><th>Time</th></tr></thead>
            <tbody>
              {r.calls.map((c, i) => (
                <tr key={i}>
                  <td className="ep">{c.endpoint === "LLM" ? c.provider ?? "LLM" : `You.com ${c.endpoint}`}</td>
                  <td>{c.label}{!c.ok && <span style={{ color: "var(--red)" }}> (failed)</span>}</td>
                  <td>{c.results ?? "–"}</td>
                  <td>{(c.ms / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tiny muted">Verdicts use a fixed rubric: the model only labels each source; the score is computed in code.</p>
        </details>
      </section>
    </div>
  );
}

function IdentityCard({ identity, brand, sender }: { identity: Identity; brand: string; sender: string | null }) {
  const status: Record<Identity["senderStatus"], [string, number]> = {
    verified: ["Sender verified", 0],
    freemail: ["Free email address", 3],
    lookalike: ["Lookalike domain", 3],
    unrelated: ["Different domain", 2],
    unknown: ["Sender not checked", 1],
  };
  const [label, sev] = status[identity.senderStatus];
  return (
    <section className="card">
      <div className="cat-head">
        <p className="section-title" style={{ margin: 0 }}>Is this email really from {brand}?</p>
        <span className={`score s${sev}`}>{label}</span>
      </div>
      <p className="small" style={{ margin: "8px 0 0" }}>
        {sender ? <>Sender: <strong>{sender}</strong>. </> : null}
        {identity.officialDomain ? (
          <>Official site found via You.com Search: <a href={identity.officialUrl ?? "#"} target="_blank" rel="noreferrer">{identity.officialDomain}</a></>
        ) : (
          <>No official website found.</>
        )}
      </p>
      {identity.flags.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {identity.flags.map((f, i) => <FlagRow key={i} f={f} />)}
        </div>
      )}
    </section>
  );
}

function FlagRow({ f }: { f: Flag }) {
  return (
    <div className="flag">
      <span className={`score s${f.severity}`}>{SCORE_LABEL[f.severity]}</span>
      <div>
        <strong className="small">{f.label}</strong>
        <div className="small muted">{f.detail}</div>
        {f.fromEmail && !f.sourceUrl && <span className="tiny muted">Source: quoted from the pasted email</span>}
        {f.sourceUrl && (
          <a className="src" href={f.sourceUrl} target="_blank" rel="noreferrer">↗ {f.sourceTitle?.slice(0, 70) || host(f.sourceUrl)}</a>
        )}
      </div>
    </div>
  );
}

function CategoryCard({ c }: { c: CategoryResult }) {
  return (
    <div className="card cat">
      <div className="cat-head">
        <h3>{c.name}</h3>
        <span className={`score s${c.score}`}>{SCORE_LABEL[c.score]}</span>
      </div>
      <p className="small muted" style={{ margin: "4px 0 0" }}>{c.summary}</p>
      {c.evidence.map((e) => <EvidenceRow key={e.id} e={e} />)}
      <p className="tiny muted" style={{ margin: "10px 0 0" }}>Searched: {c.searched.join(", ")}</p>
    </div>
  );
}

function EvidenceRow({ e }: { e: Evidence }) {
  return (
    <div className="ev">
      <p className="small">{e.claim}</p>
      {e.note && <p className="tiny muted" style={{ margin: "2px 0" }}>{e.note}</p>}
      {e.passage && <p className="quote">“{e.passage.slice(0, 220)}{e.passage.length > 220 ? "…" : ""}”</p>}
      <a className="src" href={e.url} target="_blank" rel="noreferrer">
        ↗ {host(e.url)}{when(e.date) ? ` · ${when(e.date)}` : ""}
      </a>
      {e.alsoReported && e.alsoReported.length > 0 && (
        <div className="tiny muted" style={{ marginTop: 2 }}>
          Also reported by{" "}
          {e.alsoReported.slice(0, 4).map((o, i) => (
            <span key={o.url}>
              {i > 0 && ", "}
              <a href={o.url} target="_blank" rel="noreferrer">{host(o.url)}</a>
            </span>
          ))}
          {e.alsoReported.length > 4 && ` and ${e.alsoReported.length - 4} more`}
        </div>
      )}
    </div>
  );
}
