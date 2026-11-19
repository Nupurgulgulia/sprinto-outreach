// Step 2 — Extract. Every page goes through deterministic rules first, then (if a key is set) the
// model fills what the rules missed. Nothing is stored without a quote that is really on the page.

import type { CleanPage } from "./fetch";
import { callJson } from "./llm";
import type { Evidence, Facts, Trigger, TriggerType } from "./types";

export type PageKind = "home" | "security" | "careers" | "pricing" | "customers" | "about" | "other";

export function pageKind(url: string): PageKind {
  const p = new URL(url).pathname.toLowerCase();
  if (p === "/" || p === "") return "home";
  if (/security|trust|compliance/.test(p)) return "security";
  if (/career|jobs|join|hiring|work-with-us/.test(p) || /lever\.co|greenhouse\.io|ashbyhq|workable/.test(url)) return "careers";
  if (/pricing|plans/.test(p)) return "pricing";
  if (/customer|case-stud|clients|stories/.test(p)) return "customers";
  if (/about|company|product|platform/.test(p)) return "about";
  return "other";
}

export function emptyFacts(): Facts {
  return {
    product_summary: null,
    is_b2b_saas: null,
    buyer_description: null,
    b2b_evidence: null,
    certifications: null,
    cert_evidence: null,
    funding_stage: null,
    funding_evidence: null,
    employee_count: null,
    employee_evidence: null,
    open_roles: null,
    roles_evidence: null,
    enterprise_tier: null,
    enterprise_evidence: null,
    triggers: [],
  };
}

