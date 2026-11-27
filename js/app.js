import { Turntable } from './deck3d.js';
import { MATERIALS, VINYLS, ROOMS, METALS, asset } from './materials.js';
import { SpotifySource } from './sources/spotify.js';
import { YouTubeSource, parseYouTube, searchYouTube } from './sources/youtube.js';
import { LocalSource } from './sources/local.js';
import { fetchLyrics } from './lyrics.js';

const $ = (s) => document.querySelector(s);
const body = document.body;

// ---------- settings ----------
const PREFS_KEY = 'vinyl.prefs.v2';
const prefs = Object.assign({
  material: 'walnut', vinyl: 'black', room: 'cream', lyrics: true, lid: false, focus: false, focusLyrics: false,
  clock: false, motion: true, glow: true, blur: 8, rpm: 33, metal: 'silver', ytPanel: false, ytGhost: false,
}, (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })());
const save = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };
// rooms renamed when the photographed set replaced the first backdrops
prefs.room = { dawn: 'morning', night: 'reading', studio: 'listening' }[prefs.room] || prefs.room;

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 5000 : 2400);
}

// ---------- playback state and sources ----------
const state = { source: null, track: null, playing: false, position: 0, at: 0, device: '' };
const status = { spotify: 'disconnected', youtube: 'idle', local: 'idle' };
let active = null;
let liveStart = 0;

const onState = (s) => {
  if (s.source !== active?.id) return;
  const prevId = state.track?.id || null;
  Object.assign(state, s, { at: performance.now() });
  if (prevId !== (s.track?.id || null)) onTrackChange();
  if (state.playing) keepAwake();
  renderStatus();
};
const onStatus = (src, st, msg) => {
  if (st !== 'profile') status[src] = st;
  if (msg && st === 'error') toast(msg, true);
  renderStatus();
};

const spotify = new SpotifySource({ onState, onStatus });
const youtube = new YouTubeSource({ onState, onStatus, mount: $('#yt-mount') });
const local = new LocalSource({ onState, onStatus });

function activate(src) {
  if (active && active !== src) {
    active.stop();
    if (active === youtube) $('#yt-card').hidden = true;
    state.track = null; state.playing = false;
    onTrackChange();
  }
  active = src;
  if (src === youtube) $('#yt-card').hidden = false;
  try { localStorage.setItem('vinyl.source', src.id); } catch { /* ignore */ }
  renderStatus();
}

function position() {
  if (!state.track) return 0;
  const p = state.position + (state.playing ? performance.now() - state.at : 0);
  return state.track.duration ? Math.min(p, state.track.duration) : p;
}

// ---------- the deck ----------
const tt = new Turntable($('#deck'), {
  onStartStop: () => togglePlay(),
  onSpeed: (rpm) => { prefs.rpm = rpm; save(); },
  onSeek: (p) => {
    if (!active || !state.track?.duration) return;
    const ms = p * state.track.duration;
    state.position = ms; state.at = performance.now();
    run(() => active.seek(ms));
  },
});
tt.setSpeed(prefs.rpm);
tt.onLabel = (color) => {
  document.documentElement.style.setProperty('--album', color || 'transparent');
  body.classList.toggle('glow', !!color && prefs.glow);
};

function placeDeck(instant = false) {
  const r = $('#deck-zone').getBoundingClientRect();
  tt.setRegion({ x: r.left, y: r.top, w: r.width, h: r.height }, instant);
}
new ResizeObserver(() => placeDeck(true)).observe(document.documentElement);

function applyLook() {
  const m = MATERIALS.find((x) => x.id === prefs.material) || MATERIALS[0];
  const v = VINYLS.find((x) => x.id === prefs.vinyl) || VINYLS[0];
  tt.applyMaterial({ ...m, metal: prefs.metal }, v);
  document.querySelectorAll('.metal-chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === prefs.metal)));
  document.querySelectorAll('.mat-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === m.id)));
  document.querySelectorAll('.vinyl-chip:not(.metal-chip)').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === v.id)));
}
function cycle(list, key, dir = 1, label) {
  const i = list.findIndex((x) => x.id === prefs[key]);
  prefs[key] = list[(i + dir + list.length) % list.length].id;
  save();
  const item = list.find((x) => x.id === prefs[key]);
  toast(label ? label(item) : item.name);
}

