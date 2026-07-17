// ===================== CONFIG =====================
const JSONBIN_BIN_ID = '6a4c45b5da38895dfe382c7c';
const JSONBIN_KEY    = '$2a$10$Suhd6ugh.yjzb8tt/KynCuzQNrHQtw0xZSCQRjrpx9893YzyKheoa';
const JSONBIN_URL    = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// Hardcoded users (public repo, plaintext — same tradeoff as workout/baseball).
// Add more users by appending entries: { password, displayName }.
const USERS = {
  MPoretz: { password: 'Baloo123', displayName: 'Max' },
  MPheng: { password: 'Baloournal', displayName: 'Malynn' },
  HBrown: { password: 'HarrysJoint', displayName: 'Harry' }
};

const LS_USER = 'diary_currentUser';
const LS_LAST = 'diary_lastOpenId';
const LS_DATA_PREFIX = 'diary_data:'; // per-user cache, e.g. diary_data:MPoretz

const CORE_CATEGORIES = ['fun', 'romance', 'friends', 'chaos', 'drama', 'activities'];
const OPTIONAL_CATEGORIES = ['mood', 'productivity', 'energy', 'growth', 'adventure', 'stress', 'love', 'social', 'creativity', 'gratitude'];

// ===================== STATE =====================
let CURRENT_USER = null;                                 // e.g. 'MPoretz'
let DATA = { entries: [], _updated: 0 };                 // per-user slice we operate on
let binCache = { _schema: 2 };                           // last-known full bin (for slice-preserving PUTs)
let currentId = null;
let pageDate = null;
let searchQ = '';
let saveTimer = null;
let pushTimer = null;

// ===================== UTILS =====================
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
function lsDataKey(user) { return LS_DATA_PREFIX + user; }

// ===================== BIN SCHEMA / MIGRATION =====================
// v1: { _schema:1, pwHash, entries:[...], _updated }         ← original single-user layout
// v2: { _schema:2, <user>: { entries:[...], _updated }, ... } ← multi-user
function migrateBin(bin) {
  if (!bin || typeof bin !== 'object') return { _schema: 2 };
  if (bin._schema === 2) return bin;
  // Anything else (v1 flat, or empty) → wrap the old entries under MPoretz.
  const migrated = { _schema: 2 };
  if (Array.isArray(bin.entries) && bin.entries.length) {
    migrated.MPoretz = { entries: bin.entries, _updated: bin._updated || Date.now() };
  }
  return migrated;
}
function sliceOf(bin, user) {
  return (bin && bin[user] && typeof bin[user] === 'object')
    ? { entries: Array.isArray(bin[user].entries) ? bin[user].entries : [], _updated: bin[user]._updated || 0 }
    : { entries: [], _updated: 0 };
}

