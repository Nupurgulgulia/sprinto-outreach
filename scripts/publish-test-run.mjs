// Turns an E2E report into public/test-run.json, which the app's "Load latest test run" button reads.
//   node scripts/publish-test-run.mjs <e2e-report.json>
// The file is public on the website, so real people's email addresses (from Hunter) are removed.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export function publishTestRun(report, outPath = "public/test-run.json") {
  const results = report.results.map((r) => {
    const { _ms, ...rest } = r;
    return {
      ...rest,
      contact: r.contact ? { ...r.contact, email: "(hidden in the published test run)" } : null,
      sent: null,
    };
  });
  const verdicts = Object.fromEntries(Object.entries(report.verdicts).map(([v, list]) => [v, list.length]));
  const out = {
    ran_at: report.ran_at,
    base: report.base,
    summary: {
      companies: report.companies,
      checks: report.checks,
      passed: report.checks - report.failures.length,
      failures: report.failures,
      quotes_found: report.quote_check.ok,
      quotes_missing: report.quote_check.missing,
      avg_seconds: Math.round(report.avg_ms_per_company / 100) / 10,
      max_seconds: Math.round(report.max_ms / 100) / 10,
      avg_extra_fetches: Number(report.avg_extra_fetches),
      verdicts,
    },
    results,
  };
  mkdirSync("public", { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1]?.endsWith("publish-test-run.mjs")) {
  const src = process.argv[2];
  if (!src) {
    console.error("usage: node scripts/publish-test-run.mjs <e2e-report.json>");
    process.exit(1);
  }
  const out = publishTestRun(JSON.parse(readFileSync(src, "utf8")));
  console.log(`public/test-run.json: ${out.results.length} companies, ${out.summary.passed}/${out.summary.checks} checks`);
}
