// Step 3 — Qualify. The Evidence Map, as code. "Enough" is never something the model reports;
// it is these checks. No randomness and no AI in this file.

import type { Evidence, Facts, QuestionId, QuestionStatus, Verdict } from "./types";

export const MAX_EXTRA_FETCHES = 4;
const MAX_EMPLOYEES = 500;
const MIN_ROLES = 5;

/** Cheapest kill first. Limits are per question; the total is capped at 4 beyond the homepage. */
export const QUESTIONS: { id: QuestionId; question: string; limit: number; pages: string[] }[] = [
  { id: "b2b", question: "B2B SaaS?", limit: 1, pages: ["/product", "/about"] },
  { id: "certified", question: "Already certified?", limit: 1, pages: ["/security", "/trust"] },
  { id: "stage", question: "Right stage and size?", limit: 2, pages: ["/careers", "/pricing", "/customers"] },
  { id: "pressure", question: "Under compliance pressure?", limit: 2, pages: ["/security", "/customers", "/careers"] },
];

const keep = (e: Evidence | null): Evidence[] => (e ? [e] : []);

export function evaluate(facts: Facts, tries: Record<QuestionId, number>): QuestionStatus[] {
  const out: QuestionStatus[] = [];

  // Q1
  {
    const q = QUESTIONS[0];
    const answered = facts.is_b2b_saas !== null && (facts.is_b2b_saas === false || Boolean(facts.buyer_description));
    out.push({
      id: q.id,
      question: q.question,
      status: facts.is_b2b_saas === false ? "short_circuit" : answered ? "answered" : "unknown",
      answer:
        facts.is_b2b_saas === false
          ? "No: not software sold to businesses"
          : answered
            ? `Yes: sells to ${facts.buyer_description}`
            : "Not stated",
      evidence: keep(facts.b2b_evidence),
      tries: tries.b2b,
      limit: q.limit,
    });
  }
  // Q2
  {
    const q = QUESTIONS[1];
    const certs = facts.certifications;
    out.push({
      id: q.id,
      question: q.question,
      status: certs === null ? "unknown" : certs.length ? "short_circuit" : "answered",
      answer:
        certs === null
          ? "Not stated (treated as not certified, flagged)"
          : certs.length
            ? `Yes: ${certs.join(", ")}`
            : "No: security/trust page read, names no certification",
      evidence: keep(facts.cert_evidence),
      tries: tries.certified,
      limit: q.limit,
    });
  }
  // Q3
  {
    const q = QUESTIONS[2];
    const tooBig = facts.employee_count !== null && facts.employee_count > MAX_EMPLOYEES;
    const parts: string[] = [];
    if (facts.funding_stage) parts.push(`funding: ${facts.funding_stage}`);
    if (facts.employee_count !== null) parts.push(`${facts.employee_count} employees`);
    if (facts.open_roles !== null) parts.push(`${facts.open_roles} open roles`);
    if (facts.enterprise_tier) parts.push("enterprise pricing tier");
    const answered =
      Boolean(facts.funding_stage) ||
      facts.employee_count !== null ||
      (facts.open_roles ?? 0) >= MIN_ROLES ||
      facts.enterprise_tier === true;
    out.push({
      id: q.id,
      question: q.question,
      status: tooBig ? "short_circuit" : answered ? "answered" : "unknown",
      answer: tooBig
        ? `No: ${facts.employee_count} employees (over ${MAX_EMPLOYEES}, has in-house GRC)`
        : answered
          ? parts.join(" · ")
          : parts.length
            ? `Not enough yet (${parts.join(" · ")})`
            : "Not stated",
      evidence: [
        ...keep(facts.funding_evidence),
        ...keep(facts.employee_evidence),
        ...keep(facts.roles_evidence),
        ...keep(facts.enterprise_evidence),
      ],
      tries: tries.stage,
      limit: q.limit,
    });
  }
  // Q4
  {
    const q = QUESTIONS[3];
    const t = facts.triggers;
    out.push({
      id: q.id,
      question: q.question,
      status: t.length ? "answered" : "unknown",
      answer: t.length ? t.map((x) => x.label).join(" · ") : "No trigger found yet",
      evidence: t.map(({ quote, url }) => ({ quote, url })),
      tries: tries.pressure,
      limit: q.limit,
    });
  }
  return out;
}

