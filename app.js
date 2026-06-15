(function () {
'use strict';
// ── Supabase ──────────────────────────────────────────────────────────────────
// SB_ANON is the public anon key — intentionally client-side visible.
// Security is enforced by Row Level Security (RLS) policies on the DB, not by hiding this key.
// Never put the service_role key here.
const SB_URL  = 'https://wbbfkyzdmpnyiizifijz.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndiYmZreXpkbXBueWlpemlmaWp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NDQ0NTEsImV4cCI6MjA5MjQyMDQ1MX0.vwy06QlB7PcmHn2FXEZ_LBiF_lsa5TRWOgQsnnobFdg';
let sb = null;
try { sb = supabase.createClient(SB_URL, SB_ANON); }
catch(e) { console.warn('Supabase unavailable — offline only:', e.message); }
let sbUser = null;
let _authBusy = false;

// ── Sync badge ────────────────────────────────────────────────────────────────
function setSyncBadge(state, text) {
  const el = document.getElementById('sync-badge');
  el.style.display = '';
  el.className = 'sb-' + state;
  el.textContent = text;
  if (state === 'synced') setTimeout(() => { el.style.display = 'none'; }, 2000);
}

// ── Supabase data sync ────────────────────────────────────────────────────────
async function loadFromSupabase() {
  if (!sbUser) return;
  setSyncBadge('syncing', '◌ syncing...');
  try {
    const uid = sbUser.id;
    const [{ data: prof }, { data: games }, { data: runs }] = await Promise.all([
      sb.from('profiles').select('*').eq('id', uid).maybeSingle(),
      sb.from('games').select('*').eq('user_id', uid),
      sb.from('runs').select('*').eq('user_id', uid),
    ]);
    if (prof) {
      db.profile.name        = prof.name;
      db.profile.avatar      = prof.avatar || null;
      db.profile.bio         = prof.bio    || '';
      db.profile.currentGame = prof.current_game_id || null;
      db.profile.tag         = prof.tag    || null;
      if (!db.settings) db.settings = {};
      if (prof.accent_hue != null) db.settings.accentHue = prof.accent_hue;
      if (prof.accent_sat != null) db.settings.accentSat = prof.accent_sat;
      if (prof.bg_effect)          db.settings.bgEffect  = prof.bg_effect;
    }
    // Prefer game_type from Supabase; fall back to local for games not yet re-saved.
    const _localGameMeta = {};
    db.games.forEach(g => { _localGameMeta[g.id] = g.gameType || null; });

    db.games = (games && games.length) ? games.map(g => ({
      id: g.id, name: g.name, icon: g.icon || null, fields: g.fields || [],
      builds: (g.builds?.list) || [], buildCustomFields: (g.builds?.customFields) || [],
      gameType: g.game_type || _localGameMeta[g.id] || null,
    })) : [];

    // Merge runs logged locally while offline — don't wipe them on sign-in.
    const _remoteIds = new Set((runs || []).map(r => r.id));
    const _unsynced  = db.runs.filter(r => !_remoteIds.has(r.id));
    db.runs = (runs && runs.length) ? runs.map(r => ({ id: r.id, gameId: r.game_id, result: r.result, date: r.date, notes: r.notes || '', comment: r.comment || '', tags: r.tags || [], fields: r.fields || {}, buildId: r.build_id || null })) : [];
    if (_unsynced.length) {
      db.runs.push(..._unsynced);
      _unsynced.forEach(r => syncRun(r));
    }
    save(db);
    setSyncBadge('synced', '✓ synced');
    migrateLegacyImages();
  } catch(e) {
    console.error('loadFromSupabase', e);
    setSyncBadge('error', '✗ sync error');
  }
}

// ── Input limits, sanitization, rate limiting ─────────────────────────────────
const LIMITS = Object.freeze({
  profileName: 64, bio: 500, gameName: 64,
  notes: 2000, comment: 2000, fieldValue: 256, tagLabel: 32, tagCount: 20,
  fieldsPerGame: 20, buildsPerGame: 50, buildCustomFields: 10,
});

function _clamp(s, max) { return typeof s === 'string' ? s.slice(0, max) : ''; }

function _sanitizeProfile(p) {
  const tag = p.tag ? p.tag.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : null;
  return {
    name:        _clamp(p.name || 'PLAYER', LIMITS.profileName),
    bio:         _clamp(p.bio  || '',       LIMITS.bio),
    tag:         (tag && tag.length === 4) ? tag : null,
    currentGame: typeof p.currentGame === 'string' ? p.currentGame : null,
    avatar:      p.avatar || null,
  };
}

function _sanitizeGame(g) {
  return {
    ...g,
    name: _clamp(g.name || '', LIMITS.gameName),
    fields: (Array.isArray(g.fields) ? g.fields : []).slice(0, LIMITS.fieldsPerGame),
    builds: (Array.isArray(g.builds) ? g.builds : []).slice(0, LIMITS.buildsPerGame).map(b => ({
      ...b,
      name:     _clamp(b.name     || '', 64),
      items:    _clamp(b.items    || '', 1000),
      bans:     _clamp(b.bans     || '', 500),
      strategy: _clamp(b.strategy || '', 1000),
    })),
    buildCustomFields: (Array.isArray(g.buildCustomFields) ? g.buildCustomFields : [])
      .slice(0, LIMITS.buildCustomFields),
  };
}

function _sanitizeRun(r) {
  const result  = ['win', 'loss', 'abandoned'].includes(r.result) ? r.result : null;
  const date    = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : null;
  const tags    = (Array.isArray(r.tags) ? r.tags : [])
    .filter(t => typeof t === 'string').map(t => _clamp(t.trim(), LIMITS.tagLabel))
    .filter(Boolean).slice(0, LIMITS.tagCount);
  const fields  = {};
  if (r.fields && typeof r.fields === 'object') {
    Object.entries(r.fields).forEach(([k, v]) => {
      if (typeof k === 'string' && typeof v === 'string')
        fields[k.slice(0, 32)] = _clamp(v, LIMITS.fieldValue);
    });
  }
  return { ...r, result, date, notes: _clamp(r.notes || '', LIMITS.notes),
    comment: _clamp(r.comment || '', LIMITS.comment), tags, fields };
}

class _RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.log = []; }
  allow() {
    const now = Date.now();
    this.log = this.log.filter(t => now - t < this.windowMs);
    if (this.log.length >= this.max) return false;
    this.log.push(now);
    return true;
  }
}
const _syncLimiter = new _RateLimiter(60, 60_000); // 60 writes / minute

async function syncProfile() {
  if (!sbUser || !_syncLimiter.allow()) return;
  const p = _sanitizeProfile(db.profile);
  try {
    await sb.from('profiles').upsert({
      id: sbUser.id,
      name: p.name,
      avatar: p.avatar,
      bio: p.bio,
      current_game_id: p.currentGame || null,
      accent_hue: db.settings?.accentHue ?? 145,
      accent_sat: db.settings?.accentSat ?? 1,
      bg_effect:  db.settings?.bgEffect  || 'none',
      tag: p.tag,
    });
  } catch(e) {
    if (e?.code === '23505') throw Object.assign(e, { _tagConflict: true });
    console.error('syncProfile', e);
  }
}

async function syncGame(game) {
  if (!sbUser || !_syncLimiter.allow()) return;
  const g = _sanitizeGame(game);
  try {
    await sb.from('games').upsert({
      id: g.id, user_id: sbUser.id, name: g.name, icon: g.icon || null, fields: g.fields,
      builds: { list: g.builds, customFields: g.buildCustomFields || [] },
      game_type: game.gameType || null,
    });
  } catch(e) { console.error('syncGame', e); setSyncBadge('error', '✗ game sync failed'); }
}

async function syncRun(run) {
  if (!sbUser || !_syncLimiter.allow()) return;
  const r = _sanitizeRun(run);
  try {
    await sb.from('runs').upsert({
      id: r.id, game_id: r.gameId, user_id: sbUser.id,
      result: r.result, date: r.date, notes: r.notes, comment: r.comment,
      tags: r.tags, fields: r.fields, build_id: r.buildId || null,
    });
  } catch(e) { console.error('syncRun', e); setSyncBadge('error', '✗ run sync failed'); }
}

async function deleteGameFromSb(gameId) {
  if (!sbUser) return;
  try { await sb.from('games').delete().eq('id', gameId).eq('user_id', sbUser.id); }
  catch(e) { console.error('deleteGameFromSb', e); setSyncBadge('error', '✗ delete failed'); }
}

async function deleteRunFromSb(runId) {
  if (!sbUser) return;
  try { await sb.from('runs').delete().eq('id', runId).eq('user_id', sbUser.id); }
  catch(e) { console.error('deleteRunFromSb', e); setSyncBadge('error', '✗ delete failed'); }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
function bindPwToggle(toggleId, inputId) {
  document.getElementById(toggleId).addEventListener('click', function() {
    const inp = document.getElementById(inputId);
    inp.type = inp.type === 'password' ? 'text' : 'password';
    this.classList.toggle('closed', inp.type === 'password');
  });
}

let authMode = 'in'; // 'in' | 'up'

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById('auth-tab-in').classList.toggle('active', mode === 'in');
  document.getElementById('auth-tab-up').classList.toggle('active', mode === 'up');
  document.getElementById('auth-submit-btn').textContent = mode === 'in' ? '[ Sign In ]' : '[ Create Account ]';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-error').style.color = '';
  document.getElementById('confirm-pw-group').style.display = mode === 'up' ? '' : 'none';
  document.getElementById('forgot-pw-btn').style.display   = mode === 'in' ? '' : 'none';
}

document.getElementById('auth-tab-in').addEventListener('click', () => switchAuthTab('in'));
document.getElementById('auth-tab-up').addEventListener('click', () => switchAuthTab('up'));

bindPwToggle('pw-toggle',         'auth-password');
bindPwToggle('pw-toggle-confirm', 'auth-confirm');

// Forgot password
document.getElementById('forgot-pw-btn').addEventListener('click', async () => {
  const email = document.getElementById('auth-email').value.trim();
  const errEl = document.getElementById('auth-error');
  errEl.style.color = '';
  if (!sb) { errEl.textContent = '// supabase unavailable — use offline mode'; return; }
  if (!email) { errEl.textContent = '// enter your email address first'; return; }
  errEl.textContent = '// sending reset link...';
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email);
    if (error) {
      errEl.textContent = '// ' + error.message;
    } else {
      errEl.style.color = 'var(--accent)';
      errEl.textContent = '// reset link sent — check your email';
    }
  } catch(e) { errEl.textContent = '// ' + e.message; }
});

document.getElementById('auth-submit-btn').addEventListener('click', async () => {
  const email   = document.getElementById('auth-email').value.trim();
  const pass    = document.getElementById('auth-password').value;
  const confirm = document.getElementById('auth-confirm').value;
  const errEl   = document.getElementById('auth-error');
  errEl.textContent = ''; errEl.style.color = '';
  if (!sb) { errEl.textContent = '// supabase unavailable — use offline mode'; return; }
  if (!email || !pass) { errEl.textContent = '// email and password required'; return; }
  if (authMode === 'up' && pass !== confirm) { errEl.textContent = '// passwords do not match'; return; }
  const btn = document.getElementById('auth-submit-btn');
  btn.textContent = '[ ... ]'; btn.disabled = true;
  try {
    let result;
    if (authMode === 'in') {
      result = await sb.auth.signInWithPassword({ email, password: pass });
    } else {
      result = await sb.auth.signUp({ email, password: pass });
    }
    if (result.error) {
      errEl.textContent = '// ' + result.error.message;
      btn.textContent = authMode === 'in' ? '[ Sign In ]' : '[ Create Account ]';
      btn.disabled = false;
    } else if (authMode === 'in' && result.data?.session) {
      _authBusy = true;
      errEl.style.color = 'var(--accent)';
      errEl.textContent = '// signed in! welcome back.';
      btn.textContent = '[ ✓ ]';
      setTimeout(async () => {
        sbUser = result.data.session.user;
        await loadFromSupabase();
        closeModal('auth-modal');
        bootUI();
        updateAuthBar();
        renderSidebarProfile();
        renderSidebar();
        if (db.games.length) selectGame(db.games[0].id);
        _authBusy = false;
      }, 900);
    } else if (authMode === 'up' && result.data?.user && !result.data?.session) {
      errEl.style.color = 'var(--accent)';
      errEl.textContent = '// check your email to confirm your account';
      btn.textContent = '[ Create Account ]';
      btn.disabled = false;
    } else {
      btn.textContent = authMode === 'in' ? '[ Sign In ]' : '[ Create Account ]';
      btn.disabled = false;
    }
  } catch(e) {
    errEl.textContent = '// ' + e.message;
    btn.textContent = authMode === 'in' ? '[ Sign In ]' : '[ Create Account ]';
    btn.disabled = false;
  }
});

document.getElementById('auth-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('auth-password').focus();
});
document.getElementById('auth-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (authMode === 'up') document.getElementById('auth-confirm').focus();
    else document.getElementById('auth-submit-btn').click();
  }
});
document.getElementById('auth-confirm').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('auth-submit-btn').click();
});

document.getElementById('auth-skip-btn').addEventListener('click', () => {
  closeModal('auth-modal');
  seedDemo();
  updateAuthBar();
  renderSidebarProfile();
  renderSidebar();
  if (db.games.length) selectGame(db.games[0].id);
});

async function doSignOut() {
  try { if (sb) await sb.auth.signOut(); } catch(e) { console.error('signOut', e); }
  sbUser = null;
  isReadOnly = false;
  _authBusy = false;
  db = defaultDB();
  save(db);
  closeModal('profile-modal');
  updateAuthBar();
  renderSidebarProfile();
  renderSidebar();
  document.getElementById('game-view').style.display = 'none';
  document.getElementById('no-game-selected').style.display = '';
  document.getElementById('auth-email').value = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-confirm').value = '';
  document.getElementById('auth-error').textContent = '';
  document.getElementById('auth-submit-btn').textContent = '[ Sign In ]';
  document.getElementById('auth-submit-btn').disabled = false;
  openModal('auth-modal');
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STORE_KEY = 'rlt_v2';

const GENERIC_FIELDS = [
  { id: 'char',     label: 'Character / Build', type: 'text'   },
  { id: 'diff',     label: 'Difficulty',         type: 'text'   },
  { id: 'floor',    label: 'Stage / Floor',      type: 'text'   },
  { id: 'score',    label: 'Score',              type: 'number' },
  { id: 'duration', label: 'Duration',           type: 'text'   },
  { id: 'seed',     label: 'Seed',               type: 'text'   },
  { id: 'runnum',   label: 'Run #',              type: 'number' },
];

// ── Storage ───────────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || defaultDB(); }
  catch { return defaultDB(); }
}
function defaultDB() { return { profile: { name: 'PLAYER', avatar: null, bio: '', currentGame: null }, games: [], runs: [], settings: { accentHue: 145, accentSat: 1, bgEffect: 'none' } }; }
function save(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  catch { alert('Storage full — try removing images or old runs.'); }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ── App state ─────────────────────────────────────────────────────────────────
let db             = load();
let activeGameId   = null;
let activeFilter   = 'all';
let activeSort     = 'date-desc';
let activeSearch   = '';
let editingRunId   = null;
let editingGameId  = null;
let selectedResult = 'loss';

let pendingGameIcon = undefined;
let pendingAvatar   = undefined;
let pendingRpIcon   = undefined;

let isReadOnly = false;

let modalEnabledGeneric = new Set();
let modalCustomFields   = [];
let modalGenericLabels  = {};

let rpEnabledGeneric = new Set();
let rpCustomFields   = [];
let rpGenericLabels  = {};

let rpBuilds            = [];
let rpBuildCustomFields = [];
let rpExpandedBuildId   = null;

let activeGameView = 'runs';

// ── Image utilities ───────────────────────────────────────────────────────────
function resizeImage(file, maxPx) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h) { if (w > maxPx) { h = h * maxPx / w; w = maxPx; } }
        else        { if (h > maxPx) { w = w * maxPx / h; h = maxPx; } }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.88));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function uploadToStorage(file, storagePath, maxPx) {
  const blob = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > h) { if (w > maxPx) { h = h * maxPx / w; w = maxPx; } }
        else        { if (h > maxPx) { w = w * maxPx / h; h = maxPx; } }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.88);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const { error } = await sb.storage.from('user-media').upload(storagePath, blob, {
    contentType: 'image/jpeg', upsert: true,
  });
  if (error) throw error;
  const url = sb.storage.from('user-media').getPublicUrl(storagePath).data.publicUrl;
  return url + '?t=' + Date.now();
}

async function migrateLegacyImages() {
  if (!sbUser) return;
  let dirty = false;

  if (db.profile.avatar?.startsWith('data:image/')) {
    try {
      const res = await fetch(db.profile.avatar);
      const blob = await res.blob();
      const path = `${sbUser.id}/avatar`;
      const { error } = await sb.storage.from('user-media').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (!error) {
        db.profile.avatar = sb.storage.from('user-media').getPublicUrl(path).data.publicUrl + '?t=' + Date.now();
        dirty = true;
      }
    } catch(e) { console.warn('migrate avatar', e); }
  }

  for (const g of db.games) {
    if (g.icon?.startsWith('data:image/')) {
      try {
        const res = await fetch(g.icon);
        const blob = await res.blob();
        const path = `${sbUser.id}/icons/${g.id}`;
        const { error } = await sb.storage.from('user-media').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
        if (!error) {
          g.icon = sb.storage.from('user-media').getPublicUrl(path).data.publicUrl + '?t=' + Date.now();
          dirty = true;
        }
      } catch(e) { console.warn('migrate icon', g.id, e); }
    }
  }

  const bgVal = localStorage.getItem('rlt_bgimg');
  if (bgVal?.startsWith('data:image/')) {
    try {
      const res = await fetch(bgVal);
      const blob = await res.blob();
      const path = `${sbUser.id}/bg`;
      const { error } = await sb.storage.from('user-media').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      if (!error) {
        const url = sb.storage.from('user-media').getPublicUrl(path).data.publicUrl + '?t=' + Date.now();
        localStorage.setItem('rlt_bgimg', url);
        applyBgImage(url);
        syncBgPreview(url);
      }
    } catch(e) { console.warn('migrate bg', e); }
  }

  if (dirty) {
    save(db);
    syncProfile();
    db.games.forEach(g => syncGame(g));
    renderSidebarProfile();
    renderSidebar();
  }
}