// ---------- room ----------
function applyRoom() {
  const room = ROOMS.find((r) => r.id === prefs.room) || ROOMS[0];
  const el = $('#room');
  el.classList.toggle('plain', !room.img);
  body.classList.toggle('tone-light', room.tone === 'light');
  body.classList.toggle('tone-dark', room.tone !== 'light');
  tt.setRoom({ id: room.id, img: room.img ? asset(room.img) : null, light: room.light });
  document.querySelector('meta[name=theme-color]').content = room.tone === 'light' ? '#efe9df' : '#17130f';
  document.documentElement.style.setProperty('--blur', `${prefs.blur}px`);
  if (room.img) {
    const layers = el.querySelectorAll('.room-img');
    const [shown, hidden] = layers[0].classList.contains('on') ? [layers[0], layers[1]] : [layers[1], layers[0]];
    const img = new Image();
    img.onload = () => {
      hidden.style.backgroundImage = `url("${img.src}")`;
      hidden.classList.add('on'); shown.classList.remove('on');
    };
    img.src = asset(room.img);
  }
  document.querySelectorAll('.room-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === room.id)));
}

// ---------- now playing ----------
const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
function swapText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('swap'); void el.offsetWidth; el.classList.add('swap');
}

function onTrackChange() {
  const t = state.track;
  body.classList.toggle('has-track', !!t);
  const cover = $('#cover'), img = cover.querySelector('img');
  if (!t) {
    swapText($('#t-title'), 'Put a record on');
    swapText($('#t-artist'), active ? 'Waiting for something to play.' : 'Search a song, paste a link or drop your files.');
    $('#t-album').textContent = '';
    $('#progress').hidden = true;
    cover.classList.add('empty'); img.hidden = true;
    setLyrics(null, 'idle');
    tt.loaded = false;
    document.title = 'Crackle';
    return;
  }
  swapText($('#t-title'), t.title);
  swapText($('#t-artist'), t.artist || '');
  $('#t-album').textContent = t.album || '';
  $('#progress').hidden = false;
  $('#progress').classList.toggle('live', !!t.live || !t.duration);
  const art = t.art || '';
  if (art) { img.src = art; img.hidden = false; cover.classList.remove('empty'); }
  else { cover.classList.add('empty'); img.hidden = true; }
  liveStart = performance.now();
  tt.setRecord({ key: t.albumKey || t.id, title: t.title, artist: t.artist, art: t.art, artFallback: t.artFallback });
  tt.loaded = true;
  document.title = `${t.title}${t.artist ? ' · ' + t.artist : ''}`;
  if ('mediaSession' in navigator && active !== spotify) {
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: art ? [{ src: art }] : [] }); } catch { /* unsupported */ }
  }
  loadLyrics(t);
}

function renderStatus() {
  const line = $('.src-line'), label = $('#src-label');
  line.classList.remove('live', 'warn', 'bad');
  if (!active) label.textContent = 'no record';
  else {
    const st = status[active.id];
    const names = { spotify: 'spotify', youtube: 'youtube', local: local.kind === 'preview' ? 'preview · 30 s' : 'files' };
    const dev = state.device && active === spotify && st === 'remote' ? ` · ${state.device.toLowerCase()}` : '';
    const extra = { connecting: ' · connecting', error: ' · error', idle: ' · nothing playing' }[st] || '';
    label.textContent = `${names[active.id]}${dev}${extra}`;
    line.classList.add(st === 'error' ? 'bad' : st === 'connecting' ? 'warn' : 'live');
  }
  const badge = (el, st, map) => { const [txt, cls] = map[st] || [st, '']; el.textContent = txt; el.className = `badge mono ${cls}`; };
  badge($('#sp-badge'), status.spotify, {
    disconnected: ['not connected', ''], connecting: ['connecting', 'warn'], ready: ['this screen', 'ok'],
    remote: ['following account', 'ok'], idle: ['nothing playing', ''], error: ['error', 'bad'],
  });
  badge($('#yt-badge'), status.youtube, { idle: ['idle', ''], connecting: ['loading', 'warn'], ready: ['playing', 'ok'], error: ['error', 'bad'] });
  badge($('#lf-badge'), status.local, { idle: ['idle', ''], ready: ['loaded', 'ok'], error: ['error', 'bad'] });
  $('#sp-login').hidden = spotify.connected;
  if (spotify.connected && spotify.user) {
    $('#sp-hint').textContent = spotify.user.premium && spotify.sdkHelp
      ? `Logged in as ${spotify.user.name}. ${spotify.sdkHelp} Until then, songs start in your Spotify app and the turntable follows.`
      : spotify.user.premium
      ? `Logged in as ${spotify.user.name}. Search plays full songs here, or play from any Spotify app and the turntable follows.`
      : `Logged in as ${spotify.user.name}. Playing inside the browser needs Premium; play from any Spotify app and the turntable follows.`;
  } else if (spotify.connected && spotify.sdkHelp) {
    $('#sp-hint').textContent = `${spotify.sdkHelp} Until then, songs start in your Spotify app and the turntable follows.`;
  }
  $('#sp-setup').hidden = spotify.connected;
  $('#sp-connected').hidden = !spotify.connected;
  $('#sp-here').disabled = !spotify.deviceId;
  $('#sp-drm').hidden = spotify.sdkError !== 'drm';
}

