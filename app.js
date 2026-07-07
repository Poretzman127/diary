// ===================== CONFIG =====================
const JSONBIN_BIN_ID = '6a4c45b5da38895dfe382c7c';
const JSONBIN_KEY    = '$2a$10$Suhd6ugh.yjzb8tt/KynCuzQNrHQtw0xZSCQRjrpx9893YzyKheoa';
const JSONBIN_URL    = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

const LS_DATA = 'diary_data';
const LS_LAST = 'diary_lastOpenId';

const CORE_CATEGORIES = ['fun', 'romance', 'friends', 'chaos', 'drama', 'activities'];
const OPTIONAL_CATEGORIES = ['mood', 'productivity', 'energy', 'growth', 'adventure', 'stress', 'love', 'social', 'creativity', 'gratitude'];

// ===================== STATE =====================
let DATA = { _schema: 1, pwHash: null, entries: [], _updated: 0 };
let currentId = null;
let pageDate = null; // ISO YYYY-MM-DD for the currently-displayed entry (staged for new, or actual for saved)
let searchQ = '';
let saveTimer = null;
let pushTimer = null;
let remoteReady = false;

// ===================== UTILS =====================
async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtLongDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}
function fmtShortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ===================== STORAGE (local + remote) =====================
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_DATA);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveLocal() {
  localStorage.setItem(LS_DATA, JSON.stringify(DATA));
}
async function fetchRemote() {
  try {
    const r = await fetch(`${JSONBIN_URL}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY } });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.record ? j.record : null;
  } catch { return null; }
}
async function pushRemote() {
  try {
    const r = await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify(DATA)
    });
    if (r.ok) setStatus('Synced', true);
    else setStatus('Offline (saved locally)');
  } catch {
    setStatus('Offline (saved locally)');
  }
}
function queuePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushRemote(), 500);
}
function mutate() {
  DATA._updated = Date.now();
  saveLocal();
  queuePush();
}

// ===================== GATE =====================
const gate = document.getElementById('gate');
const gateSub = document.getElementById('gate-sub');
const gatePw = document.getElementById('gate-pw');
const gatePw2 = document.getElementById('gate-pw2');
const gateBtn = document.getElementById('gate-btn');
const gateForm = document.getElementById('gate-form');
const gateErr = document.getElementById('gate-err');

function initGate() {
  const hasHash = !!(DATA && DATA.pwHash);
  if (hasHash) {
    gateSub.textContent = 'Enter your password to unlock.';
    gatePw2.style.display = 'none';
    gatePw2.required = false;
    gateBtn.textContent = 'Unlock';
  } else {
    gateSub.textContent = 'Set a password to protect your entries.';
    gatePw2.style.display = 'block';
    gatePw2.required = true;
    gateBtn.textContent = 'Set password';
  }
  setTimeout(() => gatePw.focus(), 50);
}

gateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  gateErr.textContent = '';
  const pw = gatePw.value;
  if (!DATA.pwHash) {
    const pw2 = gatePw2.value;
    if (pw.length < 4) { gateErr.textContent = 'Password must be at least 4 characters.'; return; }
    if (pw !== pw2) { gateErr.textContent = 'Passwords do not match.'; return; }
    DATA.pwHash = await sha256(pw);
    mutate();
    unlock();
    return;
  }
  const h = await sha256(pw);
  if (h !== DATA.pwHash) { gateErr.textContent = 'Wrong password.'; gatePw.select(); return; }
  unlock();
});

function unlock() {
  document.body.classList.remove('locked');
  document.getElementById('app').hidden = false;
  gatePw.value = ''; gatePw2.value = '';
  bootApp();
}
function lock() {
  autoSave(true);
  document.body.classList.add('locked');
  document.getElementById('app').hidden = true;
  initGate();
}

// ===================== BOOT =====================
async function boot() {
  const local = loadLocal();
  if (local) DATA = normalize(local);

  // Kick a remote fetch immediately; wait briefly if we don't have a local hash yet.
  const remotePromise = fetchRemote();
  if (!DATA.pwHash) {
    const remote = await remotePromise;
    if (remote) {
      DATA = normalize(remote);
      saveLocal();
    }
    remoteReady = true;
    initGate();
  } else {
    initGate();
    remotePromise.then(remote => {
      remoteReady = true;
      if (!remote) return;
      const rn = normalize(remote);
      // Last-writer-wins: adopt remote if it's newer.
      if ((rn._updated || 0) > (DATA._updated || 0)) {
        DATA = rn;
        saveLocal();
        if (!document.body.classList.contains('locked')) {
          // Already unlocked → re-render.
          renderList();
          if (currentId && !DATA.entries.some(e => e.id === currentId)) newEntry();
          else if (currentId) openEntry(currentId, true);
        }
      } else if ((DATA._updated || 0) > (remote._updated || 0)) {
        pushRemote();
      }
    });
  }
}
function normalize(bin) {
  const b = bin || {};
  return {
    _schema: 1,
    pwHash: b.pwHash || null,
    entries: Array.isArray(b.entries) ? b.entries : [],
    _updated: b._updated || 0
  };
}

function bootApp() {
  renderList();
  const lastId = localStorage.getItem(LS_LAST);
  if (lastId && DATA.entries.some(e => e.id === lastId)) openEntry(lastId);
  else newEntry();
  wireEvents();
}

function wireEvents() {
  document.getElementById('new-btn').onclick = () => { autoSave(true); newEntry(); closeSide(); };
  document.getElementById('lock-btn').onclick = () => lock();
  document.getElementById('publish-btn').onclick = () => publish();
  document.getElementById('delete-btn').onclick = () => deleteCurrent();
  document.getElementById('side-toggle').onclick = () => document.body.classList.toggle('side-open');

  const search = document.getElementById('search');
  search.oninput = () => { searchQ = search.value.trim().toLowerCase(); renderList(); };

  const body = document.getElementById('entry-body');
  const title = document.getElementById('entry-title');
  body.addEventListener('input', () => queueAutoSave());
  title.addEventListener('input', () => queueAutoSave());

  const picker = document.getElementById('page-date-picker');
  picker.addEventListener('change', () => {
    if (picker.value) changePageDate(picker.value);
  });

  window.addEventListener('beforeunload', () => autoSave(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { autoSave(true); return; }
    // Coming back to tab — refresh from remote (may have edits from another device).
    fetchRemote().then(remote => {
      if (!remote) return;
      const rn = normalize(remote);
      if ((rn._updated || 0) > (DATA._updated || 0)) {
        DATA = rn; saveLocal();
        renderList();
        if (currentId && !DATA.entries.some(e => e.id === currentId)) newEntry();
        else if (currentId) openEntry(currentId, true);
      }
    });
  });
  window.addEventListener('online', () => pushRemote());
}

// ===================== ENTRIES =====================
function findEntry(id) { return DATA.entries.find(e => e.id === id) || null; }

function newEntry() {
  currentId = null;
  pageDate = todayISO();
  localStorage.removeItem(LS_LAST);
  document.getElementById('entry-title').value = '';
  document.getElementById('entry-body').innerHTML = '';
  updateDateUI();
  document.getElementById('delete-btn').hidden = true;
  renderRatings([]);
  setStatus('');
  markPublishState('unsaved');
  renderList();
  document.getElementById('entry-body').focus();
}

function openEntry(id, keepScroll) {
  if (!keepScroll) autoSave(true);
  const e = findEntry(id);
  if (!e) { newEntry(); return; }
  currentId = id;
  pageDate = e.date;
  localStorage.setItem(LS_LAST, id);
  document.getElementById('entry-title').value = e.title || '';
  document.getElementById('entry-body').innerHTML = e.body || '';
  updateDateUI();
  document.getElementById('delete-btn').hidden = false;
  renderRatings(e.extraCats || []);
  applyRatingUI(e.ratings || {});
  setStatus('');
  markPublishState('saved');
  renderList();
  if (!keepScroll) {
    closeSide();
    document.querySelector('.main').scrollTop = 0;
  }
}

function currentPayload() {
  const title = document.getElementById('entry-title').value.trim();
  const body = document.getElementById('entry-body').innerHTML.trim();
  const ratings = collectRatings();
  const extraCats = collectExtraCats();
  return { title, body, ratings, extraCats };
}
function isEmpty(p) {
  return !p.title && !stripHtml(p.body) && Object.keys(p.ratings).length === 0 && (!p.extraCats || p.extraCats.length === 0);
}
function queueAutoSave() {
  markPublishState('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => autoSave(false), 700);
}
function autoSave(final) {
  clearTimeout(saveTimer);
  const p = currentPayload();
  if (isEmpty(p)) return;
  const now = Date.now();
  if (currentId) {
    const i = DATA.entries.findIndex(e => e.id === currentId);
    if (i >= 0) DATA.entries[i] = { ...DATA.entries[i], ...p, updatedAt: now };
  } else {
    const e = {
      id: uid(), date: pageDate || todayISO(),
      title: p.title, body: p.body,
      ratings: p.ratings, extraCats: p.extraCats,
      createdAt: now, updatedAt: now
    };
    DATA.entries.unshift(e);
    currentId = e.id;
    localStorage.setItem(LS_LAST, currentId);
    document.getElementById('delete-btn').hidden = false;
  }
  mutate();
  renderList();
  if (final) markPublishState('saved');
}
function publish() {
  autoSave(true);
  if (!currentId) { setStatus('Nothing to save yet — write something first.'); return; }
  markPublishState('saved');
  setStatus('Saved ✓', true);
  setTimeout(() => setStatus(''), 1600);
}
function deleteCurrent() {
  if (!currentId) return;
  const e = findEntry(currentId);
  if (!e) return;
  const label = e.title || fmtShortDate(e.date);
  if (!confirm(`Delete "${label}"? This can't be undone.`)) return;
  DATA.entries = DATA.entries.filter(x => x.id !== currentId);
  mutate();
  currentId = null;
  localStorage.removeItem(LS_LAST);
  newEntry();
}

// ===================== LIST =====================
function renderList() {
  const el = document.getElementById('entry-list');
  const sorted = [...DATA.entries].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt||0) - (a.createdAt||0));
  let list = sorted;
  if (searchQ) {
    list = list.filter(e => (e.title + ' ' + stripHtml(e.body)).toLowerCase().includes(searchQ));
  }
  if (list.length === 0) {
    el.innerHTML = `<div class="side-list-empty">${searchQ ? 'No matches.' : 'No entries yet.'}</div>`;
    return;
  }
  el.innerHTML = list.map(e => {
    const active = e.id === currentId ? ' active' : '';
    const snip = stripHtml(e.body).slice(0, 60) || (e.title ? '' : 'Empty entry');
    const title = e.title || 'Untitled';
    return `
      <div class="side-item${active}" data-id="${e.id}">
        <div class="side-item-date">${fmtShortDate(e.date)}</div>
        <div class="side-item-title">${escapeHtml(title)}</div>
        <div class="side-item-snippet">${escapeHtml(snip)}</div>
      </div>`;
  }).join('');
  el.querySelectorAll('.side-item').forEach(item => {
    item.onclick = () => openEntry(item.dataset.id);
  });
}

