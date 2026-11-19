import { NextResponse } from "next/server";
import { hunterQuota } from "@/lib/contact";
import { aiAvailable, aiModel, callJson } from "@/lib/llm";
import { mailStatus } from "@/lib/mail";

export const dynamic = "force-dynamic";

async function aiStatus() {
  if (!aiAvailable())
    return { ok: false, detail: "No GEMINI_API_KEY or OPENROUTER_API_KEY. Running rules-only: keyword extraction and template emails." };
  const { data, error } = await callJson<{ ok: boolean }>("Reply with JSON only.", 'Return {"ok": true}');
  return data?.ok
    ? { ok: true, detail: `${process.env.GEMINI_API_KEY ? "Gemini" : "OpenRouter"} key works (${aiModel()}).` }
    : { ok: false, detail: `Key set but the call failed: ${error?.slice(0, 160)}` };
}

async function readerStatus() {
  try {
    const res = await fetch("https://r.jina.ai/https://example.com", { signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, detail: res.ok ? "Reachable. Used once per JavaScript-heavy page." : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const [ai, hunter, gmail, reader] = await Promise.all([aiStatus(), hunterQuota(), mailStatus(), readerStatus()]);
  return NextResponse.json({
    checks: [
      { name: "AI model", ...ai },
      { name: "Hunter.io", ...hunter },
      { name: "Email (Resend)", ...gmail },
      { name: "Rendering reader (r.jina.ai)", ...reader },
    ],
  });
}