// ---------- lyrics ----------
const lyricsShown = () => prefs.lyrics || (prefs.focus && prefs.focusLyrics);
let lyrics = null, lyricIndex = -1, lyricCtl = null;
function setLyrics(result, note = '') {
  lyrics = result && (result.synced.length || result.plain) ? result : null;
  lyricIndex = -1;
  const box = $('#lyrics'), lines = box.querySelector('.lines');
  lines.replaceChildren();
  lines.style.transform = 'translateY(0)';
  box.classList.toggle('plain', !!lyrics && !lyrics.synced.length);
  body.classList.toggle('synced', !!lyrics?.synced.length);
  const add = (cls, text) => { const p = document.createElement('p'); p.className = cls; p.textContent = text; lines.appendChild(p); };
  if (lyrics?.synced.length) lyrics.synced.forEach((l) => add(l.text ? 'ln' : 'ln gap', l.text));
  else if (lyrics) lyrics.plain.split(/\r?\n/).forEach((text) => add('ln', text || ' '));
  else if (note && note !== 'idle') add('note', note);
  box.hidden = !lyricsShown() || note === 'idle';
}
async function loadLyrics(t) {
  lyricCtl?.abort();
  lyricCtl = new AbortController();
  if (t.live) { setLyrics(null, 'live stream'); return; }
  setLyrics(null, 'looking for lyrics');
  try {
    const r = await fetchLyrics(t, lyricCtl.signal);
    if (state.track?.id !== t.id) return;
    setLyrics(r, r?.instrumental ? 'instrumental' : 'no lyrics found');
  } catch (e) {
    if (e.name !== 'AbortError') setLyrics(null, 'lyrics unavailable');
  }
}
function updateLyrics(pos) {
  if (!lyrics || !lyricsShown()) return;
  const box = $('#lyrics'), lines = box.querySelector('.lines');
  if (lyrics.synced.length) {
    const s = lyrics.synced;
    let i = -1;
    for (let k = 0; k < s.length; k++) { if (s[k].t <= pos + 250) i = k; else break; }
    if (i === lyricIndex) return;
    lyricIndex = i;
    [...lines.children].forEach((el, k) => { el.classList.toggle('now', k === i); el.classList.toggle('near', Math.abs(k - i) === 1); });
    const cur = lines.children[Math.max(0, i)];
    if (cur) lines.style.transform = `translateY(${-(cur.offsetTop - box.clientHeight * .3)}px)`;
  } else if (state.track?.duration) {
    const max = lines.scrollHeight - box.clientHeight;
    if (max > 0) lines.style.transform = `translateY(${-(max * Math.min(1, pos / state.track.duration)).toFixed(0)}px)`;
  }
}

// ---------- frame loop: feeds the deck and the panel ----------
let lastText = 0;
const ui = {};
function frame(now) {
  if (!ui.bar) Object.assign(ui, { bar: $('#progress .bar i'), pos: $('#t-pos'), dur: $('#t-dur'), play: $('#b-play'), use: $('#b-play use') });
  const t = state.track;
  const pos = position();
  if (active === youtube || ytMode !== 'card') layoutYt();
  tt.wantSpin = !!t && state.playing;
  if (t && !tt.dragArm) {
    tt.progress = t.duration ? pos / t.duration : ((now - liveStart) / 1000 % 1500) / 1500;
    if (t.duration) {
      const k = Math.min(1, pos / t.duration).toFixed(4);
      if (k !== ui.k) { ui.k = k; ui.bar.style.transform = `scaleX(${k})`; }
    }
  }
  if (now - lastText > 200) {
    lastText = now;
    if (t) {
      ui.pos.textContent = fmt(pos);
      ui.dur.textContent = t.duration ? fmt(t.duration) : 'live';
      updateLyrics(pos);
    }
    const playIcon = state.playing ? '#i-pause' : '#i-play';
    const use = ui.use;
    if (use.getAttribute('href') !== playIcon) {
      use.setAttribute('href', playIcon);
      ui.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    }
  }
  requestAnimationFrame(frame);
}

