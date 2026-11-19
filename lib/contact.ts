// Step 4 — Find the point of contact. Option A: Hunter.io Domain Search. Option B: contacts looked
// up by hand on Apollo and stored in data/manual-contacts.json. Manual entries win when present.

import manual from "@/data/manual-contacts.json";
import type { Contact } from "./types";

type HunterEmail = {
  value: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  seniority: string | null;
  department: string | null;
  confidence: number | null;
};

// Who buys compliance automation depends on size. At a small startup the founder or CTO owns the
// SOC 2 project; once there is a security function, its head owns it.
const SECURITY = /\b(ciso|chief information security|head of (security|compliance|grc|trust|it)|(security|compliance|grc) (lead|manager|director|officer)|vp,? (security|compliance)|director,? (security|compliance))\b/i;
const TECH = /\b(cto|chief technology|vp,? engineering|head of engineering|director of engineering|engineering manager)\b/i;
const FOUNDER = /\b(ceo|chief executive|founder|co-founder|cofounder|coo|chief operating)\b/i;

function score(position: string, small: boolean): { score: number; why: string } {
  if (SECURITY.test(position))
    return { score: small ? 80 : 100, why: "owns security and compliance, so a SOC 2 / ISO 27001 project lands on their desk" };
  if (TECH.test(position))
    return { score: 90, why: "runs engineering; with no dedicated security lead, the audit work (controls, evidence, policies) falls on them" };
  if (FOUNDER.test(position))
    return {
      score: small ? 95 : 60,
      why: small
        ? "at this size the founder signs off on the audit budget and feels the enterprise deals it blocks"
        : "senior enough to sponsor the project, though likely to delegate it",
    };
  return { score: 0, why: "" };
}

export function isSmall(employees: number | null): boolean {
  return employees === null || employees <= 50;
}

export type Headcount = { label: string; min: number };
type ContactLookup = { contact: Contact | null; note: string };

/** Hunter reports company size as a band ("1001-5000", "10K+"). The lower bound is what we can defend. */
export function parseHeadcount(raw: unknown): Headcount | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const m = raw.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k)?/i);
  if (!m) return null;
  const min = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
  return Number.isFinite(min) ? { label: raw.trim(), min } : null;
}

/**
 * Hunter Company Enrichment: company size when the website never states it.
 * Only called for companies that already qualified, so the free quota is not spent on drops.
 */
export async function hunterCompanySize(domain: string): Promise<Headcount | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${key}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const metrics = (await res.json())?.data?.metrics ?? {};
    if (typeof metrics.employeesCount === "number" && metrics.employeesCount > 0) {
      return { label: `${metrics.employeesCount}${metrics.employees ? ` (${metrics.employees})` : ""}`, min: metrics.employeesCount };
    }
    return parseHeadcount(metrics.employees);
  } catch {
    return null;
  }
}

export async function findContact(domain: string, employees: number | null): Promise<ContactLookup> {
  const m = (manual as Record<string, { name: string; title: string; email: string; note?: string }>)[domain];
  if (m) {
    const s = score(m.title, isSmall(employees));
    return {
      contact: {
        name: m.name,
        first_name: m.name.split(" ")[0],
        title: m.title,
        email: m.email,
        source: "manual",
        confidence: null,
        why: `${m.title}: ${s.why || "picked by hand on Apollo"}.`,
      },
      note: "From data/manual-contacts.json (Apollo, looked up by hand).",
    };
  }

  const key = process.env.HUNTER_API_KEY;
  if (!key) return { contact: null, note: "No HUNTER_API_KEY and no manual contact for this domain." };

  try {
    const res = await fetch(
      `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&type=personal&limit=10&api_key=${key}`,
      { signal: AbortSignal.timeout(12000) },
    );
    if (res.status === 429) return { contact: null, note: "Hunter monthly quota used up." };
    if (!res.ok) return { contact: null, note: `Hunter returned HTTP ${res.status}.` };
    const data = (await res.json())?.data;
    const emails: HunterEmail[] = data?.emails ?? [];
    const small = isSmall(employees);
    const ranked = emails
      .filter((e) => e.first_name && e.position)
      .map((e) => ({ e, ...score(e.position!, small) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.e.confidence ?? 0) - (a.e.confidence ?? 0));
    if (!ranked.length) {
      return {
        contact: null,
        note: emails.length
          ? `Hunter found ${emails.length} people but none with a founder, CTO or security title.`
          : "Hunter found no named people at this domain.",
      };
    }
    const top = ranked[0];
    const name = [top.e.first_name, top.e.last_name].filter(Boolean).join(" ");
    return {
      contact: {
        name,
        first_name: top.e.first_name!,
        title: top.e.position!,
        email: top.e.value,
        source: "hunter",
        confidence: top.e.confidence,
        why: `${top.e.position}: ${top.why}. Picked from ${ranked.length} relevant of ${emails.length} people Hunter found.`,
      },
      note: "Hunter.io Domain Search (1 search used).",
    };
  } catch (e) {
    return { contact: null, note: `Hunter call failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function hunterQuota(): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { ok: false, detail: "HUNTER_API_KEY not set. Manual contacts (Apollo) still work." };
  try {
    const res = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, detail: `Hunter returned HTTP ${res.status}` };
    const s = (await res.json())?.data?.requests?.searches;
    return { ok: true, detail: s ? `${s.available - s.used} of ${s.available} searches left this month` : "Key works" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