function setImgZone(zone, src) {
  zone.querySelectorAll('img').forEach(i => i.remove());
  if (src && isSafeImgSrc(src)) {
    zone.classList.add('has-image');
    const img = document.createElement('img');
    img.src = src;
    zone.prepend(img);
  } else {
    zone.classList.remove('has-image');
  }
}

// ── Icon rendering ────────────────────────────────────────────────────────────
function applyGameIcon(el, game) {
  el.querySelectorAll('img').forEach(i => i.remove());
  const initial = el.querySelector('.rp-icon-initial') || el.querySelector('span') || el;
  if (game.icon && isSafeImgSrc(game.icon)) {
    const img = document.createElement('img');
    img.src = game.icon;
    el.prepend(img);
    if (initial !== el) initial.style.display = 'none';
  } else {
    if (initial !== el) { initial.style.display = ''; initial.textContent = (game.name || '?')[0].toUpperCase(); }
    else { el.textContent = (game.name || '?')[0].toUpperCase(); }
  }
}

function applyRpIcon(iconSrc, gameName) {
  const zone = document.getElementById('rp-icon-zone');
  const initial = document.getElementById('rp-icon-initial');
  const hover   = zone.querySelector('.rp-icon-hover');
  zone.querySelectorAll('img').forEach(i => i.remove());
  if (iconSrc && isSafeImgSrc(iconSrc)) {
    const img = document.createElement('img');
    img.src = iconSrc;
    zone.insertBefore(img, initial);
    initial.style.display = 'none';
  } else {
    initial.style.display = '';
    initial.textContent = (gameName || '?')[0].toUpperCase();
  }
  if (hover) zone.appendChild(hover);
}

// ── Profile ───────────────────────────────────────────────────────────────────
function renderSidebarProfile() {
  const { name, avatar, bio, currentGame, tag } = db.profile;
  document.getElementById('sidebar-display-name').textContent = (name || 'PLAYER').toUpperCase();
  const tagEl = document.getElementById('sidebar-profile-tag');
  if (tag) { tagEl.textContent = '#' + tag; tagEl.style.display = ''; }
  else tagEl.style.display = 'none';

  const subEl = document.getElementById('sidebar-profile-sub');
  if (currentGame) {
    const game = db.games.find(g => g.id === currentGame);
    if (game) {
      subEl.className = 'profile-sub profile-current-game';
      subEl.textContent = '▶ ' + game.name.toUpperCase();
    } else {
      subEl.className = 'profile-sub';
      subEl.innerHTML = '&gt;&gt; edit_profile';
    }
  } else if (bio) {
    subEl.className = 'profile-sub profile-bio-preview';
    subEl.textContent = bio.length > 24 ? bio.slice(0, 24) + '…' : bio;
  } else {
    subEl.className = 'profile-sub';
    subEl.innerHTML = '&gt;&gt; edit_profile';
  }

  // Avatar
  const wrap    = document.getElementById('sidebar-avatar');
  const initial = document.getElementById('sidebar-avatar-initials');
  wrap.querySelectorAll('img').forEach(i => i.remove());
  if (avatar && isSafeImgSrc(avatar)) {
    const img = document.createElement('img');
    img.src = avatar;
    wrap.prepend(img);
    initial.style.display = 'none';
  } else {
    initial.style.display = '';
    initial.textContent = (name || 'P')[0].toUpperCase();
  }

  // Sidebar stats row
  const totalGames = db.games.length;
  const totalRuns  = db.runs.length;
  const totalWins  = db.runs.filter(r => r.result === 'win').length;
  const wr = totalRuns ? Math.round(totalWins / totalRuns * 100) + '%' : '—';
  document.getElementById('pstat-games').textContent = totalGames;
  document.getElementById('pstat-runs').textContent  = totalRuns;
  document.getElementById('pstat-rate').textContent  = wr;
}

function openProfileModal() {
  pendingAvatar = undefined;
  // Show sign-out and share only when authenticated
  document.getElementById('go-online-btn').style.display    = sbUser ? 'none' : '';
  document.getElementById('signout-btn').style.display      = sbUser ? '' : 'none';
  const _shareBtn = document.getElementById('share-profile-btn');
  _shareBtn.style.display  = sbUser ? '' : 'none';
  _shareBtn.disabled       = false;
  _shareBtn.textContent    = '[ share profile ]';
  _shareBtn.style.color    = '';
  const p = db.profile;
  document.getElementById('pm-name').value = p.name || '';
  document.getElementById('pm-bio').value  = p.bio  || '';
  document.getElementById('pm-tag').value  = p.tag  || '';
  document.getElementById('pm-tag-error').textContent = '';

  const cgSel = document.getElementById('pm-current-game');
  cgSel.innerHTML = '<option value="">// none selected</option>';
  db.games.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name.toUpperCase();
    if (g.id === p.currentGame) opt.selected = true;
    cgSel.appendChild(opt);
  });

  setImgZone(document.getElementById('avatar-upload-zone'), p.avatar);

  // All-time stats
  const totalRuns = db.runs.length;
  const totalWins = db.runs.filter(r => r.result === 'win').length;
  const wr = totalRuns ? Math.round(totalWins / totalRuns * 100) + '%' : '—';
  document.getElementById('pm-stat-games').textContent = db.games.length;
  document.getElementById('pm-stat-runs').textContent  = totalRuns;
  document.getElementById('pm-stat-wins').textContent  = totalWins;
  document.getElementById('pm-stat-rate').textContent  = wr;

  // Favorite game (most runs)
  const favEl = document.getElementById('pm-favorite');
  if (db.games.length) {
    const counts = db.games.map(g => ({ g, n: db.runs.filter(r => r.gameId === g.id).length }));
    counts.sort((a, b) => b.n - a.n);
    const top = counts[0];
    favEl.style.display = 'flex';
    favEl.textContent = top.g.name.toUpperCase() + ' — ' + top.n + ' run' + (top.n !== 1 ? 's' : '');
  } else {
    favEl.style.display = 'none';
  }

  openModal('profile-modal');
}

document.getElementById('edit-profile-btn').addEventListener('click', openProfileModal);

document.getElementById('avatar-upload-zone').addEventListener('click', () =>
  document.getElementById('file-avatar').click());

document.getElementById('file-avatar').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = '';
  if (sbUser) {
    try {
      const url = await uploadToStorage(file, `${sbUser.id}/avatar`, 300);
      pendingAvatar = url;
      setImgZone(document.getElementById('avatar-upload-zone'), url);
      return;
    } catch(err) { console.error('avatar upload', err); }
  }
  const dataUrl = await resizeImage(file, 300);
  pendingAvatar = dataUrl;
  setImgZone(document.getElementById('avatar-upload-zone'), dataUrl);
});

document.getElementById('go-online-btn').addEventListener('click', () => {
  closeModal('profile-modal');
  openModal('auth-modal');
});

document.getElementById('clear-avatar-btn').addEventListener('click', () => {
  pendingAvatar = null;
  setImgZone(document.getElementById('avatar-upload-zone'), null);
});

document.getElementById('save-profile-btn').addEventListener('click', async () => {
  const tagRaw = document.getElementById('pm-tag').value.trim().toUpperCase();
  const tagErr = document.getElementById('pm-tag-error');
  tagErr.textContent = '';
  if (tagRaw && !/^[A-Z0-9]{4}$/.test(tagRaw)) {
    tagErr.textContent = '// 4 letters/digits only';
    return;
  }
  db.profile.name        = document.getElementById('pm-name').value.trim() || 'PLAYER';
  db.profile.bio         = document.getElementById('pm-bio').value.trim();
  db.profile.currentGame = document.getElementById('pm-current-game').value || null;
  if (pendingAvatar !== undefined) db.profile.avatar = pendingAvatar;
  if (tagRaw) db.profile.tag = tagRaw;
  save(db);
  try {
    await syncProfile();
  } catch(e) {
    if (e?._tagConflict) { tagErr.textContent = '// tag taken'; return; }
  }
  renderSidebarProfile();
  closeModal('profile-modal');
});

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('games-list');
  list.innerHTML = '';
  if (!db.games.length) {
    list.innerHTML = '<div class="sidebar-empty"><span>no games yet</span>click [ + add game ]<br>to get started</div>';
    return;
  }
  db.games.forEach(g => {
    const runCount = db.runs.filter(r => r.gameId === g.id).length;
    const el = document.createElement('div');
    el.className = 'game-item' + (g.id === activeGameId ? ' active' : '');

    const thumb = document.createElement('div');
    thumb.className = 'game-thumb';
    if (g.icon) {
      const img = document.createElement('img');
      img.src = g.icon;
      thumb.appendChild(img);
    } else {
      thumb.textContent = (g.name || '?')[0].toUpperCase();
    }

    const meta = document.createElement('div');
    meta.className = 'game-meta';
    meta.innerHTML = `<div class="game-name">${esc(g.name.toUpperCase())}</div><div class="game-count">${runCount} run${runCount !== 1 ? 's' : ''}</div>`;

    const del = document.createElement('button');
    del.className = 'game-del';
    del.title = 'Delete';
    del.textContent = '✕';
    del.addEventListener('click', e => { e.stopPropagation(); promptDeleteGame(g.id); });

    el.append(thumb, meta, del);
    el.addEventListener('click', () => selectGame(g.id));
    list.appendChild(el);
  });
}

// ── Select / render game view ─────────────────────────────────────────────────
function selectGame(id) {
  activeGameId = id;
  activeFilter = 'all';
  activeSort   = 'date-desc';
  activeSearch = '';
  activeGameView = 'runs';
  document.querySelectorAll('.filter-chip').forEach(c =>
    c.classList.toggle('active', c.dataset.filter === 'all'));
  const searchEl = document.getElementById('runs-search');
  if (searchEl) { searchEl.value = ''; }
  const sortEl = document.getElementById('sort-select');
  if (sortEl) sortEl.value = 'date-desc';
  renderSidebar();
  renderGameView();
  renderRightPanel();
}