// ===================== RATINGS =====================
let extraCatsForCurrent = [];

function renderRatings(extraCats) {
  extraCatsForCurrent = Array.isArray(extraCats) ? [...extraCats] : [];
  const el = document.getElementById('ratings');
  const cats = [...CORE_CATEGORIES, ...extraCatsForCurrent];
  el.innerHTML = `
    <div class="ratings-title">How was it?</div>
    <div class="rating-rows">
      ${cats.map(cat => ratingRowHtml(cat, !CORE_CATEGORIES.includes(cat))).join('')}
    </div>
    <div class="add-cat-wrap">
      <button class="add-cat-btn" id="add-cat-btn">＋ Add category</button>
      <div class="add-cat-menu" id="add-cat-menu" hidden></div>
    </div>
  `;
  wireRatings();
}
function ratingRowHtml(cat, removable) {
  return `
    <div class="rating-row" data-cat="${cat}">
      <div class="rating-label">
        ${cat}
        ${removable ? `<button class="cat-remove" data-remove="${cat}" title="Remove ${cat}">×</button>` : ''}
      </div>
      <div class="rating-stars">
        ${[1,2,3,4,5].map(n => `<span class="rating-star" data-val="${n}">★</span>`).join('')}
        <span class="rating-star clear" data-val="0" title="Clear rating">✕</span>
      </div>
    </div>`;
}
function wireRatings() {
  document.querySelectorAll('.rating-star').forEach(star => {
    star.onclick = () => {
      const row = star.closest('.rating-row');
      const cat = row.dataset.cat;
      setRating(cat, Number(star.dataset.val));
    };
  });
  document.querySelectorAll('.cat-remove').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const cat = btn.dataset.remove;
      extraCatsForCurrent = extraCatsForCurrent.filter(c => c !== cat);
      const ratings = collectRatings();
      delete ratings[cat];
      renderRatings(extraCatsForCurrent);
      applyRatingUI(ratings);
      queueAutoSave();
    };
  });
  const addBtn = document.getElementById('add-cat-btn');
  const menu = document.getElementById('add-cat-menu');
  addBtn.onclick = () => {
    const avail = OPTIONAL_CATEGORIES.filter(c => !extraCatsForCurrent.includes(c));
    if (avail.length === 0) {
      menu.innerHTML = `<div class="add-cat-empty">All optional categories added.</div>`;
    } else {
      menu.innerHTML = avail.map(c => `<button class="add-cat-item" data-cat="${c}">${c}</button>`).join('');
      menu.querySelectorAll('.add-cat-item').forEach(b => {
        b.onclick = () => {
          const cat = b.dataset.cat;
          if (!extraCatsForCurrent.includes(cat)) extraCatsForCurrent.push(cat);
          const ratings = collectRatings();
          renderRatings(extraCatsForCurrent);
          applyRatingUI(ratings);
          queueAutoSave();
        };
      });
    }
    menu.hidden = !menu.hidden;
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.add-cat-wrap')) menu.hidden = true;
  }, { once: true });
}
function setRating(cat, val) {
  const row = document.querySelector(`.rating-row[data-cat="${cat}"]`);
  if (!row) return;
  row.querySelectorAll('.rating-star:not(.clear)').forEach(s => {
    const v = Number(s.dataset.val);
    s.classList.toggle('on', v <= val && val > 0);
  });
  queueAutoSave();
}
function collectRatings() {
  const out = {};
  document.querySelectorAll('.rating-row').forEach(row => {
    const cat = row.dataset.cat;
    const stars = row.querySelectorAll('.rating-star:not(.clear).on').length;
    if (stars > 0) out[cat] = stars;
  });
  return out;
}
function collectExtraCats() { return [...extraCatsForCurrent]; }
function applyRatingUI(ratings) {
  const cats = [...CORE_CATEGORIES, ...extraCatsForCurrent];
  cats.forEach(cat => setRatingSilent(cat, ratings[cat] || 0));
}
function setRatingSilent(cat, val) {
  const row = document.querySelector(`.rating-row[data-cat="${cat}"]`);
  if (!row) return;
  row.querySelectorAll('.rating-star:not(.clear)').forEach(s => {
    const v = Number(s.dataset.val);
    s.classList.toggle('on', v <= val && val > 0);
  });
}

// ===================== MISC UI =====================
function setStatus(msg, ok) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('ok', !!ok);
}
function markPublishState(state) {
  const btn = document.getElementById('publish-btn');
  btn.classList.toggle('saved', state === 'saved');
  btn.title = state === 'saved' ? 'Saved' : 'Save entry';
}
function closeSide() { document.body.classList.remove('side-open'); }

function updateDateUI() {
  document.getElementById('page-date-label').textContent = fmtLongDate(pageDate || todayISO());
  const picker = document.getElementById('page-date-picker');
  if (picker) picker.value = pageDate || todayISO();
}

function changePageDate(iso) {
  if (!iso || iso === pageDate) return;
  pageDate = iso;
  updateDateUI();
  if (currentId) {
    const i = DATA.entries.findIndex(x => x.id === currentId);
    if (i >= 0) {
      DATA.entries[i].date = iso;
      DATA.entries[i].updatedAt = Date.now();
      mutate();
      renderList();
    }
  } else {
    // Empty new-entry — nothing to persist yet; date will be used when it saves.
    queueAutoSave();
  }
}

// ===================== SW =====================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ===================== INIT =====================
boot();
