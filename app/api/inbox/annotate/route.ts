import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { Report } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function verdictLabel(r: Report) {
  if (r.verdictKind === "scam") return "Scam";
  if (r.verdictKind === "thin") return "Unknown";
  return r.verdict === "green" ? "Green" : r.verdict === "yellow" ? "Yellow" : "Red";
}

function reportHtml(r: Report) {
  const color = r.verdict === "green" ? "#127a46" : r.verdict === "yellow" ? "#8a5a00" : "#b42318";
  const bg = r.verdict === "green" ? "#e3f5ea" : r.verdict === "yellow" ? "#fff3d1" : "#fde7e4";
  const sources = [
    ...r.identity.flags.filter((f) => f.sourceUrl).map((f) => ({ label: f.label, url: f.sourceUrl! })),
    ...r.categories.flatMap((c) => c.evidence.filter((e) => (e.counted ?? 0) >= 2).map((e) => ({ label: `${c.name}: ${e.claim}`, url: e.url }))),
  ].slice(0, 6);
  return `<div style="font-family:system-ui,sans-serif;max-width:600px">
  <div style="background:${bg};color:${color};padding:16px;border-radius:12px">
    <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">BrandCheck · ${verdictLabel(r)}</div>
    <div style="font-size:20px;font-weight:700;margin:6px 0">${esc(r.headline)}</div>
    <ul style="color:#17161a;margin:8px 0 0;padding-left:18px">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </div>
  ${sources.length ? `<h3 style="font-size:14px">Sources</h3><ul>${sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.label.slice(0, 140))}</a></li>`).join("")}</ul>` : ""}
  ${r.questions.length ? `<h3 style="font-size:14px">Questions to ask before you sign</h3><ol>${r.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>` : ""}
  <p style="color:#6b6870;font-size:12px">Checked with live web data from You.com in ${(r.durationMs / 1000).toFixed(1)}s. BrandCheck reports what public sources say; it is not legal advice.</p>
</div>`;
}

// Writes the verdict back into Gmail: applies a "BrandCheck/<verdict>" label to the original email and
// files the report as a reply in the same thread, sent to the inbox owner only (never to the sender).
export async function POST(req: Request) {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_APP_PASSWORD;
  if (!user || !pass) return Response.json({ error: "Set IMAP_USER and IMAP_APP_PASSWORD." }, { status: 400 });
  const { uid, messageId, subject, report } = (await req.json()) as { uid: number; messageId?: string; subject: string; report: Report };
  const result: { label?: string; labelError?: string; replied?: boolean; replyError?: string } = {};

  // 1. Label over IMAP (Gmail X-GM-LABELS)
  const label = `BrandCheck/${verdictLabel(report)}`;
  const client = new ImapFlow({ host: process.env.IMAP_HOST || "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    await client.mailboxCreate(label).catch(() => {}); // already exists is fine
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(String(uid), [label], { uid: true, useLabels: true });
      result.label = label;
    } finally {
      lock.release();
    }
  } catch (e) {
    result.labelError = (e as Error).message;
  } finally {
    await client.logout().catch(() => {});
  }

  // 2. Report as an in-thread reply to yourself over SMTP
  try {
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
    await transport.sendMail({
      from: `BrandCheck <${user}>`,
      to: user,
      subject: subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`,
      headers: { "X-BrandCheck": "report" },
      inReplyTo: messageId,
      references: messageId ? [messageId] : undefined,
      html: reportHtml(report),
      text: `${report.headline}\n\n${report.reasons.map((x) => `- ${x}`).join("\n")}\n\nQuestions to ask:\n${report.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
    });
    result.replied = true;
  } catch (e) {
    result.replyError = (e as Error).message;
  }
  return Response.json(result);
}