function renderGameView() {
  const noGame = document.getElementById('no-game-selected');
  const view   = document.getElementById('game-view');

  if (!activeGameId) {
    const hasGames = db.games.length > 0;
    noGame.querySelector('.term-prompt').innerHTML = hasGames
      ? '&gt; NO_GAME_SELECTED<span class="cur"></span>'
      : '&gt; READY<span class="cur"></span>';
    noGame.querySelector('h2').textContent = hasGames ? 'Select a game to begin' : 'No games yet';
    noGame.querySelector('p').textContent  = hasGames
      ? 'choose a game from the sidebar'
      : 'click [ + add game ] in the sidebar to add your first game';
    noGame.style.display = 'flex'; view.style.display = 'none'; return;
  }

  const game = db.games.find(g => g.id === activeGameId);
  if (!game) { activeGameId = null; renderGameView(); return; }

  noGame.style.display = 'none';
  view.style.display   = 'flex';

  // Topbar icon
  const iconEl = document.getElementById('topbar-game-icon');
  iconEl.innerHTML = '';
  if (game.icon) {
    const img = document.createElement('img');
    img.src = game.icon;
    iconEl.appendChild(img);
  } else {
    iconEl.textContent = (game.name || '?')[0].toUpperCase();
  }

  document.getElementById('topbar-title').textContent = game.name.toUpperCase();

  // Sync tab visibility with activeGameView
  document.querySelectorAll('.view-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === activeGameView));
  const filterBar  = document.getElementById('filter-bar');
  const runsArea   = document.getElementById('runs-area');
  const buildsView = document.getElementById('builds-view');
  const isRuns = activeGameView === 'runs';
  filterBar.style.display  = isRuns ? 'flex' : 'none';
  runsArea.style.display   = isRuns ? 'block' : 'none';
  buildsView.style.display = isRuns ? 'none' : 'block';

  updateTopbarWatcher(game.id);
  renderStats(game);
  if (isRuns) renderRuns(game);
  else renderBuildsView(game);
}

// ── Builds view ───────────────────────────────────────────────────────────────
function renderBuildsView(game) {
  const el = document.getElementById('builds-view');
  el.innerHTML = '';
  const builds = game?.builds || [];

  if (!builds.length) {
    el.innerHTML = `
      <div class="bv-no-builds">
        <div class="term-prompt">&gt; NO_BUILDS_FOUND</div>
        <p>add builds in the game settings panel →</p>
      </div>`;
    return;
  }

  const gameRuns = db.runs.filter(r => r.gameId === game.id);

  builds.forEach(build => {
    const buildRuns = gameRuns.filter(r => r.buildId === build.id);
    const card = document.createElement('div');
    card.className = 'bv-card';

    // Header
    const header = document.createElement('div');
    header.className = 'bv-header';
    const nameEl = document.createElement('div');
    nameEl.className = 'bv-name';
    nameEl.textContent = build.name || '(unnamed build)';
    const countEl = document.createElement('div');
    countEl.className = 'bv-run-count';
    countEl.textContent = buildRuns.length + ' run' + (buildRuns.length !== 1 ? 's' : '');
    header.append(nameEl, countEl);
    if (!isReadOnly) {
      const editBuildBtn = document.createElement('button');
      editBuildBtn.className = 'btn btn-ghost btn-sm';
      editBuildBtn.textContent = '[ edit build ]';
      editBuildBtn.addEventListener('click', () => {
        rpExpandedBuildId = build.id;
        renderRightPanel();
        openModal('game-settings-modal');
        requestAnimationFrame(() => {
          const el = document.querySelector(`#rp-builds-list .build-card.open`);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
      header.appendChild(editBuildBtn);
    }
    card.appendChild(header);

    // Build details (items / bans / strategy + custom fields)
    const detailFields = [
      { key: 'items',    label: 'Items' },
      { key: 'bans',     label: 'Bans' },
      { key: 'strategy', label: 'Strategy' },
    ];
    const customFields = game.buildCustomFields || [];
    const hasMeta = detailFields.some(df => build[df.key]) ||
                    customFields.some(cf => (build.custom || {})[cf.id]);
    if (hasMeta) {
      const details = document.createElement('div');
      details.className = 'bv-details';
      detailFields.forEach(df => {
        if (build[df.key]) {
          const pill = document.createElement('span');
          pill.className = 'bv-detail-pill';
          pill.innerHTML = `<strong>${esc(df.label)}:</strong>${esc(build[df.key])}`;
          details.appendChild(pill);
        }
      });
      customFields.forEach(cf => {
        const val = (build.custom || {})[cf.id];
        if (val) {
          const pill = document.createElement('span');
          pill.className = 'bv-detail-pill';
          pill.innerHTML = `<strong>${esc(cf.label)}:</strong>${esc(val)}`;
          details.appendChild(pill);
        }
      });
      card.appendChild(details);
    }

    // Runs list
    const runsList = document.createElement('div');
    runsList.className = 'bv-runs-list';
    if (!buildRuns.length) {
      const empty = document.createElement('div');
      empty.className = 'bv-empty';
      empty.textContent = '> no runs logged with this build yet';
      runsList.appendChild(empty);
    } else {
      [...buildRuns]
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .forEach(run => {
          const row = document.createElement('div');
          row.className = 'bv-run-row';
          const safeResult = /^(win|loss|abandoned)$/.test(run.result) ? run.result : 'loss';
          const badge = document.createElement('span');
          badge.className = `result-badge ${safeResult}`;
          badge.textContent = safeResult.toUpperCase();
          const date = document.createElement('span');
          date.className = 'run-date';
          date.textContent = run.date || '';
          const notes = document.createElement('span');
          notes.className = 'bv-run-notes';
          notes.textContent = run.notes || run.comment || '';
          row.append(badge, date, notes);
          runsList.appendChild(row);
        });
    }
    card.appendChild(runsList);
    el.appendChild(card);
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(game) {
  const { runs, wins, losses, rate } = getGameStats(game.id);

  const sorted = [...runs].sort((a,b) => (b.date||'').localeCompare(a.date||''));
  let curStreak = 0, curType = null;
  for (const r of sorted) {
    if (!curType) { curType = r.result; curStreak = 1; }
    else if (r.result === curType) curStreak++;
    else break;
  }
  const streakLabel = curStreak && curType
    ? `${curStreak}${curType === 'win' ? 'W' : curType === 'loss' ? 'L' : 'Q'}` : '—';

  let bestWin = 0, winRun = 0;
  [...runs].sort((a,b) => (a.date||'').localeCompare(b.date||'')).forEach(r => {
    if (r.result === 'win') { winRun++; if (winRun > bestWin) bestWin = winRun; }
    else winRun = 0;
  });
  const bestLabel = bestWin ? `${bestWin}W` : '—';

  document.getElementById('stat-total').textContent       = runs.length;
  document.getElementById('stat-wins').textContent        = wins;
  document.getElementById('stat-losses').textContent      = losses;
  document.getElementById('stat-winrate').textContent     = rate;
  document.getElementById('stat-streak').textContent      = streakLabel;
  document.getElementById('stat-best-streak').textContent = bestLabel;
}

// ── Runs grid ─────────────────────────────────────────────────────────────────
function renderRuns(game) {
  // Strictly filter to this game's runs only
  let runs = db.runs.filter(r => r.gameId === game.id);

  // Update filter chip counts
  const allCount  = runs.length;
  const winCount  = runs.filter(r => r.result === 'win').length;
  const lossCount = runs.filter(r => r.result === 'loss').length;
  const quitCount = runs.filter(r => r.result === 'abandoned').length;
  document.querySelector('.filter-chip[data-filter="all"]').textContent      = allCount  ? `ALL (${allCount})`   : 'ALL';
  document.querySelector('.filter-chip[data-filter="win"]').textContent      = winCount  ? `WIN (${winCount})`   : 'WIN';
  document.querySelector('.filter-chip[data-filter="loss"]').textContent     = lossCount ? `LOSS (${lossCount})` : 'LOSS';
  document.querySelector('.filter-chip[data-filter="abandoned"]').textContent = quitCount ? `QUIT (${quitCount})` : 'QUIT';

  if (activeFilter !== 'all') runs = runs.filter(r => r.result === activeFilter);
  if (activeSearch) {
    const q = activeSearch.toLowerCase();
    runs = runs.filter(r => [
      r.notes, r.comment, ...(r.tags || []), ...Object.values(r.fields || {})
    ].join(' ').toLowerCase().includes(q));
  }
  if (activeSort === 'date-desc') runs.sort((a,b) => (b.date||'').localeCompare(a.date||''));
  else if (activeSort === 'date-asc') runs.sort((a,b) => (a.date||'').localeCompare(b.date||''));
  else runs.sort((a,b) => (a.result||'').localeCompare(b.result||''));

  const grid  = document.getElementById('runs-grid');
  const empty = document.getElementById('empty-state');
  grid.innerHTML = '';
  if (!runs.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  runs.forEach(run => {
    const fields = game.fields || [];
    const fmap   = run.fields || {};

    const charField = fields.find(f => f.id === 'char');
    const charVal   = charField ? (fmap[charField.id] || '') : '';

    const pills = fields
      .filter(f => f.id !== 'char' && fmap[f.id])
      .map(f => `<span class="detail-pill">${esc(f.label)}: ${esc(fmap[f.id])}</span>`)
      .join('');

    const tags = (run.tags || []).filter(Boolean)
      .map(t => `<span class="detail-pill tag">#${esc(t)}</span>`).join('');

    const card = document.createElement('div');
    const safeResult = /^(win|loss|abandoned)$/.test(run.result) ? run.result : 'loss';
    card.className = `run-card ${safeResult}`;
    card.innerHTML = `
      <div class="run-header">
        <span class="result-badge ${safeResult}">${safeResult.toUpperCase()}</span>
        <span class="run-date">${esc(run.date || '')}</span>
      </div>
      ${charVal ? `<div class="run-char">${esc(charVal)}</div>` : ''}
      <div class="run-details">${pills}${tags}</div>
      ${run.notes ? `<div class="run-notes">${esc(run.notes)}</div>` : ''}
      ${run.comment ? `<div class="run-comment">${esc(run.comment)}</div>` : ''}
      ${!isReadOnly ? `<div class="run-actions"><button class="btn btn-ghost btn-sm edit-run-card-btn">[ edit ]</button><button class="btn btn-ghost btn-sm delete-run-card-btn">[ delete ]</button></div>` : ''}
    `;
    if (!isReadOnly) {
      card.querySelector('.edit-run-card-btn').addEventListener('click', e => {
        e.stopPropagation();
        openRunModal(run.id);
      });
      card.querySelector('.delete-run-card-btn').addEventListener('click', function() {
        if (this.dataset.confirm === '1') {
          db.runs = db.runs.filter(r => r.id !== run.id);
          save(db);
          deleteRunFromSb(run.id);
          renderSidebar();
          renderSidebarProfile();
          renderGameView();
          renderRightPanel();
        } else {
          this.dataset.confirm = '1';
          this.textContent = '[ confirm? ]';
          setTimeout(() => { if (this.dataset.confirm === '1') { this.dataset.confirm = ''; this.textContent = '[ delete ]'; } }, 3000);
        }
      });
    }
    grid.appendChild(card);
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function getGameStats(gameId) {
  const runs   = db.runs.filter(r => r.gameId === gameId);
  const wins   = runs.filter(r => r.result === 'win').length;
  const losses = runs.filter(r => r.result === 'loss').length;
  const rate   = runs.length ? Math.round(wins / runs.length * 100) + '%' : '—';
  return { runs, wins, losses, rate };
}

function renderGenericFieldsList(containerId, enabledSet, labelsObj) {
  const list = document.getElementById(containerId);
  list.innerHTML = '';
  GENERIC_FIELDS.forEach(gf => {
    const row = document.createElement('div');
    row.className = 'field-row';
    const isOn = enabledSet.has(gf.id);
    const cb = document.createElement('button');
    cb.className = 'field-checkbox-btn' + (isOn ? ' on' : '');
    cb.textContent = isOn ? '[✓]' : '[ ]';
    cb.title = isOn ? 'Disable field' : 'Enable field';
    cb.addEventListener('click', () => {
      const nowOn = cb.classList.toggle('on');
      cb.textContent = nowOn ? '[✓]' : '[ ]';
      cb.title = nowOn ? 'Disable field' : 'Enable field';
      if (nowOn) enabledSet.add(gf.id);
      else       enabledSet.delete(gf.id);
    });
    const input = document.createElement('input');
    input.type  = 'text';
    input.value = labelsObj[gf.id] ?? gf.label;
    input.placeholder = gf.label;
    input.title = 'Default: ' + gf.label;
    const reset = document.createElement('button');
    reset.className = 'field-reset-btn';
    reset.textContent = '↺';
    reset.title = 'Reset to default (' + gf.label + ')';
    const updateResetVis = () => {
      const v = input.value.trim();
      reset.style.display = (v && v !== gf.label) ? 'inline-block' : 'none';
    };
    input.addEventListener('input', () => { labelsObj[gf.id] = input.value; updateResetVis(); });
    reset.addEventListener('click', () => {
      input.value = gf.label;
      labelsObj[gf.id] = gf.label;
      updateResetVis();
      input.focus();
    });
    updateResetVis();
    const badge = document.createElement('span');
    badge.className = 'field-type-badge';
    badge.textContent = gf.type;
    row.append(cb, input, reset, badge);
    list.appendChild(row);
  });
}

function renderCustomFieldList(containerId, fieldsArr, onDelete) {
  const list = document.getElementById(containerId);
  list.innerHTML = '';
  fieldsArr.forEach((cf, idx) => {
    const row = document.createElement('div');
    row.className = 'field-row';
    const input = document.createElement('input');
    input.type  = 'text';
    input.value = cf.label;
    input.placeholder = 'field label...';
    input.addEventListener('input', () => { fieldsArr[idx].label = input.value; });
    const del = document.createElement('button');
    del.className = 'field-del-btn';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('click', () => { fieldsArr.splice(idx, 1); onDelete(); });
    row.append(input, del);
    list.appendChild(row);
  });
}

// ── Right Panel ───────────────────────────────────────────────────────────────
function renderRightPanel() {
  const toggleBtn = document.getElementById('open-game-settings-btn');
  if (toggleBtn) toggleBtn.style.display = (activeGameId && !isReadOnly) ? 'inline-flex' : 'none';

  if (!activeGameId) { closeModal('game-settings-modal'); return; }

  const game = db.games.find(g => g.id === activeGameId);
  if (!game) { closeModal('game-settings-modal'); return; }

  pendingRpIcon = undefined;

  // Icon
  applyRpIcon(game.icon, game.name);

  // Name
  document.getElementById('rp-name').value = game.name;

  // Stats (only this game's runs)
  const { runs, wins, losses, rate } = getGameStats(game.id);
  document.getElementById('rp-stat-total').textContent  = runs.length;
  document.getElementById('rp-stat-wins').textContent   = wins;
  document.getElementById('rp-stat-losses').textContent = losses;
  document.getElementById('rp-stat-rate').textContent   = rate;

  // Run fields
  const active = game.fields || [];
  rpEnabledGeneric = new Set(active.filter(f => f.builtin).map(f => f.id));
  rpCustomFields   = active.filter(f => !f.builtin).map(f => ({ ...f }));
  rpGenericLabels  = {};
  active.filter(f => f.builtin).forEach(f => { rpGenericLabels[f.id] = f.label; });

  // Builds
  rpBuilds            = (game.builds || []).map(b => ({ ...b, custom: { ...(b.custom || {}) } }));
  rpBuildCustomFields = (game.buildCustomFields || []).map(f => ({ ...f }));
  rpExpandedBuildId   = null;

  // Game integration
  const gtSel = document.getElementById('rp-game-type');
  gtSel.value = game.gameType || '';
  renderWatcherBlock(game.id, game.gameType || '');

  renderRpFields();
  renderRpBuilds();
}

function renderRpFields() {
  renderGenericFieldsList('rp-generic-list', rpEnabledGeneric, rpGenericLabels);
  renderRpCustomList();
}

function renderRpCustomList() {
  renderCustomFieldList('rp-custom-list', rpCustomFields, renderRpCustomList);
}

function renderRpBuilds() {
  const list = document.getElementById('rp-builds-list');
  list.innerHTML = '';
  rpBuilds.forEach((build, idx) => {
    const card = document.createElement('div');
    card.className = 'build-card' + (build.id === rpExpandedBuildId ? ' open' : '');

    const preview = [build.items, build.bans].filter(Boolean).join(' · ');

    const header = document.createElement('div');
    header.className = 'build-card-header';
    header.innerHTML = `
      <span class="build-card-name">${esc(build.name || 'Unnamed Build')}</span>
      ${preview ? `<span class="build-preview">${esc(preview.slice(0, 40))}</span>` : ''}
    `;

    const delBtn = document.createElement('button');
    delBtn.className = 'build-card-del';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete build';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      rpBuilds.splice(idx, 1);
      if (rpExpandedBuildId === build.id) rpExpandedBuildId = null;
      renderRpBuilds();
    });
    header.appendChild(delBtn);

    const editor = document.createElement('div');
    editor.className = 'build-editor';

    const standardFields = [
      { key: 'name',     label: 'Build Name',    tag: 'input',    placeholder: 'e.g. Shiv Silent, Zeus Rail...' },
      { key: 'items',    label: 'Items / Loadout', tag: 'textarea', placeholder: 'list items, relics, cards...' },
      { key: 'bans',     label: 'Item Bans',      tag: 'input',    placeholder: 'items to avoid...' },
      { key: 'strategy', label: 'Strategy',       tag: 'textarea', placeholder: '// how to pilot this build...' },
    ];

    standardFields.forEach(sf => {
      const grp = document.createElement('div');
      grp.className = 'build-field-group';
      const lbl = document.createElement('div');
      lbl.className = 'build-field-label';
      lbl.textContent = sf.label;
      const inp = document.createElement(sf.tag);
      inp.className = 'build-field-input';
      inp.placeholder = sf.placeholder;
      inp.value = build[sf.key] || '';
      if (sf.tag === 'textarea') { inp.rows = 2; inp.style.minHeight = '48px'; }
      inp.addEventListener('input', () => { rpBuilds[idx][sf.key] = inp.value; });
      grp.append(lbl, inp);
      editor.appendChild(grp);
    });

    // Custom build fields
    rpBuildCustomFields.forEach(cf => {
      const grp = document.createElement('div');
      grp.className = 'build-field-group';
      const lbl = document.createElement('div');
      lbl.className = 'build-field-label';
      lbl.textContent = cf.label;
      const inp = document.createElement('input');
      inp.className = 'build-field-input';
      inp.placeholder = cf.label.toLowerCase() + '...';
      inp.value = (build.custom || {})[cf.id] || '';
      inp.addEventListener('input', () => {
        if (!rpBuilds[idx].custom) rpBuilds[idx].custom = {};
        rpBuilds[idx].custom[cf.id] = inp.value;
      });
      grp.append(lbl, inp);
      editor.appendChild(grp);
    });

    header.addEventListener('click', () => {
      rpExpandedBuildId = build.id === rpExpandedBuildId ? null : build.id;
      renderRpBuilds();
    });

    card.append(header, editor);
    list.appendChild(card);
  });
  renderRpBuildCustomList();
}

function renderRpBuildCustomList() {
  const list = document.getElementById('rp-build-custom-list');
  list.innerHTML = '';
  rpBuildCustomFields.forEach((cf, idx) => {
    const row = document.createElement('div');
    row.className = 'field-row';
    const input = document.createElement('input');
    input.type  = 'text';
    input.value = cf.label;
    input.placeholder = 'field label...';
    input.addEventListener('input', () => { rpBuildCustomFields[idx].label = input.value; });
    const del = document.createElement('button');
    del.className = 'field-del-btn';
    del.textContent = '✕';
    del.addEventListener('click', () => { rpBuildCustomFields.splice(idx, 1); renderRpBuilds(); });
    row.append(input, del);
    list.appendChild(row);
  });
}

document.getElementById('rp-add-build-btn').addEventListener('click', () => {
  const build = { id: uid(), name: '', items: '', bans: '', strategy: '', custom: {} };
  rpBuilds.push(build);
  rpExpandedBuildId = build.id;
  renderRpBuilds();
  // Scroll to new build
  document.getElementById('rp-fields-scroll').scrollTop = 99999;
});

document.getElementById('rp-add-build-field-btn').addEventListener('click', () => {
  rpBuildCustomFields.push({ id: uid(), label: '' });
  renderRpBuildCustomList();
  const inputs = document.getElementById('rp-build-custom-list').querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

function saveRightPanel() {
  if (!activeGameId) return;
  const game = db.games.find(g => g.id === activeGameId);
  if (!game) return;

  const name = document.getElementById('rp-name').value.trim();
  if (!name) { document.getElementById('rp-name').focus(); return; }

  game.name = name;
  if (pendingRpIcon !== undefined) game.icon = pendingRpIcon;

  const fields = [];
  GENERIC_FIELDS.forEach(gf => {
    if (rpEnabledGeneric.has(gf.id)) {
      const custom = (rpGenericLabels[gf.id] || '').trim();
      fields.push({ id: gf.id, label: custom || gf.label, type: gf.type, builtin: true });
    }
  });
  rpCustomFields.filter(cf => cf.label.trim()).forEach(cf =>
    fields.push({ id: cf.id, label: cf.label.trim(), type: 'text', builtin: false }));

  game.fields            = fields;
  game.builds            = rpBuilds.filter(b => b.name.trim());
  game.buildCustomFields = rpBuildCustomFields.filter(f => f.label.trim());
  game.gameType          = document.getElementById('rp-game-type').value || null;
  pendingRpIcon          = undefined;

  save(db);
  syncGame(game);
  renderSidebar();
  renderGameView();
  renderRightPanel();
  renderSidebarProfile();

  closeModal('game-settings-modal');
}

// RP icon click → open file picker
document.getElementById('rp-icon-zone').addEventListener('click', () =>
  document.getElementById('file-rp-icon').click());

document.getElementById('file-rp-icon').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = '';
  if (sbUser && activeGameId) {
    try {
      const url = await uploadToStorage(file, `${sbUser.id}/icons/${activeGameId}`, 256);
      pendingRpIcon = url;
      applyRpIcon(url, document.getElementById('rp-name').value || '?');
      return;
    } catch(err) { console.error('rp icon upload', err); }
  }
  const dataUrl = await resizeImage(file, 256);
  pendingRpIcon = dataUrl;
  applyRpIcon(dataUrl, document.getElementById('rp-name').value || '?');
});

document.getElementById('rp-save-btn').addEventListener('click', saveRightPanel);

document.getElementById('open-game-settings-btn').addEventListener('click', () => {
  if (!activeGameId) return;
  renderRightPanel();
  openModal('game-settings-modal');
});

document.getElementById('rp-delete-btn').addEventListener('click', () =>
  promptDeleteGame(activeGameId));

document.getElementById('rp-add-field-btn').addEventListener('click', () => {
  rpCustomFields.push({ id: uid(), label: '', type: 'text', builtin: false });
  renderRpCustomList();
  const inputs = document.getElementById('rp-custom-list').querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

// ── Game modal ────────────────────────────────────────────────────────────────
function openGameModal(gameId = null) {
  editingGameId   = gameId || uid();
  pendingGameIcon = undefined;
  const game = gameId ? db.games.find(g => g.id === gameId) : null;

  document.getElementById('game-modal-title').textContent      = game ? 'Edit Game' : 'Add Game';
  document.getElementById('gm-name').value                     = game?.name || '';
  document.getElementById('clear-game-icon-btn').style.display = game?.icon ? 'block' : 'none';
  setImgZone(document.getElementById('game-icon-zone'), game?.icon || null);

  const active = game?.fields || [];
  modalEnabledGeneric = new Set(active.filter(f => f.builtin).map(f => f.id));
  if (!game) { modalEnabledGeneric.add('char'); modalEnabledGeneric.add('diff'); modalEnabledGeneric.add('floor'); }
  modalCustomFields = active.filter(f => !f.builtin).map(f => ({ ...f }));
  modalGenericLabels = {};
  active.filter(f => f.builtin).forEach(f => { modalGenericLabels[f.id] = f.label; });

  document.getElementById('gm-game-type').value = game?.gameType || '';
  updateGmPathHint(game?.gameType || '');
  const connectBtn  = document.getElementById('gm-connect-btn');
  const connectHint = document.getElementById('gm-connect-hint');
  const alreadyWatching = game && watchers[game.id]?.active;
  const hasPicker = ('showDirectoryPicker' in window);
  const isMbGame  = game?.gameType === 'megabonk';
  if (alreadyWatching) {
    connectBtn.textContent = isMbGame ? '⬡ Server Connected' : '⬡ Files Connected';
    connectBtn.className   = 'gm-connect-btn connected';
  } else if (!hasPicker && !isMbGame && game?.gameType) {
    connectBtn.textContent = '// watcher requires Brave, Chrome, Edge, or Opera GX';
    connectBtn.className   = 'gm-connect-btn unavailable';
  } else {
    connectBtn.textContent = isMbGame ? '⬡ Test Server Connection' : '⬡ Connect Game Files';
    connectBtn.className   = 'gm-connect-btn';
  }
  connectHint.textContent = '';

  renderFieldsEditor();
  openModal('game-modal');
}

function renderFieldsEditor() {
  renderGenericFieldsList('generic-fields-list', modalEnabledGeneric, modalGenericLabels);
  renderCustomFieldsList();
}

function renderCustomFieldsList() {
  renderCustomFieldList('custom-fields-list', modalCustomFields, renderCustomFieldsList);
}

document.getElementById('add-custom-field-btn').addEventListener('click', () => {
  modalCustomFields.push({ id: uid(), label: '', type: 'text', builtin: false });
  renderCustomFieldsList();
  const inputs = document.getElementById('custom-fields-list').querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

document.getElementById('game-icon-zone').addEventListener('click', () =>
  document.getElementById('file-game-icon').click());

document.getElementById('file-game-icon').addEventListener('change', async e => {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = '';
  if (sbUser) {
    try {
      const url = await uploadToStorage(file, `${sbUser.id}/icons/${editingGameId}`, 256);
      pendingGameIcon = url;
      setImgZone(document.getElementById('game-icon-zone'), url);
      document.getElementById('clear-game-icon-btn').style.display = 'block';
      return;
    } catch(err) { console.error('game icon upload', err); }
  }
  const dataUrl = await resizeImage(file, 256);
  pendingGameIcon = dataUrl;
  setImgZone(document.getElementById('game-icon-zone'), dataUrl);
  document.getElementById('clear-game-icon-btn').style.display = 'block';
});

document.getElementById('clear-game-icon-btn').addEventListener('click', e => {
  e.stopPropagation();
  pendingGameIcon = null;
  setImgZone(document.getElementById('game-icon-zone'), null);
  document.getElementById('clear-game-icon-btn').style.display = 'none';
});

document.getElementById('save-game-btn').addEventListener('click', () => {
  const name = document.getElementById('gm-name').value.trim();
  if (!name) { alert('Game name is required.'); return; }

  const fields = [];
  GENERIC_FIELDS.forEach(gf => {
    if (modalEnabledGeneric.has(gf.id)) {
      const custom = (modalGenericLabels[gf.id] || '').trim();
      fields.push({ id: gf.id, label: custom || gf.label, type: gf.type, builtin: true });
    }
  });
  modalCustomFields.filter(cf => cf.label.trim()).forEach(cf =>
    fields.push({ id: cf.id, label: cf.label.trim(), type: 'text', builtin: false }));

  const gameType = document.getElementById('gm-game-type').value || null;

  let savedGame;
  const existingGame = db.games.find(g => g.id === editingGameId);
  if (existingGame) {
    existingGame.name = name; existingGame.fields = fields; existingGame.gameType = gameType;
    if (pendingGameIcon !== undefined) existingGame.icon = pendingGameIcon;
    savedGame = existingGame;
  } else {
    savedGame = { id: editingGameId, name, icon: pendingGameIcon ?? null, fields, gameType };
    db.games.push(savedGame);
  }
  save(db);
  syncGame(savedGame);
  closeModal('game-modal');
  renderSidebar();
  renderSidebarProfile();
  if (existingGame && editingGameId === activeGameId) { renderGameView(); renderRightPanel(); }
  if (!existingGame) selectGame(savedGame.id);
});

document.getElementById('gm-connect-btn').addEventListener('click', async () => {
  const hint     = document.getElementById('gm-connect-hint');
  const gameType = document.getElementById('gm-game-type').value;
  const btn      = document.getElementById('gm-connect-btn');

  if (!gameType) {
    hint.textContent = '// pick a game type above first';
    document.getElementById('gm-game-type').focus();
    return;
  }

  const name = document.getElementById('gm-name').value.trim();
  if (!name) { alert('Enter a game name first.'); return; }

  const fields = [];
  GENERIC_FIELDS.forEach(gf => {
    if (modalEnabledGeneric.has(gf.id)) {
      const custom = (modalGenericLabels[gf.id] || '').trim();
      fields.push({ id: gf.id, label: custom || gf.label, type: gf.type, builtin: true });
    }
  });
  modalCustomFields.filter(cf => cf.label.trim()).forEach(cf =>
    fields.push({ id: cf.id, label: cf.label.trim(), type: 'text', builtin: false }));

  let targetId = editingGameId;
  const connectExisting = db.games.find(g => g.id === editingGameId);
  if (connectExisting) {
    connectExisting.name = name; connectExisting.fields = fields; connectExisting.gameType = gameType;
    if (pendingGameIcon !== undefined) connectExisting.icon = pendingGameIcon;
    syncGame(connectExisting);
  } else {
    const newGame = { id: editingGameId, name, icon: pendingGameIcon ?? null, fields, gameType };
    db.games.push(newGame);
    targetId = editingGameId;
    syncGame(newGame);
  }
  save(db);

  if (gameType === 'megabonk') {
    hint.textContent = '// testing server connection...';
    try {
      const res  = await fetch('http://localhost:3400/api/megabonk', { cache: 'no-store' });
      const data = await res.json();
      if (data.error) {
        hint.textContent = '// server reached but files not found — launch Megabonk first';
        return;
      }
      if (!watchers[targetId]) watchers[targetId] = {};
      watchers[targetId].gameType = gameType;
      ensureMegabonkKillsField(targetId);
      await startWatcher(targetId);
      btn.textContent = '⬡ Server Connected';
      btn.className   = 'gm-connect-btn connected';
      hint.textContent = '// watching via localhost:3400';
    } catch {
      hint.textContent = '// server not running — start server.ps1 first';
    }
    return;
  }

  if (!('showDirectoryPicker' in window)) {
    hint.textContent = '// file watcher not supported — use Brave, Chrome, Edge, or Opera GX';
    return;
  }
  try {
    hint.textContent = '// opening folder picker...';
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    if (!watchers[targetId]) watchers[targetId] = {};
    watchers[targetId].dirHandle = handle;
    watchers[targetId].gameType  = gameType;
    await saveWatchHandle(targetId, handle);
    await startWatcher(targetId);
    btn.textContent = '⬡ Files Connected';
    btn.className   = 'gm-connect-btn connected';
    const meta = GAME_TYPE_META[gameType] || {};
    hint.textContent = '// watching · ' + (meta.label || gameType);
  } catch(e) {
    if (e.name !== 'AbortError') {
      hint.textContent = e.name === 'SecurityError'
        ? '// blocked — open via localhost:3400, not file://'
        : `// error: ${e.message || e.name}`;
      console.error('gm-connect-btn', e);
    } else {
      hint.textContent = '';
    }
  }
});

function promptDeleteGame(gameId, fromModal = false) {
  const game = db.games.find(g => g.id === gameId);
  if (!game) return;
  const rc = db.runs.filter(r => r.gameId === gameId).length;
  if (!confirm(`DELETE "${game.name}"?${rc ? `\n\n(also deletes ${rc} run${rc !== 1 ? 's' : ''})` : ''}`)) return;
  db.games = db.games.filter(g => g.id !== gameId);
  // Remove only the runs that belong to this game (cascade handled by Supabase FK)
  db.runs  = db.runs.filter(r => r.gameId !== gameId);
  if (db.profile.currentGame === gameId) db.profile.currentGame = null;
  save(db);
  deleteGameFromSb(gameId);
  if (fromModal) closeModal('game-modal');
  if (activeGameId === gameId) activeGameId = db.games[0]?.id || null;
  renderSidebarProfile();
  renderSidebar();
  renderGameView();
  renderRightPanel();
}

// ── Run modal ─────────────────────────────────────────────────────────────────
function openRunModal(runId = null, prefill = {}) {
  if (!activeGameId) return;
  const game = db.games.find(g => g.id === activeGameId);

  const existing = runId ? db.runs.find(r => r.id === runId) : null;
  editingRunId = existing ? existing.id : null;

  document.getElementById('run-modal-title').textContent  = existing ? 'Edit Run' : 'New Run';
  const _delBtn = document.getElementById('delete-run-btn');
  _delBtn.style.display   = existing ? '' : 'none';
  _delBtn.dataset.confirm = '';
  _delBtn.textContent     = 'Delete';
  document.getElementById('rm-date').value    = existing ? (existing.date || today()) : today();
  document.getElementById('rm-notes').value   = existing ? (existing.notes || '') : (prefill.notes || '');
  document.getElementById('rm-comment').value = existing ? (existing.comment || '') : '';
  document.getElementById('rm-tags').value    = existing ? (existing.tags || []).join(', ') : '';

  if (existing) prefill = { result: existing.result, fields: existing.fields || {} };

  // Build selector — show only if the game has saved builds
  const builds = game?.builds || [];
  const buildRow = document.getElementById('rm-build-row');
  const buildSel = document.getElementById('rm-build-select');
  buildRow.style.display = builds.length ? '' : 'none';
  buildSel.innerHTML = '<option value="">// no build selected</option>';
  builds.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || '(unnamed build)';
    buildSel.appendChild(opt);
  });
  buildSel.value = existing ? (existing.buildId || '') : '';

  selectedResult = prefill.result || 'loss';
  document.querySelectorAll('.result-option').forEach(b =>
    b.classList.toggle('selected', b.dataset.val === selectedResult));

  const area   = document.getElementById('run-fields-area');
  const fields = game?.fields || [];
  area.innerHTML = '';

  for (let i = 0; i < fields.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'form-row';
    for (let j = i; j < Math.min(i + 2, fields.length); j++) {
      const f  = fields[j];
      const fg = document.createElement('div');
      fg.className = 'form-group';
      const lbl = document.createElement('label');
      lbl.textContent = f.label;
      const inp = document.createElement('input');
      inp.type  = f.type === 'number' ? 'number' : 'text';
      inp.id    = 'rf-' + f.id;
      inp.placeholder = f.label.toLowerCase() + '...';
      inp.value = (prefill.fields || {})[f.id] || '';
      fg.append(lbl, inp);
      row.appendChild(fg);
    }
    area.appendChild(row);
  }

  openModal('run-modal');
}

document.getElementById('save-run-btn').addEventListener('click', () => {
  const game = db.games.find(g => g.id === activeGameId);
  if (!game) return;

  const fields = {};
  (game?.fields || []).forEach(f => {
    const el = document.getElementById('rf-' + f.id);
    if (el) fields[f.id] = el.value.trim();
  });
  const tags = document.getElementById('rm-tags').value
    .split(',').map(s => s.trim()).filter(Boolean);
  const buildId = document.getElementById('rm-build-select').value || null;

  const runData = {
    gameId:  activeGameId,
    result:  selectedResult,
    date:    document.getElementById('rm-date').value,
    notes:   document.getElementById('rm-notes').value.trim(),
    comment: document.getElementById('rm-comment').value.trim(),
    tags, fields, buildId,
  };

  let savedRun;
  if (editingRunId) {
    const idx = db.runs.findIndex(r => r.id === editingRunId);
    // Preserve gameId — runs never change games
    db.runs[idx] = { ...db.runs[idx], ...runData, gameId: db.runs[idx].gameId };
    savedRun = db.runs[idx];
  } else {
    savedRun = { id: uid(), ...runData };
    db.runs.push(savedRun);
  }
  save(db);
  syncRun(savedRun);
  closeModal('run-modal');
  renderSidebar();
  renderSidebarProfile();
  renderGameView();
  renderRightPanel();
});

document.getElementById('delete-run-btn').addEventListener('click', function() {
  if (this.dataset.confirm === '1') {
    const runId = editingRunId;
    db.runs = db.runs.filter(r => r.id !== runId);
    save(db);
    deleteRunFromSb(runId);
    closeModal('run-modal');
    renderSidebar();
    renderSidebarProfile();
    renderGameView();
    renderRightPanel();
  } else {
    this.dataset.confirm = '1';
    this.textContent = 'Delete — sure?';
    setTimeout(() => { if (this.dataset.confirm === '1') { this.dataset.confirm = ''; this.textContent = 'Delete'; } }, 3000);
  }
});

// Result buttons
document.querySelectorAll('.result-option').forEach(btn =>
  btn.addEventListener('click', () => {
    selectedResult = btn.dataset.val;
    document.querySelectorAll('.result-option').forEach(b =>
      b.classList.toggle('selected', b === btn));
  }));

// View tabs (Runs / Builds)
document.querySelectorAll('.view-tab').forEach(tab =>
  tab.addEventListener('click', () => {
    activeGameView = tab.dataset.view;
    document.querySelectorAll('.view-tab').forEach(t =>
      t.classList.toggle('active', t === tab));
    const filterBar  = document.getElementById('filter-bar');
    const runsArea   = document.getElementById('runs-area');
    const buildsView = document.getElementById('builds-view');
    const isRuns = activeGameView === 'runs';
    filterBar.style.display  = isRuns ? 'flex' : 'none';
    runsArea.style.display   = isRuns ? 'block' : 'none';
    buildsView.style.display = isRuns ? 'none' : 'block';
    if (!isRuns && activeGameId) {
      renderBuildsView(db.games.find(g => g.id === activeGameId));
    }
  }));

// Filters
document.querySelectorAll('.filter-chip').forEach(chip =>
  chip.addEventListener('click', () => {
    activeFilter = chip.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach(c =>
      c.classList.toggle('active', c === chip));
    if (activeGameId) renderRuns(db.games.find(g => g.id === activeGameId));
  }));

document.getElementById('sort-select').addEventListener('change', e => {
  activeSort = e.target.value;
  if (activeGameId) renderRuns(db.games.find(g => g.id === activeGameId));
});

document.getElementById('runs-search').addEventListener('input', e => {
  activeSearch = e.target.value.trim();
  if (activeGameId) renderRuns(db.games.find(g => g.id === activeGameId));
});

// ── Game file integration ─────────────────────────────────────────────────────

const GAME_TYPE_META = {
  hades:    { label: 'Hades',            hint: 'Looks for Profile*.sav — point to your Hades save folder.\nDefault: %USERPROFILE%\\Saved Games\\Hades' },
  hades2:   { label: 'Hades II',         hint: 'Looks for Profile*.sav — point to your Hades II save folder.\nDefault: %USERPROFILE%\\Saved Games\\Hades II' },
  ror2:     { label: 'Risk of Rain 2',   hint: 'Looks for UserProfile.xml — point to your RoR2 UserProfiles folder in Steam userdata.\nDefault: %ProgramFiles(x86)%\\Steam\\userdata\\<steam id>\\632360\\remote\\UserProfiles' },
  sts2:     { label: 'Slay the Spire 2', hint: 'Scans for .run files — point to your STS2 steam saves folder.\nDefault: %APPDATA%\\SlayTheSpire2\\steam\\<your steam id>' },
  megabonk: { label: 'Megabonk',         hint: 'Uses local server — save files are encrypted and in a system folder the browser cannot access.\nRun server.ps1 first: powershell -ExecutionPolicy Bypass -File server.ps1', serverMode: true },
  generic:  { label: 'Generic',          hint: 'Point to your game\'s save folder. Any file change detected here will trigger a run prompt.' },
};

const ROR2_BODY_NAMES = {
  CommandoBody:     'Commando',
  HuntressBody:     'Huntress',
  Bandit2Body:      'Bandit',
  ToolbotBody:      'MUL-T',
  EngiBody:         'Engineer',
  MageBody:         'Artificer',
  MercBody:         'Mercenary',
  TreebotBody:      'REX',
  LoaderBody:       'Loader',
  CrocoBody:        'Acrid',
  CaptainBody:      'Captain',
  RailgunnerBody:   'Railgunner',
  VoidSurvivorBody: 'Void Fiend',
  SeekerBody:       'Seeker',
  FalseSonBody:     'False Son',
  ChefBody:         'Chef',
};

const watchers = {}; // gameId → { dirHandle, gameType, lastState, interval, active }

// ── IndexedDB handle persistence ──────────────────────────────────────────────
function openWatcherDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rte_watchers', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = () => reject(req.error);
  });
}

async function saveWatchHandle(gameId, handle) {
  const db = await openWatcherDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, gameId);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadWatchHandle(gameId) {
  const idb = await openWatcherDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get(gameId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

// ── Per-game file readers ──────────────────────────────────────────────────────
async function readGameState(dirHandle, gameType) {
  try {
    if (gameType === 'hades')  return await readHadesState(dirHandle);
    if (gameType === 'hades2') return await readHades2State(dirHandle);
    if (gameType === 'ror2')     return await readRoR2State(dirHandle);
    if (gameType === 'sts2')     return await readSTS2State(dirHandle);
    if (gameType === 'megabonk') return await readMegabonkState();
    if (gameType === 'generic')  return await readGenericState(dirHandle);
  } catch(e) { /* permission denied or file not found */ return { found: false, reason: 'error' }; }
  return { found: false, reason: 'error' };
}

async function readHadesState(dirHandle) {
  let savMtime = 0, hasTempFile = false, savName = null;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    if (/^Profile\d+\.sav$/i.test(name)) {
      const f = await handle.getFile();
      if (f.lastModified > savMtime) { savMtime = f.lastModified; savName = name; }
    }
    if (/Profile\d+_Temp\.sav/i.test(name)) hasTempFile = true;
  }
  return {
    found: savMtime > 0, reason: savMtime > 0 ? null : 'nofile',
    fileName: savName,
    detail: savMtime > 0 ? 'updated ' + timeAgo(savMtime) : null,
    savMtime, hasTempFile,
  };
}

// Hades 2 weapon IDs found in the binary save file (Lua-serialised strings)
const HADES2_WEAPONS = {
  WeaponStaff:   "Witch's Staff",
  WeaponDagger:  'Sister Blades',
  WeaponAxe:     'Moonstone Axe',
  WeaponTorch:   'Umbral Flames',
  WeaponSkull:   'Argent Skull',
  WeaponSpear:   'Nocturnal Arms',
};

async function extractHades2Weapon(file) {
  // Scan up to 2 MB of the binary save for ASCII weapon ID strings.
  // Keys/strings in the Lua-binary format appear as raw UTF-8, so a simple
  // indexOf search on a latin-1 decoded buffer is sufficient.
  try {
    const buf  = await file.slice(0, 2 * 1024 * 1024).arrayBuffer();
    const text = new TextDecoder('latin1').decode(buf);
    for (const [id, name] of Object.entries(HADES2_WEAPONS)) {
      if (text.includes(id)) return name;
    }
  } catch { /* ignore — can't read binary */ }
  return null;
}

async function readHades2State(dirHandle) {
  let savMtime = 0, hasTempFile = false, weapon = null, savName = null;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    if (/^Profile\d+\.sav$/i.test(name)) {
      const f = await handle.getFile();
      if (f.lastModified > savMtime) {
        savMtime = f.lastModified;
        savName = name;
        weapon = await extractHades2Weapon(f);
      }
    }
    if (/Profile\d+_Temp\.sav/i.test(name)) hasTempFile = true;
  }
  return {
    found: savMtime > 0, reason: savMtime > 0 ? null : 'nofile',
    fileName: savName,
    detail: savMtime > 0 ? ((weapon ? weapon + ' · ' : '') + 'updated ' + timeAgo(savMtime)) : null,
    savMtime, hasTempFile, weapon,
  };
}

async function readRoR2State(dirHandle) {
  // Try to find a UserProfile.xml in this dir or one level down
  async function findXml(dir, depth = 0) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && name.toLowerCase().endsWith('.xml')) {
        return { text: await (await handle.getFile()).text(), name };
      }
      if (handle.kind === 'directory' && depth < 2) {
        const found = await findXml(handle, depth + 1).catch(() => null);
        if (found) return found;
      }
    }
    return null;
  }
  const res = await findXml(dirHandle);
  if (!res) return { found: false, reason: 'nofile' };
  const xml = res.text;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const n = tag => {
    const el = doc.querySelector(tag) || doc.querySelector(`fields ${tag}`);
    return el ? (parseFloat(el.textContent) || 0) : 0;
  };
  const s = tag => {
    const el = doc.querySelector(tag);
    return el ? el.textContent.trim() : '';
  };
  // Several XML paths that different RoR2 versions use for last-played survivor
  const lastBody = s('lastSeenSurvivorBodyName') || s('selectedBodyName') || s('lastBodyName') || s('preferredSurvivorBodyName') || '';
  const runsFinished = n('totalRunsFinished');
  return {
    found: true, reason: null,
    fileName: res.name,
    detail: `${runsFinished} run${runsFinished !== 1 ? 's' : ''}` + (lastBody ? ' · last: ' + lastBody : ''),
    runsFinished,
    deaths:       n('totalDeaths'),
    // Cumulative counters — delta between reads gives per-run values
    totalStages:  n('totalStagesCompleted'),
    totalKills:   n('totalKills') || n('totalMonstersKilled') || n('totalKillCount'),
    lastBody,
  };
}

async function readSTS2State(dirHandle) {
  let latestMtime = 0, runCount = 0, latestHandle = null, latestName = null;
  async function scanForRuns(dir, depth = 0) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && name.endsWith('.run')) {
        const f = await handle.getFile();
        runCount++;
        if (f.lastModified > latestMtime) { latestMtime = f.lastModified; latestHandle = handle; latestName = name; }
      }
      if (handle.kind === 'directory' && depth < 3) {
        await scanForRuns(handle, depth + 1).catch(() => {});
      }
    }
  }
  await scanForRuns(dirHandle);
  let lastRun = null;
  if (latestHandle) {
    try {
      const text = await (await latestHandle.getFile()).text();
      lastRun = JSON.parse(text);
    } catch { lastRun = null; }
  }
  return {
    found: runCount > 0, reason: runCount > 0 ? null : 'nofile',
    fileName: latestName,
    detail: runCount > 0 ? `${runCount} run file${runCount !== 1 ? 's' : ''} · latest ${timeAgo(latestMtime)}` : null,
    latestMtime, runCount, lastRun,
  };
}

async function readMegabonkState() {
  try {
    const res = await fetch('http://localhost:3400/api/megabonk', { cache: 'no-store' });
    if (!res.ok) return { found: false, reason: 'server' };
    const d = await res.json();
    if (d.error) return { found: false, reason: 'nofile' };
    return {
      found: true, reason: null,
      fileName: 'stats.json',
      detail: 'updated ' + timeAgo(d.statsMtime),
      statsSize:  d.statsSize,
      statsMtime: d.statsMtime,
      progSize:   d.progSize,
    };
  } catch { return { found: false, reason: 'server' }; }
}

async function getMegabonkKillsFromOCR() {
  try {
    const res = await fetch('http://localhost:3400/api/megabonk/ocr', { cache: 'no-store' });
    if (!res.ok) return null;
    const d = await res.json();
    if (d.kills != null) console.log('[megabonk/ocr] kills detected:', d.kills, '| raw text:', d.ocrText);
    else console.log('[megabonk/ocr] no kills parsed | raw text:', d.ocrText, '| error:', d.error);
    return d.kills ?? null;
  } catch { return null; }
}

async function readGenericState(dirHandle) {
  let latestMtime = 0, count = 0, latestName = null;
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    count++;
    const f = await handle.getFile();
    if (f.lastModified > latestMtime) { latestMtime = f.lastModified; latestName = name; }
  }
  return {
    found: count > 0, reason: count > 0 ? null : 'nofile',
    fileName: latestName,
    detail: count > 0 ? `${count} file${count !== 1 ? 's' : ''} · newest ${timeAgo(latestMtime)}` : null,
    latestMtime,
  };
}

// Format seconds → "MM:SS" (or "H:MM:SS" if ≥ 1h)
function fmtDuration(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// Human-readable "x ago" from an epoch-ms timestamp
function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5)  return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

// Did the watched save actually change between two reads? (mtime/size/counter moved)
function _watcherStateChanged(gameType, prev, curr) {
  if (!prev || !curr) return false;
  switch (gameType) {
    case 'hades': case 'hades2': return curr.savMtime  !== prev.savMtime;
    case 'sts2':                 return curr.latestMtime !== prev.latestMtime || curr.runCount !== prev.runCount;
    case 'megabonk':             return curr.statsMtime !== prev.statsMtime || curr.statsSize !== prev.statsSize;
    case 'ror2':                 return curr.runsFinished !== prev.runsFinished || curr.totalStages !== prev.totalStages || curr.totalKills !== prev.totalKills;
    case 'generic':              return curr.latestMtime !== prev.latestMtime;
    default:                     return false;
  }
}

// ── Run-end detection (state delta) ───────────────────────────────────────────
function detectRunEnd(gameType, prev, curr) {
  if (!prev || !curr) return null;

  if (gameType === 'hades') {
    // Temp save vanished + main save updated → run ended (died or escaped)
    if (prev.hasTempFile && !curr.hasTempFile && curr.savMtime !== prev.savMtime)
      return { result: null };  // binary save — can't determine win/loss
    // Fallback: save updated while never in a run (short runs may miss temp file)
    if (!prev.hasTempFile && !curr.hasTempFile && curr.savMtime !== prev.savMtime)
      return { result: null };
    return null;
  }

  if (gameType === 'hades2') {
    // Only trigger when temp file disappears — avoids false positives from menu autosaves
    if (prev.hasTempFile && !curr.hasTempFile && curr.savMtime !== prev.savMtime) {
      const fields = {};
      if (curr.weapon) fields.char = curr.weapon;
      return { result: null, fields };  // binary save — can't determine win/loss
    }
    return null;
  }

  if (gameType === 'ror2') {
    const survivor = ROR2_BODY_NAMES[curr.lastBody] || (curr.lastBody ? curr.lastBody.replace(/Body$/, '') : null);
    const fields = {};
    if (survivor) fields.char = survivor;
    // Use cumulative stat deltas for per-run values (highestStagesCompleted is all-time best, not useful)
    const stagesDelta = curr.totalStages - prev.totalStages;
    const killsDelta  = curr.totalKills  - prev.totalKills;
    if (stagesDelta > 0) fields.floor = String(stagesDelta);
    if (killsDelta  > 0) fields.score = String(killsDelta);
    if (curr.runsFinished > prev.runsFinished) return { result: 'win',  fields };
    if (curr.deaths       > prev.deaths)       return { result: 'loss', fields };
    return null;
  }

  if (gameType === 'sts2') {
    if (curr.runCount > prev.runCount || curr.latestMtime !== prev.latestMtime) {
      const r = curr.lastRun;
      const result = r?.victory === true ? 'win' : r?.victory === false ? 'loss' : null;
      const fields = {};
      if (r?.character_chosen) fields.char = r.character_chosen.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (r?.floor_reached   != null) fields.floor = String(r.floor_reached);
      if (r?.ascension_level != null) fields.diff  = 'Ascension ' + r.ascension_level;
      if (r?.score           != null) fields.score = String(r.score);
      return { result, fields };
    }
    return null;
  }

  if (gameType === 'megabonk') {
    // Detect any write to stats.json (size OR mtime changed) → run ended (death)
    // stats.json is encrypted; kill data unavailable — duration is captured by the watcher timer
    const changed = curr.statsSize !== prev?.statsSize || curr.statsMtime !== prev?.statsMtime;
    if (!curr.statsSize || !changed) return null;
    return { result: null, fields: {} };
  }

  if (gameType === 'generic') {
    if (curr.latestMtime !== prev.latestMtime) return { result: null };
    return null;
  }

  return null;
}

// Returns true when a run-start signal is detected (used to auto-trigger the in-progress indicator)
function detectRunStart(gameType, prev, curr) {
  if (!prev || !curr) return false;
  // Hades/II: temp save appearing = entered a run
  if (gameType === 'hades' || gameType === 'hades2')
    return !prev.hasTempFile && curr.hasTempFile;
  return false;
}

// ── Run-in-progress tracker ────────────────────────────────────────────────────
let _runTimerInterval = null;

function startRunInProgress(gameId) {
  const w = watchers[gameId];
  if (!w) return;
  w.runInProgress  = true;
  w.runStartTime   = Date.now();
  clearInterval(_runTimerInterval);
  _runTimerInterval = setInterval(() => updateTopbarRunBtn(gameId), 1000);
  updateTopbarRunBtn(gameId);
  _showRunStartedFlash();
}

function _showRunStartedFlash() {
  const flash = document.getElementById('run-started-flash');
  if (!flash) return;
  flash.style.animation = 'none';
  flash.style.display   = 'flex';
  void flash.offsetWidth;
  flash.style.animation = 'flash-slide-in 0.25s ease';
  clearTimeout(flash._t);
  flash._t = setTimeout(() => {
    flash.style.animation = 'flash-slide-out 0.35s ease forwards';
    flash._t2 = setTimeout(() => { flash.style.display = 'none'; flash.style.animation = ''; }, 350);
  }, 2200);
}

function stopRunInProgress(gameId) {
  const w = watchers[gameId];
  if (w) { w.runInProgress = false; w.runStartTime = null; }
  clearInterval(_runTimerInterval);
  _runTimerInterval = null;
  updateTopbarRunBtn(gameId);
}

function updateTopbarRunBtn(gameId) {
  const btn    = document.getElementById('topbar-run-btn');
  const dot    = document.getElementById('topbar-run-dot');
  const label  = document.getElementById('topbar-run-label');
  const banner = document.getElementById('run-live-banner');
  const prompt = document.getElementById('run-start-prompt');
  if (!btn) return;
  const w    = watchers[gameId];
  const game = db.games.find(g => g.id === gameId);
  // Only show when watcher is active and game has a type
  if (!w?.active || !game?.gameType || isReadOnly) {
    btn.style.display    = 'none';
    banner.style.display = 'none';
    if (prompt) prompt.style.display = 'none';
    return;
  }
  btn.style.display = 'flex';
  if (w.runInProgress && w.runStartTime) {
    const elapsed = Math.floor((Date.now() - w.runStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const fmt = `${m}:${String(s).padStart(2,'0')}`;
    dot.className      = 'run-indicator-dot active';
    label.textContent  = `■ ${fmt}`;
    btn.classList.add('active');
    btn.title = 'Run in progress — click to end';
    banner.style.display = 'flex';
    document.getElementById('rlb-timer').textContent = fmt;
    document.getElementById('rlb-game').textContent  = '// ' + (game.name || '').toUpperCase();
    if (prompt) prompt.style.display = 'none';
  } else {
    dot.className      = 'run-indicator-dot';
    label.textContent  = '▶ run';
    btn.classList.remove('active');
    btn.title = 'Track current run — click to start';
    banner.style.display = 'none';
    if (prompt) {
      prompt.style.display = 'flex';
      const rspGame = document.getElementById('rsp-game');
      if (rspGame) rspGame.textContent = '// ' + (game.name || '').toUpperCase();
    }
  }
}

document.getElementById('topbar-run-btn').addEventListener('click', () => {
  if (!activeGameId) return;
  const w = watchers[activeGameId];
  if (!w?.active) return;
  if (w.runInProgress) stopRunInProgress(activeGameId);
  else startRunInProgress(activeGameId);
});

document.getElementById('rlb-end-btn').addEventListener('click', () => {
  if (activeGameId) stopRunInProgress(activeGameId);
});

document.getElementById('rsp-start-btn').addEventListener('click', () => {
  if (!activeGameId) return;
  const w = watchers[activeGameId];
  if (!w?.active || w.runInProgress) return;
  startRunInProgress(activeGameId);
});

// ── Toast ──────────────────────────────────────────────────────────────────────
let pendingAutoRun = null;
let toastDismissTimer = null;

function showRunToast(gameId, detected) {
  pendingAutoRun = { gameId, ...detected };
  const meta = GAME_TYPE_META[db.games.find(g => g.id === gameId)?.gameType] || {};
  document.getElementById('auto-run-toast-title').textContent =
    '> RUN_DETECTED' + (meta.label ? ' [' + meta.label.toUpperCase() + ']' : '');
  const f = detected.fields || {};
  const extras = [
    f.char     ? f.char                  : null,
    f.floor    ? 'lvl ' + f.floor        : null,
    f.duration ? f.duration              : null,
    f.score    ? f.score + ' kills'      : null,
  ].filter(Boolean).join(' · ');
  document.getElementById('auto-run-toast-sub').textContent =
    (detected.result ? 'result: ' + detected.result.toUpperCase() : 'result unknown — set manually')
    + (extras ? '  //  ' + extras : '');
  document.getElementById('auto-run-toast').style.display = 'flex';
  clearTimeout(toastDismissTimer);
  toastDismissTimer = setTimeout(dismissRunToast, 18000);
}

function dismissRunToast() {
  document.getElementById('auto-run-toast').style.display = 'none';
  pendingAutoRun = null;
  clearTimeout(toastDismissTimer);
}

document.getElementById('auto-run-quick-btn').addEventListener('click', () => {
  if (!pendingAutoRun) return;
  const { gameId, result, fields } = pendingAutoRun;
  dismissRunToast();
  if (gameId !== activeGameId) selectGame(gameId);
  const run = { id: uid(), gameId, result: result || null, date: today(), notes: '', comment: '', tags: [], fields: fields || {}, buildId: null };
  db.runs.push(run);
  save(db);
  syncRun(run);
  renderSidebar();
  renderSidebarProfile();
  renderGameView();
});

document.getElementById('auto-run-log-btn').addEventListener('click', () => {
  if (!pendingAutoRun) return;
  const { gameId, result, fields } = pendingAutoRun;
  dismissRunToast();
  if (gameId !== activeGameId) selectGame(gameId);
  openRunModal(null, { result, fields });
});

document.getElementById('auto-run-dismiss-btn').addEventListener('click', dismissRunToast);

// ── Watcher engine ─────────────────────────────────────────────────────────────
async function startWatcher(gameId) {
  const w = watchers[gameId];
  const isMegabonk = w?.gameType === 'megabonk';
  if (!w?.gameType) return;
  if (!isMegabonk && !w?.dirHandle) return;
  stopWatcher(gameId);
  w.lastState     = await readGameState(w.dirHandle, w.gameType);
  w.active        = true;
  w.lastReadAt    = Date.now();
  w.foundFiles    = !!w.lastState?.found;
  w.notFoundReason = w.lastState?.found ? null : (w.lastState?.reason || 'nofile');
  w.lastFileName  = w.lastState?.fileName || null;
  w.lastDetail    = w.lastState?.detail || null;
  w.lastChangeAt  = null;
  renderWatcherBlock(gameId, w.gameType);
  if (gameId === activeGameId) updateTopbarWatcher(gameId);
  w.interval = setInterval(async () => {
    try {
      if (!isMegabonk) {
        const perm = await w.dirHandle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') { stopWatcher(gameId); renderWatcherBlock(gameId, w.gameType); if (gameId === activeGameId) updateTopbarWatcher(gameId); return; }
      }
      const curr = await readGameState(w.dirHandle, w.gameType);
      w.lastReadAt = Date.now();

      // Files not found this tick → surface the warning state, skip detection.
      if (!curr || !curr.found) {
        w.foundFiles = false;
        w.notFoundReason = curr?.reason || 'nofile';
        renderWatcherBlock(gameId, w.gameType);
        if (gameId === activeGameId) updateTopbarWatcher(gameId);
        return;
      }

      const prevFound = !!w.lastState?.found;
      // Flash "save updated" when the file actually changed between two good reads.
      if (prevFound && _watcherStateChanged(w.gameType, w.lastState, curr)) w.lastChangeAt = Date.now();
      w.foundFiles    = true;
      w.notFoundReason = null;
      w.lastFileName  = curr.fileName || null;
      w.lastDetail    = curr.detail || null;

      // Only run run-detection when both reads located the save (avoids spurious deltas).
      const hit = prevFound ? detectRunEnd(w.gameType, w.lastState, curr) : null;
      if (hit) {
        // Megabonk: attach run duration before clearing the timer
        if (isMegabonk && w.runStartTime) {
          const durSec = Math.round((Date.now() - w.runStartTime) / 1000);
          if (durSec >= 10) {
            if (!hit.fields) hit.fields = {};
            hit.fields.duration = fmtDuration(durSec);
          }
        }
        // Megabonk: OCR the death screen for kill count before showing toast
        if (isMegabonk) {
          const kills = await getMegabonkKillsFromOCR();
          if (kills != null) {
            if (!hit.fields) hit.fields = {};
            hit.fields.score = String(kills);
          }
        }
        stopRunInProgress(gameId);
        showRunToast(gameId, hit);
      } else if (prevFound && !w.runInProgress && detectRunStart(w.gameType, w.lastState, curr)) {
        startRunInProgress(gameId);
      }
      w.lastState = curr;
      // Refresh status line each tick (filename / proof / heartbeat / change-flash).
      renderWatcherBlock(gameId, w.gameType);
      if (gameId === activeGameId) updateTopbarWatcher(gameId);
    } catch(e) { console.error('watcher tick', e); }
  }, 3000);
}

function stopWatcher(gameId) {
  const w = watchers[gameId];
  if (!w) return;
  clearInterval(w.interval);
  w.interval = null;
  w.active = false;
  stopRunInProgress(gameId);
}

// ── Topbar watcher pill ────────────────────────────────────────────────────────
function updateTopbarWatcher(gameId) {
  const btn   = document.getElementById('topbar-watch-btn');
  const dot   = document.getElementById('topbar-watcher-dot');
  const label = document.getElementById('topbar-watcher-label');
  if (!btn) return;
  const game = db.games.find(g => g.id === gameId);
  if (!game?.gameType || isReadOnly) { btn.style.display = 'none'; return; }
  if (game.gameType !== 'megabonk' && !('showDirectoryPicker' in window)) { btn.style.display = 'none'; return; }
  btn.style.display = 'flex';
  const w = watchers[gameId];
  if (w?.active && w.foundFiles) {
    dot.className   = 'watcher-dot active';
    label.textContent = 'watching';
    btn.classList.add('active');
  } else if (w?.active && !w.foundFiles) {
    dot.className   = 'watcher-dot warn';
    label.textContent = 'no save found';
    btn.classList.remove('active');
  } else {
    dot.className   = 'watcher-dot inactive';
    label.textContent = w?.dirHandle ? 'paused' : 'connect files';
    btn.classList.remove('active');
  }
  updateTopbarRunBtn(gameId);
}

document.getElementById('topbar-watch-btn').addEventListener('click', async () => {
  if (!activeGameId) return;
  const w = watchers[activeGameId];
  if (w?.active) return; // already watching — button is just a status indicator when active
  if (!('showDirectoryPicker' in window)) return;
  const game = db.games.find(g => g.id === activeGameId);
  if (!game?.gameType) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    if (!watchers[activeGameId]) watchers[activeGameId] = {};
    watchers[activeGameId].dirHandle = handle;
    watchers[activeGameId].gameType  = game.gameType;
    await saveWatchHandle(activeGameId, handle);
    await startWatcher(activeGameId);
    updateTopbarWatcher(activeGameId);
    renderWatcherBlock(activeGameId, game.gameType);
  } catch(e) {
    if (e.name !== 'AbortError') {
      console.error('topbar folder picker', e);
      const label = document.getElementById('topbar-watcher-label');
      if (label) label.textContent = e.name === 'SecurityError' ? 'blocked — use localhost:3400' : 'error: ' + (e.message || e.name);
    }
  }
});

// ── Watcher UI in right panel ──────────────────────────────────────────────────
function renderWatcherBlock(gameId, gameType) {
  const block      = document.getElementById('rp-watcher-block');
  const hint       = document.getElementById('rp-watcher-hint');
  const dot        = document.getElementById('rp-watcher-dot');
  const label      = document.getElementById('rp-watcher-label');
  const folderName = document.getElementById('rp-folder-name');
  if (!block) return;

  if (!gameType) { block.style.display = 'none'; return; }
  block.style.display = '';

  const meta = GAME_TYPE_META[gameType] || {};
  const hintLines = (meta.hint || '').split('\n');
  hint.textContent = hintLines[0] || '';

  const w = watchers[gameId];
  const isMegabonk = gameType === 'megabonk';
  const hasPicker = ('showDirectoryPicker' in window);
  const selectBtn = document.getElementById('rp-select-folder-btn');
  if (selectBtn) {
    if (isMegabonk) {
      selectBtn.textContent = '⊕ test server connection';
      selectBtn.style.display = '';
    } else if (!hasPicker) {
      selectBtn.style.display = 'none';
    } else {
      selectBtn.textContent = '⊕ select save folder';
      selectBtn.style.display = '';
    }
  }
  const serverCmd = document.getElementById('rp-server-cmd');
  if (serverCmd) serverCmd.style.display = isMegabonk ? '' : 'none';
  const ocrRow = document.getElementById('rp-ocr-test-row');
  if (ocrRow) ocrRow.style.display = isMegabonk ? '' : 'none';
  // "test read" button: file games only (Megabonk has its own server/OCR tests)
  const testRow = document.getElementById('rp-test-read-row');
  if (testRow) testRow.style.display = (!isMegabonk && hasPicker && w?.dirHandle) ? '' : 'none';

  const detailEl = document.getElementById('rp-watcher-detail');
  const labelName = meta.label || gameType;

  if (w?.active && w.foundFiles) {
    // ✅ Reading the save successfully
    dot.className = 'watcher-dot active';
    label.textContent = 'watching ' + labelName;
  } else if (w?.active && !w.foundFiles) {
    // ⚠️ Polling, but the expected save isn't where we're looking
    dot.className = 'watcher-dot warn';
    if (isMegabonk && w.notFoundReason === 'server') label.textContent = 'server not running — start server.ps1';
    else if (w.notFoundReason === 'error')           label.textContent = "can't read this folder — re-select it";
    else                                             label.textContent = `no ${labelName} save found in this folder`;
  } else if (isMegabonk) {
    dot.className = 'watcher-dot inactive';
    label.textContent = 'server not running — start server.ps1';
  } else if (!hasPicker && !isMegabonk) {
    dot.className = 'watcher-dot inactive';
    label.textContent = '// watcher requires Brave, Chrome, Edge, or Opera GX';
  } else if (w?.dirHandle) {
    dot.className = 'watcher-dot inactive';
    label.textContent = 'paused — permission required on reload';
  } else {
    dot.className = 'watcher-dot inactive';
    label.textContent = 'no folder selected';
  }

  // Folder / file line — show the actual file being read as proof when watching
  if (folderName) {
    if (isMegabonk && w?.active && w.foundFiles) {
      folderName.textContent = '⚡ stats.json via localhost:3400';
      folderName.classList.add('visible');
    } else if (w?.active && w.foundFiles && w.lastFileName) {
      folderName.textContent = '📄 ' + w.lastFileName;
      folderName.classList.add('visible');
    } else {
      const name = w?.dirHandle?.name;
      folderName.textContent = name ? '📁 ' + name : (isMegabonk ? '⚡ via localhost:3400' : '');
      folderName.classList.toggle('visible', !!name || isMegabonk);
    }
  }

  // Proof / heartbeat / change-flash line
  if (detailEl) {
    const recentlyChanged = w?.lastChangeAt && (Date.now() - w.lastChangeAt) < 4000;
    if (w?.active && w.foundFiles) {
      const bits = [];
      if (w.lastDetail) bits.push(w.lastDetail);
      if (w.lastReadAt) bits.push('checked ' + timeAgo(w.lastReadAt));
      detailEl.textContent = (recentlyChanged ? '✓ save updated · ' : '') + bits.join(' · ');
      detailEl.className = 'watcher-detail visible' + (recentlyChanged ? ' flash' : '');
    } else if (w?.active && !w.foundFiles && w.notFoundReason !== 'server') {
      detailEl.textContent = '// point this at the folder that actually contains your save file';
      detailEl.className = 'watcher-detail visible';
    } else {
      detailEl.textContent = '';
      detailEl.className = 'watcher-detail';
    }
  }
}

// One-shot "test read": reports exactly what the reader finds right now.
async function doTestRead(gameId) {
  const w = watchers[gameId];
  const resultEl = document.getElementById('rp-test-read-result');
  if (!resultEl) return;
  if (!w?.dirHandle || !w?.gameType) { resultEl.textContent = 'select a folder first'; resultEl.style.color = 'var(--text-dim)'; return; }
  resultEl.textContent = 'reading…'; resultEl.style.color = 'var(--text-dim)';
  const st = await readGameState(w.dirHandle, w.gameType);
  const labelName = GAME_TYPE_META[w.gameType]?.label || w.gameType;
  if (st && st.found) {
    resultEl.textContent = `✓ found ${st.fileName || 'save'}${st.detail ? ' · ' + st.detail : ''}`;
    resultEl.style.color = 'var(--accent)';
  } else if (st && st.reason === 'error') {
    resultEl.textContent = '✗ could not read this folder (permission?)';
    resultEl.style.color = 'var(--loss)';
  } else {
    resultEl.textContent = `✗ no ${labelName} save file found in this folder`;
    resultEl.style.color = 'var(--loss)';
  }
}

document.getElementById('rp-test-read-btn')?.addEventListener('click', () => {
  if (activeGameId) doTestRead(activeGameId);
});

// Game type dropdown change → update hint, don't start watcher yet (need save)
document.getElementById('rp-game-type').addEventListener('change', e => {
  if (!activeGameId) return;
  renderWatcherBlock(activeGameId, e.target.value);
});

function updateGmPathHint(gameType) {
  const meta      = GAME_TYPE_META[gameType] || {};
  const block     = document.getElementById('gm-path-hint');
  const descEl    = document.getElementById('gm-path-desc');
  const valueEl   = document.getElementById('gm-path-value');

  if (!gameType || !meta.hint) { block.style.display = 'none'; return; }

  const lines = meta.hint.split('\n');
  const desc  = lines[0] || '';
  const path  = (lines[1] || '').replace(/^Default:\s*/i, '');

  descEl.textContent  = desc;
  valueEl.textContent = path || '// any folder in your game directory';
  block.style.display = '';
}

document.getElementById('gm-path-copy').addEventListener('click', () => {
  const val = document.getElementById('gm-path-value').textContent;
  navigator.clipboard.writeText(val).then(() => {
    const btn = document.getElementById('gm-path-copy');
    const orig = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => btn.textContent = orig, 1200);
  }).catch(() => {});
});

document.getElementById('gm-game-type').addEventListener('change', e => {
  updateGmPathHint(e.target.value);
  const btn = document.getElementById('gm-connect-btn');
  const hasPicker = ('showDirectoryPicker' in window);
  const isMb = e.target.value === 'megabonk';
  document.getElementById('gm-connect-hint').textContent = '';
  if (!hasPicker && !isMb && e.target.value) {
    btn.className   = 'gm-connect-btn unavailable';
    btn.textContent = '// watcher requires Brave, Chrome, Edge, or Opera GX';
  } else {
    btn.className   = 'gm-connect-btn';
    btn.textContent = isMb ? '⬡ Test Server Connection' : '⬡ Connect Game Files';
  }
});

// Select folder / server-test button
document.getElementById('rp-select-folder-btn').addEventListener('click', async () => {
  if (!activeGameId) return;
  const gameType = document.getElementById('rp-game-type').value;
  if (!gameType) {
    document.getElementById('rp-game-type').focus();
    return;
  }

  if (gameType === 'megabonk') {
    try {
      const res  = await fetch('http://localhost:3400/api/megabonk', { cache: 'no-store' });
      const data = await res.json();
      if (data.error) {
        alert('Server responded but Megabonk files not found:\n' + data.error + '\n\nMake sure Megabonk has been launched at least once.');
        return;
      }
      if (!watchers[activeGameId]) watchers[activeGameId] = {};
      watchers[activeGameId].gameType = gameType;
      const game = db.games.find(g => g.id === activeGameId);
      if (game && game.gameType !== gameType) { game.gameType = gameType; save(db); syncGame(game); }
      ensureMegabonkKillsField(activeGameId);
      await startWatcher(activeGameId);
      renderWatcherBlock(activeGameId, gameType);
      updateTopbarWatcher(activeGameId);
    } catch {
      alert('Cannot reach local server.\n\nStart it first:\n  powershell -ExecutionPolicy Bypass -File server.ps1');
    }
    return;
  }

  if (!('showDirectoryPicker' in window)) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    if (!watchers[activeGameId]) watchers[activeGameId] = {};
    watchers[activeGameId].dirHandle = handle;
    watchers[activeGameId].gameType  = gameType;
    const game = db.games.find(g => g.id === activeGameId);
    if (game && game.gameType !== gameType) { game.gameType = gameType; save(db); syncGame(game); }
    await saveWatchHandle(activeGameId, handle);
    await startWatcher(activeGameId);
    renderWatcherBlock(activeGameId, gameType);
  } catch(e) {
    if (e.name !== 'AbortError') console.error('folder picker', e);
  }
});

document.getElementById('rp-copy-server-cmd').addEventListener('click', () => {
  const cmd = document.getElementById('rp-server-cmd-text').textContent;
  navigator.clipboard.writeText(cmd).then(() => {
    const btn = document.getElementById('rp-copy-server-cmd');
    const orig = btn.textContent;
    btn.textContent = '✓ copied';
    setTimeout(() => btn.textContent = orig, 1400);
  }).catch(() => {});
});

document.getElementById('rp-ocr-test-btn').addEventListener('click', async () => {
  const btn    = document.getElementById('rp-ocr-test-btn');
  const result = document.getElementById('rp-ocr-result');
  btn.textContent = '// scanning...';
  result.textContent = '';
  try {
    const res = await fetch('http://localhost:3400/api/megabonk/ocr', { cache: 'no-store' });
    const d   = await res.json();
    console.log('[OCR test] raw text:', d.ocrText);
    console.log('[OCR test] kills:', d.kills, '| error:', d.error);
    if (d.error && !d.ocrText) {
      result.textContent = '// ' + d.error;
    } else if (d.kills != null) {
      result.textContent = `✓ ${d.kills} kills`;
    } else {
      result.textContent = '// no kills found — check console for raw text';
    }
  } catch {
    result.textContent = '// server not reachable';
  }
  btn.textContent = '⊕ test OCR now';
});

// Ensure a Megabonk game has auto-tracked fields: Kills (OCR) and Duration (timer).
function ensureMegabonkKillsField(gameId) {
  const game = db.games.find(g => g.id === gameId);
  if (!game) return;
  if (!game.fields) game.fields = [];
  let dirty = false;
  if (!game.fields.some(f => f.id === 'score')) {
    game.fields.push({ id: 'score', label: 'Kills', type: 'number', builtin: true });
    dirty = true;
  }
  if (!game.fields.some(f => f.id === 'duration')) {
    game.fields.push({ id: 'duration', label: 'Duration', type: 'text', builtin: true });
    dirty = true;
  }
  if (dirty) { save(db); syncGame(game); }
}

// Restore watchers from IndexedDB on startup
async function initWatchers() {
  for (const game of db.games) {
    if (!game.gameType) continue;
    if (game.gameType === 'megabonk') {
      if (!watchers[game.id]) watchers[game.id] = {};
      watchers[game.id].gameType = game.gameType;
      ensureMegabonkKillsField(game.id);
      await startWatcher(game.id);
      continue;
    }
    if (!('showDirectoryPicker' in window)) continue;
    try {
      const handle = await loadWatchHandle(game.id);
      if (!handle) continue;
      const perm = await handle.queryPermission({ mode: 'read' });
      watchers[game.id] = { dirHandle: handle, gameType: game.gameType, active: false };
      if (perm === 'granted') await startWatcher(game.id);
    } catch(e) { /* stale handle or no permission */ }
  }
}

// Button wires
document.getElementById('add-game-btn').addEventListener('click', () => openGameModal());
document.getElementById('new-run-btn').addEventListener('click',  () => openRunModal());

// Modal helpers
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('[data-close]').forEach(btn =>
  btn.addEventListener('click', () => closeModal(btn.dataset.close)));
const LOCKED_MODALS = new Set(['auth-modal', 'profile-modal', 'settings-modal', 'recovery-modal']);
document.querySelectorAll('.modal-overlay').forEach(ov =>
  ov.addEventListener('click', e => {
    if (e.target === ov && !LOCKED_MODALS.has(ov.id)) closeModal(ov.id);
  }));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape')
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      if (!LOCKED_MODALS.has(m.id)) closeModal(m.id);
    });
});

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function isSafeImgSrc(s) {
  return typeof s === 'string' && (
    s.startsWith('data:image/') ||
    s.startsWith('blob:') ||
    s.startsWith('https://wbbfkyzdmpnyiizifijz.supabase.co/storage/')
  );
}
function today() { return new Date().toISOString().slice(0,10); }

