// Steps 5 and 6 — the two most likely pain points for this person, then the email.
// The model writes only from verified facts; a template takes over when there is no key
// or the model's draft fails the checks.

import { callJson } from "./llm";
import type { Contact, Draft, Facts, PainPoint, Trigger } from "./types";

const SPRINTO = `Sprinto automates compliance certifications (SOC 2, ISO 27001, GDPR, HIPAA) for SaaS companies.
It connects to a company's cloud, HR, code and identity tools, runs the controls checks continuously, collects audit evidence automatically, and ships ready policies, so a lean team gets audit-ready without pulling engineers off product work.`;

function company(domain: string): string {
  const base = domain.split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function signOff(): string {
  return process.env.SENDER_NAME?.trim() || "The Sprinto team";
}

const PAIN_BY_TRIGGER: Record<Trigger["type"], PainPoint> = {
  audit_in_progress: {
    title: "Running the audit by hand",
    why: "An audit in progress means screenshots, spreadsheets of controls and evidence requests landing on engineers every week.",
  },
  security_page_no_badge: {
    title: "A trust page with no report behind it",
    why: "Enterprise buyers read the security page, then ask for a SOC 2 report the company cannot send yet, and the deal waits.",
  },
  compliance_hire: {
    title: "Building a compliance function from zero",
    why: "A first security/compliance hire inherits no tooling, so their first months go to policy writing and evidence chasing.",
  },
  enterprise_logos: {
    title: "Security reviews slowing enterprise deals",
    why: "With large customers on the logo wall, every new enterprise deal brings a long security questionnaire.",
  },
};

function personaPain(title: string): PainPoint {
  if (/ceo|founder|coo/i.test(title))
    return { title: "Deals stuck in security review", why: "Founders feel certification as revenue: an enterprise deal that cannot close until the report exists." };
  if (/cto|engineer/i.test(title))
    return { title: "Engineering time lost to audit prep", why: "Without automation, collecting evidence and fixing control gaps comes out of the product roadmap." };
  return { title: "Keeping controls passing between audits", why: "Point-in-time audits drift; a security lead needs to know a control broke before the auditor does." };
}

export function painPoints(facts: Facts, contact: Contact): PainPoint[] {
  const out: PainPoint[] = [];
  const order: Trigger["type"][] = ["audit_in_progress", "compliance_hire", "security_page_no_badge", "enterprise_logos"];
  for (const type of order) {
    if (facts.triggers.some((t) => t.type === type)) out.push(PAIN_BY_TRIGGER[type]);
    if (out.length === 1) break;
  }
  out.push(personaPain(contact.title));
  return out.slice(0, 2);
}

function strongestTrigger(facts: Facts): Trigger | null {
  const order: Trigger["type"][] = ["audit_in_progress", "compliance_hire", "security_page_no_badge", "enterprise_logos"];
  for (const type of order) {
    const t = facts.triggers.find((x) => x.type === type);
    if (t) return t;
  }
  return null;
}

function templateDraft(domain: string, facts: Facts, contact: Contact): Draft {
  const name = company(domain);
  const t = strongestTrigger(facts);
  const pains = painPoints(facts, contact);
  const hooks: Record<Trigger["type"], string> = {
    audit_in_progress: `I saw on ${name}'s site that a SOC 2 / ISO 27001 audit is under way.`,
    compliance_hire: `I noticed ${name} is hiring for a security/compliance role, which usually means the certification push is starting.`,
    security_page_no_badge: `I was reading ${name}'s security page: the practices are there, but there is no SOC 2 or ISO 27001 report to point buyers to yet.`,
    enterprise_logos: `${name} already sells to some very large customers, and each of them tends to send a long security questionnaire.`,
  };
  const hook = t ? hooks[t.type] : `I came across ${name} while looking at fast-growing SaaS teams.`;
  const body = `Hi ${contact.first_name},

${hook} ${pains[0].why}

${SPRINTO.split("\n")[1].replace("It connects to a company's", "Sprinto connects to your").replace("so a lean team gets", "so your team gets")}

Teams your size typically get audit-ready in weeks rather than months. Worth a 20-minute look next week?

Best,
${signOff()}`;
  return {
    subject: t ? `${name} + ${t.type === "audit_in_progress" ? "your audit" : "SOC 2"}` : `${name} + SOC 2`,
    body,
    hook,
    why: t
      ? `Opens on the strongest verified trigger ("${t.label}", quoted from ${t.url}) and the pain that trigger causes for a ${contact.title}.`
      : "No trigger was verified, so the email stays generic.",
    pain_points: pains,
    written_by: "template",
  };
}

type AiDraft = { pain_points: PainPoint[]; subject: string; body: string; hook: string; why: string };

const DRAFT_SYSTEM = `You write first-touch cold emails for Sprinto's Growth Lead.
${SPRINTO}
Rules for the email:
- Address the person by first name in the first line ("Hi <first name>,").
- The first sentence after the greeting is the hook: one specific, verified fact about their company from the FACTS list. Do not invent any fact, number, customer, or event that is not in FACTS.
- Then one sentence on the pain that fact causes for someone in their role.
- Then one or two sentences on what Sprinto does about it. No feature lists, no superlatives.
- End with one low-friction question (e.g. a 20-minute call). Under 120 words total. Plain text, no markdown, no emojis.
- Never write "I hope this email finds you well", "quick question", or "touch base".
- Sign off with exactly: SIGNOFF
Return JSON only:
{"pain_points": [{"title": string, "why": string}, {"title": string, "why": string}],
 "subject": string (under 7 words, lowercase is fine, no clickbait),
 "body": string, "hook": string (the fact you opened on), "why": string (one sentence: why this hook for this person)}`;

export async function writeDraft(domain: string, facts: Facts, contact: Contact, aiOn: boolean): Promise<Draft> {
  const fallback = templateDraft(domain, facts, contact);
  if (!aiOn) return fallback;

  const evidence = [
    facts.product_summary && `What they do: ${facts.product_summary}`,
    facts.buyer_description && `Who they sell to: ${facts.buyer_description}`,
    facts.funding_stage && `Funding: ${facts.funding_stage} ("${facts.funding_evidence?.quote}")`,
    facts.employee_count && `Headcount: ${facts.employee_count} ("${facts.employee_evidence?.quote}")`,
    facts.open_roles && `Open roles: ${facts.open_roles}`,
    facts.enterprise_tier && `Has an enterprise pricing tier ("${facts.enterprise_evidence?.quote}")`,
    ...facts.triggers.map((t) => `Compliance trigger: ${t.label}: "${t.quote}" (${t.url})`),
  ]
    .filter(Boolean)
    .join("\n");

  const { data } = await callJson<AiDraft>(
    DRAFT_SYSTEM.replace("SIGNOFF", signOff()),
    `Company: ${company(domain)} (${domain})
Recipient: ${contact.name}, ${contact.title}
Why this person: ${contact.why}
Suggested pain points (improve if the facts support better ones): ${painPoints(facts, contact).map((p) => p.title).join("; ")}

FACTS (all verified with quotes from their website):
${evidence}`,
  );

  if (
    !data?.body ||
    !data.subject ||
    !new RegExp(`\\b${contact.first_name}\\b`, "i").test(data.body.split("\n")[0]) ||
    data.body.split(/\s+/).length > 170 ||
    /hope this (email )?finds you/i.test(data.body)
  ) {
    return fallback;
  }
  return {
    subject: data.subject.slice(0, 120),
    body: data.body.trim(),
    hook: data.hook ?? "",
    why: data.why ?? "",
    pain_points: Array.isArray(data.pain_points) && data.pain_points.length >= 2 ? data.pain_points.slice(0, 2) : fallback.pain_points,
    written_by: "ai",
  };
}