// ---------- transport ----------
async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message || String(e), true); }
}
function togglePlay() {
  if (!active || !state.track) { $('#q').focus(); return; }
  const wasPlaying = state.playing;
  state.position = position(); state.at = performance.now(); state.playing = !wasPlaying;
  if (active === spotify) spotify.prime();
  run(() => active.toggle(wasPlaying));
}
const next = () => active && run(() => active.next());
const prev = () => active && run(() => active.prev());

// ---------- search: previews without an account, Spotify when connected, links ----------
let searchCtl = null, results = [], sel = -1, searchTimer;
async function itunes(q, signal) {
  const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=12&term=${encodeURIComponent(q)}`, { signal });
  if (!r.ok) throw new Error('Search is unavailable right now.');
  const j = await r.json();
  return j.results.filter((x) => x.previewUrl).map((x) => ({
    source: 'preview', url: x.previewUrl, title: x.trackName, artist: x.artistName, album: x.collectionName || '',
    albumKey: `it-${x.collectionId || x.trackId}`, thumb: x.artworkUrl100,
    art: (x.artworkUrl100 || '').replace(/\/\d+x\d+bb\./, '/1000x1000bb.'),
  }));
}
const GROUPS = { spotify: 'Spotify', youtube: 'YouTube', preview: '30-second previews' };
function renderResults(note) {
  const ul = $('#results');
  ul.replaceChildren();
  if (note) { const li = document.createElement('li'); li.className = 'note'; li.textContent = note; ul.append(li); }
  let group = '';
  results.forEach((r, i) => {
    if (r.source !== group) {
      group = r.source;
      const h = document.createElement('li'); h.className = 'group'; h.setAttribute('role', 'presentation'); h.textContent = GROUPS[group] || group;
      ul.append(h);
    }
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.i = i;
    li.setAttribute('aria-selected', String(i === sel));
    const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy'; if (r.thumb || r.art) img.src = r.thumb || r.art;
    const t = document.createElement('div'); t.className = 't';
    const b = document.createElement('b'); b.textContent = r.title;
    const s = document.createElement('small'); s.textContent = [r.artist, r.album].filter(Boolean).join(' · ');
    t.append(b, s);
    li.append(img, t);
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(i); });
    ul.append(li);
  });
  const open = !!note || results.length > 0;
  ul.hidden = !open;
  body.classList.toggle('searching', open);
  if (open) placeResults();
}
// open the list toward the larger free space and stop it above the screen edge
function placeResults() {
  const ul = $('#results'), box = $('#search').getBoundingClientRect();
  const below = innerHeight - box.bottom - 24, above = box.top - 24;
  const up = below < 360 && above > below;
  ul.classList.toggle('up', up);
  ul.style.maxHeight = `${Math.round(Math.max(180, Math.min(up ? above : below, innerHeight * .72)))}px`;
}
function markSelected() {
  $('#results').querySelectorAll('li[data-i]').forEach((li) => {
    const on = +li.dataset.i === sel;
    li.setAttribute('aria-selected', String(on));
    if (on) li.scrollIntoView({ block: 'nearest' });
  });
}
async function search(q) {
  searchCtl?.abort();
  searchCtl = new AbortController();
  const signal = searchCtl.signal;
  try {
    // Spotify (full songs) when connected, YouTube always; 30 s previews only without Spotify
    const quiet = (p) => p.catch((e) => { if (e.name === 'AbortError') throw e; return []; });
    const [sp, yt, it] = await Promise.all([
      spotify.connected ? quiet(spotify.search(q)) : [],
      quiet(searchYouTube(q, signal, 8)),
      spotify.connected ? [] : quiet(itunes(q, signal)),
    ]);
    if (signal.aborted) return;
    results = [...sp, ...yt, ...it];
    sel = results.length ? 0 : -1;
    renderResults(results.length ? '' : 'Nothing found.');
  } catch (e) {
    if (e.name !== 'AbortError') { results = []; renderResults(e.message); }
  }
}
function closeResults() { $('#results').hidden = true; results = []; sel = -1; body.classList.remove('searching'); }
function choose(i) {
  const r = results[i];
  if (!r) return;
  const list = results.filter((x) => x.source === 'preview');
  closeResults();
  $('#q').value = '';
  $('#q').blur();
  if (r.source === 'spotify') {
    spotify.prime();
    run(async () => { activate(spotify); spotify.start(); await spotify.playUri(r.uri); });
  } else if (r.source === 'youtube') {
    run(async () => { activate(youtube); await youtube.load(r.id); });
  } else {
    run(async () => { activate(local); await local.loadItems(list, list.indexOf(r), 'preview'); });
  }
}
function submitQuery(text) {
  const q = text.trim();
  if (!q) return;
  if (parseYouTube(q)) {
    closeResults(); $('#q').value = ''; $('#q').blur();
    run(async () => { activate(youtube); await youtube.load(q); });
    return;
  }
  const sp = q.match(/open\.spotify\.com\/(?:intl-\w+\/)?track\/([A-Za-z0-9]{22})|spotify:track:([A-Za-z0-9]{22})/);
  if (sp) {
    closeResults(); $('#q').value = '';
    if (!spotify.connected) { toast('Connect Spotify to play Spotify links.', true); openSheet('sources'); return; }
    spotify.prime();
    run(async () => { activate(spotify); spotify.start(); await spotify.playUri(`spotify:track:${sp[1] || sp[2]}`); });
    return;
  }
  if (sel >= 0) choose(sel); else search(q);
}
$('#q').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) { closeResults(); return; }
  if (/^https?:|^spotify:|youtu/.test(q)) { closeResults(); return; }
  searchTimer = setTimeout(() => search(q), 260);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    markSelected();
  } else if (e.key === 'Enter') { e.preventDefault(); submitQuery(e.target.value); }
  else if (e.key === 'Escape') { closeResults(); e.target.blur(); }
});
$('#q').addEventListener('blur', () => setTimeout(closeResults, 120));

// ---------- chrome: idle, focus, fullscreen, lid, lyrics ----------
let idleTimer;
function wake() {
  body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.querySelector('dialog[open]') || $('#dock').matches(':hover') || document.activeElement === $('#q')) return;
    body.classList.add('idle');
    if (document.activeElement?.closest('#dock, #transport')) document.activeElement.blur();
  }, 4000);
}
const setToggle = (id, on) => $(id).setAttribute('aria-pressed', String(on));
function setFocus(on) {
  prefs.focus = on; save();
  body.classList.toggle('focus', on);
  setToggle('#b-focus', on);
  if (!on) tt.setZoom(1);
  if (on && prefs.focusLyrics) setFocusLyrics(false);   // focus starts with the record alone
  syncLyricsBox();
  requestAnimationFrame(() => placeDeck());
}
// focus mode keeps only the record; this button brings back the lyrics alone, on the left
function setFocusLyrics(on) {
  prefs.focusLyrics = on; save();
  body.classList.toggle('focus-lyrics', on);
  setToggle('#b-flyrics', on);
  syncLyricsBox();
  requestAnimationFrame(() => placeDeck());
}
function setLyricsOn(on) {
  prefs.lyrics = on; save();
  body.classList.toggle('lyrics-on', on);
  setToggle('#b-lyrics', on);
  syncLyricsBox();
}
function syncLyricsBox() {
  $('#lyrics').hidden = !lyricsShown() || !state.track;
  lyricIndex = -1;
}
function setLid(on) { prefs.lid = on; save(); tt.setLid(on); setToggle('#b-lid', on); }
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => toast('Full screen is not available here.', true));
}
let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !('wakeLock' in navigator) || document.hidden) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.playing) keepAwake(); });
function tickClock() {
  const c = $('#clock');
  c.hidden = !prefs.clock;
  if (prefs.clock) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 10000);

// ---------- sheets ----------
function openSheet(name) {
  const d = $(`#dlg-${name}`);
  if (!d) return;
  if (d.open) { if (d.classList.contains('side')) d.close(); return; }
  document.querySelectorAll('dialog[open]').forEach((x) => x.close());
  if (d.classList.contains('side')) {
    d.show();
    body.classList.add('customizing');
    tt.setShowcase(true);
    requestAnimationFrame(() => placeDeck());
    d.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
  } else d.showModal();
  wake();
}
function sideClosed() {
  if (document.querySelector('dialog.side[open]')) return;
  body.classList.remove('customizing');
  tt.setShowcase(false);
  requestAnimationFrame(() => placeDeck());
}
document.addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]');
  if (o) openSheet(o.dataset.open);
  const c = e.target.closest('[data-close]');
  if (c) c.closest('dialog').close();
});
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d && !d.classList.contains('side')) d.close(); });
  d.addEventListener('close', wake);
  if (d.classList.contains('side')) d.addEventListener('close', sideClosed);
});