// ── Demo seed ─────────────────────────────────────────────────────────────────
function seedDemo() {
  if (db.games.length) return;
  const hId = uid(), sId = uid();

  const hFields = [
    { id: 'char',  label: 'Character / Build', type: 'text',   builtin: true  },
    { id: 'diff',  label: 'Difficulty',         type: 'text',   builtin: true  },
    { id: 'floor', label: 'Stage / Floor',      type: 'text',   builtin: true  },
    { id: uid(),   label: 'Weapon',             type: 'text',   builtin: false },
    { id: uid(),   label: 'Aspect',             type: 'text',   builtin: false },
  ];
  const [hChar, hDiff, hFloor, hWeapon, hAspect] = hFields.map(f => f.id);

  const sFields = [
    { id: 'char',  label: 'Character / Build', type: 'text',   builtin: true  },
    { id: 'diff',  label: 'Difficulty',         type: 'text',   builtin: true  },
    { id: 'floor', label: 'Stage / Floor',      type: 'text',   builtin: true  },
    { id: uid(),   label: 'Ascension',          type: 'number', builtin: false },
  ];
  const [sChar, sDiff, sFloor, sAsc] = sFields.map(f => f.id);

  db.games = [
    { id: hId, name: 'Hades',          icon: null, fields: hFields },
    { id: sId, name: 'Slay the Spire', icon: null, fields: sFields },
  ];
  db.runs = [
    { id: uid(), gameId: hId, result: 'win',  date: '2026-04-10', notes: 'First clear! Athena deflect carried.',                       tags: ['first-win'], fields: { [hChar]:'Zagreus', [hDiff]:'Heat 0', [hFloor]:'Elysium',  [hWeapon]:'Stygian Blade',    [hAspect]:'Zagreus' } },
    { id: uid(), gameId: hId, result: 'loss', date: '2026-04-12', notes: 'Lernaean Bone Hydra wrecked me. Bad boon offerings all run.', tags: [],            fields: { [hChar]:'Zagreus', [hDiff]:'Heat 2', [hFloor]:'Tartarus', [hWeapon]:'Heart-Seeking Bow', [hAspect]:'Chiron'  } },
    { id: uid(), gameId: hId, result: 'win',  date: '2026-04-18', notes: 'Rail + Zeus build absolutely cooked.',                       tags: ['op-build'],  fields: { [hChar]:'Zagreus', [hDiff]:'Heat 4', [hFloor]:'Olympus',  [hWeapon]:'Adamant Rail',      [hAspect]:'Lucifer' } },
    { id: uid(), gameId: sId, result: 'loss', date: '2026-04-15', notes: 'Corrupt Heart without a solid relic defense.',               tags: [],            fields: { [sChar]:'Ironclad', [sDiff]:'A5', [sFloor]:'Act 3', [sAsc]:'5' } },
    { id: uid(), gameId: sId, result: 'win',  date: '2026-04-20', notes: 'Shiv + Blade Dance infinite. Easy W.',                       tags: ['first-win','infinite'], fields: { [sChar]:'Silent', [sDiff]:'A0', [sFloor]:'Act 4', [sAsc]:'0' } },
  ];
  save(db);
}

