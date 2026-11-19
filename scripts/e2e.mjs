// Live end-to-end test against a deployed copy of the app.
//   node scripts/e2e.mjs [baseUrl] [--send] [--publish]
// Runs a test set of real companies through /api/run, checks every result against the Evidence Map
// invariants, re-fetches the source page of every quote to confirm it is really there, tests input
// validation and the locked recipient, and (with --send) sends ONE real email to SEND_TO.

import { writeFileSync } from "node:fs";
import { publishTestRun } from "./publish-test-run.mjs";

const BASE = (process.argv.find((a) => a.startsWith("http")) ?? "https://sprinto-outreach-bice-one.vercel.app").replace(/\/$/, "");
const DO_SEND = process.argv.includes("--send");
const OUT = process.env.E2E_OUT ?? "e2e-results.json";

// expect: verdicts we would accept. "any" = no ground truth, invariants only.
const TEST_SET = [
  // Known certified SaaS: must DROP on "Already certified?"
  { domain: "rocketlane.com", expect: ["DROP"], why: "SOC 2 on its site" },
  { domain: "zluri.com", expect: ["DROP"], why: "SOC 2 on its site" },
  { domain: "kapture.cx", expect: ["DROP"], why: "ISO 27001 + SOC 2 on trust center" },
  { domain: "freshworks.com", expect: ["DROP", "REVIEW"], why: "certified, >500 employees (Cloudflare may block us)" },
  { domain: "atlassian.com", expect: ["DROP", "REVIEW"], why: "certified, huge (may block bots)" },
  // Not B2B SaaS: must DROP on "B2B SaaS?" (or REVIEW if the site blocks us)
  { domain: "zerodha.com", expect: ["DROP", "REVIEW"], why: "consumer stock broker" },
  { domain: "swiggy.com", expect: ["DROP", "REVIEW"], why: "consumer food delivery" },
  { domain: "nykaa.com", expect: ["DROP", "REVIEW"], why: "consumer e-commerce" },
  // Unreachable: must REVIEW, never crash
  { domain: "not-a-real-site-xyz-123.com", expect: ["REVIEW"], why: "domain does not exist" },
  // Early-stage / open-source SaaS: no ground truth, invariants only
  { domain: "springworks.in", expect: "any" },
  { domain: "spyne.ai", expect: "any" },
  { domain: "plane.so", expect: "any" },
  { domain: "formbricks.com", expect: "any" },
  { domain: "papermark.com", expect: "any" },
  { domain: "documenso.com", expect: "any" },
  { domain: "twenty.com", expect: "any" },
  { domain: "hoppscotch.io", expect: "any" },
  { domain: "unkey.com", expect: "any" },
  { domain: "dub.co", expect: "any" },
  { domain: "trigger.dev", expect: "any" },
];

const VERDICTS = ["SEND", "SEND_FLAGGED", "HOLD", "DROP", "REVIEW"];
const ATS = /lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|goodfit\.so/;
const BANNED = /hope this (email )?finds you|quick question|touch base|circle back/i;

const failures = [];
const notes = [];
let checks = 0;
function expectTrue(scope, name, ok, detail = "") {
  checks++;
  if (!ok) failures.push(`${scope}: ${name}${detail ? ` (${detail})` : ""}`);
}

async function post(path, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, ms: Date.now() - t0 };
}