function buildSheets() {
  for (const m of MATERIALS) {
    const b = document.createElement('button');
    b.className = 'mat-card'; b.dataset.id = m.id; b.setAttribute('role', 'radio');
    const sw = document.createElement('div'); sw.className = 'sw';
    if (m.body.tex) sw.style.backgroundImage = `url("${asset(m.body.tex)}")`; else sw.style.background = m.body.color;
    const meta = document.createElement('div'); meta.className = 'meta';
    const name = document.createElement('b'); name.textContent = m.name;
    const note = document.createElement('small'); note.textContent = m.note;
    meta.append(name, note); b.append(sw, meta);
    b.addEventListener('click', () => { prefs.material = m.id; save(); applyLook(); });
    $('#materials').append(b);
  }
  for (const v of VINYLS) {
    const b = document.createElement('button');
    b.className = 'vinyl-chip'; b.dataset.id = v.id; b.setAttribute('role', 'radio');
    const i = document.createElement('i'); i.style.setProperty('--c', v.swatch);
    b.append(i, document.createTextNode(v.name));
    b.addEventListener('click', () => { prefs.vinyl = v.id; save(); applyLook(); });
    $('#vinyls').append(b);
  }
  for (const [id, metal] of Object.entries(METALS)) {
    const b = document.createElement('button');
    b.className = 'vinyl-chip metal-chip'; b.dataset.id = id; b.setAttribute('role', 'radio');
    const i = document.createElement('i'); i.style.setProperty('--c', `linear-gradient(135deg, #fff 0%, ${metal.color} 45%, #333 100%)`);
    b.append(i, document.createTextNode(metal.name));
    b.addEventListener('click', () => { prefs.metal = id; save(); applyLook(); });
    $('#metals').append(b);
  }
  for (const r of ROOMS) {
    const b = document.createElement('button');
    b.className = `room-card${r.img ? '' : ' plain'}`; b.dataset.id = r.id; b.setAttribute('role', 'radio');
    if (r.img) b.style.backgroundImage = `url("${asset(r.img)}")`;
    const s = document.createElement('span'); s.textContent = r.name; b.append(s);
    b.addEventListener('click', () => { prefs.room = r.id; save(); applyRoom(); });
    $('#rooms').append(b);
  }
  const bind = (id, key, after) => {
    const el = $(id);
    el.checked = !!prefs[key];
    el.addEventListener('change', () => { prefs[key] = el.checked; save(); after?.(); });
  };
  bind('#o-clock', 'clock', tickClock);
  bind('#o-ytpanel', 'ytPanel', layoutYt);
  bind('#o-ytghost', 'ytGhost', layoutYt);
  bind('#o-motion', 'motion', () => { tt.followPointer = prefs.motion; });
  bind('#o-glow', 'glow', () => body.classList.toggle('glow', prefs.glow && !!tt.albumColor));
  $('#o-blur').value = prefs.blur;
  $('#o-blur').addEventListener('input', (e) => { prefs.blur = +e.target.value; save(); document.documentElement.style.setProperty('--blur', `${prefs.blur}px`); });

  $('#sp-redirect').textContent = spotify.redirectUri;
  $('#sp-client').value = spotify.clientId;
  $('#sp-copy').addEventListener('click', () => navigator.clipboard?.writeText(spotify.redirectUri).then(() => toast('Redirect URI copied'), () => toast('Copy failed', true)));
  $('#sp-login').addEventListener('click', () => {
    if (/^[0-9a-f]{32}$/i.test(spotify.clientId)) run(() => spotify.login());
    else { openSheet('sources'); $('#sp-client').focus(); }
  });
  $('#sp-form').addEventListener('submit', (e) => { e.preventDefault(); spotify.clientId = $('#sp-client').value; run(() => spotify.login()); });
  $('#sp-here').addEventListener('click', () => spotify.prime() || run(async () => { activate(spotify); spotify.start(); await spotify.playHere(); }));
  $('#sp-drm').addEventListener('click', () => run(async () => {
    const ok = await spotify.requestDrm();
    toast(ok ? 'Protected playback allowed. Starting the player.' : 'The browser did not allow it. Turn on DRM in its settings, then reload.', !ok);
    renderStatus();
  }));
  $('#sp-out').addEventListener('click', () => { spotify.logout(); if (active === spotify) { active = null; state.track = null; onTrackChange(); } renderStatus(); });
  for (const [label, url] of [['lofi hip hop radio', 'https://www.youtube.com/watch?v=jfKfPfyJRdk'], ['jazz café', 'https://www.youtube.com/watch?v=Dx5qFachd3A']]) {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'chip'; c.textContent = label;
    c.addEventListener('click', () => { $('#dlg-sources').close(); submitQuery(url); });
    $('#yt-suggest').append(c);
  }
  const loadFiles = (files) => run(async () => { activate(local); await local.load(files); $('#dlg-sources').close(); });
  $('#lf-input').addEventListener('change', (e) => { if (e.target.files.length) loadFiles(e.target.files); e.target.value = ''; });
  window.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('dragging'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) body.classList.remove('dragging'); });
  window.addEventListener('drop', (e) => { e.preventDefault(); body.classList.remove('dragging'); if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); });
}

