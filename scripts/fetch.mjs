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

// Preview image: media:thumbnail / media:content / image enclosure / itunes:image, else the first <img> in the body.
function findImage(b, link) {
  const tagAttr = (re, a) => { const m = b.match(re); if (!m) return ''; const v = m[0].match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']+)["']`, 'i')); return v ? decode(v[1]) : ''; };
  let img = tagAttr(/<media:thumbnail\b[^>]*>/i, 'url')
    || tagAttr(/<media:content\b[^>]*(?:medium=["']image["']|type=["']image\/)[^>]*>/i, 'url')
    || tagAttr(/<enclosure\b[^>]*type=["']image\/[^>]*>/i, 'url')
    || tagAttr(/<itunes:image\b[^>]*>/i, 'href');
  if (!img) {
    const html = decode(tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary'));
    const m = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (m && !/(pixel|tracking|feedburner|1x1|spacer|gravatar|emoji)/i.test(m[1])) img = decode(m[1]);
  }
  if (!img) return null;
  try { const u = new URL(img, link || undefined); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

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
      image: findImage(b, link),
    };
  }).filter(i => i.guid);
  return { title, items };
}

async function get(url, extra = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'personal-rss-reader/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8', ...extra },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`The site answered ${res.status}`);
  return { text: await res.text(), url: res.url || url };
}

// ---- YouTube: its feed endpoint fails intermittently (404/500), so retry, try the uploads playlist feed,
//      and finally read the channel's Videos page. ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isYouTubeFeed = u => /youtube\.com\/feeds\/videos\.xml/i.test(u || '');
const channelIdOf = u => (String(u || '').match(/channel_id=(UC[\w-]{22})/) || [])[1];

function agoToDate(text) {
  const m = String(text || '').match(/(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mos?|years?|yrs?|y)\b/i);
  if (!m) return null;
  const n = +m[1], u = m[2].toLowerCase();
  const ms = u.startsWith('mo') ? 30 * 864e5 : u.startsWith('s') ? 1e3 : u.startsWith('mi') || u === 'm' ? 6e4
    : u.startsWith('h') ? 36e5 : u.startsWith('d') ? 864e5 : u.startsWith('w') ? 7 * 864e5 : 365 * 864e5;
  return new Date(Date.now() - n * ms).toISOString();
}

function scrapeYouTubeVideos(html) {
  const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [], seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object' || out.length >= 15) return;
    const L = o.lockupViewModel;
    if (L && L.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' && /^[\w-]{11}$/.test(L.contentId || '') && !seen.has(L.contentId)) {
      const md = L.metadata?.lockupMetadataViewModel;
      const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap(r => (r.metadataParts || []).map(p => p.text?.content || ''));
      seen.add(L.contentId);
      out.push({ id: L.contentId, title: md?.title?.content || '', ago: parts.find(t => /ago|streamed|premiered/i.test(t)) || '' });
    }
    const V = o.videoRenderer;   // older page layout
    if (V && /^[\w-]{11}$/.test(V.videoId || '') && !seen.has(V.videoId)) {
      seen.add(V.videoId);
      out.push({ id: V.videoId, title: V.title?.runs?.[0]?.text || V.title?.simpleText || '', ago: V.publishedTimeText?.simpleText || '' });
    }
    for (const k in o) walk(o[k]);
  })(data);
  return out.filter(v => v.title).map(v => ({
    guid: `yt:video:${v.id}`,           // same id the feed uses, so nothing duplicates when the feed comes back
    title: v.title,
    link: `https://www.youtube.com/watch?v=${v.id}`,
    published: agoToDate(v.ago),
    summary: '',
    image: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
  }));
}

async function loadYouTube(feedUrl, feed) {
  const cid = channelIdOf(feedUrl);
  const attempts = [feedUrl, feedUrl, feedUrl];
  if (cid) attempts.push(`https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${cid.slice(2)}`);
  for (let n = 0; n < attempts.length; n++) {
    try {
      const { text } = await get(attempts[n]);
      if (isFeed(text)) {
        const parsed = parse(text, feed.title || 'YouTube');
        // the uploads-playlist feed is titled after the playlist, so keep the channel's name
        return { url: feedUrl, kind: 'feed', title: n === 3 ? (feed.title || parsed.title) : parsed.title, items: parsed.items };
      }
    } catch { /* try the next attempt */ }
    await sleep(400 * (n + 1));
  }
  if (cid) {
    try {
      const { text } = await get(`https://www.youtube.com/channel/${cid}/videos`, { 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' });
      const items = scrapeYouTubeVideos(text);
      if (items.length) {
        const name = plain((text.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '') || feed.title || 'YouTube';
        return { url: feedUrl, kind: 'feed', title: name, items, fallback: true };
      }
    } catch { /* fall through */ }
  }
  throw new Error('YouTube’s feed is having trouble right now; it will retry automatically');
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
    .map(([link, f]) => ({ guid: link, title: f.title, link, published: new Date().toISOString(), summary: '', image: null }));
  if (items.length < 3) throw new Error('No feed or articles found on this page');
  return { title, items };
}

// Accepts a feed address or a normal website; for a website, finds its advertised feed,
// and if it has none, reads the page itself for article headlines.
async function load(feed) {
  const start = feed.feed_url || feed.url;
  if (isYouTubeFeed(start)) return loadYouTube(start, feed);
  let { text, url } = await get(start);
  if (!isFeed(text)) {
    const links = text.match(/<link\b[^>]*>/gi) || [];
    const alt = links.find(l => /rel=["']?alternate/i.test(l) && /application\/(rss|atom)\+xml/i.test(l));
    const href = alt && alt.match(/href=["']([^"']+)["']/i);
    if (!href) return { url, kind: 'page', ...scrapePage(text, url) };
    const feedUrl = new URL(decode(href[1]), url).href;
    if (isYouTubeFeed(feedUrl)) return loadYouTube(feedUrl, feed);
    const page = { text, url };
    ({ text, url } = await get(feedUrl));
    if (!isFeed(text)) return { url: page.url, kind: 'page', ...scrapePage(page.text, page.url) };
  }
  return { url, kind: 'feed', ...parse(text, new URL(url).hostname) };
}

// ---- run ----
const feeds = await db('feeds?select=id,user_id,url,feed_url,kind,title');
let saved = 0, failed = 0;
const CONCURRENCY = 10;         // be polite: check a few feeds at a time
const FIRST_UNREAD = 3;         // a brand-new feed only marks its newest few items unread

// Postgres rejects NUL characters and broken emoji halves in text; strip them.
const tidy = v => typeof v === 'string' ? v.replace(/\u0000/g, '').toWellFormed() : v;
const clean = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, tidy(v)]));

async function check(feed) {
  try {
    const res = await load(feed);
    const { url, kind, title } = res;
    let items = res.items;
    // The Videos-page fallback lists older uploads the feed never showed; only keep genuinely recent ones.
    if (res.fallback) items = items.filter(i => i.published && Date.parse(i.published) > Date.now() - 3 * 864e5);
    if (items.length) {
      const firstTime = !feed.kind;   // kind is only set after a feed's first successful check
      const newestFirst = [...items].sort((a, b) => (b.published || '').localeCompare(a.published || ''));
      await db('items?on_conflict=feed_id,guid', {
        method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
        body: newestFirst.map((i, n) => ({
          ...clean(i), user_id: feed.user_id, feed_id: feed.id, feed_title: title,
          read: firstTime && n >= FIRST_UNREAD,
        })),
      });
    }
    await db(`feeds?id=eq.${feed.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { feed_url: url, kind, title: tidy(title), last_fetched: new Date().toISOString(), last_error: null },
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