// ---------------------------------------------------------------- quote check

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** The evidence check: a quote counts only if it is actually on the page we fetched. */
export function quoteOnPage(quote: string | null | undefined, page: CleanPage): boolean {
  if (!quote || quote.trim().length < 4) return false;
  const q = norm(quote).replace(/^["']|["']$/g, "").replace(/\.{3}|…/g, " ");
  const text = norm(page.text);
  if (text.includes(q)) return true;
  // Allow the model to have trimmed the ends of a long sentence.
  return q.length > 50 && text.includes(q.slice(0, 50));
}

const ev = (quote: string, url: string): Evidence => ({ quote: quote.slice(0, 280), url });

// ---------------------------------------------------------------- rule extraction

/** Only these two disqualify. GDPR / HIPAA claims are near-universal and Sprinto can still sell SOC 2. */
const DISQUALIFYING_CERT = /\b(soc ?2(?:\s*type\s*(?:ii|i|1|2))?|iso(?:\/iec)?\s?27001)\b/i;
const ANY_CERT = /\b(soc ?2|iso(?:\/iec)?\s?27001|hipaa|pci[- ]dss|gdpr)\b/i;
const HAS_CERT_WORD = /\b(certified|certification|compliant|attest|attested|audited|achieved|type ii report|type 2 report|badge)\b/i;
const IN_PROGRESS = /\b(in progress|working towards?|pursuing|underway|under way|preparing for|on track|in the process|coming soon|expected|currently undergoing)\b/i;

const B2B_POSITIVE =
  /\b(b2b|saas|for (?:teams|businesses|companies|enterprises|startups)|(?:sales|engineering|hr|finance|marketing|support|product|ops|it|security|legal) teams|your (?:team|business|customers|workflows?)|platform (?:for|that)|api(?:s)?\b|integrat(?:es|ions) with|book a demo|request a demo|free trial)\b/i;
const B2C_NEGATIVE =
  /\b(add to cart|shop now|free shipping|order online|order now|book a table|our menu|demat|trading account|mutual funds|stock ?brok(?:ing|er|erage)|brokerage|invest(?:ing)? in (?:stocks|mutual funds|ipos?)|open (?:a |an |your )?(?:free )?(?:\w+ )?account|download the app|for your family|for individuals|personal finance|recipes|cash on delivery|free delivery|order food|food delivery|groceries|beauty products|skincare|makeup|lipstick|fashion|apparel|shop by category|bestsellers)\b/i;

const ENTERPRISE_NAMES = [
  "Google", "Microsoft", "Amazon", "AWS", "Salesforce", "Oracle", "Adobe", "Deloitte", "Accenture", "Walmart",
  "Unilever", "Siemens", "SAP", "IBM", "Cisco", "Intel", "Meta", "Uber", "Airbnb", "Netflix", "Spotify",
  "Shopify", "Stripe", "PayPal", "Visa", "Mastercard", "HSBC", "JPMorgan", "Goldman Sachs", "Coca-Cola",
  "PepsiCo", "Nike", "Samsung", "Tata", "Infosys", "Wipro", "Reliance", "Flipkart", "Swiggy", "Zomato",
  "Paytm", "Razorpay", "Freshworks", "Zoho", "Atlassian", "HubSpot", "Slack", "Zoom", "Dropbox", "Twilio",
  "Okta", "Nvidia", "Dell", "Philips", "Bosch", "Toyota", "Vodafone", "Airtel", "Verizon", "KPMG", "PwC",
  "McKinsey", "Capgemini", "Cognizant", "HDFC", "ICICI", "Axis Bank", "Kotak", "Byju's", "Ola", "Zepto",
  "Meesho", "Nykaa", "Myntra", "PhonePe", "Cred", "Booking.com", "Expedia", "Siemens", "Shell", "BP",
];

function lines(page: CleanPage): string[] {
  return page.text.split("\n");
}

function firstLine(page: CleanPage, re: RegExp, also?: RegExp): string | null {
  return lines(page).find((l) => re.test(l) && (!also || also.test(l))) ?? null;
}

/** Security / IT compliance, not payroll, tax or financial-regulatory compliance. Applied to rules and AI alike. */
export function isSecurityComplianceRole(title: string): boolean {
  return (
    /\b(security|compliance|grc|infosec|ciso|privacy)\b/i.test(title) &&
    !/\b(payroll|tax|finance|financial|accounting|kyc|aml|statutory|legal|labou?r|hr|regulatory affairs)\b/i.test(title)
  );
}

export type PageUpdate ={ facts: Partial<Facts>; triggers: Trigger[]; rejected: number };

function trigger(type: TriggerType, quote: string, url: string): Trigger {
  const labels: Record<TriggerType, string> = {
    audit_in_progress: "Audit or certification in progress",
    security_page_no_badge: "Security page with no certification badge",
    compliance_hire: "Hiring for security / compliance",
    enterprise_logos: "3+ enterprise customer logos",
  };
  return { type, label: labels[type], ...ev(quote, url) };
}

export function extractRules(page: CleanPage): PageUpdate {
  const kind = pageKind(page.url);
  const f: Partial<Facts> = {};
  const triggers: Trigger[] = [];
  const url = page.url;

  // Q1 B2B SaaS
  // Rules-only mode weighs consumer language against business language; AI mode reads it properly.
  const negs = lines(page).filter((l) => B2C_NEGATIVE.test(l));
  const neg = negs[0] ?? null;
  const pos = lines(page).filter((l) => B2B_POSITIVE.test(l) && !B2C_NEGATIVE.test(l));
  if (neg && negs.length >= pos.length) {
    f.is_b2b_saas = false;
    f.b2b_evidence = ev(neg, url);
    f.buyer_description = "consumers (retail language on the site)";
  } else if (pos.length >= 2) {
    f.is_b2b_saas = true;
    f.b2b_evidence = ev(pos[0], url);
    f.buyer_description = "teams / businesses (keyword match)";
  }

  // Q2 certified / Q4 audit in progress
  for (const l of lines(page)) {
    if (!ANY_CERT.test(l)) continue;
    if (IN_PROGRESS.test(l) && DISQUALIFYING_CERT.test(l)) {
      triggers.push(trigger("audit_in_progress", l, url));
    } else if (DISQUALIFYING_CERT.test(l) && HAS_CERT_WORD.test(l) && !f.certifications?.length) {
      f.certifications = [l.match(DISQUALIFYING_CERT)![0].toUpperCase().replace(/SOC ?2/, "SOC 2")];
      f.cert_evidence = ev(l, url);
    }
  }
  // Also catch badge images ("[image: SOC 2 Type II]").
  if (!f.certifications?.length) {
    const badge = lines(page).find((l) => /\[image:[^\]]*(soc ?2|iso ?27001)/i.test(l));
    if (badge) {
      f.certifications = [badge.match(DISQUALIFYING_CERT)?.[0]?.toUpperCase() ?? "SOC 2"];
      f.cert_evidence = ev(badge, url);
    }
  }
  // A real security page talks about security in several places. A thin or off-topic page proves nothing.
  const SECURITY_TALK = /\b(encrypt\w*|access control|penetration|pen ?test|vulnerab\w*|data protection|infosec|security (?:practices|program|controls|team)|least privilege|sso|mfa|two-factor|aes-?256|tls)\b/i;
  const securityLines = lines(page).filter((l) => SECURITY_TALK.test(l));
  // Only the main security/trust page can prove a certification is absent. A sub-page like
  // /trust/ai talks about one topic and says nothing about the company's certifications.
  const topLevel = new URL(url).pathname.replace(/\/$/, "").split("/").filter(Boolean).length <= 1;
  if (
    kind === "security" &&
    topLevel &&
    securityLines.length >= 2 &&
    !f.certifications?.length &&
    !triggers.some((t) => t.type === "audit_in_progress")
  ) {
    f.certifications = [];
    f.cert_evidence = ev(securityLines[0], url);
    triggers.push(trigger("security_page_no_badge", securityLines[0], url));
  }

  // Q3 stage and size
  const emp = page.text.match(/(?:team of\s+)?(\d{1,3}(?:,\d{3})+|\d{1,5})\+?\s*(?:employees|people|team members|teammates|strong)\b/i);
  if (emp) {
    const n = Number(emp[1].replace(/,/g, ""));
    const l = firstLine(page, new RegExp(emp[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
    if (n > 0 && l) {
      f.employee_count = n;
      f.employee_evidence = ev(l, url);
    }
  }
  const fund =
    firstLine(page, /\b(pre-seed|seed|series [a-e])\b/i, /\b(round|funding|raise[ds]?|backed|led by|investment)\b/i) ??
    firstLine(page, /\braised\s+(?:us)?\$?\s?\d[\d.,]*\s*(?:m|mn|million|b|billion|cr|crore)\b/i);
  if (fund) {
    const m = fund.match(/\b(pre-seed|seed|series [a-e])\b/i);
    f.funding_stage = m ? m[1].replace(/\b\w/g, (c) => c.toUpperCase()) : "funded (amount stated)";
    f.funding_evidence = ev(fund, url);
  }
  if (kind === "careers") {
    const roleLines = lines(page).filter(
      (l) =>
        l.split(" ").length <= 10 &&
        /\b(engineer|developer|manager|designer|analyst|scientist|lead|director|executive|specialist|architect|recruiter|marketer|consultant|intern|associate|representative|sre|devops|head of)\b/i.test(l),
    );
    if (roleLines.length) {
      f.open_roles = roleLines.length;
      f.roles_evidence = ev(roleLines[0], url);
    }
    const hire = roleLines.find(isSecurityComplianceRole);
    if (hire) triggers.push(trigger("compliance_hire", hire, url));
  }
  if (kind === "pricing") {
    const ent = firstLine(page, /\benterprise\b/i);
    f.enterprise_tier = Boolean(ent);
    if (ent) f.enterprise_evidence = ev(ent, url);
  }

  // Q4 enterprise logos (any page; image alt text usually carries them)
  let bestLine: string | null = null;
  const found = new Set<string>();
  for (const l of lines(page)) {
    let here = 0;
    for (const name of ENTERPRISE_NAMES) {
      if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(l)) {
        found.add(name);
        here++;
      }
    }
    if (here && (!bestLine || here > 1)) bestLine = l;
  }
  if (found.size >= 3 && bestLine && (kind === "customers" || kind === "home")) {
    triggers.push(trigger("enterprise_logos", bestLine, url));
  }

  return { facts: f, triggers, rejected: 0 };
}

// ---------------------------------------------------------------- AI extraction

type AiExtract = {
  product_summary?: string | null;
  is_b2b_saas?: boolean | null;
  buyer_description?: string | null;
  b2b_quote?: string | null;
  certifications?: { name: string; quote: string }[];
  certification_in_progress?: { name: string; quote: string } | null;
  funding_stage?: string | null;
  funding_quote?: string | null;
  employee_count?: number | null;
  employee_quote?: string | null;
  open_roles?: number | null;
  open_roles_quote?: string | null;
  enterprise_tier?: boolean | null;
  enterprise_quote?: string | null;
  compliance_hire?: { title: string; quote: string } | null;
  enterprise_customers?: string[];
  customers_quote?: string | null;
};

const EXTRACT_SYSTEM = `You read one web page of a company and pull out facts for a sales qualification.
Rules:
- Only report what the page itself states. If the page does not say it, return null. Never guess.
- Every fact needs a quote copied EXACTLY, character for character, from the page text (one sentence or line, under 200 characters). A fact without an exact quote will be thrown away.
- "is_b2b_saas" is true only if the page describes software sold to businesses or teams; false if it sells to consumers or is not software (a shop, a marketplace, a broker, a delivery app). Whenever you set it to true OR false, "b2b_quote" must be the exact line that shows it (e.g. a product, pricing or "for teams" line), and "buyer_description" names who buys.
- "certifications" lists only certifications the company says it HOLDS (e.g. SOC 2 Type II, ISO 27001). Certifications that are planned or in progress go in "certification_in_progress".
- "enterprise_customers" lists well-known large companies named as customers or shown as logos.
Return JSON only, with exactly these keys:
{"product_summary": string|null, "is_b2b_saas": boolean|null, "buyer_description": string|null, "b2b_quote": string|null,
 "certifications": [{"name": string, "quote": string}], "certification_in_progress": {"name": string, "quote": string}|null,
 "funding_stage": string|null, "funding_quote": string|null, "employee_count": number|null, "employee_quote": string|null,
 "open_roles": number|null, "open_roles_quote": string|null, "enterprise_tier": boolean|null, "enterprise_quote": string|null,
 "compliance_hire": {"title": string, "quote": string}|null, "enterprise_customers": [string], "customers_quote": string|null}`;

export async function extractAi(page: CleanPage, domain: string): Promise<{ update: PageUpdate; error: string | null }> {
  const { data, error } = await callJson<AiExtract>(
    EXTRACT_SYSTEM,
    `Company domain: ${domain}\nPage URL: ${page.url}\n\nPAGE TEXT:\n${page.text}`,
  );
  const update: PageUpdate = { facts: {}, triggers: [], rejected: 0 };
  if (!data) return { update, error };

  const url = page.url;
  const f = update.facts;
  const keep = (q: string | null | undefined) => {
    if (quoteOnPage(q, page)) return true;
    if (q) update.rejected++;
    return false;
  };

  if (data.product_summary) f.product_summary = data.product_summary.slice(0, 200);
  if (typeof data.is_b2b_saas === "boolean" && keep(data.b2b_quote)) {
    f.is_b2b_saas = data.is_b2b_saas;
    f.buyer_description = data.buyer_description ?? null;
    f.b2b_evidence = ev(data.b2b_quote!, url);
  }
  const held = (data.certifications ?? []).filter((c) => DISQUALIFYING_CERT.test(c.name) && keep(c.quote));
  if (held.length) {
    f.certifications = held.map((c) => c.name);
    f.cert_evidence = ev(held[0].quote, url);
  }
  if (data.certification_in_progress && keep(data.certification_in_progress.quote)) {
    update.triggers.push(trigger("audit_in_progress", data.certification_in_progress.quote, url));
  }
  if (data.funding_stage && keep(data.funding_quote)) {
    f.funding_stage = data.funding_stage;
    f.funding_evidence = ev(data.funding_quote!, url);
  }
  if (typeof data.employee_count === "number" && data.employee_count > 0 && keep(data.employee_quote)) {
    f.employee_count = data.employee_count;
    f.employee_evidence = ev(data.employee_quote!, url);
  }
  if (typeof data.open_roles === "number" && data.open_roles > 0 && keep(data.open_roles_quote)) {
    f.open_roles = data.open_roles;
    f.roles_evidence = ev(data.open_roles_quote!, url);
  }
  if (data.enterprise_tier === true && keep(data.enterprise_quote)) {
    f.enterprise_tier = true;
    f.enterprise_evidence = ev(data.enterprise_quote!, url);
  }
  if (
    data.compliance_hire &&
    isSecurityComplianceRole(`${data.compliance_hire.title} ${data.compliance_hire.quote}`) &&
    keep(data.compliance_hire.quote)
  ) {
    update.triggers.push(trigger("compliance_hire", data.compliance_hire.quote, url));
  }
  if ((data.enterprise_customers?.length ?? 0) >= 3 && keep(data.customers_quote)) {
    update.triggers.push(trigger("enterprise_logos", data.customers_quote!, url));
  }
  return { update, error: null };
}

// ---------------------------------------------------------------- merge

/** First evidenced answer wins; later pages only fill gaps. Triggers accumulate, one per type. */
export function mergeInto(facts: Facts, update: PageUpdate): void {
  const u = update.facts;
  const fill = <K extends keyof Facts>(k: K, ek?: keyof Facts) => {
    const cur = facts[k];
    const next = u[k];
    if (next === undefined || next === null) return;
    const empty = cur === null || (Array.isArray(cur) && k !== "certifications");
    // An empty certifications list can be upgraded to a named one, never the other way round.
    const upgrade = k === "certifications" && Array.isArray(cur) && cur.length === 0 && Array.isArray(next) && next.length > 0;
    if (empty || upgrade) {
      (facts[k] as Facts[K]) = next as Facts[K];
      if (ek && u[ek]) (facts[ek] as unknown) = u[ek];
    }
  };
  fill("product_summary");
  fill("is_b2b_saas", "b2b_evidence");
  if (facts.buyer_description === null && u.buyer_description) facts.buyer_description = u.buyer_description;
  fill("certifications", "cert_evidence");
  fill("funding_stage", "funding_evidence");
  fill("employee_count", "employee_evidence");
  fill("open_roles", "roles_evidence");
  fill("enterprise_tier", "enterprise_evidence");
  for (const t of update.triggers) {
    if (!facts.triggers.some((x) => x.type === t.type)) facts.triggers.push(t);
  }
}
