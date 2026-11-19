// Step 7 — Send. Resend's email API. The recipient is SEND_TO from the server environment, full
// stop: nothing in a request body, query string or the UI can change it.

const RESEND_URL = "https://api.resend.com";

// Without a verified domain, Resend only allows this sender, and only to the account owner's address.
const DEFAULT_FROM = "Sprinto Outreach <onboarding@resend.dev>";

export function lockedRecipient(): string | null {
  return process.env.SEND_TO?.trim() || null;
}

function sender(): string {
  return process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;
}

export function mask(email: string | null): string {
  if (!email) return "(not set)";
  const [u, d] = email.split("@");
  return `${u.slice(0, 2)}***@${d}`;
}

export async function mailStatus(): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, detail: "RESEND_API_KEY not set. Drafts still work; sending is off." };
  if (!lockedRecipient()) return { ok: false, detail: "SEND_TO not set. Add your own email address so sends have somewhere to go." };
  try {
    // A "sending access" key cannot list domains and answers 401 restricted_api_key: that still proves it is a real key.
    const res = await fetch(`${RESEND_URL}/domains`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    if (res.ok || /restricted_api_key/.test(body)) {
      return { ok: true, detail: `Key works. Sends from ${sender()} to ${mask(lockedRecipient())} only.` };
    }
    return { ok: false, detail: `Resend rejected the key (HTTP ${res.status}).` };
  } catch (e) {
    return { ok: false, detail: `Could not reach Resend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function sendEmail(input: {
  subject: string;
  body: string;
  intendedFor: string;
  domain: string;
}): Promise<{ id: string; to: string }> {
  const key = process.env.RESEND_API_KEY;
  const to = lockedRecipient();
  if (!key) throw new Error("Resend is not configured (RESEND_API_KEY).");
  if (!to) throw new Error("SEND_TO is not set.");
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
  const res = await fetch(`${RESEND_URL}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: sender(),
      to: [to],
      subject: clean(input.subject),
      text: `${input.body}\n\n--\n[Sprinto outreach demo] Written for ${clean(input.intendedFor)} at ${clean(input.domain)}. Delivered to your own inbox because the recipient is locked.`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message ?? `HTTP ${res.status}`;
    // The common first-time error: onboarding@resend.dev can only deliver to the Resend account's own email.
    if (/only send testing emails to your own email/i.test(msg)) {
      throw new Error(`${msg} Set SEND_TO to the email you signed up to Resend with, or verify a domain.`);
    }
    throw new Error(`Resend: ${msg}`);
  }
  return { id: data.id, to };
}
