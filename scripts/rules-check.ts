// Offline checks of the Evidence Map rules: every branch of the verdict, the loop's page choice,
// the evidence (quote) check and the robots.txt parser. No network. Run: npx tsx scripts/rules-check.ts

import { emptyFacts, extractRules, quoteOnPage } from "../lib/extract";
import { cleanHtml, robotsAllows } from "../lib/fetch";
import { decide, evaluate, nextPage } from "../lib/rules";
import type { Facts, QuestionId } from "../lib/types";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`);
}

const ev = (q: string) => ({ quote: q, url: "https://acme.io/" });
const tries0: Record<QuestionId, number> = { b2b: 0, certified: 0, stage: 0, pressure: 0 };
function facts(over: Partial<Facts>): Facts {
  return { ...emptyFacts(), ...over };
}
const b2b = { is_b2b_saas: true, buyer_description: "HR teams", b2b_evidence: ev("For HR teams") };
const pressure = { triggers: [{ type: "audit_in_progress" as const, label: "Audit", ...ev("SOC 2 audit in progress") }] };
const stage = { funding_stage: "Series A", funding_evidence: ev("Series A") };
const notCert = { certifications: [] as string[], cert_evidence: ev("Security page") };
const run = (f: Facts, fetches = 2) => decide(evaluate(f, tries0), fetches, f);

// --- Verdict branches (Evidence Map table + "two answered, one unknown") ---
check("all four answered -> SEND", run(facts({ ...b2b, ...pressure, ...stage, ...notCert })).verdict === "SEND");
check("not B2B SaaS -> DROP (short-circuit)", run(facts({ is_b2b_saas: false, b2b_evidence: ev("Shop now") })).verdict === "DROP");
check("already SOC 2 -> DROP even with a trigger", run(facts({ ...b2b, ...pressure, certifications: ["SOC 2"], cert_evidence: ev("SOC 2 Type II certified") })).verdict === "DROP");
check("over 500 employees -> DROP", run(facts({ ...b2b, ...pressure, employee_count: 1200, employee_evidence: ev("1,200 employees") })).verdict === "DROP");
check("unknown never overrides short-circuit (certified + stage unknown) -> DROP", run(facts({ ...b2b, certifications: ["ISO 27001"], cert_evidence: ev("ISO 27001 certified") })).verdict === "DROP");
check("no pressure trigger -> HOLD, never DROP", run(facts({ ...b2b, ...stage, ...notCert })).verdict === "HOLD");
check("B2B unknown -> HOLD (manual review)", run(facts({ ...pressure })).verdict === "HOLD");
{
  const d = run(facts({ ...b2b, ...pressure, ...stage }));
  check("certification unknown -> SEND_FLAGGED with the unknown named", d.verdict === "SEND_FLAGGED" && d.flags.some((f) => /certification/.test(f)), JSON.stringify(d));
}
{
  const d = run(facts({ ...b2b, ...pressure, ...notCert }));
  check("stage unknown -> SEND_FLAGGED", d.verdict === "SEND_FLAGGED" && d.flags.some((f) => /stage/.test(f)), JSON.stringify(d));
}
check("flagged ranks below fully qualified", run(facts({ ...b2b, ...pressure, ...stage })).rank < run(facts({ ...b2b, ...pressure, ...stage, ...notCert })).rank);
check("4 open roles alone is not 'stage answered' (needs 5+)", evaluate(facts({ open_roles: 4 }), tries0)[2].status === "unknown");
check("5 open roles answers stage", evaluate(facts({ open_roles: 5 }), tries0)[2].status === "answered");
check("250 employees qualifies but is flagged outside 11-200", run(facts({ ...b2b, ...pressure, ...notCert, employee_count: 250, employee_evidence: ev("250 employees") })).flags.some((f) => /11-200/.test(f)));

// --- Loop: next page choice, tries, cap ---
{
  const qs = evaluate(facts({ ...b2b }), tries0);
  const n = nextPage(qs, new Set(), "https://acme.io", []);
  check("first empty field after B2B is certification -> /security", n?.url === "https://acme.io/security" && n.question === "certified", JSON.stringify(n));
}
{
  const qs = evaluate(facts({ ...b2b }), tries0);
  const n = nextPage(qs, new Set(), "https://acme.io", ["https://acme.io/trust-center"]);
  check("homepage link preferred over guessed path (/trust-center)", n?.url === "https://acme.io/trust-center", JSON.stringify(n));
}
{
  const qs = evaluate(facts({ ...b2b, ...notCert }), tries0);
  const n = nextPage(qs, new Set(), "https://acme.io", ["https://jobs.lever.co/acme"]);
  check("careers on Lever is followed for stage", n?.url === "https://jobs.lever.co/acme", JSON.stringify(n));
}
{
  const used = { b2b: 0, certified: 1, stage: 2, pressure: 2 };
  const qs = evaluate(facts({ ...b2b }), used);
  check("question out of tries is not fetched again", nextPage(qs, new Set(), "https://acme.io", []) === null);
}
{
  const d = decide(evaluate(facts({ ...b2b, ...stage, ...notCert }), tries0), 4, facts({}));
  check("at the cap the reason names 4/4 fetches", /4\/4/.test(d.reason), d.reason);
}

// --- Evidence check: quotes must be on the page ---
const page = cleanHtml(
  "<html><body><nav>Home Pricing</nav><p>We are currently undergoing our SOC 2 Type II audit with an independent firm.</p><p>Acme helps finance teams close the books faster with automated reconciliation.</p><footer><img alt='SOC 2 badge'></footer></body></html>",
  "https://acme.io/security",
  200,
);
check("real quote passes", quoteOnPage("We are currently undergoing our SOC 2 Type II audit", page));
check("invented quote is rejected", !quoteOnPage("Acme is ISO 27001 certified since 2021", page));
check("nav text is stripped by cleaning", !page.text.includes("Home Pricing"));

// --- Rule extraction on realistic snippets ---
{
  const u = extractRules(page);
  check("'undergoing SOC 2 audit' is a trigger, not a certification", u.triggers.some((t) => t.type === "audit_in_progress") && !(u.facts.certifications ?? []).length, JSON.stringify(u));
}
{
  const p = cleanHtml("<p>Our platform is SOC 2 Type II certified and ISO 27001 compliant, audited every year by an independent auditor.</p>", "https://acme.io/", 200);
  check("'SOC 2 Type II certified' -> certification found", (extractRules(p).facts.certifications ?? []).length > 0);
}
{
  const p = cleanHtml("<ul><li>Payroll &amp; Compliance Executive Remote</li><li>Senior Backend Engineer Bangalore</li><li>Security Compliance Analyst (SOC 2) Remote</li></ul>", "https://acme.io/careers", 200);
  const t = extractRules(p).triggers.find((x) => x.type === "compliance_hire");
  check("payroll compliance ignored, security compliance analyst counted", !!t && /Security Compliance Analyst/.test(t.quote), JSON.stringify(t));
}
{
  const p = cleanHtml("<p>Open a free demat account and invest in stocks, mutual funds and IPOs with India's largest stock broker.</p><p>Download the app on Android and iOS to start trading today with zero brokerage.</p>", "https://broker.in/", 200);
  check("consumer broker -> is_b2b_saas false", extractRules(p).facts.is_b2b_saas === false);
}
{
  const p = cleanHtml("<p>We use cookies to enhance your browsing experience and analyze our traffic on this website.</p>", "https://acme.io/security", 200);
  check("cookie banner is dropped, not used as a security quote", extractRules(p).triggers.length === 0 && !p.text.includes("cookies"));
}

// --- Regressions found by the live E2E run ---
{
  const qs = evaluate(facts({ ...b2b }), tries0);
  const n = nextPage(qs, new Set(), "https://www.atlassian.com", ["https://www.atlassian.com/trust/ai", "https://www.atlassian.com/trust"]);
  check("Atlassian: main /trust is chosen over the /trust/ai sub-page", n?.url === "https://www.atlassian.com/trust", JSON.stringify(n));
}
{
  const p = cleanHtml(
    "<p>Protect the integrity of your data with comprehensive security practices and encryption at rest.</p><p>Access control and least privilege apply to every AI feature we ship.</p>",
    "https://www.atlassian.com/trust/ai",
    200,
  );
  const u = extractRules(p);
  check("Atlassian: a /trust/ai sub-page does not prove 'not certified'", u.facts.certifications === undefined && u.triggers.length === 0, JSON.stringify(u));
}
{
  const p = cleanHtml("<p>Shop by category: skincare, makeup and fashion bestsellers with free delivery and cash on delivery.</p>", "https://nykaa.com/", 200);
  check("Nykaa-style beauty store -> not B2B SaaS", extractRules(p).facts.is_b2b_saas === false);
}

// --- robots.txt ---
check("robots: Disallow /careers blocks /careers", !robotsAllows("User-agent: *\nDisallow: /careers", "/careers"));
check("robots: longer Allow beats Disallow /", robotsAllows("User-agent: *\nDisallow: /\nAllow: /security", "/security"));
check("robots: rules for another bot don't apply", robotsAllows("User-agent: BadBot\nDisallow: /", "/"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
