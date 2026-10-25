// Fetches feeds, keeps the newest items, encrypts with PASSCODE, writes docs/data.enc.json.
// Zero dependencies. Node 20+.
//   FEEDS     one feed URL per line (repo secret)
//   PASSCODE  passphrase used to encrypt (repo secret)
import { webcrypto as crypto } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const MAX_PER_FEED = 30;
const MAX_TOTAL = 400;

const passcode = process.env.PASSCODE;
if (!passcode) throw new Error('PASSCODE is not set');

let feedText = process.env.FEEDS;
if (!feedText) {
  try { feedText = await readFile(new URL('../feeds.local.txt', import.meta.url), 'utf8'); }
  catch { throw new Error('FEEDS is not set (and no feeds.local.txt for local testing)'); }
}
const urls = feedText.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

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
const attr = (xml, name, a) => {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${a}=["']([^"']+)["']`, 'i'));
  return m ? decode(m[1]) : '';
};
const atomLink = entry => {
  const links = entry.match(/<link\s[^>]*>/gi) || [];
  const alt = links.find(l => /rel=["']alternate["']/i.test(l)) || links.find(l => !/rel=/i.test(l)) || links[0];
  const m = alt && alt.match(/href=["']([^"']+)["']/i);
  return m ? decode(m[1]) : '';
};
const plain = html => decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const summary = html => { const t = plain(decode(html)); return t.length > 280 ? t.slice(0, 277) + '…' : t; };

function parse(xml, url) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const head = xml.split(/<(item|entry)[\s>]/i)[0];
  const feedTitle = tag(head, 'title') || new URL(url).hostname;
  const items = (isAtom ? blocks(xml, 'entry') : blocks(xml, 'item')).slice(0, MAX_PER_FEED).map(b => {
    const link = isAtom ? atomLink(b) : (tag(b, 'link') || attr(b, 'link', 'href') || tag(b, 'guid'));
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const body = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content');
    const t = Date.parse(date);
    return {
      id: tag(b, 'guid') || tag(b, 'id') || link,
      title: plain(tag(b, 'title')) || '(untitled)',
      link,
      date: Number.isNaN(t) ? null : new Date(t).toISOString(),
      summary: summary(body),
      feed: feedTitle,
    };
  });
  return { title: feedTitle, items };
}

// ---- fetch all ----
const results = await Promise.allSettled(urls.map(async url => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'personal-rss-reader/1.0', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return parse(await res.text(), url);
}));

const feeds = [], items = [], errors = [];
results.forEach((r, i) => {
  if (r.status === 'fulfilled') { feeds.push({ title: r.value.title, count: r.value.items.length }); items.push(...r.value.items); }
  else errors.push({ url: urls[i], error: String(r.reason?.message || r.reason) });
});
items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
const payload = { updated: new Date().toISOString(), feeds, errors, items: items.slice(0, MAX_TOTAL) };

const enc = new TextEncoder();
const outFile = new URL('../docs/data.enc.json', import.meta.url);

// ---- skip if nothing changed (keyed hash, so it reveals nothing) ----
const hmacKey = await crypto.subtle.importKey('raw', enc.encode(passcode), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const digest = Buffer.from(await crypto.subtle.sign('HMAC', hmacKey,
  enc.encode(JSON.stringify({ feeds, errors, items: payload.items })))).toString('base64');
try {
  const prev = JSON.parse(await readFile(outFile, 'utf8'));
  if (prev.h === digest) { console.log('No changes; leaving data as is.'); process.exit(0); }
} catch { /* first run */ }

// ---- encrypt (PBKDF2 -> AES-GCM), mirrored in docs/app.js ----
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const baseKey = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
  baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload))));
const b64 = u8 => Buffer.from(u8).toString('base64');

await writeFile(outFile, JSON.stringify({ v: 1, h: digest, salt: b64(salt), iv: b64(iv), data: b64(data) }));
console.log(`Feeds ok: ${feeds.length}, failed: ${errors.length}, items: ${payload.items.length}`);
