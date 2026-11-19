// Step 1 — Scrape. robots.txt check, plain fetch, clean, and one reader retry for JS shells.

export const USER_AGENT =
  "Mozilla/5.0 (compatible; SprintoOutreachBot/1.0; research for a class project)";
const TIMEOUT_MS = 8000;
const READER_TIMEOUT_MS = 15000;
const THIN_WORDS = 120; // fewer clean words than this = probably a JavaScript shell
const CHAR_CAP = 8000; // ~2,000 tokens

export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split(/[/?#\s]/)[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------- robots.txt

type RobotsVerdict = { allowed: boolean; reason: string };

const robotsCache = new Map<string, string | null>();

async function robotsFor(origin: string): Promise<string | null> {
  if (robotsCache.has(origin)) return robotsCache.get(origin) ?? null;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    // A missing robots.txt means "no rules", which is an allow.
    if (res.status === 404 || res.status === 410) {
      robotsCache.set(origin, null);
      return null;
    }
    if (!res.ok) return `unreadable: HTTP ${res.status}`;
    const text = await res.text();
    robotsCache.set(origin, text);
    return text;
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "unreachable: domain does not resolve";
    if (code === "ECONNREFUSED" || code === "ECONNRESET") return `unreachable: connection failed (${code})`;
    return `unreadable: ${describe(err)}`;
  }
}

/** Minimal parser: the `User-agent: *` group, longest matching Allow/Disallow wins. */
export function robotsAllows(robots: string, path: string): boolean {
  const lines = robots.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim());
  let inStar = false;
  let sawRuleInGroup = false;
  const rules: { allow: boolean; prefix: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (sawRuleInGroup) {
        inStar = false;
        sawRuleInGroup = false;
      }
      if (val === "*") inStar = true;
    } else if (key === "allow" || key === "disallow") {
      sawRuleInGroup = true;
      if (inStar && val) rules.push({ allow: key === "allow", prefix: val.replace(/\*$/, "") });
    }
  }
  let best: { allow: boolean; prefix: string } | null = null;
  for (const r of rules) {
    if (path.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  }
  return best ? best.allow : true;
}

export async function checkRobots(url: string): Promise<RobotsVerdict> {
  const u = new URL(url);
  const robots = await robotsFor(u.origin);
  if (robots?.startsWith("unreachable: ")) return { allowed: false, reason: `site ${robots.slice(13)}` };
  if (robots?.startsWith("unreadable: ")) return { allowed: false, reason: `robots.txt could not be read (${robots.slice(12)})` };
  if (robots === null) return { allowed: true, reason: "no robots.txt" };
  return robotsAllows(robots, u.pathname)
    ? { allowed: true, reason: "allowed by robots.txt" }
    : { allowed: false, reason: `robots.txt disallows ${u.pathname}` };
}

// ---------------------------------------------------------------- cleaning

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "...", copy: "(c)", reg: "(R)", trade: "(TM)",
};

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// Short lines are normally noise, but some short lines carry exactly the facts we need.
const KEEP_SHORT =
  /soc ?2|iso ?27001|hipaa|gdpr|pci|certif|complian|audit|trust|security|enterprise|series [a-e]|seed|raised|funding|employees|team of|engineer|manager|lead|head of|director|officer|analyst|apply|open (roles|positions)|customers|trusted by|\$\d/i;

const COOKIE_NOISE = /\b(we use cookies|this website uses cookies|accept all cookies|cookie (?:policy|settings|preferences)|by clicking .{0,30}accept)\b/i;

function htmlToBlocks(html: string): string[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    // Image alt text often names customer logos and certification badges.
    .replace(/<img[^>]*\balt="([^"]{2,80})"[^>]*>/gi, " [image: $1] ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr|\/footer|\/header|\/a)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decode(body)
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export type CleanPage = {
  url: string;
  text: string;
  words: number;
  links: string[];
  status: number;
};

