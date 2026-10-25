// Feeds reader: decrypts data.enc.json in the browser, tracks read/starred locally.
(() => {
  const $ = s => document.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---- theme (icon-only sun/moon) ----
  const root = document.documentElement;
  const savedTheme = store.get('theme', null);
  if (savedTheme) root.dataset.theme = savedTheme;
  $('#theme').onclick = () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
  };

  // ---- state ----
  let items = [];
  let meta = {};
  let view = 'unread';
  const read = new Set(store.get('read', []));
  const starred = store.get('starred', {}); // id -> full item, so stars survive items aging out

  const save = () => {
    // only keep read ids that still exist, so storage stays small
    const live = new Set(items.map(i => i.id));
    store.set('read', [...read].filter(id => live.has(id)));
    store.set('starred', starred);
  };

  // ---- decrypt ----
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function decrypt(pass) {
    const res = await fetch('data.enc.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('nodata');
    const box = await res.json();
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(box.salt), iterations: 250000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
      return JSON.parse(new TextDecoder().decode(plain));
    } catch { throw new Error('badpass'); }
  }

  async function open(pass, remember) {
    $('#err').textContent = '';
    const btn = $('#unlock .go');
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const data = await decrypt(pass);
      if (remember) store.set('pass', pass); else sessionStorage.setItem('pass', pass);
      items = data.items; meta = data;
      $('#lock').hidden = true; $('#app').hidden = false;
      render();
    } catch (e) {
      store.del('pass'); sessionStorage.removeItem('pass');
      $('#err').textContent = e.message === 'badpass' ? 'That passcode didn’t work.'
        : e.message === 'nodata' ? 'No feed data yet. Run the “Fetch feeds” Action once.'
        : 'Couldn’t load feeds.';
      $('#pass').select();
    } finally {
      btn.disabled = false; btn.textContent = 'Open';
    }
  }

  $('#unlock').onsubmit = e => { e.preventDefault(); const p = $('#pass').value; if (p) open(p, $('#remember').checked); };
  $('#lockBtn').onclick = () => { store.del('pass'); sessionStorage.removeItem('pass'); location.reload(); };

  // ---- render ----
  const ago = iso => {
    if (!iso) return '';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    if (s < 604800) return Math.round(s / 86400) + 'd';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '#';

  function render() {
    let list;
    if (view === 'starred') list = Object.values(starred).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    else if (view === 'unread') list = items.filter(i => !read.has(i.id));
    else list = items;

    $('#nUnread').textContent = items.filter(i => !read.has(i.id)).length || '';
    $('#nStarred').textContent = Object.keys(starred).length || '';
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-pressed', t.dataset.view === view));

    $('#list').innerHTML = list.length ? list.map(i => `
      <article class="item ${read.has(i.id) ? 'read' : ''}" data-id="${esc(i.id)}">
        <a href="${esc(safeUrl(i.link))}" target="_blank" rel="noopener noreferrer">
          <div class="meta"><span class="dot"></span><span>${esc(i.feed)}</span><span>·</span><span>${ago(i.date)}</span></div>
          <h2 class="title">${esc(i.title)}</h2>
          ${i.summary ? `<p class="sum">${esc(i.summary)}</p>` : ''}
        </a>
        <button class="icon-btn star" aria-label="Star" aria-pressed="${!!starred[i.id]}"><svg fill="none"><use href="#i-star"/></svg></button>
      </article>`).join('')
      : `<p class="empty">${view === 'unread' ? 'All caught up.' : view === 'starred' ? 'Nothing starred yet.' : 'No articles yet.'}</p>`;

    const errs = meta.errors || [];
    $('#foot').innerHTML = `Updated ${meta.updated ? new Date(meta.updated).toLocaleString() : '—'} · ${(meta.feeds || []).length} feeds`
      + (errs.length ? `<details><summary>${errs.length} feed${errs.length > 1 ? 's' : ''} failed</summary>${errs.map(e => `<div>${esc(e.url)} (${esc(e.error)})</div>`).join('')}</details>` : '');
  }

  $('#list').addEventListener('click', e => {
    const card = e.target.closest('.item'); if (!card) return;
    const id = card.dataset.id;
    const item = items.find(i => i.id === id) || starred[id];
    if (e.target.closest('.star')) {
      e.preventDefault();
      if (starred[id]) delete starred[id]; else starred[id] = item;
      save(); render(); return;
    }
    if (e.target.closest('a')) { read.add(id); save(); setTimeout(render, 150); }
  });

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => { view = t.dataset.view; render(); scrollTo(0, 0); });
  $('#markAll').onclick = () => { items.forEach(i => read.add(i.id)); save(); render(); };

  // ---- auto-unlock if remembered ----
  const remembered = store.get('pass', null) || sessionStorage.getItem('pass');
  if (remembered) open(remembered, !!store.get('pass', null));
})();
