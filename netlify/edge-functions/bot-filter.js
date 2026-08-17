// Edge filter: blocks scraper user agents and blunts per-IP hammering.
//
// Why this exists: a single scraper pulled roughly 20 GB in a week against a
// 100 GB monthly cap, from about 6,500 full-page loads in one day. Each full
// visit transfers ~7.3 MB, most of it painting assets. The site is static
// with no backend, so the edge is the only place to enforce anything.
//
// This is friction, not a security boundary. The blocklist is public and any
// scraper can spoof a browser user agent. The goal is to stop the lazy
// majority that ships its HTTP library's default user agent, which is what
// the observed traffic was doing.
//
// Path scoping lives in netlify.toml and is deliberate: the document plus
// /assets/*, minus the pre-baked .dvs.br payload. Blocking the document stops
// a crawler before it can discover any asset URL, and /assets/* covers the
// bytes that actually cost money. /js/* and /css/* are left alone so the
// twenty module requests on the critical path do not pay for an isolate hop.
//
// The .dvs.br exclusion is not cosmetic: passing an already-Brotli-encoded
// response through context.next() decompresses the body but keeps the
// Content-Encoding header, and the browser then fails to decode it. See the
// comment on that declaration in netlify.toml.

// Known-good crawlers. Checked BEFORE the blocklist so a user agent that
// happens to contain a blocked substring can never be caught by accident,
// and so they are never rate limited.
//
// Link-preview bots are here on purpose: the page ships full Open Graph tags,
// and unfurls in Slack, Discord, iMessage, LinkedIn, and X need to keep
// working. Losing those would cost more reach than the scrapers cost in
// bandwidth.
const ALLOWED_AGENTS = [
  // Search
  'googlebot',
  'google-inspectiontool',
  'bingbot',
  'duckduckbot',
  'applebot',
  'yandexbot',
  'baiduspider',
  // Link previews and unfurls
  'facebookexternalhit',
  'twitterbot',
  'linkedinbot',
  'slackbot',
  'discordbot',
  'whatsapp',
  'telegrambot',
  'redditbot',
  'skypeuripreview',
  // Auditing and uptime
  'chrome-lighthouse',
  'pagespeed',
  'pingdom',
  'uptimerobot',
];

// Default user agents of common HTTP libraries and scraping frameworks,
// matched as case-insensitive substrings.
//
// Kept deliberately narrow. Every entry here is a library default that no
// browser sends, so false positives are close to impossible. Broader strings
// were considered and rejected: 'headlesschrome' would catch screenshot and
// audit services, 'node-fetch' and 'axios' catch legitimate integrations.
// The cost of blocking a real visitor is far higher than the cost of serving
// one more scraper.
const BLOCKED_AGENTS = [
  'python-requests',
  'python-urllib',
  'curl/',
  'wget',
  'scrapy',
  'go-http-client',
  'aiohttp',
  'httpx',
  'libwww-perl',
];

// Per-IP throttle. Document requests only. Assets are burst fetched (a single
// visit pulls nine of them at once), so counting those would false-positive on
// real browsers.
//
// Best effort by design. Deno isolates are per-region and get recycled, so
// this Map is neither shared nor durable. It blunts hammering from one source;
// it is not a quota. The observed scraper averaged about 4.5 requests a
// minute, well under this ceiling, which is why the blocklist above is the
// actual defense and this is only a backstop.
const RATE_LIMIT = 60;          // document requests per IP per window
const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 5000;   // hard ceiling so the Map cannot grow unbounded

/** ip -> { count, windowStart } */
const hits = new Map();

function pruneExpired(now) {
  for (const [ip, entry] of hits) {
    if (now - entry.windowStart >= RATE_WINDOW_MS) hits.delete(ip);
  }
  // Still full after pruning means a burst of distinct live IPs. Drop
  // everything rather than grow without bound: a cleared Map costs one lenient
  // window, which is the right trade for a best-effort limiter.
  if (hits.size >= MAX_TRACKED_IPS) hits.clear();
}

function isRateLimited(ip, now) {
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    if (hits.size >= MAX_TRACKED_IPS) pruneExpired(now);
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

function deny(status, message, extraHeaders) {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Never let a rejection get cached and replayed to a real visitor.
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export default async (request, context) => {
  try {
    const ua = request.headers.get('user-agent') ?? '';

    // Missing or blank user agent. Every real browser, and every crawler
    // worth serving, sends one.
    if (ua.trim() === '') return deny(403, 'Forbidden');

    const lower = ua.toLowerCase();

    if (!ALLOWED_AGENTS.some((agent) => lower.includes(agent))) {
      if (BLOCKED_AGENTS.some((agent) => lower.includes(agent))) {
        return deny(403, 'Forbidden');
      }

      const { pathname } = new URL(request.url);
      if (pathname === '/' || pathname === '/index.html') {
        // context.ip is absent under `netlify dev`, where every local request
        // then shares one bucket. Fine for development.
        const ip = context.ip || 'local';
        if (isRateLimited(ip, Date.now())) {
          return deny(429, 'Too Many Requests', { 'Retry-After': '60' });
        }
      }
    }
  } catch (err) {
    // A throwing edge function makes Netlify serve an error page in place of
    // the site. Any failure here falls through to the normal static response
    // instead: worst case a scraper gets served, not an outage.
    console.error('[bot-filter] passing through after error:', err);
  }

  return context.next();
};