// ── Share ─────────────────────────────────────────────────────────────────────
async function generateShareLink() {
  if (!sbUser) return;
  const token = crypto.randomUUID();
  const btn = document.getElementById('share-profile-btn');
  const orig = btn.textContent;
  btn.textContent = '[ generating... ]';
  btn.disabled = true;
  try {
    const { error } = await sb.from('share_tokens').insert({ token, user_id: sbUser.id });
    if (error) throw error;
    const url = window.location.origin + window.location.pathname + '#share/' + token;
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '[ link copied! ]';
    } catch {
      prompt('Copy this share link:', url);
      btn.textContent = '[ link ready! ]';
    }
    btn.style.color = 'var(--win)';
  } catch(e) {
    console.error('generateShareLink', e);
    btn.textContent = '[ error ]';
    btn.style.color = 'var(--loss)';
  }
  setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.disabled = false; }, 2200);
}

document.getElementById('share-profile-btn').addEventListener('click', generateShareLink);

async function loadSharedProfile(token) {
  setSyncBadge('syncing', '◌ loading...');
  try {
    const { data, error } = await sb.rpc('get_shared_profile', { p_token: token });
    if (error || !data) {
      setSyncBadge('error', '✗ invalid link');
      return false;
    }
    isReadOnly = true;
    if (data.profile) {
      db.profile.name        = data.profile.name || 'PLAYER';
      db.profile.avatar      = data.profile.avatar || null;
      db.profile.bio         = data.profile.bio || '';
      db.profile.currentGame = data.profile.current_game_id || null;
      if (!db.settings) db.settings = {};
      db.settings.accentHue = data.profile.accent_hue ?? 145;
      db.settings.accentSat = data.profile.accent_sat ?? 1;
      db.settings.bgEffect  = data.profile.bg_effect  || 'none';
    }
    db.games = (data.games || []).map(g => ({
      id: g.id, name: g.name, icon: g.icon || null, fields: g.fields || [],
      builds: (g.builds?.list) || [], buildCustomFields: (g.builds?.customFields) || [],
    }));
    db.runs = (data.runs || []).map(r => ({
      // Shared view intentionally omits private notes/comment — RPC does not send them.
      id: r.id, gameId: r.game_id, result: r.result, date: r.date,
      notes: '', comment: '', tags: r.tags || [], fields: r.fields || {}
    }));

    document.getElementById('share-banner-name').textContent = (db.profile.name || 'PLAYER').toUpperCase();
    document.getElementById('share-banner').style.display = 'flex';
    document.getElementById('add-game-btn').style.display = 'none';
    document.getElementById('new-run-btn').style.display  = 'none';
    document.getElementById('rp-footer').style.display    = 'none';
    document.getElementById('profile-section').style.pointerEvents = 'none';

    setSyncBadge('synced', '✓ loaded');
    return true;
  } catch(e) {
    console.error('loadSharedProfile', e);
    setSyncBadge('error', '✗ failed to load');
    return false;
  }
}

