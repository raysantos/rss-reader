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
    const body = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content');
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

// Accepts a feed address or a normal website; for a website, finds its advertised feed.
async function load(feed) {
  let { text, url } = await get(feed.feed_url || feed.url);
  if (!isFeed(text)) {
    const links = text.match(/<link\b[^>]*>/gi) || [];
    const alt = links.find(l => /rel=["']?alternate/i.test(l) && /application\/(rss|atom)\+xml/i.test(l));
    const href = alt && alt.match(/href=["']([^"']+)["']/i);
    if (!href) throw new Error('No feed found at this address');
    url = new URL(decode(href[1]), url).href;
    ({ text, url } = await get(url));
    if (!isFeed(text)) throw new Error('No feed found at this address');
  }
  return { url, ...parse(text, new URL(url).hostname) };
}

// ---- run ----
const feeds = await db('feeds?select=id,user_id,url,feed_url');
let saved = 0, failed = 0;

await Promise.all(feeds.map(async feed => {
  try {
    const { url, title, items } = await load(feed);
    if (items.length) {
      await db('items?on_conflict=feed_id,guid', {
        method: 'POST', prefer: 'resolution=ignore-duplicates,return=minimal',
        body: items.map(i => ({ ...i, user_id: feed.user_id, feed_id: feed.id, feed_title: title })),
      });
    }
    await db(`feeds?id=eq.${feed.id}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: { feed_url: url, title, last_fetched: new Date().toISOString(), last_error: null },
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
}));

// prune: old unstarred articles, and unstarred leftovers from removed feeds
const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
await db(`items?starred=is.false&created_at=lt.${cutoff}`, { method: 'DELETE', prefer: 'return=minimal' });
await db('items?starred=is.false&feed_id=is.null', { method: 'DELETE', prefer: 'return=minimal' });

console.log(`Feeds: ${feeds.length} (${failed} failed), articles checked: ${saved}`);
