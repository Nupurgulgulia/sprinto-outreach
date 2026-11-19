"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompanyResult, Verdict } from "@/lib/types";

const DEMO = ["rocketlane.com", "zluri.com", "zipy.ai", "nected.ai", "springworks.in", "atlan.com", "whatfix.com", "zerodha.com"];
const MAX_DOMAINS = 15;
const STORE = "sprinto-outreach:v1";

const VERDICT_LABEL: Record<Verdict, string> = {
  SEND: "Qualified",
  SEND_FLAGGED: "Qualified · flagged",
  HOLD: "Hold for a human",
  DROP: "Drop",
  REVIEW: "Couldn't read",
};
const VERDICT_ORDER: Verdict[] = ["SEND", "SEND_FLAGGED", "HOLD", "REVIEW", "DROP"];

type Check = { name: string; ok: boolean; detail: string };
type EmailState = { subject: string; body: string; sending?: boolean; error?: string };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be unavailable; the page still works */
  }
}

export default function Home() {
  const [input, setInput] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [autoSend, setAutoSend] = useState(false);
  const [results, setResults] = useState<CompanyResult[]>([]);
  const [running, setRunning] = useState<{ done: number; total: number; current: string } | null>(null);
  const [filter, setFilter] = useState<Verdict | "ALL">("ALL");
  const [open, setOpen] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [emails, setEmails] = useState<Record<string, EmailState>>({});

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const saved = load<{ input: string; results: CompanyResult[] }>(STORE, { input: "", results: [] });
    setInput(saved.input);
    setResults(saved.results);
    setLoaded(true);
  }, []);
  useEffect(() => {
    // Never write before the saved state has been read back, or an empty first render wipes it.
    if (loaded) save(STORE, { input, results });
  }, [loaded, input, results]);

  const runChecks = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/health");
      setChecks((await res.json()).checks);
    } catch {
      setChecks([{ name: "Server", ok: false, detail: "Could not reach /api/health" }]);
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    runChecks();
  }, [runChecks]);

  const emailFor = (r: CompanyResult): EmailState =>
    emails[r.domain] ?? { subject: r.draft?.subject ?? "", body: r.draft?.body ?? "" };

  const send = useCallback(
    async (r: CompanyResult, override?: EmailState) => {
      const e = override ?? emails[r.domain] ?? { subject: r.draft?.subject ?? "", body: r.draft?.body ?? "" };
      setEmails((m) => ({ ...m, [r.domain]: { ...e, sending: true, error: undefined } }));
      try {
        const res = await fetch("/api/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            subject: e.subject,
            body: e.body,
            domain: r.domain,
            intendedFor: r.contact ? `${r.contact.name} (${r.contact.title}, ${r.contact.email})` : "the contact",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setResults((rs) => rs.map((x) => (x.domain === r.domain ? { ...x, sent: { at: data.at, to: data.to, id: data.id } } : x)));
        setEmails((m) => ({ ...m, [r.domain]: { ...e, sending: false } }));
      } catch (err) {
        setEmails((m) => ({ ...m, [r.domain]: { ...e, sending: false, error: err instanceof Error ? err.message : String(err) } }));
      }
    },
    [emails],
  );

  const run = async () => {
    const domains = [
      ...new Set(
        input
          .split(/[\n,]+/)
          .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0])
          .filter(Boolean),
      ),
    ].slice(0, MAX_DOMAINS);
    if (!domains.length) return;
    setRunning({ done: 0, total: domains.length, current: domains[0] });
    setOpen(null);
    for (let i = 0; i < domains.length; i++) {
      const domain = domains[i];
      setRunning({ done: i, total: domains.length, current: domain });
      let result: CompanyResult;
      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ domain, ai: useAi }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        result = data;
      } catch (err) {
        result = failed(domain, err instanceof Error ? err.message : String(err));
      }
      setResults((rs) => [result, ...rs.filter((x) => x.domain !== result.domain)]);
      setEmails((m) => {
        const next = { ...m };
        delete next[domain];
        return next;
      });
      if (autoSend && result.verdict === "SEND" && result.draft) {
        await send(result, { subject: result.draft.subject, body: result.draft.body });
      }
    }
    setRunning(null);
  };

  const sorted = useMemo(
    () =>
      [...results].sort(
        (a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || b.rank - a.rank,
      ),
    [results],
  );
  const shown = filter === "ALL" ? sorted : sorted.filter((r) => r.verdict === filter);
  const counts = useMemo(() => {
    const c: Partial<Record<Verdict, number>> = {};
    for (const r of results) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
    return c;
  }, [results]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sprinto-outreach-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <header className="top">
        <div className="logo">
          <div className="logo-mark">S</div>
          <div>
            Sprinto Outreach <small>· qualify → find the person → write → send</small>
          </div>
        </div>
      </header>

      <div className="wrap">
        <aside className="side">
          <section className="panel">
            <p className="label">Company websites (one per line, max {MAX_DOMAINS})</p>
            <textarea
              className="domains"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={"acme.io\nexample.com"}
              disabled={!!running}
            />
            <label className="toggle">
              <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
              <span>
                Use AI to read pages and write emails
                <small>Off: keyword rules read the pages and a template writes the email. The verdict is always decided by rules.</small>
              </span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
              <span>
                Send automatically
                <small>Sends every fully qualified email the moment it is written. Flagged ones always wait for you.</small>
              </span>
            </label>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={run} disabled={!!running || !input.trim()}>
                {running ? "Running…" : "Run"}
              </button>
              <button className="btn" onClick={() => setInput(DEMO.join("\n"))} disabled={!!running}>
                Try the demo list
              </button>
            </div>
            {running && (
              <div className="progress">
                {running.done}/{running.total} done · reading <b>{running.current}</b>
                <div className="bar">
                  <div style={{ width: `${(running.done / running.total) * 100}%` }} />
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <p className="label">Setup check</p>
            {!checks && <p className="note">Checking…</p>}
            {checks?.map((c) => (
              <div className="check" key={c.name}>
                <div>
                  <b>{c.name}</b>
                  <p>{c.detail}</p>
                </div>
                <span className={`dot ${c.ok ? "ok" : "no"}`}>{c.ok ? "OK" : "OFF"}</span>
              </div>
            ))}
            <button className="btn small" style={{ marginTop: 8 }} onClick={runChecks} disabled={checking}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </section>
        </aside>

        <main>
          {results.length > 0 && (
            <div className="summary">
              <button className={`chip ${filter === "ALL" ? "on" : ""}`} onClick={() => setFilter("ALL")}>
                All {results.length}
              </button>
              {VERDICT_ORDER.filter((v) => counts[v]).map((v) => (
                <button key={v} className={`chip ${filter === v ? "on" : ""}`} onClick={() => setFilter(v)}>
                  {VERDICT_LABEL[v]} {counts[v]}
                </button>
              ))}
              <span className="spacer" />
              <button className="btn small" onClick={exportJson}>
                Export JSON
              </button>
              <button
                className="btn small"
                onClick={() => {
                  setResults([]);
                  setEmails({});
                }}
                disabled={!!running}
              >
                Clear
              </button>
            </div>
          )}

          {results.length === 0 && (
            <div className="empty panel">
              <h2>Paste company websites and press Run</h2>
              <p>
                Each company is read, qualified against Sprinto&apos;s ICP with a capped agent loop, matched to the right
                person, and given a draft email. Every verdict shows the quotes it rests on.
              </p>
              <div className="steps">
                {["1 Scrape", "2 Extract", "3 Qualify (loop ≤4)", "4 Find PoC", "5 Pain points", "6 Draft", "7 Send"].map((s) => (
                  <span key={s}>{s}</span>
                ))}
              </div>
            </div>
          )}

          {shown.map((r) => (
            <CompanyCard
              key={r.domain}
              r={r}
              open={open === r.domain}
              onToggle={() => setOpen(open === r.domain ? null : r.domain)}
              email={emailFor(r)}
              onEmail={(e) => setEmails((m) => ({ ...m, [r.domain]: e }))}
              onSend={() => send(r)}
            />
          ))}
        </main>
      </div>
    </>
  );
}

function failed(domain: string, msg: string): CompanyResult {
  return {
    domain,
    ran_at: new Date().toISOString(),
    verdict: "REVIEW",
    reason: `The run failed: ${msg}`,
    rank: 0,
    needs: [],
    flags: [],
    questions: [],
    facts: {
      product_summary: null, is_b2b_saas: null, buyer_description: null, b2b_evidence: null, certifications: null,
      cert_evidence: null, funding_stage: null, funding_evidence: null, employee_count: null, employee_evidence: null,
      open_roles: null, roles_evidence: null, enterprise_tier: null, enterprise_evidence: null, triggers: [],
    },
    fetch_log: [],
    extra_fetches: 0,
    rejected_quotes: 0,
    contact: null,
    contact_note: null,
    draft: null,
    ai_mode: "rules-only",
  };
}

function CompanyCard({
  r,
  open,
  onToggle,
  email,
  onEmail,
  onSend,
}: {
  r: CompanyResult;
  open: boolean;
  onToggle: () => void;
  email: EmailState;
  onEmail: (e: EmailState) => void;
  onSend: () => void;
}) {
  return (
    <article className="card">
      <button className="card-head" onClick={onToggle} aria-expanded={open}>
        <span className={`pill v-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
        <div>
          <div className="domain">{r.domain}</div>
          <div className="reason">{r.reason}</div>
          <div className="meta">
            <span>{r.extra_fetches}/4 extra fetches</span>
            <span>{r.ai_mode === "ai" ? "AI-read" : "rules-only"}</span>
            {r.rejected_quotes > 0 && <span>{r.rejected_quotes} AI quote(s) rejected: not on the page</span>}
            {r.needs.length > 0 && <span className="flag">needs: {r.needs.join(", ")}</span>}
            {r.flags.map((f) => (
              <span key={f} className="flag">
                ⚑ {f}
              </span>
            ))}
            {r.sent && <span className="ok-text">✓ sent {new Date(r.sent.at).toLocaleTimeString()}</span>}
          </div>
        </div>
        <div className="who">
          {r.contact ? (
            <>
              {r.contact.name}
              <small>{r.contact.title}</small>
            </>
          ) : (
            <small>{open ? "▲" : "▼"}</small>
          )}
        </div>
      </button>

      {open && (
        <div className="card-body">
          {r.facts.product_summary && <p style={{ margin: 0 }}>{r.facts.product_summary}</p>}

          {r.questions.length > 0 && (
            <section className="section">
              <h4>Why this verdict: the four questions</h4>
              <div className="qs">
                {r.questions.map((q) => (
                  <div key={q.id} className={`q q-${q.status}`}>
                    <span className="q-icon">{q.status === "answered" ? "✓" : q.status === "unknown" ? "?" : "✕"}</span>
                    <div>
                      <div className="q-title">
                        {q.question} <small>{q.answer}</small>
                      </div>
                      {q.evidence.map((e, i) => (
                        <blockquote key={i}>
                          “{e.quote}”
                          <a href={e.url} target="_blank" rel="noreferrer">
                            {new URL(e.url).pathname || "/"}
                          </a>
                        </blockquote>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {r.fetch_log.length > 0 && (
            <section className="section">
              <h4>Agent loop: what was fetched and why</h4>
              <div className="table-scroll">
                <table className="log">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Page</th>
                      <th>Why</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.fetch_log.map((l) => (
                      <tr key={`${l.step}-${l.url}`}>
                        <td>{l.step === 0 ? "home" : l.step}</td>
                        <td className="url">{l.url}</td>
                        <td>{l.reason}</td>
                        <td className={`o-${l.outcome}`}>
                          {l.outcome === "ok" || l.outcome === "thin_retry_ok" ? `${l.words} words · ${l.detail}` : `${l.outcome}: ${l.detail}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {(r.contact || r.contact_note) && (
            <div className="two">
              <section className="section">
                <h4>Why this person</h4>
                {r.contact ? (
                  <div className="box">
                    <b>{r.contact.name}</b> · {r.contact.title}
                    <p>{r.contact.email}{r.contact.confidence !== null ? ` · Hunter confidence ${r.contact.confidence}%` : ""}</p>
                    <p>{r.contact.why}</p>
                    <p>Source: {r.contact.source === "hunter" ? "Hunter.io Domain Search" : "Apollo, looked up by hand"}</p>
                  </div>
                ) : (
                  <div className="box">
                    <p>{r.contact_note}</p>
                  </div>
                )}
              </section>
              {r.draft && (
                <section className="section">
                  <h4>Their two most likely pain points</h4>
                  {r.draft.pain_points.map((p) => (
                    <div className="box" key={p.title}>
                      <b>{p.title}</b>
                      <p>{p.why}</p>
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}

          {r.draft && (
            <section className="section email">
              <h4>The email ({r.draft.written_by === "ai" ? "written by AI from verified facts" : "template"})</h4>
              <input value={email.subject} onChange={(e) => onEmail({ ...email, subject: e.target.value })} aria-label="Subject" />
              <textarea value={email.body} onChange={(e) => onEmail({ ...email, body: e.target.value })} aria-label="Body" />
              {r.draft.why && <p className="note">Why it is written this way: {r.draft.why}</p>}
              <div className="row">
                <button className="btn primary" onClick={onSend} disabled={email.sending}>
                  {email.sending ? "Sending…" : r.sent ? "Send again" : "Approve & send to my inbox"}
                </button>
                {r.sent && <span className="ok-text">Delivered to {r.sent.to}</span>}
                {email.error && <span className="err-text">{email.error}</span>}
              </div>
              <p className="note">The recipient is locked on the server to your own address; this button cannot email the prospect.</p>
            </section>
          )}
        </div>
      )}
    </article>
  );
}