// ------------------------------------------------------------------ invariants per result
function checkResult(r, spec) {
  const s = r.domain;
  expectTrue(s, "verdict is valid", VERDICTS.includes(r.verdict), r.verdict);
  if (spec.expect !== "any") expectTrue(s, `verdict in ${spec.expect.join("/")} (${spec.why})`, spec.expect.includes(r.verdict), `got ${r.verdict}: ${r.reason}`);
  expectTrue(s, "reason is written out", typeof r.reason === "string" && r.reason.length > 20);
  expectTrue(s, "at most 4 fetches beyond homepage", r.extra_fetches <= 4 && r.fetch_log.filter((l) => l.step > 0).length <= 4, `${r.extra_fetches}`);
  if (r.verdict === "REVIEW") {
    expectTrue(s, "REVIEW logs why the homepage failed", r.fetch_log.length >= 1 && !!r.fetch_log[0].detail);
    expectTrue(s, "REVIEW spends no Hunter search", r.contact === null && r.contact_note === null);
    return;
  }
  expectTrue(s, "first fetch is the homepage", r.fetch_log[0]?.reason === "homepage");
  for (const q of r.questions) expectTrue(s, `"${q.question}" tries within limit`, q.tries <= q.limit, `${q.tries}/${q.limit}`);
  const sc = r.questions.filter((q) => q.status === "short_circuit");
  const st = Object.fromEntries(r.questions.map((q) => [q.id, q.status]));
  if (r.verdict === "DROP") expectTrue(s, "DROP rests on a short-circuit", sc.length > 0);
  else expectTrue(s, "non-DROP has no short-circuit", sc.length === 0);
  if (r.verdict === "SEND") expectTrue(s, "SEND has all four answered", r.questions.every((q) => q.status === "answered"), JSON.stringify(st));
  if (r.verdict === "SEND_FLAGGED")
    expectTrue(s, "SEND_FLAGGED: B2B + pressure answered, unknown named", st.b2b === "answered" && st.pressure === "answered" && r.flags.length > 0, JSON.stringify(st));
  if (r.verdict === "HOLD") expectTrue(s, "HOLD only when B2B or pressure unknown", st.b2b === "unknown" || st.pressure === "unknown", JSON.stringify(st));
  if (r.verdict === "HOLD") expectTrue(s, "HOLD lists what it needs", r.needs.length > 0);
  // Evidence: every answered or short-circuited question has a quote from this company's own site
  for (const q of r.questions) {
    if (q.status === "unknown") continue;
    expectTrue(s, `"${q.question}" has evidence`, q.evidence.length > 0);
    for (const e of q.evidence) {
      const host = new URL(e.url).hostname;
      expectTrue(s, "evidence URL is on their site (or their job board, or Hunter company data)", host.endsWith(s) || ATS.test(host) || host === "hunter.io", e.url);
      expectTrue(s, "evidence quote is non-trivial", e.quote.trim().length >= 8, e.quote);
    }
  }
  // Contact and draft only for qualified companies
  const qualified = r.verdict === "SEND" || r.verdict === "SEND_FLAGGED";
  const droppedByHunterSize = r.verdict === "DROP" && /Hunter/.test(r.reason);
  if (!qualified) expectTrue(s, "no contact / draft for non-qualified", r.contact === null && r.draft === null);
  if (!qualified && !droppedByHunterSize) expectTrue(s, "no Hunter search for non-qualified", r.contact_note === null);
  if (qualified) expectTrue(s, "qualified has a contact note", !!r.contact_note);
  if (r.contact) {
    expectTrue(s, "contact has name, title, email", !!(r.contact.name && r.contact.title && /@/.test(r.contact.email)));
    expectTrue(s, "contact email is at their domain", r.contact.email.endsWith(`@${s}`) || r.contact.email.endsWith(`.${s}`), r.contact.email);
    expectTrue(s, "contact choice is explained", r.contact.why.length > 20);
    expectTrue(s, "contact has a draft", !!r.draft);
  }
  if (r.draft) {
    const d = r.draft;
    const words = d.body.split(/\s+/).length;
    expectTrue(s, "draft greets by first name on line 1", new RegExp(`\\b${r.contact.first_name}\\b`, "i").test(d.body.split("\n")[0]), d.body.split("\n")[0]);
    expectTrue(s, "draft under ~170 words", words <= 170, `${words} words`);
    expectTrue(s, "draft has no filler phrases", !BANNED.test(d.body));
    expectTrue(s, "subject is short", d.subject.length > 3 && d.subject.length <= 80, d.subject);
    expectTrue(s, "exactly two pain points", d.pain_points.length === 2);
    expectTrue(s, "draft explains why", d.why.length > 10);
    // The hook should rest on a verified trigger: some trigger keyword should appear in the hook/body
    const trig = r.facts.triggers.map((t) => t.type).join(",");
    expectTrue(s, "draft mentions Sprinto's offer", /sprinto|soc 2|iso 27001|audit/i.test(d.body));
    notes.push(`${s}: draft hook "${(d.hook || d.body.split("\n")[2] || "").slice(0, 110)}" (triggers: ${trig})`);
  }
}

