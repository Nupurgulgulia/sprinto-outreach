# Sprinto Outreach (Build 2)

**Live demo:** https://sprinto-outreach-bice-one.vercel.app

Paste a list of company websites. For each one the app reads the site, decides whether it fits
Sprinto's ICP, finds the right person, works out their two most likely pain points, drafts a cold
email addressed to them by name, and sends it through Resend to **your own inbox** (the recipient is
locked on the server).

Every verdict shows the four questions it was decided on, the verbatim quote and page behind each
answer, and a log of every page the agent loop fetched and why.

## The 7 steps, and where they live

| Step | What happens | File |
|---|---|---|
| 1 Scrape | robots.txt check → plain fetch → clean (drop nav, cookie banners, blocks under 8 words, duplicates; cap ~2,000 tokens) → one retry through a rendering reader (r.jina.ai) if the page is a JavaScript shell | `lib/fetch.ts` |
| 2 Extract | Keyword rules on every page, then the model fills gaps. **Every fact needs a quote that is really on the page**; quotes that are not are rejected and counted on the card | `lib/extract.ts` |
| 3 Qualify + agent loop | The Evidence Map as code: four questions, per-question try limits (1/1/2/2), hard cap of 4 fetches beyond the homepage, short-circuits, verdict | `lib/rules.ts`, `lib/pipeline.ts` |
| 4 Find the PoC | Hunter.io Domain Search (Option A), or contacts looked up by hand on Apollo in `data/manual-contacts.json` (Option B). Ranked by title for the company's size | `lib/contact.ts` |
| 5 Pain points | Two, tied to the strongest verified trigger and the person's role | `lib/draft.ts` |
| 6 Draft | Model writes from verified facts only; checked (greets by first name, under ~120 words, no filler). Falls back to a template | `lib/draft.ts` |
| 7 Send | Resend email API. `To:` is `SEND_TO` from the server env; the API never reads a recipient from the request | `lib/mail.ts` |

## The ICP and the Evidence Map

A B2B SaaS company with roughly 11 to 200 employees, at seed to Series C, showing at least one
verifiable sign of compliance pressure, and not yet certified.

| Question | Sufficient when | Tries | If unanswered | Short-circuit |
|---|---|---|---|---|
| B2B SaaS? | `is_b2b_saas` set + buyer named, with a quote | 1 | HOLD (manual review) | No → DROP |
| Already certified? | a named SOC 2 / ISO 27001, or a real security page that names none | 1 | treat as not certified, flag | Yes → DROP |
| Right stage and size? | funding stage named, 5+ open roles, enterprise pricing tier, or headcount | 2 | qualify at lower rank, flag | over 500 employees → DROP |
| Under compliance pressure? | at least one trigger, quoted, with its URL | 2 | HOLD for a human, never drop | none |

Fetch order after the homepage follows the first empty question: `/security` or `/trust`, then
`/careers`, `/pricing`, `/customers`. Links actually found on the homepage (including job boards like
Lever or Greenhouse) are preferred over guessed paths.

**Verdicts**

- **Qualified**: all four answered. Contact found, email drafted.
- **Qualified · flagged**: B2B and under pressure, but certification or stage is unknown. Drafted, ranked lower, the unknown named on the card. A wrong drop is the expensive error.
- **Hold for a human**: no pressure trigger found, or B2B status unclear. Absence of evidence on a thin site is not evidence of no need.
- **Drop**: a short-circuit fired. The card says which, with the quote.
- **Couldn't read**: robots.txt disallowed or unreadable, Cloudflare, login wall, timeout. Logged with the reason; the run moves on.

### Decisions worth defending

- **Only SOC 2 and ISO 27001 disqualify.** "GDPR compliant" is on nearly every EU-facing site and does not mean the company has the SOC 2 report its buyers ask for.
- **The verdict never comes from the model.** The model only reads pages and writes. Turning AI off changes how pages are read, not how they are judged.
- **Hunter is only called for qualified companies**, so the 25 free searches a month are not spent on drops.
- **Flagged companies are never auto-sent.** "Send automatically" only sends fully qualified ones; flagged drafts wait for a click.
- **Small company → founder or CTO; larger → head of security.** At under 50 people the founder owns the audit budget; once a security function exists, its head owns it.

## Run it locally

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in what you have (everything is optional; the setup check on the page shows what is missing):

- `GEMINI_API_KEY`: free at https://aistudio.google.com/apikey. Without it the app runs rules-only.
- `HUNTER_API_KEY`: free at https://hunter.io (25 searches/month). Or add Apollo lookups to `data/manual-contacts.json`.
- `RESEND_API_KEY`: from https://resend.com/api-keys. Without a verified domain, emails come from `onboarding@resend.dev` and can only go to your Resend sign-up email.
- `SEND_TO`: your own address. Every email goes here.

```bash
npm run dev
```

Open http://localhost:3000, press **Try the demo list**, then **Run**.

## Deploy to Vercel

1. Push this folder to a new GitHub repo.
2. In Vercel: **Add New → Project**, import the repo (framework is detected as Next.js).
3. Add the same environment variables under **Settings → Environment Variables**, then deploy.

Each company runs in its own request (up to 60 s), so a long list never hits the serverless time
limit. Results are kept in the browser (localStorage) and can be exported as JSON.

## Testing

**Offline rule checks** (no network, under a second): every branch of the Evidence Map verdict, the
loop's page choice, the quote check, rule extraction and robots.txt.

```bash
npx tsx scripts/rules-check.ts
```

**Live end-to-end test** against the deployed app: 20 real companies with known answers where we
have them, ~360 invariant checks (verdict matches the four answers, at most 4 extra fetches, every
quote from the company's own site, contact and draft only for qualified companies, email greets by
first name), then it re-fetches every quote's source page to confirm the quote is really there,
and tests input validation and the locked recipient. Add `--send` to send one real email to `SEND_TO`.

```bash
node scripts/e2e.mjs https://sprinto-outreach-bice-one.vercel.app
```

Last run (19 Nov 2026): 358/358 checks passed, 42/42 quotes found on the live pages, avg 11 s per
company (max 24 s, limit 60 s), 0.95 extra fetches per company on average.