document.getElementById('share-back-btn').addEventListener('click', () => {
  history.replaceState(null, '', window.location.pathname);
  window.location.reload();
});

window.addEventListener('hashchange', async () => {
  const m = window.location.hash.match(/^#share\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!m) return;
  db = defaultDB();
  isReadOnly = false;
  const ok = await loadSharedProfile(m[1]);
  if (ok) bootUI();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
function updateAuthBar() {
  const dot   = document.querySelector('#sidebar-auth .sa-dot');
  const label = document.querySelector('#sidebar-auth .sa-label');
  const btn   = document.getElementById('btn-sidebar-auth');
  if (sbUser) {
    dot.className   = 'sa-dot online';
    label.className = 'sa-label online';
    label.textContent = sbUser.email;
    btn.textContent = '[ sign out ]';
    btn.className   = 'danger';
  } else {
    dot.className   = 'sa-dot offline';
    label.className = 'sa-label';
    label.textContent = 'offline';
    btn.textContent = '[ sign in ]';
    btn.className   = '';
  }
}

document.getElementById('btn-sidebar-auth').addEventListener('click', () => {
  if (sbUser) {
    if (confirm('Sign out of your account?')) doSignOut();
  } else {
    openModal('auth-modal');
  }
});

function bootUI() {
  const s = db.settings || {};
  applyAccentHue(s.accentHue ?? 145, s.accentSat ?? 1);
  applyBgImage(localStorage.getItem('rlt_bgimg'));
  applyBgEffect(s.bgEffect || 'none');
  document.getElementById('profile-section').style.pointerEvents = '';
  updateAuthBar();
  renderSidebarProfile();
  renderSidebar();
  if (db.games.length) selectGame(db.games[0].id);
  else {
    document.getElementById('game-view').style.display = 'none';
    document.getElementById('no-game-selected').style.display = '';
  }
  initWatchers();
}

// Deferred via queueMicrotask so all module-level consts (e.g. bgFx) finish
// initializing before boot runs — the offline path (sb === null) calls bootUI
// synchronously and would otherwise hit those consts in their temporal dead zone.
const _boot = async () => {
  // Share-link mode: #share/<uuid>
  const shareMatch = window.location.hash.match(/^#share\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (shareMatch) {
    db = defaultDB();
    const ok = await loadSharedProfile(shareMatch[1]);
    if (ok) bootUI();
    return;
  }

  if (!sb) {
    // Supabase CDN failed to load — go straight to offline boot
    db = load();
    bootUI();
    updateAuthBar();
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    sbUser = session.user;
    await loadFromSupabase();
    bootUI();
  } else {
    openModal('auth-modal');
  }
  updateAuthBar();

  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      if (_authBusy || sbUser?.id === session.user.id) return;
      sbUser = session.user;
      await loadFromSupabase();
      closeModal('auth-modal');
      bootUI();
    } else if (event === 'PASSWORD_RECOVERY') {
      document.getElementById('recovery-pw-new').value     = '';
      document.getElementById('recovery-pw-confirm').value = '';
      document.getElementById('recovery-msg').textContent  = '';
      document.getElementById('recovery-msg').className    = 'settings-msg';
      closeModal('auth-modal');
      openModal('recovery-modal');
    } else if (event === 'SIGNED_OUT') {
      sbUser = null;
    }
    updateAuthBar();
  });
};
queueMicrotask(_boot);

