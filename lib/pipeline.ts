// The whole 7-step run for one domain. The agent loop is steps 2-5 of "How the loop uses the map".

import { findContact } from "./contact";
import { writeDraft } from "./draft";
import { emptyFacts, extractAi, extractRules, mergeInto, pageKind } from "./extract";
import { fetchPage, type CleanPage } from "./fetch";
import { aiAvailable } from "./llm";
import { MAX_EXTRA_FETCHES, decide, evaluate, nextPage, shortCircuited } from "./rules";
import type { CompanyResult, FetchLogEntry, QuestionId } from "./types";

export async function runCompany(domain: string, opts: { ai: boolean }): Promise<CompanyResult> {
  const aiOn = opts.ai && aiAvailable();
  const facts = emptyFacts();
  const log: FetchLogEntry[] = [];
  const fetched = new Set<string>();
  const tries: Record<QuestionId, number> = { b2b: 0, certified: 0, stage: 0, pressure: 0 };
  let rejected = 0;
  let extra = 0;
  const aiErrors: string[] = [];

  // AI reads first when it is on, so its verified answers win; keyword rules fill whatever is left.
  const read = async (page: CleanPage) => {
    if (aiOn) {
      const { update, error } = await extractAi(page, domain);
      if (error) aiErrors.push(error);
      rejected += update.rejected;
      mergeInto(facts, update);
    }
    mergeInto(facts, extractRules(page));
  };

  const base = (verdict: CompanyResult["verdict"], reason: string): CompanyResult => ({
    domain,
    ran_at: new Date().toISOString(),
    verdict,
    reason,
    rank: 0,
    needs: [],
    flags: [],
    questions: evaluate(facts, tries),
    facts,
    fetch_log: log,
    extra_fetches: extra,
    rejected_quotes: rejected,
    contact: null,
    contact_note: null,
    draft: null,
    ai_mode: aiOn ? "ai" : "rules-only",
  });

  // 1-2. robots.txt + homepage (apex first, then www)
  let origin = `https://${domain}`;
  let home = await fetchPage(`${origin}/`);
  if (!home.ok && !home.blocked) {
    const www = await fetchPage(`https://www.${domain}/`);
    if (www.ok) {
      origin = `https://www.${domain}`;
      home = www;
    }
  }
  if (!home.ok) {
    log.push({ step: 0, url: `${origin}/`, reason: "homepage", outcome: home.blocked ? "blocked" : "failed", detail: home.reason, words: 0 });
    return base("REVIEW", `Homepage could not be read: ${home.reason}. Queued for a human; the run moved on.`);
  }
  // A homepage with almost no readable text (even after the rendering reader) can't be judged.
  if (home.page.words < 40) {
    log.push({ step: 0, url: home.page.url, reason: "homepage", outcome: "failed", detail: `only ${home.page.words} readable words, even after the rendering reader`, words: home.page.words });
    return base("REVIEW", `Homepage has only ${home.page.words} readable words (a JavaScript app the reader could not render). Queued for a human; the run moved on.`);
  }
  // Keep the origin the site actually redirected to (e.g. apex -> www).
  origin = new URL(home.page.url).origin;
  fetched.add(`${origin}/`);
  fetched.add(home.page.url.replace(/\/$/, ""));
  log.push({
    step: 0,
    url: home.page.url,
    reason: "homepage",
    outcome: home.via === "reader" ? "thin_retry_ok" : "ok",
    detail: home.via === "reader" ? "JavaScript shell; re-read through the rendering reader" : "plain request",
    words: home.page.words,
  });
  const homeLinks = home.page.links;
  await read(home.page);

  // 3-5. the loop: check, name the next page for the first empty field, fetch, extract, repeat
  while (extra < MAX_EXTRA_FETCHES) {
    const qs = evaluate(facts, tries);
    if (shortCircuited(qs)) break;
    const next = nextPage(qs, fetched, origin, homeLinks);
    if (!next) break;
    extra++;
    fetched.add(next.url);
    const res = await fetchPage(next.url);
    if (!res.ok) {
      log.push({ step: extra, url: next.url, reason: next.reason, outcome: res.blocked ? "blocked" : "failed", detail: res.reason, words: 0 });
      continue;
    }
    tries[next.question]++;
    log.push({
      step: extra,
      url: res.page.url,
      reason: next.reason,
      outcome: res.via === "reader" ? "thin_retry_ok" : "ok",
      detail: `${pageKind(res.page.url)} page${res.via === "reader" ? " via rendering reader" : ""}`,
      words: res.page.words,
    });
    await read(res.page);
  }

  // 6. verdict
  const qs = evaluate(facts, tries);
  const d = decide(qs, extra, facts);
  const result: CompanyResult = { ...base(d.verdict, d.reason), questions: qs, rank: d.rank, needs: d.needs, flags: d.flags };
  if (aiOn && aiErrors.length && aiErrors.length >= log.filter((l) => l.outcome !== "failed").length) {
    result.flags.push(`AI extraction failed on every page (${aiErrors[0].slice(0, 120)}); rules-only facts used`);
  }

  // 7. contact + draft, only for qualified companies (saves Hunter's 25 monthly searches)
  if (d.verdict === "SEND" || d.verdict === "SEND_FLAGGED") {
    const { contact, note, headcount } = await findContact(domain, facts.employee_count);
    // The site never said how big they are, but Hunter's company data does. Over 500 is the
    // Evidence Map's size short-circuit, so re-decide before writing anything.
    if (facts.employee_count === null && headcount && headcount.min > 500) {
      facts.employee_count = headcount.min;
      facts.employee_evidence = { quote: `Hunter.io company data: headcount ${headcount.label}`, url: `https://hunter.io/search/${domain}` };
      const qs2 = evaluate(facts, tries);
      const d2 = decide(qs2, extra, facts);
      return {
        ...result,
        questions: qs2,
        verdict: d2.verdict,
        reason: `${d2.reason} (size from Hunter.io; the site never stated it)`,
        rank: d2.rank,
        needs: d2.needs,
        flags: d2.flags,
        contact_note: `${note} No email drafted: company is too large.`,
      };
    }
    result.contact = contact;
    result.contact_note = note;
    if (contact) {
      result.draft = await writeDraft(domain, facts, contact, aiOn);
    } else {
      result.flags.push("no named contact found, so nothing can be sent");
    }
  }
  return result;
}
