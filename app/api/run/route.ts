import { NextResponse } from "next/server";
import { normalizeDomain } from "@/lib/fetch";
import { runCompany } from "@/lib/pipeline";

// One company per request, so a long list never hits the serverless time limit.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const domain = normalizeDomain(String(body?.domain ?? ""));
  if (!domain) return NextResponse.json({ error: "Not a valid domain" }, { status: 400 });
  try {
    const result = await runCompany(domain, { ai: body?.ai !== false });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