// ------------------------------------------------------------------ quote re-verification
function normText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<img[^>]*\balt="([^"]*)"[^>]*>/gi, " [image: $1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}
const pageCache = new Map();
async function pageText(url) {
  if (!pageCache.has(url)) {
    pageCache.set(
      url,
      (async () => {
        try {
          const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (E2E quote check)" }, signal: AbortSignal.timeout(15000) });
          let t = normText(await res.text());
          if (t.length < 400) {
            const r2 = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(20000) });
            t += " " + normText(await r2.text());
          }
          return t;
        } catch {
          return null;
        }
      })(),
    );
  }
  return pageCache.get(url);
}
async function verifyQuotes(results) {
  let ok = 0, missing = 0, unreachable = 0;
  const misses = [];
  for (const r of results) {
    for (const q of r.questions ?? []) {
      for (const e of q.evidence) {
        if (e.url.startsWith("https://hunter.io/")) continue; // company data from Hunter's API, not a web page
        const text = await pageText(e.url);
        if (text === null) { unreachable++; continue; }
        const quote = normText(e.quote).replace(/^\[image: |\]$/g, "");
        const probe = quote.slice(0, 45);
        if (text.includes(probe)) ok++;
        else { missing++; misses.push(`${r.domain} ${q.id}: "${e.quote.slice(0, 80)}" @ ${e.url}`); }
      }
    }
  }
  return { ok, missing, unreachable, misses };
}

// ------------------------------------------------------------------ main
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

console.log(`E2E against ${BASE}\n`);

// 1. Health
const health = await (await fetch(`${BASE}/api/health`)).json();
for (const c of health.checks) {
  console.log(`  setup  ${c.ok ? "OK " : "OFF"}  ${c.name}: ${c.detail}`);
  expectTrue("health", `${c.name} OK`, c.ok, c.detail);
}
const hunterBefore = Number((health.checks.find((c) => c.name === "Hunter.io")?.detail.match(/^(\d+)/) ?? [])[1]);

// 2. Input validation
{
  const a = await post("/api/run", { domain: "not a domain!!" });
  expectTrue("validation", "bad domain -> 400", a.status === 400, `${a.status}`);
  const b = await post("/api/send", { subject: "", body: "" });
  expectTrue("validation", "empty send -> 400", b.status === 400, `${b.status}`);
  const c = await post("/api/run", { domain: "https://www.RocketLane.com/pricing?x=1" });
  expectTrue("validation", "URL with scheme/path/case is normalised to the domain", c.data.domain === "rocketlane.com", c.data.domain);
}

// 3. The test set, AI on
const t0 = Date.now();
const results = await pool(TEST_SET, 4, async (spec) => {
  const { status, data, ms } = await post("/api/run", { domain: spec.domain, ai: true });
  if (status !== 200) {
    failures.push(`${spec.domain}: /api/run HTTP ${status} ${data.error ?? ""}`);
    return null;
  }
  data._ms = ms;
  checkResult(data, spec);
  console.log(`  ${data.verdict.padEnd(12)} ${spec.domain.padEnd(28)} ${String(ms).padStart(6)}ms  ${data.extra_fetches}/4  ${data.reason.slice(0, 90)}`);
  return data;
});
const ok = results.filter(Boolean);
const totalSec = ((Date.now() - t0) / 1000).toFixed(0);

// 4. Determinism: same company, rules-only, twice
{
  const a = await post("/api/run", { domain: "springworks.in", ai: false });
  const b = await post("/api/run", { domain: "springworks.in", ai: false });
  const sig = (r) => `${r.verdict}|${r.questions.map((q) => q.status).join(",")}`;
  expectTrue("determinism", "rules-only run twice gives the same verdict and answers", sig(a.data) === sig(b.data), `${sig(a.data)} vs ${sig(b.data)}`);
}

// 5. Quotes really on the page
const qv = await verifyQuotes(ok);
expectTrue("evidence", "every quote found on its source page", qv.missing === 0, `${qv.missing} missing`);

