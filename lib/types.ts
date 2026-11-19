// Shared shapes for the pipeline. One CompanyResult per domain, built by /api/run.

export type Verdict = "SEND" | "SEND_FLAGGED" | "HOLD" | "DROP" | "REVIEW";

/** A fact is only ever stored with the verbatim quote and the page it came from. */
export type Evidence = { quote: string; url: string };

export type TriggerType =
  | "audit_in_progress"
  | "security_page_no_badge"
  | "compliance_hire"
  | "enterprise_logos";

export type Trigger = { type: TriggerType; label: string } & Evidence;

export type Facts = {
  product_summary: string | null;
  // Q1 — B2B SaaS?
  is_b2b_saas: boolean | null;
  buyer_description: string | null;
  b2b_evidence: Evidence | null;
  // Q2 — Already certified? null = unknown, [] = a trust/security page was read and names none
  certifications: string[] | null;
  cert_evidence: Evidence | null;
  // Q3 — Right stage and size?
  funding_stage: string | null;
  funding_evidence: Evidence | null;
  employee_count: number | null;
  employee_evidence: Evidence | null;
  open_roles: number | null;
  roles_evidence: Evidence | null;
  enterprise_tier: boolean | null;
  enterprise_evidence: Evidence | null;
  // Q4 — Under compliance pressure?
  triggers: Trigger[];
};

export type QuestionId = "b2b" | "certified" | "stage" | "pressure";

export type QuestionStatus = {
  id: QuestionId;
  question: string;
  status: "answered" | "unknown" | "short_circuit";
  answer: string;
  evidence: Evidence[];
  tries: number;
  limit: number;
};

export type FetchLogEntry = {
  step: number;
  url: string;
  reason: string; // why this page was fetched
  outcome: "ok" | "thin_retry_ok" | "failed" | "blocked";
  detail: string;
  words: number;
};

export type Contact = {
  name: string;
  first_name: string;
  title: string;
  email: string;
  source: "hunter" | "manual";
  confidence: number | null;
  why: string;
};

export type PainPoint = { title: string; why: string };

export type Draft = {
  subject: string;
  body: string;
  hook: string;
  why: string;
  pain_points: PainPoint[];
  written_by: "ai" | "template";
};

export type CompanyResult = {
  domain: string;
  ran_at: string;
  verdict: Verdict;
  reason: string;
  rank: number;
  needs: string[];
  flags: string[];
  questions: QuestionStatus[];
  facts: Facts;
  fetch_log: FetchLogEntry[];
  extra_fetches: number;
  rejected_quotes: number;
  contact: Contact | null;
  contact_note: string | null;
  draft: Draft | null;
  ai_mode: "ai" | "rules-only";
  sent?: { at: string; to: string; id: string } | null;
};