// ── Settings modal ────────────────────────────────────────────────────────────
function openSettingsModal() {
  document.getElementById('settings-email').value      = '';
  document.getElementById('settings-email-pw').value   = '';
  document.getElementById('settings-pw-new').value     = '';
  document.getElementById('settings-pw-confirm').value = '';
  document.getElementById('settings-pw-current').value = '';
  ['settings-email-msg', 'settings-pw-msg'].forEach(id => {
    const el = document.getElementById(id);
    el.textContent = '';
    el.className = 'settings-msg';
  });
  const hasAuth = !!(sbUser && sb);
  document.getElementById('settings-account-section').style.display = hasAuth ? '' : 'none';
  document.getElementById('settings-offline-notice').style.display  = hasAuth ? 'none' : '';
  document.getElementById('settings-appearance-controls').style.display = isReadOnly ? 'none' : '';
  document.getElementById('settings-appearance-readonly').style.display  = isReadOnly ? '' : 'none';
  openModal('settings-modal');
  // reset wheel so it re-initialises with current saved hue each open
  const cwCanvas = document.getElementById('settings-color-wheel');
  if (cwCanvas) cwCanvas._cwReady = false;
  requestAnimationFrame(initColorWheel);
  syncBgPreview(localStorage.getItem('rlt_bgimg'));
  syncBgEffectChips();
}

document.getElementById('settings-btn').addEventListener('click', openSettingsModal);

// ── Change email (password confirmation) ──────────────────────────────────────
document.getElementById('settings-email-btn').addEventListener('click', async () => {
  const newEmail = document.getElementById('settings-email').value.trim();
  const pw       = document.getElementById('settings-email-pw').value;
  const msgEl    = document.getElementById('settings-email-msg');
  const btn      = document.getElementById('settings-email-btn');
  msgEl.className = 'settings-msg'; msgEl.textContent = '';
  if (!newEmail)        { msgEl.className = 'settings-msg err'; msgEl.textContent = '// enter a new email address'; return; }
  if (!pw)              { msgEl.className = 'settings-msg err'; msgEl.textContent = '// enter your current password'; return; }
  if (!sb || !sbUser)   { msgEl.className = 'settings-msg err'; msgEl.textContent = '// not signed in'; return; }
  btn.textContent = '[ ... ]'; btn.disabled = true;
  try {
    const { error: reAuthErr } = await sb.auth.signInWithPassword({ email: sbUser.email, password: pw });
    if (reAuthErr) {
      msgEl.className = 'settings-msg err';
      msgEl.textContent = '// incorrect password';
    } else {
      const { error: updateErr } = await sb.auth.updateUser({ email: newEmail });
      if (updateErr) {
        msgEl.className = 'settings-msg err';
        msgEl.textContent = '// ' + updateErr.message;
      } else {
        msgEl.className = 'settings-msg ok';
        msgEl.textContent = '// confirmation sent to ' + newEmail + ' — click the link to complete the change';
        document.getElementById('settings-email').value    = '';
        document.getElementById('settings-email-pw').value = '';
      }
    }
  } catch(e) {
    msgEl.className = 'settings-msg err'; msgEl.textContent = '// ' + e.message;
  }
  btn.textContent = '[ Update Email ]'; btn.disabled = false;
});

// ── Change password (current password confirmation) ───────────────────────────
document.getElementById('settings-pw-btn').addEventListener('click', async () => {
  const pw      = document.getElementById('settings-pw-new').value;
  const confirm = document.getElementById('settings-pw-confirm').value;
  const current = document.getElementById('settings-pw-current').value;
  const msgEl   = document.getElementById('settings-pw-msg');
  const btn     = document.getElementById('settings-pw-btn');
  msgEl.className = 'settings-msg'; msgEl.textContent = '';
  if (!pw)            { msgEl.className = 'settings-msg err'; msgEl.textContent = '// enter a new password'; return; }
  if (pw.length < 6)  { msgEl.className = 'settings-msg err'; msgEl.textContent = '// password must be at least 6 characters'; return; }
  if (pw !== confirm)  { msgEl.className = 'settings-msg err'; msgEl.textContent = '// passwords do not match'; return; }
  if (!current)        { msgEl.className = 'settings-msg err'; msgEl.textContent = '// enter your current password'; return; }
  if (!sb || !sbUser)  { msgEl.className = 'settings-msg err'; msgEl.textContent = '// not signed in'; return; }
  btn.textContent = '[ ... ]'; btn.disabled = true;
  try {
    const { error: reAuthErr } = await sb.auth.signInWithPassword({ email: sbUser.email, password: current });
    if (reAuthErr) {
      msgEl.className = 'settings-msg err'; msgEl.textContent = '// incorrect current password';
    } else {
      const { error: updateErr } = await sb.auth.updateUser({ password: pw });
      if (updateErr) {
        msgEl.className = 'settings-msg err'; msgEl.textContent = '// ' + updateErr.message;
      } else {
        msgEl.className = 'settings-msg ok'; msgEl.textContent = '// password updated successfully';
        document.getElementById('settings-pw-new').value     = '';
        document.getElementById('settings-pw-confirm').value = '';
        document.getElementById('settings-pw-current').value = '';
      }
    }
  } catch(e) {
    msgEl.className = 'settings-msg err'; msgEl.textContent = '// ' + e.message;
  }
  btn.textContent = '[ Update Password ]'; btn.disabled = false;
});

bindPwToggle('settings-email-pw-toggle',  'settings-email-pw');
bindPwToggle('settings-pw-toggle',        'settings-pw-new');
bindPwToggle('settings-pw-confirm-toggle','settings-pw-confirm');
bindPwToggle('settings-pw-current-toggle','settings-pw-current');

document.getElementById('settings-pw-email-btn').addEventListener('click', async () => {
  const msgEl = document.getElementById('settings-pw-msg');
  const btn   = document.getElementById('settings-pw-email-btn');
  msgEl.className = 'settings-msg'; msgEl.textContent = '';
  if (!sb || !sbUser) { msgEl.className = 'settings-msg err'; msgEl.textContent = '// not signed in'; return; }
  btn.textContent = '...'; btn.disabled = true;
  try {
    const { error } = await sb.auth.resetPasswordForEmail(sbUser.email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    if (error) {
      msgEl.className = 'settings-msg err'; msgEl.textContent = '// ' + error.message;
    } else {
      msgEl.className = 'settings-msg ok';
      msgEl.textContent = '// reset link sent to ' + sbUser.email + ' — click it to set a new password';
    }
  } catch(e) {
    msgEl.className = 'settings-msg err'; msgEl.textContent = '// ' + e.message;
  }
  btn.textContent = 'or reset via email'; btn.disabled = false;
});

// ── Recovery modal ────────────────────────────────────────────────────────────
document.getElementById('recovery-pw-btn').addEventListener('click', async () => {
  const pw      = document.getElementById('recovery-pw-new').value;
  const confirm = document.getElementById('recovery-pw-confirm').value;
  const msgEl   = document.getElementById('recovery-msg');
  const btn     = document.getElementById('recovery-pw-btn');
  msgEl.className = 'settings-msg'; msgEl.textContent = '';
  if (!pw)           { msgEl.className = 'settings-msg err'; msgEl.textContent = '// enter a new password'; return; }
  if (pw.length < 6) { msgEl.className = 'settings-msg err'; msgEl.textContent = '// password must be at least 6 characters'; return; }
  if (pw !== confirm) { msgEl.className = 'settings-msg err'; msgEl.textContent = '// passwords do not match'; return; }
  btn.textContent = '[ ... ]'; btn.disabled = true;
  try {
    const { error } = await sb.auth.updateUser({ password: pw });
    if (error) {
      msgEl.className = 'settings-msg err'; msgEl.textContent = '// ' + error.message;
    } else {
      msgEl.className = 'settings-msg ok'; msgEl.textContent = '// password updated successfully';
      setTimeout(() => closeModal('recovery-modal'), 1200);
    }
  } catch(e) {
    msgEl.className = 'settings-msg err'; msgEl.textContent = '// ' + e.message;
  }
  btn.textContent = '[ Set Password ]'; btn.disabled = false;
});

document.getElementById('recovery-cancel-btn').addEventListener('click', () => closeModal('recovery-modal'));

// ── Appearance: accent color ──────────────────────────────────────────────────
function applyAccentHue(h, s = 1) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  const sp = Math.round(s * 100);
  const r  = document.documentElement;
  r.style.setProperty('--accent',        `hsl(${h},${sp}%,50%)`);
  r.style.setProperty('--accent-dim',    `hsl(${h},${sp}%,21%)`);
  r.style.setProperty('--accent-glow',   `hsla(${h},${sp}%,50%,0.12)`);
  r.style.setProperty('--accent-glow2',  `hsla(${h},${sp}%,50%,0.06)`);
  r.style.setProperty('--win',           `hsl(${h},${sp}%,50%)`);
  r.style.setProperty('--win-bg',        `hsla(${h},${sp}%,50%,0.08)`);
  r.style.setProperty('--text',          `hsl(${h},${Math.round(s*80+20)}%,81%)`);
  r.style.setProperty('--text-dim',      `hsl(${h},${Math.round(s*25+8)}%,36%)`);
  r.style.setProperty('--text-faint',    `hsl(${h},${Math.round(s*40+12)}%,23%)`);
  r.style.setProperty('--surface',       `hsl(${h},${Math.round(s*50+10)}%,3%)`);
  r.style.setProperty('--surface2',      `hsl(${h},${Math.round(s*40+10)}%,6%)`);
  r.style.setProperty('--border',        `hsl(${h},${Math.round(s*55+12)}%,12%)`);
  r.style.setProperty('--border-hi',     `hsl(${h},${Math.round(s*48+11)}%,21%)`);
  r.style.setProperty('--scanline-tint', `hsla(${h},${sp}%,50%,0.018)`);
}

// ── Appearance: background image ─────────────────────────────────────────────
function applyBgImage(dataUrl) {
  const el = document.getElementById('app-bg');
  if (dataUrl) {
    el.style.backgroundImage = `url(${dataUrl})`;
    el.style.display = 'block';
    document.body.style.backgroundColor = 'transparent';
  } else {
    el.style.display = 'none';
    el.style.backgroundImage = '';
    if (!bgFx.current || bgFx.current === 'none') document.body.style.backgroundColor = '';
  }
}