export function shortCircuited(qs: QuestionStatus[]): QuestionStatus | null {
  return qs.find((q) => q.status === "short_circuit") ?? null;
}

/**
 * The loop's next step: the first unanswered question that still has tries left names a page.
 * Links actually found on the homepage are preferred over guessed paths.
 */
export function nextPage(
  qs: QuestionStatus[],
  fetched: Set<string>,
  origin: string,
  homeLinks: string[],
): { url: string; question: QuestionId; reason: string } | null {
  for (const q of qs) {
    if (q.status !== "unknown" || q.tries >= q.limit) continue;
    const spec = QUESTIONS.find((x) => x.id === q.id)!;
    const site = new URL(origin).hostname.replace(/^www\./, "");
    // Pass 1: a page the homepage actually links to (e.g. /trust-center, jobs.lever.co/acme).
    for (const path of spec.pages) {
      const stem = path.slice(1);
      const linked = homeLinks.find((l) => {
        try {
          const u = new URL(l);
          if (fetched.has(l)) return false;
          const ats = /lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com/.test(u.hostname);
          if (stem === "careers" && ats) return true;
          return u.hostname.endsWith(site) && new RegExp(`^/${stem}`, "i").test(u.pathname);
        } catch {
          return false;
        }
      });
      if (linked) return { url: linked, question: q.id, reason: `"${q.question}" is still empty → linked from homepage` };
    }
    // Pass 2: the standard paths, in Evidence Map order.
    for (const path of spec.pages) {
      const url = `${origin}${path}`;
      if (fetched.has(url)) continue;
      return { url, question: q.id, reason: `"${q.question}" is still empty → standard path` };
    }
  }
  return null;
}

/** Turns the four answers into one verdict, with the reason written out. */
export function decide(qs: QuestionStatus[], fetchesUsed: number, facts: Facts) {
  const byId = Object.fromEntries(qs.map((q) => [q.id, q])) as Record<QuestionId, QuestionStatus>;
  const flags: string[] = [];
  const needs = qs.filter((q) => q.status === "unknown").map((q) => q.question);

  const sc = shortCircuited(qs);
  if (sc) {
    return {
      verdict: "DROP" as Verdict,
      reason: `Short-circuit on "${sc.question}" ${sc.answer}.`,
      needs: [],
      flags,
      rank: 0,
    };
  }
  if (byId.b2b.status === "unknown") {
    return {
      verdict: "HOLD" as Verdict,
      reason: `Could not tell from the site whether they sell software to businesses. Manual review (${fetchesUsed}/${MAX_EXTRA_FETCHES} extra fetches used).`,
      needs,
      flags: ["manual_review"],
      rank: 10,
    };
  }
  if (byId.pressure.status === "unknown") {
    return {
      verdict: "HOLD" as Verdict,
      reason: `Fits the ICP on what we could see, but no compliance-pressure trigger was found after ${fetchesUsed}/${MAX_EXTRA_FETCHES} extra fetches. Absence of evidence on a thin site is not evidence of no need, so this goes to a human instead of being dropped.`,
      needs,
      flags,
      rank: 20,
    };
  }
  if (byId.certified.status === "unknown") flags.push("certification status not stated (assumed not certified)");
  if (byId.stage.status === "unknown") flags.push("stage / size not stated");
  const n = facts.employee_count;
  if (n !== null && (n > 200 || n < 11)) flags.push(`${n} employees is outside the 11-200 sweet spot`);

  const triggers = byId.pressure.evidence.length;
  if (flags.length) {
    return {
      verdict: "SEND_FLAGGED" as Verdict,
      reason: `Qualified and flagged: B2B SaaS with ${triggers} compliance trigger${triggers > 1 ? "s" : ""}, but ${flags.join(" and ")}. A wrong drop is the expensive error, so it qualifies at a lower rank with the unknown named.`,
      needs,
      flags,
      rank: 50 + triggers * 5,
    };
  }
  return {
    verdict: "SEND" as Verdict,
    reason: `Qualified: B2B SaaS, not yet certified, right stage, and ${triggers} compliance trigger${triggers > 1 ? "s" : ""} with quotes.`,
    needs: [],
    flags,
    rank: 80 + triggers * 5,
  };
}
