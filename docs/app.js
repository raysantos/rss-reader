// Feeds reader: Supabase-backed, no libraries. Auth + data go straight to Supabase's REST API.
(() => {
  const $ = s => document.querySelector(s);
  const CFG = window.FEEDS_CONFIG || {};
  const BASE = (CFG.supabaseUrl || '').replace(/\/$/, '');
  const KEY = CFG.publishableKey || '';
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
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
  };

  // ---- auth ----
  let session = store.get('session', null);

  function saveSession(s) {
    session = {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at ? +s.expires_at : Math.floor(Date.now() / 1000) + (+s.expires_in || 3600),
    };
    store.set('session', session);
  }
  function clearSession() { session = null; store.del('session'); }

  async function refresh() {
    if (!session?.refresh_token) throw new Error('signedout');
    const res = await fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    if (!res.ok) { clearSession(); throw new Error('signedout'); }
    saveSession(await res.json());
  }
  async function token() {
    if (!session) throw new Error('signedout');
    if (session.expires_at - 60 < Date.now() / 1000) await refresh();
    return session.access_token;
  }

  // Supabase REST helper. Retries once after refreshing an expired login.
  async function api(path, { method = 'GET', body, prefer, retried } = {}) {
    const res = await fetch(`${BASE}/rest/v1/${path}`, {
      method, body: body && JSON.stringify(body),
      headers: {
        apikey: KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
    });
    if (res.status === 401 && !retried) { await refresh(); return api(path, { method, body, prefer, retried: true }); }
    if (!res.ok) { const e = new Error(await res.text()); e.status = res.status; throw e; }
    if (method === 'HEAD') return res;
    return res.status === 204 || res.headers.get('content-length') === '0' ? null : res.json().catch(() => null);
  }
  async function count(filter) {
    const res = await api(`items?select=id&${filter}`, { method: 'HEAD', prefer: 'count=exact' });
    return +(res.headers.get('content-range') || '').split('/')[1] || 0;
  }

  // Coming back from the emailed link: #access_token=...&refresh_token=...
  function readRedirect() {
    if (!location.hash.includes('=')) return;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('access_token')) saveSession(Object.fromEntries(p));
    else if (p.get('error_description')) $('#err').textContent = p.get('error_description').replace(/\+/g, ' ');
  }

  // sign-in mode: emailed link (default) or email + password
  let usePassword = store.get('signinMode', 'link') === 'password';
  function setMode() {
    $('#password').hidden = !usePassword;
    $('#password').required = usePassword;
    $('#signin .go').textContent = usePassword ? 'Sign in' : 'Email me a sign-in link';
    $('#modeToggle').textContent = usePassword ? 'Email me a link instead' : 'Use a password instead';
    $('#err').textContent = '';
  }
  $('#modeToggle').onclick = () => { usePassword = !usePassword; store.set('signinMode', usePassword ? 'password' : 'link'); setMode(); (usePassword ? $('#password') : $('#email')).focus(); };
  setMode();

  async function passwordSignIn() {
    const btn = $('#signin .go'), err = $('#err');
    err.className = 'err'; err.textContent = '';
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value }),
      });
      if (res.ok) { saveSession(await res.json()); $('#password').value = ''; start(); return; }
      err.textContent = res.status === 429 ? 'Too many tries. Wait a few minutes and try again.'
        : 'Wrong email or password. If you haven’t set a password yet, use the emailed link first.';
    } catch { err.textContent = 'Couldn’t reach the server.'; }
    btn.disabled = false; setMode();
  }

  $('#signin').onsubmit = async e => {
    e.preventDefault();
    if (usePassword) return passwordSignIn();
    const btn = $('#signin .go'), err = $('#err');
    err.className = 'err'; err.textContent = '';
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const redirect = location.origin + location.pathname;
      const res = await fetch(`${BASE}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
        method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: $('#email').value.trim(), create_user: false }),
      });
      if (res.ok) { err.className = 'ok'; err.textContent = 'Check your email and open the link on this device.'; }
      else if (res.status === 429) err.textContent = 'Too many tries. Wait a few minutes and try again.';
      else err.textContent = 'That email isn’t set up for this reader.';
    } catch { err.textContent = 'Couldn’t reach the server.'; }
    btn.disabled = false; btn.textContent = 'Email me a sign-in link';
  };

  // set or change password (while signed in)
  $('#pwForm').onsubmit = async e => {
    e.preventDefault();
    const msg = $('#pwMsg');
    try {
      const res = await fetch(`${BASE}/auth/v1/user`, {
        method: 'PUT',
        headers: { apikey: KEY, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#newPw').value }),
      });
      if (res.ok) { $('#newPw').value = ''; msg.textContent = 'Password saved. You can now sign in with your email and password.'; store.set('signinMode', 'password'); }
      else {
        const body = await res.json().catch(() => ({}));
        msg.textContent = body.msg || body.error_description || 'Couldn’t save that password. Try a longer one.';
      }
    } catch { msg.textContent = 'Couldn’t reach the server.'; }
  };

  async function signOut() {
    try { await fetch(`${BASE}/auth/v1/logout`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${session?.access_token}` } }); } catch {}
    clearSession(); location.reload();
  }
  $('#signOut').onclick = signOut;

  // ---- articles ----
  let view = 'unread';
  let items = [];
  let feeds = [];

  const FIELDS = 'id,feed_id,feed_title,title,link,image,published,read,starred';
  let feedFilter = null; // { id, title } when showing one source
  const FILTER = { unread: '&read=is.false', starred: '&starred=is.true', all: '' };

  async function loadItems() {
    items = await api(`items?select=${FIELDS}${FILTER[view]}${feedFilter ? `&feed_id=eq.${feedFilter.id}` : ''}&order=published.desc.nullslast,id.desc&limit=300`);
    render();
    refreshCounts();
  }
  async function refreshCounts() {
    try {
      const [u, s] = await Promise.all([count('read=is.false'), count('starred=is.true')]);
      $('#nUnread').textContent = u || ''; $('#nStarred').textContent = s || '';
    } catch {}
  }
  async function loadFeeds() {
    feeds = await api('feeds?select=id,url,feed_url,kind,title,last_fetched,last_error&order=created_at.asc');
    renderFeeds(); renderFoot();
  }

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
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

  function render() {
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-pressed', t.dataset.view === view));
    if (!items.length) {
      const msg = !feeds.length ? 'No feeds yet. <button class="btn" id="firstFeed" style="margin-top:12px">Add your first feed</button>'
        : feedFilter ? `Nothing ${view === 'unread' ? 'unread' : view === 'starred' ? 'starred' : 'saved'} from ${esc(feedFilter.title)} right now.`
        : view === 'unread' ? 'All caught up.' : view === 'starred' ? 'Nothing starred yet.' : 'No articles yet. New feeds fill in within 15 minutes.';
      $('#list').innerHTML = `<div class="empty">${msg}</div>`;
      $('#firstFeed')?.addEventListener('click', openSheet);
      return;
    }
    $('#list').innerHTML = items.map(i => `
      <article class="item ${i.read ? 'read' : ''}" data-id="${i.id}">
        <a href="${esc(safeUrl(i.link))}" target="_blank" rel="noopener noreferrer">
          <div class="media">${/^https:\/\//i.test(i.image || '') ? `<img class="thumb" src="${esc(i.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.removeAttribute('src');this.classList.add('ph')">` : '<div class="thumb ph"></div>'}
            <div class="meta"><span class="dot"></span>${feedFilter ? '' : i.feed_id ? `<span class="src" data-feed="${i.feed_id}" title="Show only ${esc(i.feed_title)}">${esc(i.feed_title)}</span>` : `<span>${esc(i.feed_title)}</span>`}${i.published ? `${feedFilter ? '' : '<span>·</span>'}<span>${ago(i.published)}</span>` : ''}</div></div>
          <div class="txt">
            <h2 class="title">${esc(i.title)}</h2>
          </div>
        </a>
        <button class="icon-btn star" aria-label="Star" aria-pressed="${i.starred}"><svg fill="none"><use href="#i-star"/></svg></button>
        ${i.feed_id ? `<button class="icon-btn unsub" aria-label="Unsubscribe from ${esc(i.feed_title)}" title="Unsubscribe from ${esc(i.feed_title)}"><svg><use href="#i-unsub"/></svg></button>` : ''}
      </article>`).join('');
  }
  function renderFoot() {
    const bad = feeds.filter(f => f.last_error).length;
    const last = feeds.map(f => f.last_fetched).filter(Boolean).sort().pop();
    $('#foot').innerHTML = feeds.length
      ? `${feeds.length} feed${feeds.length > 1 ? 's' : ''}${last ? ` · checked ${ago(last)} ago` : ''}`
        + (bad ? ` · <button style="color:var(--accent);text-decoration:underline;font-size:13px" id="badFeeds">${bad} with problems</button>` : '')
      : '';
    $('#badFeeds')?.addEventListener('click', openSheet);
  }

  $('#list').addEventListener('click', async e => {
    const card = e.target.closest('.item'); if (!card) return;
    const item = items.find(i => String(i.id) === card.dataset.id); if (!item) return;
    if (e.target.closest('.src')) { e.preventDefault(); showFeed(item.feed_id, item.feed_title); return; }
    if (e.target.closest('.unsub')) { e.preventDefault(); unsubscribe(item.feed_id, item.feed_title); return; }
    if (e.target.closest('.star')) {
      e.preventDefault();
      item.starred = !item.starred;
      e.target.closest('.star').setAttribute('aria-pressed', item.starred);
      api(`items?id=eq.${item.id}`, { method: 'PATCH', body: { starred: item.starred }, prefer: 'return=minimal' })
        .then(refreshCounts).catch(() => { item.starred = !item.starred; render(); });
      return;
    }
    const vid = ytId(item.link);
    if (vid && e.target.closest('a') && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault(); openPlayer(card, item, vid);
    }
    if (e.target.closest('a') && !item.read) {
      item.read = true; card.classList.add('read');
      api(`items?id=eq.${item.id}`, { method: 'PATCH', body: { read: true }, prefer: 'return=minimal' })
        .then(refreshCounts).catch(() => {});
    }
  });

  // ---- one-source view ----
  function showFeed(id, title) {
    if (!id) return;
    feedFilter = { id, title: title || 'this feed' };
    view = 'all';
    $('#feedChipName').textContent = feedFilter.title;
    $('#feedChip').hidden = false;
    scrollTo(0, 0); loadItems().catch(fail);
  }
  function clearFeed() {
    feedFilter = null; $('#feedChip').hidden = true;
    scrollTo(0, 0); loadItems().catch(fail);
  }
  $('#feedChip').onclick = clearFeed;
  addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !$('#sheet').hidden || $('#confirm').open) return;
    if (document.querySelector('.player')) { closePlayer(); return; }
    if (feedFilter) clearFeed();
  });

  // ---- inline video player (slides open below the clicked card's row) ----
  function ytId(link) {
    const m = String(link || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
  }
  function closePlayer(instant) {
    const p = document.querySelector('.player'); if (!p) return;
    document.querySelectorAll('.item.playing').forEach(c => c.classList.remove('playing'));
    if (instant) { p.remove(); return; }
    p.classList.remove('open');
    p.addEventListener('transitionend', () => p.remove(), { once: true });
    setTimeout(() => p.remove(), 500);
  }
  function openPlayer(card, item, vid) {
    const same = card.classList.contains('playing');
    closePlayer(true);
    if (same) return;   // clicking the playing card again closes it
    // find the last card in this card's row so the player spans the full row underneath
    const cards = [...document.querySelectorAll('#list > .item')];
    const top = card.offsetTop;
    const rowEnd = cards.filter(c => Math.abs(c.offsetTop - top) < 4).pop() || card;
    const p = document.createElement('section');
    p.className = 'player';
    p.setAttribute('aria-label', `Playing ${item.title}`);
    p.innerHTML = `<div class="player-inner">
      <div class="player-frame">
        <iframe src="https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0&modestbranding=1&playsinline=1"
          title="${esc(item.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"></iframe>
      </div>
      <div class="player-bar">
        <div class="player-text"><div class="player-src">${esc(item.feed_title || '')}</div><div class="player-title">${esc(item.title)}</div></div>
        <a class="btn ghost" href="${esc(safeUrl(item.link))}" target="_blank" rel="noopener noreferrer">Open on YouTube</a>
        <button class="icon-btn player-close" aria-label="Close player"><svg><use href="#i-x"/></svg></button>
      </div>
    </div>`;
    rowEnd.after(p);
    card.classList.add('playing');
    p.querySelector('.player-close').onclick = () => closePlayer();
    requestAnimationFrame(() => requestAnimationFrame(() => p.classList.add('open')));
    setTimeout(() => {
      const r = p.getBoundingClientRect(), head = document.querySelector('header').offsetHeight;
      if (r.top < head || r.bottom > innerHeight) scrollTo({ top: scrollY + r.top - head - 12, behavior: 'smooth' });
    }, 380);
  }

  // ---- confirmation modal ----
  function confirmModal({ title, text, ok = 'Unsubscribe' }) {
    const dlg = $('#confirm');
    $('#cTitle').textContent = title; $('#cText').textContent = text; $('#cOk').textContent = ok;
    dlg.returnValue = '';
    return new Promise(resolve => {
      const onClick = e => { if (e.target === dlg) dlg.close('cancel'); };   // click outside = cancel
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('close', () => { dlg.removeEventListener('click', onClick); resolve(dlg.returnValue === 'ok'); }, { once: true });
      dlg.showModal();
      $('#cOk').focus();
    });
  }

  // ---- unsubscribe (from a card or the feeds panel) ----
  async function unsubscribe(id, name) {
    name = name || 'this feed';
    const ok = await confirmModal({ title: `Unsubscribe from ${name}?`, text: 'Its articles and videos will be removed from your reader. Anything you starred is kept.' });
    if (!ok) return false;
    try {
      await api(`items?feed_id=eq.${id}&starred=is.false`, { method: 'DELETE', prefer: 'return=minimal' });
      await api(`feeds?id=eq.${id}`, { method: 'DELETE', prefer: 'return=minimal' });
    } catch { alertMsg(`Couldn’t unsubscribe from ${name}. Try again.`); return false; }
    feeds = feeds.filter(f => f.id !== id);
    items = items.filter(i => i.feed_id !== id || i.starred);
    if (feedFilter && feedFilter.id === id) clearFeed(); else render();
    refreshCounts(); renderFoot();
    if (!$('#sheet').hidden) renderFeeds();
    return true;
  }
  function alertMsg(m) { const el = $('#sheet').hidden ? null : $('#sheetMsg'); if (el) el.textContent = m; else console.warn(m); }

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => { view = t.dataset.view; scrollTo(0, 0); loadItems().catch(fail); });
  $('#markAll').onclick = async () => {
    if (!confirm('Mark everything as read?')) return;
    await api('items?read=is.false', { method: 'PATCH', body: { read: true }, prefer: 'return=minimal' }).catch(fail);
    loadItems().catch(fail);
  };

  // ---- feeds panel ----
  function openSheet() { $('#sheet').hidden = false; $('#sheetMsg').textContent = ''; loadFeeds().catch(fail); setTimeout(() => $('#newUrl').focus(), 50); }
  function closeSheet() { $('#sheet').hidden = true; loadItems().catch(fail); }
  $('#feedsBtn').onclick = openSheet;
  $('#closeSheet').onclick = closeSheet;
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  let feedQuery = '';
  $('#feedSearch').addEventListener('input', e => { feedQuery = e.target.value.trim().toLowerCase(); renderFeeds(); });

  function renderFeeds() {
    const name = f => f.title || host(f.url);
    const shown = feeds
      .filter(f => !feedQuery || `${name(f)} ${f.url} ${f.feed_url || ''}`.toLowerCase().includes(feedQuery))
      .sort((a, b) => (!!b.last_error - !!a.last_error) || name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }));
    $('#feedSearch').placeholder = `Search your ${feeds.length} feed${feeds.length === 1 ? '' : 's'}`;
    $('#feedSearchWrap').hidden = feeds.length < 6;
    if (!shown.length) { $('#feedList').innerHTML = `<li class="tip" style="padding:12px 0">${feeds.length ? `Nothing matches “${esc(feedQuery)}”.` : 'No feeds yet.'}</li>`; return; }
    $('#feedList').innerHTML = shown.map(f => {
      const status = f.last_error ? `<div class="sub bad">${esc(f.last_error)}</div>`
        : !f.last_fetched ? `<div class="sub">Waiting for first check</div>`
        : `<div class="sub">${f.kind === 'page' ? 'Web page · ' : ''}${esc(host(f.feed_url || f.url))} · checked ${ago(f.last_fetched)} ago</div>`;
      return `<li class="feed-row" data-id="${f.id}">
        <div class="txt"><button class="name" data-show="${f.id}" title="Show only this feed">${esc(f.title || host(f.url))}</button>${status}</div>
        <button class="icon-btn del" aria-label="Remove ${esc(f.title || host(f.url))}" title="Remove"><svg><use href="#i-trash"/></svg></button>
      </li>`;
    }).join('');
  }

  $('#addForm').onsubmit = async e => {
    e.preventDefault();
    let url = $('#newUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { $('#sheetMsg').textContent = 'That doesn’t look like a web address.'; return; }
    try {
      await api('feeds', { method: 'POST', body: { url }, prefer: 'return=minimal' });
      $('#newUrl').value = '';
      $('#sheetMsg').textContent = `Added ${host(url)}. Articles show up within 15 minutes.`;
      loadFeeds();
    } catch (err) {
      $('#sheetMsg').textContent = err.status === 409 ? 'You already follow that one.' : 'Couldn’t add it. Try again.';
    }
  };

  // ---- import: YouTube Takeout subscriptions.csv or OPML ----
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function feedsFromFile(text) {
    const out = [];
    if (/<opml[\s>]/i.test(text)) {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      doc.querySelectorAll('outline[xmlUrl], outline[xmlurl]').forEach(o => {
        const url = o.getAttribute('xmlUrl') || o.getAttribute('xmlurl');
        if (/^https?:\/\//i.test(url)) out.push({ url, title: o.getAttribute('title') || o.getAttribute('text') || null });
      });
      return out;
    }
    // Google Takeout: Channel Id, Channel Url, Channel Title (header wording varies by language)
    for (const r of parseCsv(text)) {
      const id = (r.join(' ').match(/\bUC[\w-]{22}\b/) || [])[0];
      if (id) out.push({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, title: (r[2] || '').trim() || null });
    }
    return out;
  }
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const msg = $('#sheetMsg');
    const found = feedsFromFile(await file.text());
    if (!found.length) { msg.textContent = 'No feeds found in that file. For YouTube, use subscriptions.csv from Google Takeout.'; return; }
    const have = new Set(feeds.map(f => f.url));
    const fresh = [...new Map(found.filter(f => !have.has(f.url)).map(f => [f.url, f])).values()];
    if (!fresh.length) { msg.textContent = `All ${found.length} are already in your list.`; return; }
    msg.textContent = `Adding ${fresh.length}…`;
    try {
      for (let i = 0; i < fresh.length; i += 200) {
        await api('feeds?on_conflict=user_id,url', { method: 'POST', body: fresh.slice(i, i + 200), prefer: 'resolution=ignore-duplicates,return=minimal' });
      }
      const skipped = found.length - fresh.length;
      msg.textContent = `Added ${fresh.length} feed${fresh.length > 1 ? 's' : ''}${skipped ? ` (${skipped} already there)` : ''}. They fill in within 15 minutes.`;
      loadFeeds();
    } catch { msg.textContent = 'Couldn’t import that file. Try again.'; }
  });

  $('#feedList').addEventListener('click', e => {
    const b = e.target.closest('[data-show]'); if (!b) return;
    const f = feeds.find(x => String(x.id) === b.dataset.show);
    $('#sheet').hidden = true; showFeed(f.id, f.title || host(f.url));
  });
  $('#feedList').addEventListener('click', async e => {
    const btn = e.target.closest('.del'); if (!btn) return;
    const f = feeds.find(x => String(x.id) === btn.closest('.feed-row').dataset.id);
    if (f) unsubscribe(f.id, f.title || host(f.url));
  });

  // ---- start ----
  function fail(e) {
    if (e?.message === 'signedout') { showSignIn(); return; }
    console.error(e);
    $('#list').innerHTML = '<div class="empty">Couldn’t load your feeds. Check your connection and refresh.</div>';
  }
  function showSignIn() { $('#boot').hidden = true; $('#app').hidden = true; $('#lock').hidden = false; }

  async function start() {
    if (!/^https?:\/\//.test(BASE) || !KEY || KEY.startsWith('YOUR')) {
      $('#boot').textContent = 'Add your Supabase address and publishable key to config.js.';
      return;
    }
    readRedirect();
    if (!session) return showSignIn();
    try {
      await loadFeeds();
      $('#boot').hidden = true; $('#lock').hidden = true; $('#app').hidden = false;
      await loadItems();
      // keep it fresh while open
      setInterval(() => { if (!document.hidden && $('#sheet').hidden) refreshCounts(); }, 120000);
    } catch (e) { $('#boot').hidden = true; fail(e); }
  }
  start();
})();