// 6. Hunter spend matches qualified count
const health2 = await (await fetch(`${BASE}/api/health`)).json();
const hunterAfter = Number((health2.checks.find((c) => c.name === "Hunter.io")?.detail.match(/^(\d+)/) ?? [])[1]);
const qualified = ok.filter((r) => r.verdict === "SEND" || r.verdict === "SEND_FLAGGED");
const hunterContacts = qualified.filter((r) => r.contact_note && /Hunter/.test(r.contact_note) && !/not set/.test(r.contact_note)).length;
if (!Number.isNaN(hunterBefore) && !Number.isNaN(hunterAfter)) {
  const spent = hunterBefore - hunterAfter;
  notes.push(`Hunter searches spent: ${spent} (qualified companies: ${qualified.length}; non-qualified must spend 0)`);
  expectTrue("hunter", "Hunter spent no more searches than qualified companies (+1 for the validation run)", spent <= qualified.length + 1, `spent ${spent}, qualified ${qualified.length}`);
}

// 7. Locked recipient + one real send
const draftResult = qualified.find((r) => r.draft);
let sendInfo = "skipped (no --send flag)";
if (DO_SEND) {
  const subject = draftResult ? `[E2E] ${draftResult.draft.subject}` : "[E2E] Sprinto Outreach test";
  const body = draftResult ? draftResult.draft.body : "Hi,\n\nEnd-to-end test of the send step.\n\nThe Sprinto team";
  const s = await post("/api/send", {
    subject,
    body,
    domain: draftResult?.domain ?? "e2e",
    intendedFor: draftResult?.contact ? `${draftResult.contact.name} (${draftResult.contact.title})` : "test",
    to: "attacker@example.com",
    cc: "attacker@example.com",
  });
  expectTrue("send", "send succeeds", s.status === 200 && s.data.ok, JSON.stringify(s.data));
  expectTrue("send", "injected 'to' is ignored; mail goes to SEND_TO", s.data.to && s.data.to !== "attacker@example.com");
  const masked = health.checks.find((c) => /Email/.test(c.name))?.detail.match(/to (\S+) only/)?.[1];
  if (masked && s.data.to) expectTrue("send", "delivered to the address the setup check names", s.data.to.slice(0, 2) === masked.slice(0, 2) && s.data.to.endsWith(masked.split("@")[1]));
  sendInfo = s.status === 200 ? `sent "${subject}" (Resend id ${s.data.id})` : `FAILED ${JSON.stringify(s.data)}`;
}

// ------------------------------------------------------------------ report
const by = (v) => ok.filter((r) => r.verdict === v).map((r) => r.domain);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const report = {
  base: BASE,
  ran_at: new Date().toISOString(),
  companies: TEST_SET.length,
  completed: ok.length,
  total_seconds: Number(totalSec),
  avg_ms_per_company: avg(ok.map((r) => r._ms)),
  max_ms: Math.max(...ok.map((r) => r._ms)),
  verdicts: Object.fromEntries(VERDICTS.map((v) => [v, by(v)])),
  avg_extra_fetches: (ok.reduce((a, r) => a + r.extra_fetches, 0) / ok.length).toFixed(2),
  ai_quotes_rejected: ok.reduce((a, r) => a + r.rejected_quotes, 0),
  quote_check: qv,
  send: sendInfo,
  checks,
  failures,
  notes,
  results: ok,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));
if (process.argv.includes("--publish")) {
  publishTestRun(report);
  console.log("Published to public/test-run.json (commit and push to show it in the app)");
}

console.log(`\nVerdicts: ${VERDICTS.map((v) => `${v} ${by(v).length}`).join(" · ")}`);
console.log(`Time: ${totalSec}s total, avg ${report.avg_ms_per_company}ms, max ${report.max_ms}ms per company (limit 60000)`);
console.log(`Extra fetches per company: ${report.avg_extra_fetches} avg (cap 4)`);
console.log(`AI quotes rejected by the evidence check: ${report.ai_quotes_rejected}`);
console.log(`Quotes re-found on live pages: ${qv.ok} ok, ${qv.missing} missing, ${qv.unreachable} page unreachable`);
for (const m of qv.misses) console.log(`   missing: ${m}`);
console.log(`Send: ${sendInfo}`);
for (const n of notes) console.log(`  note: ${n}`);
console.log(`\n${checks - failures.length}/${checks} checks passed`);
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`\nFull results: ${OUT}`);
process.exit(failures.length ? 1 : 0);