// ── Appearance: matrix-style background effects ──────────────────────────────
const bgFx = {
  current: 'none',
  raf: null,
  canvas: null,
  ctx: null,
  state: null,
  start: 0,
  resizeBound: null,
};

function bgFxAccent() {
  const h = (db.settings && typeof db.settings.accentHue === 'number') ? db.settings.accentHue : 145;
  const s = (db.settings && typeof db.settings.accentSat === 'number') ? db.settings.accentSat : 1;
  return { h, s: Math.round(s * 100) };
}

function bgFxResize() {
  const c = bgFx.canvas;
  if (!c) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width  = Math.floor(window.innerWidth  * dpr);
  c.height = Math.floor(window.innerHeight * dpr);
  c.style.width  = window.innerWidth  + 'px';
  c.style.height = window.innerHeight + 'px';
  bgFx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Reset per-effect state on resize
  if (bgFx.state && bgFx.state.init) bgFx.state.init();
}

function applyBgEffect(name) {
  bgFx.current = name || 'none';
  const c = document.getElementById('bg-canvas');
  if (!c) return;
  bgFx.canvas = c;
  bgFx.ctx = c.getContext('2d');

  // Stop existing loop
  if (bgFx.raf) cancelAnimationFrame(bgFx.raf);
  bgFx.raf = null;
  if (bgFx.resizeBound) {
    window.removeEventListener('resize', bgFx.resizeBound);
    bgFx.resizeBound = null;
  }

  if (bgFx.current === 'none') {
    c.classList.remove('active');
    bgFx.ctx.clearRect(0, 0, c.width, c.height);
    bgFx.state = null;
    if (!document.getElementById('app-bg').style.backgroundImage) document.body.style.backgroundColor = '';
    return;
  }

  c.classList.add('active');
  document.body.style.backgroundColor = 'transparent';
  bgFx.state = bgFxFactory(bgFx.current);
  bgFx.resizeBound = bgFxResize;
  window.addEventListener('resize', bgFx.resizeBound);
  bgFxResize();
  bgFx.start = performance.now();
  const loop = (now) => {
    if (!bgFx.state || bgFx.current === 'none') return;
    const t = (now - bgFx.start) / 1000;
    bgFx.state.frame(t);
    bgFx.raf = requestAnimationFrame(loop);
  };
  bgFx.raf = requestAnimationFrame(loop);
}

function bgFxFactory(name) {
  if (name === 'rain')      return makeRainFx();
  if (name === 'grid')      return makeGridFx();
  if (name === 'wave')      return makeWaveFx();
  if (name === 'pulse')     return makePulseFx();
  if (name === 'starfield') return makeStarfieldFx();
  return null;
}

// Matrix Rain — falling glyph columns
function makeRainFx() {
  const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789<>/\\|=*+-_';
  let columns = [], colW = 16, lastT = 0;
  function init() {
    const w = window.innerWidth, h = window.innerHeight;
    colW = 16;
    const cols = Math.ceil(w / colW);
    columns = new Array(cols).fill(0).map((_, i) => ({
      x: i * colW + colW / 2,
      y: Math.random() * h,
      speed: 60 + Math.random() * 120,
      length: 8 + Math.floor(Math.random() * 18),
      glyphSeed: Math.random() * 99,
    }));
    lastT = 0;
  }
  function frame(t) {
    const ctx = bgFx.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    const dt = Math.min(0.05, t - lastT); lastT = t;
    const { h: hue, s } = bgFxAccent();

    // Trail fade
    ctx.fillStyle = 'rgba(0,0,0,0.10)';
    ctx.fillRect(0, 0, w, h);

    ctx.font = '14px ui-monospace, "JetBrains Mono", monospace';
    ctx.textAlign = 'center';

    columns.forEach(col => {
      col.y += col.speed * dt;
      if (col.y - col.length * 14 > h) {
        col.y = -Math.random() * h * 0.5;
        col.speed = 60 + Math.random() * 120;
      }
      for (let i = 0; i < col.length; i++) {
        const yy = col.y - i * 14;
        if (yy < -14 || yy > h + 14) continue;
        const charIdx = Math.floor((t * 8 + col.glyphSeed + i * 3.13) % GLYPHS.length);
        const ch = GLYPHS[charIdx];
        if (i === 0) {
          ctx.fillStyle = `hsla(${hue}, ${Math.max(40, s)}%, 88%, 0.95)`;
          ctx.shadowColor = `hsl(${hue}, ${s}%, 60%)`;
          ctx.shadowBlur = 8;
        } else {
          const alpha = Math.max(0.04, (1 - i / col.length) * 0.7);
          ctx.fillStyle = `hsla(${hue}, ${s}%, ${50 - i * 1.5}%, ${alpha})`;
          ctx.shadowBlur = 0;
        }
        ctx.fillText(ch, col.x, yy);
      }
    });
    ctx.shadowBlur = 0;
  }
  init();
  return { init, frame };
}

// Pulse Grid — dot grid with traveling pulse waves
function makeGridFx() {
  let dots = [], spacing = 28;
  function init() {
    const w = window.innerWidth, h = window.innerHeight;
    spacing = 28;
    dots = [];
    for (let y = spacing / 2; y < h; y += spacing) {
      for (let x = spacing / 2; x < w; x += spacing) {
        dots.push({ x, y, phase: Math.random() * Math.PI * 2 });
      }
    }
  }
  function frame(t) {
    const ctx = bgFx.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    const { h: hue, s } = bgFxAccent();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, w, h);

    // Two traveling pulse centers
    const cxA = (Math.sin(t * 0.18) * 0.5 + 0.5) * w;
    const cyA = (Math.cos(t * 0.13) * 0.5 + 0.5) * h;
    const cxB = (Math.cos(t * 0.21) * 0.5 + 0.5) * w;
    const cyB = (Math.sin(t * 0.17) * 0.5 + 0.5) * h;

    dots.forEach(d => {
      const dxA = d.x - cxA, dyA = d.y - cyA;
      const dxB = d.x - cxB, dyB = d.y - cyB;
      const distA = Math.sqrt(dxA * dxA + dyA * dyA);
      const distB = Math.sqrt(dxB * dxB + dyB * dyB);
      const wA = Math.max(0, Math.cos((distA / 80 - t * 1.4)));
      const wB = Math.max(0, Math.cos((distB / 90 - t * 1.1)));
      const intensity = Math.min(1, (wA + wB) * 0.55);
      const r = 1.2 + intensity * 2.4;
      const alpha = 0.05 + intensity * 0.85;
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, ${s}%, ${40 + intensity * 30}%, ${alpha})`;
      if (intensity > 0.5) {
        ctx.shadowColor = `hsl(${hue}, ${s}%, 55%)`;
        ctx.shadowBlur = 6 * intensity;
      } else { ctx.shadowBlur = 0; }
      ctx.fill();
    });
    ctx.shadowBlur = 0;
  }
  init();
  return { init, frame };
}

// Wave Scan — sine-wave horizontal scan lines drifting upward
function makeWaveFx() {
  let waves = [];
  function init() {
    waves = new Array(8).fill(0).map((_, i) => ({
      yOffset: i * 80,
      amp: 18 + Math.random() * 26,
      freq: 0.005 + Math.random() * 0.012,
      speed: 30 + Math.random() * 40,
      phase: Math.random() * Math.PI * 2,
    }));
  }
  function frame(t) {
    const ctx = bgFx.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    const { h: hue, s } = bgFxAccent();
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(0, 0, w, h);

    waves.forEach((wv, idx) => {
      const baseY = ((wv.yOffset + t * wv.speed) % (h + 200)) - 100;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0,    `hsla(${hue}, ${s}%, 50%, 0)`);
      grad.addColorStop(0.5,  `hsla(${hue}, ${s}%, 60%, ${0.45 - idx * 0.03})`);
      grad.addColorStop(1,    `hsla(${hue}, ${s}%, 50%, 0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.shadowColor = `hsl(${hue}, ${s}%, 55%)`;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const y = baseY + Math.sin(x * wv.freq + t * 1.4 + wv.phase) * wv.amp;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.shadowBlur = 0;
  }
  init();
  return { init, frame };
}

// Radial Pulse — expanding rings from random points
function makePulseFx() {
  let pulses = [];
  function spawn(t) {
    pulses.push({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      born: t,
      maxR: 220 + Math.random() * 280,
      duration: 2.6 + Math.random() * 1.8,
    });
  }
  let lastSpawn = 0;
  function init() { pulses = []; lastSpawn = 0; }
  function frame(t) {
    const ctx = bgFx.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    const { h: hue, s } = bgFxAccent();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, w, h);

    if (t - lastSpawn > 0.55) { spawn(t); lastSpawn = t; }
    pulses = pulses.filter(p => t - p.born < p.duration);

    pulses.forEach(p => {
      const k = (t - p.born) / p.duration;     // 0 → 1
      const r = k * p.maxR;
      const alpha = (1 - k) * 0.55;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${hue}, ${s}%, ${55 - k * 15}%, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.shadowColor = `hsl(${hue}, ${s}%, 55%)`;
      ctx.shadowBlur = 12 * (1 - k);
      ctx.stroke();
      // inner core dot
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2 + (1 - k) * 3, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, ${s}%, 70%, ${alpha * 1.4})`;
      ctx.fill();
    });
    ctx.shadowBlur = 0;
  }
  init();
  return { init, frame };
}

// Starfield — drifting glyphs/sparks toward viewer (warp-style)
function makeStarfieldFx() {
  let stars = [];
  function init() {
    const N = 220;
    stars = new Array(N).fill(0).map(() => ({
      x: (Math.random() - 0.5),
      y: (Math.random() - 0.5),
      z: Math.random(),
      speed: 0.18 + Math.random() * 0.5,
    }));
  }
  function frame(t) {
    const ctx = bgFx.ctx;
    const w = window.innerWidth, h = window.innerHeight;
    const { h: hue, s } = bgFxAccent();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    stars.forEach(st => {
      st.z -= 0.0045 * st.speed;
      if (st.z <= 0.02) {
        st.x = (Math.random() - 0.5);
        st.y = (Math.random() - 0.5);
        st.z = 1;
        st.speed = 0.18 + Math.random() * 0.5;
      }
      const k = 1 / st.z;
      const px = cx + st.x * k * w * 0.5;
      const py = cy + st.y * k * h * 0.5;
      if (px < -10 || px > w + 10 || py < -10 || py > h + 10) return;
      const size = (1 - st.z) * 2.4;
      const alpha = Math.min(1, 1 - st.z);
      // streak
      const tailK = 1 / Math.min(1, st.z + 0.04);
      const tx = cx + st.x * tailK * w * 0.5;
      const ty = cy + st.y * tailK * h * 0.5;
      ctx.strokeStyle = `hsla(${hue}, ${s}%, 70%, ${alpha * 0.45})`;
      ctx.lineWidth = Math.max(0.6, size);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(px, py); ctx.stroke();
      // head
      ctx.fillStyle = `hsla(${hue}, ${s}%, 85%, ${alpha})`;
      ctx.shadowColor = `hsl(${hue}, ${s}%, 60%)`;
      ctx.shadowBlur = 6 * alpha;
      ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI * 2); ctx.fill();
    });
    ctx.shadowBlur = 0;
  }
  init();
  return { init, frame };
}

// ── Color wheel canvas ────────────────────────────────────────────────────────
function _cwHue2Rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1/6) return p + (q-p)*6*t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q-p)*(2/3-t)*6;
  return p;
}
function _cwHslToRgb(h, s, l) {
  // h: 0-360, s/l: 0-1 → [r,g,b] 0-255
  h /= 360;
  if (s === 0) { const v = Math.round(l*255); return [v,v,v]; }
  const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
  return [
    Math.round(_cwHue2Rgb(p,q,h+1/3)*255),
    Math.round(_cwHue2Rgb(p,q,h)*255),
    Math.round(_cwHue2Rgb(p,q,h-1/3)*255),
  ];
}

function drawColorWheel(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w/2, cy = h/2, r = Math.min(cx,cy) - 1;
  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x-cx, dy = y-cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > r) continue;
      const hue = ((Math.atan2(dy,dx)*180/Math.PI)+360) % 360;
      const sat = dist/r;
      const [rr,gg,bb] = _cwHslToRgb(hue, sat, 0.5);
      const i = (y*w+x)*4;
      data[i]=rr; data[i+1]=gg; data[i+2]=bb; data[i+3]=255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // subtle dark vignette at the edge
  const ring = ctx.createRadialGradient(cx,cy,r*0.88,cx,cy,r);
  ring.addColorStop(0,'rgba(0,0,0,0)');
  ring.addColorStop(1,'rgba(0,0,0,0.28)');
  ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
  ctx.fillStyle = ring; ctx.fill();
}

function cwUpdateDot(canvas, dot, h, s) {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const r  = Math.min(cx, cy) - 1;
  const rad = h * Math.PI / 180;
  const dist = s * (r - 4);
  dot.style.left = (cx + Math.cos(rad) * dist) + 'px';
  dot.style.top  = (cy + Math.sin(rad) * dist) + 'px';
}

function cwUpdateSwatch(h, s) {
  const swatch = document.getElementById('cw-swatch');
  const label  = document.getElementById('cw-hue-label');
  if (!swatch) return;
  swatch.style.background  = `hsl(${h},${Math.round(s*100)}%,50%)`;
  swatch.style.boxShadow   = `0 0 12px hsl(${h},${Math.round(s*100)}%,50%)`;
  swatch.style.borderColor = `hsl(${h},${Math.round(s*100)}%,30%)`;
  if (label) label.textContent = `hue: ${Math.round(h)}°  sat: ${Math.round(s*100)}%`;
}

function initColorWheel() {
  const canvas = document.getElementById('settings-color-wheel');
  const dot    = document.getElementById('cw-selector-dot');
  if (!canvas || canvas._cwReady) return;
  canvas._cwReady = true;
  drawColorWheel(canvas);

  const s0 = db.settings || {};
  let cwH = s0.accentHue ?? 145;
  let cwS = s0.accentSat ?? 1;
  cwUpdateDot(canvas, dot, cwH, cwS);
  cwUpdateSwatch(cwH, cwS);

  function pickFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width  / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const x  = (e.clientX - rect.left) * scaleX - cx;
    const y  = (e.clientY - rect.top)  * scaleY - cy;
    const r  = Math.min(cx, cy) - 1;
    const dist = Math.sqrt(x * x + y * y);
    if (dist > r) return;
    cwH = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    cwS = Math.min(1, dist / (r - 4));
    cwUpdateDot(canvas, dot, cwH, cwS);
    cwUpdateSwatch(cwH, cwS);
    applyAccentHue(cwH, cwS);
    if (!db.settings) db.settings = {};
    db.settings.accentHue = cwH;
    db.settings.accentSat = cwS;
  }

  function commitCwColor() {
    save(db);
    syncProfile();
  }

  let dragging = false;
  canvas.addEventListener('mousedown', e => { dragging = true; pickFromEvent(e); });
  window.addEventListener('mousemove', e => { if (dragging) pickFromEvent(e); });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; commitCwColor(); } });
  canvas.addEventListener('touchstart', e => { pickFromEvent(e.touches[0]); }, { passive: true });
  canvas.addEventListener('touchmove',  e => { pickFromEvent(e.touches[0]); e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchend', () => commitCwColor());
}

document.getElementById('cw-reset-btn').addEventListener('click', () => {
  if (!db.settings) db.settings = {};
  db.settings.accentHue = 145;
  db.settings.accentSat = 1;
  save(db);
  syncProfile();
  applyAccentHue(145, 1);
  const canvas = document.getElementById('settings-color-wheel');
  const dot    = document.getElementById('cw-selector-dot');
  canvas._cwReady = false;
  initColorWheel();
});

// ── Background image handlers ─────────────────────────────────────────────────
document.getElementById('bg-upload-zone').addEventListener('click', () => {
  document.getElementById('file-bg-image').click();
});
document.getElementById('file-bg-image').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let bgVal;
  if (sbUser) {
    try {
      bgVal = await uploadToStorage(file, `${sbUser.id}/bg`, 1920);
    } catch(err) { console.error('bg upload', err); }
  }
  if (!bgVal) {
    try { bgVal = await resizeImage(file, 1200); }
    catch { return; }
  }
  try { localStorage.setItem('rlt_bgimg', bgVal); }
  catch { alert('Image too large for storage — try a smaller file.'); return; }
  applyBgImage(bgVal);
  syncBgPreview(bgVal);
});
document.getElementById('bg-clear-btn').addEventListener('click', () => {
  localStorage.removeItem('rlt_bgimg');
  applyBgImage(null);
  syncBgPreview(null);
});

// ── Background effect handlers ────────────────────────────────────────────────
function syncBgEffectChips() {
  const cur = (db.settings && db.settings.bgEffect) || 'none';
  document.querySelectorAll('.bg-effect-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.fx === cur));
}
document.getElementById('bg-effect-row').addEventListener('click', e => {
  const btn = e.target.closest('.bg-effect-chip');
  if (!btn) return;
  const fx = btn.dataset.fx;
  if (!db.settings) db.settings = {};
  db.settings.bgEffect = fx;
  save(db);
  syncProfile();
  applyBgEffect(fx);
  syncBgEffectChips();
});

function syncBgPreview(dataUrl) {
  const preview = document.getElementById('bg-img-preview');
  const thumb   = document.getElementById('bg-img-thumb');
  if (dataUrl) {
    thumb.style.backgroundImage = `url(${dataUrl})`;
    preview.style.display = 'flex';
  } else {
    thumb.style.backgroundImage = '';
    preview.style.display = 'none';
  }
}

bindPwToggle('recovery-pw-toggle',        'recovery-pw-new');
bindPwToggle('recovery-pw-confirm-toggle','recovery-pw-confirm');

})();

