// Fetches every feed in Supabase, saves new articles, records errors, prunes old items.
// Zero dependencies. Node 20+.
//   SUPABASE_URL          https://<project>.supabase.co
//   SUPABASE_SECRET_KEY   secret (sb_secret_...) or legacy service_role key. Never put this in the web page.

const MAX_PER_FEED = 50;
const KEEP_DAYS = 60;            // unstarred articles older than this are removed

const BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!BASE || !KEY) {
  console.log('Supabase is not connected yet (SUPABASE_URL / SUPABASE_SECRET_KEY secrets missing). Skipping.');
  process.exit(0);
}

const headers = {
  apikey: KEY,
  'Content-Type': 'application/json',
  ...(KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` }),
};
async function db(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) },
  });
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 || method !== 'GET' ? null : res.json();
}

// ---- tiny XML helpers ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&(\w+);/g, (m, n) => ENT[n] ?? m)
  .trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
};
const blocks = (xml, name) => xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, 'gi')) || [];
const atomLink = entry => {
  const links = entry.match(/<link\s[^>]*>/gi) || [];
  const alt = links.find(l => /rel=["']alternate["']/i.test(l)) || links.find(l => !/rel=/i.test(l)) || links[0];
  const m = alt && alt.match(/href=["']([^"']+)["']/i);
  return m ? decode(m[1]) : '';
};
const plain = html => decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const summary = html => { const t = plain(decode(html)); return t.length > 280 ? t.slice(0, 277) + '…' : t; };
const isFeed = text => /<(rss|feed|rdf:RDF)[\s>]/i.test(text);

function parse(xml, fallbackTitle) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const title = plain(tag(head, 'title')) || fallbackTitle;
  const items = (isAtom ? blocks(xml, 'entry') : blocks(xml, 'item')).slice(0, MAX_PER_FEED).map(b => {
    const link = isAtom ? atomLink(b) : (tag(b, 'link') || tag(b, 'guid'));
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const body = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'media:description');
    const t = Date.parse(date);
    return {
      guid: tag(b, 'guid') || tag(b, 'id') || link || plain(tag(b, 'title')),
      title: plain(tag(b, 'title')) || '(untitled)',
      link,
      published: Number.isNaN(t) ? null : new Date(t).toISOString(),
      summary: summary(body),
    };
  }).filter(i => i.guid);
  return { title, items };
}

async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'personal-rss-reader/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8' },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`The site answered ${res.status}`);
  return { text: await res.text(), url: res.url || url };
}

// ---- page fallback: pull article headlines from a site that has no feed ----
const SKIP_PATH = /\/(tag|tags|category|categories|topic|topics|author|authors|about|contact|privacy|terms|login|signin|signup|register|subscribe|account|search|cart|shop|help|faq|careers|jobs|newsletter|advertise|sitemap)(\/|$)|\.(jpe?g|png|gif|svg|pdf|zip|mp3|mp4)$/i;
const SKIP_TEXT = /^(read more|more|continue reading|learn more|see all|view all|home|menu|next|previous|older|newer|share|comments?|\d+)$/i;
const attrOf = (tagHtml, name) => { const m = tagHtml.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i')); return m ? decode(m[1]) : ''; };

function scrapePage(html, pageUrl) {
  const base = new URL(pageUrl);
  const body = html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
                   .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
                   .replace(/<!--[\s\S]*?-->/g, ' ');
  const meta = n => { const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i')); return m ? attrOf(m[0], 'content') : ''; };
  const title = plain(meta('og:site_name') || tag(html, 'title').split(/\s[|–—-]\s/)[0] || base.hostname);

  const found = new Map(); // url -> {title, score, order}
  let order = 0;
  const consider = (aHtml, inner, score) => {
    const href = attrOf(aHtml, 'href');
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) return;
    let u; try { u = new URL(href, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;
    u.hash = '';
    if (u.href === base.href || u.pathname === '/' || SKIP_PATH.test(u.pathname)) return;
    const text = plain(inner);
    if (text.length < 15 || text.length > 200 || SKIP_TEXT.test(text)) return;
    // article-looking paths: dated, slugged, or nested
    const p = u.pathname;
    if (/\/\d{4}\/\d{1,2}\//.test(p) || /-[^/]*-[^/]*-/.test(p) || p.split('/').filter(Boolean).length >= 2) score += 1;
    const prev = found.get(u.href);
    if (!prev || score > prev.score) found.set(u.href, { title: text, score, order: prev ? prev.order : order++ });
  };

  // links inside headings are the strongest signal
  for (const h of body.match(/<h[1-4]\b[^>]*>[\s\S]*?<\/h[1-4]>/gi) || []) {
    for (const m of h.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) consider(m[1], m[2], 3);
  }
  // links inside <article> blocks, or with headline-ish classes
  for (const art of body.match(/<article\b[\s\S]*?<\/article>/gi) || []) {
    for (const m of art.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) consider(m[1], m[2], 2);
  }
  for (const m of body.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/gi)) {
    const cls = attrOf(m[1], 'class');
    consider(m[1], m[2], /title|headline|post|story|entry|article|card/i.test(cls) ? 2 : 0);
  }

  const best = Math.max(0, ...[...found.values()].map(f => f.score));
  const min = best >= 3 ? 3 : best >= 2 ? 2 : 1;   // keep only the strongest tier available
  const items = [...found.entries()]
    .filter(([, f]) => f.score >= min)
    .sort((a, b) => a[1].order - b[1].order)
    .slice(0, MAX_PER_FEED)
    .map(([link, f]) => ({ guid: link, title: f.title, link, published: new Date().toISOString(), summary: '' }));
  if (items.length < 3) throw new Error('No feed or articles found on this page');
  return { title, items };
}

// Accepts a feed address or a normal website; for a website, finds its advertised feed,
// and if it has none, reads the page itself for article headlines.
async function load(feed) {
  let { text, url } = await get(feed.feed_url || feed.url);
  if (!isFeed(text)) {
    const links = text.match(/<link\b[^>]*>/gi) || [];
    const alt = links.find(l => /rel=["']?alternate/i.test(l) && /application\/(rss|atom)\+xml/i.test(l));
    const href = alt && alt.match(/href=["']([^"']+)["']/i);
    if (!href) return { url, kind: 'page', ...scrapePage(text, url) };
    const feedUrl = new URL(decode(href[1]), url).href;
    const page = { text, url };
    ({ text, url } = await get(feedUrl));
    if (!isFeed(text)) return { url: page.url, kind: 'page', ...scrapePage(page.text, page.url) };
  }
  return { url, kind: 'feed', ...parse(text, new URL(url).hostname) };
}

// ---- run ----
const feeds = await db('feeds?select=id,user_id,url,feed_url,kind');
let saved = 0, failed = 0;
const CONCURRENCY = 8;          // be polite: check a few feeds at a time
const FIRST_UNREAD = 3;         // a brand-new feed only marks its newest few items unread

async function check(feed) {
  try {
    const { url, kind, title, items } = await load(feed);
    if (items.length) {
      const firstTime = !feed.kind;   // kind is only set after a feed's first successful check
      const newestFirst = [...items].sort((a, b) => (b.published || '').localeCompare(a.published || ''));
      await db('items?on_conflict=feed_id,guid', {
        method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
        body: newestFirst.map((i, n) => ({
          ...i, user_id: feed.user_id, feed_id: feed.id, feed_title: title,
          read: firstTime && n >= FIRST_UNREAD,
        })),
      });
    }
    await db(`feeds?id=eq.${feed.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { feed_url: url, kind, title, last_fetched: new Date().toISOString(), last_error: null },
    });
    saved += items.length;
  } catch (e) {
    failed++;
    const msg = e.name === 'TimeoutError' ? 'The site took too long to answer' : String(e.message || e).slice(0, 200);
    await db(`feeds?id=eq.${feed.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { last_fetched: new Date().toISOString(), last_error: msg },
    }).catch(() => {});
    console.log(`✗ ${feed.url}: ${msg}`);
  }
}

const queue = [...feeds];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) await check(queue.shift());
}));

// prune: old unstarred articles, and unstarred leftovers from removed feeds
const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
await db(`items?starred=is.false&created_at=lt.${cutoff}`, { method: 'DELETE', prefer: 'return=minimal' });
await db('items?starred=is.false&feed_id=is.null', { method: 'DELETE', prefer: 'return=minimal' });

console.log(`Feeds: ${feeds.length} (${failed} failed), articles checked: ${saved}`);