// ---------- YouTube mini player: drag it by its grip; position is kept as a fraction of the screen ----------
function placeYtCard() {
  const card = $('#yt-card');
  if (!prefs.ytPos || card.classList.contains('in-panel') || card.classList.contains('ghost')) return;
  const w = card.offsetWidth || 320, h = card.offsetHeight || 216;
  const x = Math.max(8, Math.min(innerWidth - w - 8, prefs.ytPos.x * innerWidth));
  const y = Math.max(8, Math.min(innerHeight - h - 8, prefs.ytPos.y * innerHeight));
  Object.assign(card.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
}
// Where the YouTube player is drawn: the floating card (default), the cover's slot in the panel, or a
// see-through full-screen ghost over the record at full zoom in focus mode. The iframe itself never
// moves in the DOM (moving it would reload the video); only its box on screen changes.
const narrowLayout = matchMedia('(max-width: 900px), (max-aspect-ratio: 1/1)');
let ytMode = 'card';
function layoutYt() {
  const card = $('#yt-card');
  const on = active === youtube && !card.hidden;
  const ghost = on && prefs.ytGhost && prefs.focus && tt.zoomTarget >= 3.1;
  const panel = on && !ghost && prefs.ytPanel && !prefs.focus && !body.classList.contains('customizing') && !narrowLayout.matches;
  const mode = ghost ? 'ghost' : panel ? 'panel' : 'card';
  body.classList.toggle('yt-panel', panel);
  if (mode !== ytMode) {
    ytMode = mode;
    card.classList.toggle('ghost', ghost);
    card.classList.toggle('in-panel', panel);
    card.removeAttribute('style');
    if (mode === 'card') placeYtCard();
  }
  if (panel) {
    const r = $('#yt-slot').getBoundingClientRect(), st = card.style;
    const px = (v) => `${Math.round(v)}px`;
    if (st.left !== px(r.left) || st.top !== px(r.top) || st.width !== px(r.width) || st.height !== px(r.height)) {
      Object.assign(st, { left: px(r.left), top: px(r.top), width: px(r.width), height: px(r.height), right: 'auto', bottom: 'auto' });
    }
  }
}
(() => {
  const card = $('#yt-card'), grip = card.querySelector('.yt-grip');
  let start = null;
  grip.addEventListener('pointerdown', (e) => {
    const r = card.getBoundingClientRect();
    start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    grip.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    prefs.ytPos = { x: (e.clientX - start.dx) / innerWidth, y: (e.clientY - start.dy) / innerHeight };
    placeYtCard();
  });
  const end = () => { if (!start) return; start = null; card.classList.remove('dragging'); save(); };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  addEventListener('resize', placeYtCard);
  placeYtCard();
})();

// ---------- input ----------
$('#b-play').addEventListener('click', togglePlay);
$('#b-next').addEventListener('click', next);
$('#b-prev').addEventListener('click', prev);
$('#b-focus').addEventListener('click', () => setFocus(!prefs.focus));
$('#b-flyrics').addEventListener('click', () => setFocusLyrics(!prefs.focusLyrics));

// focus mode: the wheel (or a pinch) moves the camera closer to the record; double-click resets
let zoomTip;
function showZoom() {
  const el = $('#zoom-level');
  el.textContent = `${tt.zoomTarget.toFixed(1)}×`;
  el.classList.add('show');
  clearTimeout(zoomTip);
  zoomTip = setTimeout(() => el.classList.remove('show'), 900);
}
$('#deck').addEventListener('wheel', (e) => {
  if (!prefs.focus) return;
  e.preventDefault();
  const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  tt.setZoom(tt.zoomTarget * Math.exp(-step * (e.ctrlKey ? .01 : .0016)));
  showZoom();
  wake();
}, { passive: false });
$('#deck').addEventListener('dblclick', () => { if (prefs.focus && tt.zoomTarget !== 1) { tt.setZoom(1); showZoom(); } });
$('#b-lyrics').addEventListener('click', () => setLyricsOn(!prefs.lyrics));
$('#b-lid').addEventListener('click', () => setLid(!prefs.lid));
$('#b-full').addEventListener('click', toggleFullscreen);
for (const ev of ['pointermove', 'pointerdown', 'wheel', 'touchstart']) window.addEventListener(ev, wake, { passive: true });

window.addEventListener('keydown', (e) => {
  const typing = e.target.matches?.('input, textarea');
  const wasIdle = body.classList.contains('idle');
  wake();
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const side = document.querySelector('dialog.side[open]');
  if (side && e.key === 'Escape') { e.preventDefault(); side.close(); return; }
  if (document.querySelector('dialog[open]:not(.side)')) return;
  const onControl = e.target.closest?.('#dock button, #transport button');
  if (wasIdle && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); $('#b-play').focus(); return; }
  if (onControl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const btns = [...document.querySelectorAll('#transport button, #dock button')];
    const i = btns.indexOf(onControl);
    btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length].focus();
    e.preventDefault(); return;
  }
  if (onControl && e.key === 'ArrowUp') { onControl.blur(); e.preventDefault(); return; }
  if (onControl && (e.key === 'Enter' || e.key === ' ')) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const speed = (rpm) => () => { tt.setSpeed(rpm); prefs.rpm = rpm; save(); };
  const map = {
    ' ': togglePlay, k: togglePlay, MediaPlayPause: togglePlay,
    ArrowRight: next, MediaTrackNext: next, ArrowLeft: prev, MediaTrackPrevious: prev,
    ArrowDown: () => $('#b-play').focus(), '/': () => $('#q').focus(),
    f: () => setFocus(!prefs.focus), c: () => setLid(!prefs.lid),
    l: () => (prefs.focus ? setFocusLyrics(!prefs.focusLyrics) : setLyricsOn(!prefs.lyrics)),
    0: () => tt.setZoom(1),
    m: () => { cycle(MATERIALS, 'material', e.shiftKey ? -1 : 1); applyLook(); },
    v: () => { cycle(VINYLS, 'vinyl', 1, (v) => `${v.name} pressing`); applyLook(); },
    r: () => { cycle(ROOMS, 'room', 1, (r) => `${r.name} room`); applyRoom(); },
    3: speed(33), 4: speed(45), 7: speed(78),
    s: () => openSheet('sources'), '?': () => openSheet('keys'), Enter: toggleFullscreen,
  };
  const fn = map[k];
  if (fn) { e.preventDefault(); fn(); }
});

// ---------- boot ----------
buildSheets();
applyLook();
applyRoom();
setFocus(prefs.focus);
setFocusLyrics(false);
setLyricsOn(prefs.lyrics);
setLid(prefs.lid);
tickClock();
renderStatus();
placeDeck(true);
tt.followPointer = prefs.motion;
wake();
requestAnimationFrame(frame);
setTimeout(() => body.classList.remove('booting'), 250);

(async () => {
  try { if (await spotify.handleRedirect()) toast('Spotify connected'); } catch (e) { toast(e.message, true); }
  let last = null;
  try { last = localStorage.getItem('vinyl.source'); } catch { /* ignore */ }
  if (spotify.connected && (!last || last === 'spotify')) { activate(spotify); spotify.start(); }
  else spotify.warm();
})();

window.vinyl = { tt, state, prefs, activate, sources: { spotify, youtube, local } };