// ===================== STORAGE (local + remote) =====================
function loadLocal(user) {
  try {
    const raw = localStorage.getItem(lsDataKey(user));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function saveLocal() {
  if (!CURRENT_USER) return;
  localStorage.setItem(lsDataKey(CURRENT_USER), JSON.stringify(DATA));
}
async function fetchBin() {
  try {
    const r = await fetch(`${JSONBIN_URL}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY } });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.record ? j.record : null;
  } catch { return null; }
}
async function pushRemote() {
  if (!CURRENT_USER) return;
  try {
    // Fetch latest bin so we don't clobber other users' slices.
    const fresh = migrateBin(await fetchBin() || {});
    fresh[CURRENT_USER] = DATA;
    fresh._schema = 2;
    binCache = fresh;
    const r = await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
      body: JSON.stringify(fresh)
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

// ===================== AUTH =====================
function currentUserMeta() { return CURRENT_USER ? USERS[CURRENT_USER] : null; }

function attemptLogin(username, password) {
  const meta = USERS[username];
  if (!meta) return { ok: false, err: 'Unknown username.' };
  if (meta.password !== password) return { ok: false, err: 'Wrong password.' };
  localStorage.setItem(LS_USER, username);
  return { ok: true };
}
function doLogout() {
  autoSave(true);
  localStorage.removeItem(LS_USER);
  localStorage.removeItem(LS_LAST);
  location.reload();
}

// ===================== GATE =====================
const gate = document.getElementById('gate');
const gateUser = document.getElementById('gate-user');
const gatePw = document.getElementById('gate-pw');
const gateBtn = document.getElementById('gate-btn');
const gateForm = document.getElementById('gate-form');
const gateErr = document.getElementById('gate-err');

function showGate() {
  document.body.classList.add('locked');
  document.getElementById('app').hidden = true;
  setTimeout(() => gateUser.focus(), 50);
}

gateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  gateErr.textContent = '';
  const u = gateUser.value.trim();
  const p = gatePw.value;
  if (!u || !p) { gateErr.textContent = 'Enter a username and password.'; return; }
  const r = attemptLogin(u, p);
  if (!r.ok) {
    gateErr.textContent = r.err;
    gatePw.select();
    return;
  }
  gatePw.value = '';
  location.reload();
});

// ===================== BOOT =====================
async function boot() {
  const stored = localStorage.getItem(LS_USER);
  if (!stored || !USERS[stored]) {
    // Not logged in (or user was removed from USERS).
    if (stored) localStorage.removeItem(LS_USER);
    showGate();
    return;
  }
  CURRENT_USER = stored;

  // Load local first for instant paint.
  const cached = loadLocal(CURRENT_USER);
  if (cached && typeof cached === 'object') {
    DATA = { entries: Array.isArray(cached.entries) ? cached.entries : [], _updated: cached._updated || 0 };
  }

  // Reveal app immediately with local data.
  document.body.classList.remove('locked');
  document.getElementById('app').hidden = false;
  bootApp();

  // Then fetch remote and sync (last-writer-wins per user).
  const remote = await fetchBin();
  if (!remote) return;
  const migrated = migrateBin(remote);
  binCache = migrated;
  const remoteSlice = sliceOf(migrated, CURRENT_USER);
  if ((remoteSlice._updated || 0) > (DATA._updated || 0)) {
    DATA = remoteSlice;
    saveLocal();
    renderList();
    if (currentId && !DATA.entries.some(e => e.id === currentId)) newEntry();
    else if (currentId) openEntry(currentId, true);
  } else if ((DATA._updated || 0) > (remoteSlice._updated || 0)) {
    // Local edits happened before we saw remote — push them up so they land.
    pushRemote();
  }
  // If the raw bin was still v1, migrate it upstream on the next mutation.
  if (remote._schema !== 2) pushRemote();
}

function bootApp() {
  renderUserChip();
  renderList();
  const lastId = localStorage.getItem(LS_LAST);
  if (lastId && DATA.entries.some(e => e.id === lastId)) openEntry(lastId);
  else newEntry();
  wireEvents();
}

function wireEvents() {
  document.getElementById('new-btn').onclick = () => { autoSave(true); newEntry(); closeSide(); };
  document.getElementById('logout-btn').onclick = () => {
    if (confirm(`Log out ${currentUserMeta().displayName || CURRENT_USER}?`)) doLogout();
  };
  document.getElementById('publish-btn').onclick = () => publish();
  document.getElementById('delete-btn').onclick = () => deleteCurrent();
  document.getElementById('side-toggle').onclick = () => document.body.classList.toggle('side-open');
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('side-open')
        && !e.target.closest('.side') && !e.target.closest('.side-toggle')) closeSide();
  });

  const search = document.getElementById('search');
  search.oninput = () => { searchQ = search.value.trim().toLowerCase(); renderList(); };

  const body = document.getElementById('entry-body');
  const title = document.getElementById('entry-title');
  body.addEventListener('input', () => queueAutoSave());
  title.addEventListener('input', () => queueAutoSave());
  document.getElementById('entry-song').addEventListener('input', () => queueAutoSave());

  const picker = document.getElementById('page-date-picker');
  picker.addEventListener('change', () => {
    if (picker.value) changePageDate(picker.value);
  });

  window.addEventListener('beforeunload', () => autoSave(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { autoSave(true); return; }
    // Re-focus: refresh from remote (edits from another device may exist).
    fetchBin().then(remote => {
      if (!remote) return;
      const migrated = migrateBin(remote);
      binCache = migrated;
      const rs = sliceOf(migrated, CURRENT_USER);
      if ((rs._updated || 0) > (DATA._updated || 0)) {
        DATA = rs; saveLocal();
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
  document.getElementById('entry-song').value = '';
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
  document.getElementById('entry-song').value = e.song || '';
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
  const song = document.getElementById('entry-song').value.trim();
  const ratings = collectRatings();
  const extraCats = collectExtraCats();
  return { title, body, song, ratings, extraCats };
}
function isEmpty(p) {
  return !p.title && !stripHtml(p.body) && !p.song && Object.keys(p.ratings).length === 0 && (!p.extraCats || p.extraCats.length === 0);
}
function queueAutoSave() {
  markPublishState('unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => autoSave(false), 700);
}
function autoSave(final) {
  clearTimeout(saveTimer);
  if (!CURRENT_USER) return;
  const p = currentPayload();
  if (isEmpty(p)) return;
  const now = Date.now();
  if (currentId) {
    const i = DATA.entries.findIndex(e => e.id === currentId);
    if (i >= 0) DATA.entries[i] = { ...DATA.entries[i], ...p, updatedAt: now };
  } else {
    const e = {
      id: uid(), date: pageDate || todayISO(),
      title: p.title, body: p.body, song: p.song,
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

function renderUserChip() {
  const el = document.getElementById('side-user');
  if (!el || !CURRENT_USER) return;
  const meta = USERS[CURRENT_USER] || {};
  el.textContent = `Signed in as ${meta.displayName || CURRENT_USER}`;
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
    queueAutoSave();
  }
}

// ===================== SW =====================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ===================== INIT =====================
boot();
