import { NextResponse } from "next/server";
import { sendEmail } from "@/lib/mail";

export const dynamic = "force-dynamic";

// The handler never reads a "to" field. The recipient comes from SEND_TO on the server.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const subject = String(body?.subject ?? "").trim();
  const text = String(body?.body ?? "").trim();
  if (!subject || !text) return NextResponse.json({ error: "Subject and body are required" }, { status: 400 });
  try {
    const sent = await sendEmail({
      subject,
      body: text,
      intendedFor: String(body?.intendedFor ?? "the contact"),
      domain: String(body?.domain ?? ""),
    });
    return NextResponse.json({ ok: true, ...sent, at: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