export function cleanHtml(html: string, url: string, status: number): CleanPage {
  const blocks = htmlToBlocks(html);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const b of blocks) {
    if (COOKIE_NOISE.test(b)) continue;
    const words = b.split(" ").length;
    if (words < 8 && !KEEP_SHORT.test(b)) continue;
    const key = b.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(b);
  }
  let text = kept.join("\n");
  if (text.length > CHAR_CAP) text = text.slice(0, CHAR_CAP);
  return { url, text, words: text.split(/\s+/).filter(Boolean).length, links: extractLinks(html, url), status };
}

function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      if (u.protocol.startsWith("http")) out.add(u.toString().replace(/\/$/, ""));
    } catch {
      /* ignore bad hrefs */
    }
  }
  return [...out];
}

// ---------------------------------------------------------------- fetching

export type FetchResult =
  | { ok: true; page: CleanPage; via: "plain" | "reader" }
  | { ok: false; reason: string; blocked?: boolean };

async function plainGet(url: string) {
  const res = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  const type = res.headers.get("content-type") ?? "";
  const finalUrl = res.url || url;
  // WordPress "guesses" missing pages and can redirect /security to Security.webm. That is not a page.
  if ((type && !/html|text\/plain/i.test(type)) || /\.(webm|mp4|webp|png|jpe?g|gif|svg|pdf|zip)$/i.test(new URL(finalUrl).pathname)) {
    await res.body?.cancel().catch(() => {});
    return { status: 415, finalUrl, body: "" };
  }
  return { status: res.status, finalUrl, body: await res.text() };
}

/** Jina's free reader renders JavaScript pages and returns text. Used once, only for thin pages. */
async function readerGet(url: string): Promise<CleanPage | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { accept: "text/plain", "x-return-format": "text" },
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const raw = await res.text();
    // The reader reports the target's own error status in its text; a 404 page is not content.
    if (/Target URL returned error \d{3}/i.test(raw)) return null;
    const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const seen = new Set<string>();
    const kept = lines.filter((l) => {
      if (/^(Title|URL Source|Published Time|Markdown Content):/.test(l) || COOKIE_NOISE.test(l)) return false;
      if (l.split(" ").length < 8 && !KEEP_SHORT.test(l)) return false;
      if (seen.has(l.toLowerCase())) return false;
      seen.add(l.toLowerCase());
      return true;
    });
    const text = kept.join("\n").slice(0, CHAR_CAP);
    return { url, text, words: text.split(/\s+/).filter(Boolean).length, links: [], status: 200 };
  } catch {
    return null;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return `timed out after ${TIMEOUT_MS / 1000}s`;
    return err.message;
  }
  return String(err);
}

export async function fetchPage(url: string): Promise<FetchResult> {
  const robots = await checkRobots(url);
  if (!robots.allowed) return { ok: false, reason: robots.reason, blocked: !robots.reason.startsWith("site ") };

  let first: CleanPage | null = null;
  try {
    const { status, finalUrl, body } = await plainGet(url);
    if (status === 403 || status === 503) {
      if (/cloudflare|cf-ray|just a moment/i.test(body)) return { ok: false, reason: `Cloudflare challenge (HTTP ${status})` };
      return { ok: false, reason: `HTTP ${status}` };
    }
    if (status === 401) return { ok: false, reason: "login wall (HTTP 401)" };
    if (status === 415) return { ok: false, reason: `not a web page (redirected to ${new URL(finalUrl).pathname.split("/").pop()})` };
    if (status >= 400) return { ok: false, reason: `HTTP ${status}` };
    // A sub-page that silently redirects back to the homepage did not really exist.
    const want = new URL(url);
    const got = new URL(finalUrl);
    if (want.pathname !== "/" && (got.pathname === "/" || got.pathname === "")) {
      return { ok: false, reason: "redirected to the homepage (page does not exist)" };
    }
    first = cleanHtml(body, finalUrl, status);
  } catch (err) {
    return { ok: false, reason: describe(err) };
  }

  if (first.words >= THIN_WORDS) return { ok: true, page: first, via: "plain" };

  const rendered = await readerGet(url);
  if (rendered && rendered.words > first.words) {
    rendered.links = first.links;
    return { ok: true, page: rendered, via: "reader" };
  }
  if (first.words > 0) return { ok: true, page: first, via: "plain" };
  return { ok: false, reason: "page is empty even after the rendering reader" };
}
