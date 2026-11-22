import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export const runtime = "nodejs";
export const maxDuration = 30;

// Reads the latest unread emails from a dedicated inbox over IMAP (app password, no OAuth).
// Messages are fetched without marking them as read.
export async function GET() {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_APP_PASSWORD;
  if (!user || !pass) {
    return Response.json({ error: "Inbox not connected. Set IMAP_USER and IMAP_APP_PASSWORD in .env.local." }, { status: 400 });
  }
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []) as number[];
      const latest = uids.slice(-8).reverse();
      const emails: { uid: number; messageId?: string; from: string; subject: string; date: string | null; input: string }[] = [];
      for (const uid of latest) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.text ?? "";
        const subject = parsed.subject ?? "(no subject)";
        const body = (parsed.text || "").trim().slice(0, 8000);
        if (parsed.headers.has("x-brandcheck")) continue; // skip reports BrandCheck filed itself
        emails.push({
          uid,
          messageId: parsed.messageId,
          from,
          subject,
          date: parsed.date ? parsed.date.toISOString() : null,
          input: `From: ${from}\nSubject: ${subject}\n\n${body}`,
        });
      }
      return Response.json({ account: user, emails });
    } finally {
      lock.release();
    }
  } catch (e) {
    return Response.json({ error: `Could not read the inbox: ${(e as Error).message}` }, { status: 502 });
  } finally {
    await client.logout().catch(() => {});
  }
}
