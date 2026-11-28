import { Turntable, LAYOUTS } from './deck3d.js';
import { MATERIALS, VINYLS, ROOMS, METALS, asset } from './materials.js';
import { SpotifySource, parseSpotify } from './sources/spotify.js';
import { YouTubeSource, parseYouTube, searchYouTube } from './sources/youtube.js';
import { LocalSource } from './sources/local.js';
import { fetchLyrics } from './lyrics.js';

const $ = (s) => document.querySelector(s);
const body = document.body;

// ---------- settings ----------
const PREFS_KEY = 'vinyl.prefs.v2';
const prefs = Object.assign({
  material: 'walnut', vinyl: 'black', room: 'cream', lyrics: true, lid: false, focus: false, focusLyrics: false,
  clock: false, motion: true, glow: true, blur: 8, rpm: 33, metal: 'silver', layout: 'classic', quality: 'auto', volume: .8, ytPanel: false, ytGhost: false,
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
// every click or key press can unlock the Spotify player's audio (see SpotifySource.unlockAudio)
for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => spotify.unlockAudio(), { capture: true });
spotify.onNotice = (kind, message) => {
  if (kind === 'autoplay') { toast('Click anywhere to start the music.'); return; }
  // the browser's DRM licence was refused mid-song (Zen, for one, has no Widevine licence yet)
  if (kind === 'playback-error') toast(`Spotify stopped: this browser's protected-audio licence was refused${message ? ` (${message})` : ''}. Spotify plays fully in Firefox, Chrome and Edge.`, true);
};
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
  rebake(true);
};

// ---------- picture quality ----------
const QUALITY = [['auto', 'Auto'], ['high', 'High'], ['balanced', 'Balanced'], ['low', 'Battery']];
const TIER_NAME = { high: 'high', balanced: 'balanced', low: 'battery' };
function qualityNote() {
  const pct = Math.round(tt.renderer.getPixelRatio() / Math.min(devicePixelRatio || 1, tt.T.dpr) * 100);
  $('#quality-note').textContent = prefs.quality === 'auto'
    ? `Auto picked ${TIER_NAME[tt.tier]}${pct < 99 ? `, drawn at ${pct} %` : ''}. It lowers the resolution if frames run late and raises it again when there is room.`
    : 'Fixed. Auto adapts to the device instead.';
}
// the lighter tiers also drop the live blur behind the glass panels: the browser redoes it every frame
// over the moving deck, which costs a TV or a phone more than the deck itself
tt.onTier = (tier) => { body.classList.toggle('fx-lite', tier !== 'high'); qualityNote(); };
tt.onScale = () => qualityNote();
tt.setQuality(prefs.quality);

// ?debug: frame rate, GPU and CPU time, draw calls, what the quality system decided
if (new URLSearchParams(location.search).has('debug')) {
  window.tt = tt;                 // for poking at it from the console
  const hud = document.createElement('pre');
  hud.id = 'hud';
  document.body.append(hud);
  let prev = { ...tt.stats }, at = performance.now();
  setInterval(() => {
    const s = tt.stats, now = performance.now(), sec = (now - at) / 1000;
    const per = (k) => ((s[k] - prev[k]) / sec).toFixed(1);
    const drawn = s.drawn - prev.drawn, rested = s.skipped - prev.skipped;
    const cv = tt.renderer.domElement;
    hud.textContent = [
      `tier     ${tt.tier}${tt.quality === 'auto' ? ' (auto)' : ''}   scale ${Math.round([1, .85, .72, .6][tt.scaleIx] * 100)}%`,
      `pixels   ${tt.renderer.getPixelRatio().toFixed(2)}x  ${cv.width}x${cv.height}  dpr ${devicePixelRatio}`,
      `fps      ${s.fps.toFixed(0)}  refresh ${tt.refreshHz || '?'} Hz`,
      `gpu      ${s.gpu == null ? 'n/a' : s.gpu.toFixed(2) + ' ms'}   cpu ${s.cpu.toFixed(2)} ms`,
      `calls    ${s.calls}   tris ${(s.tris / 1000).toFixed(0)}k`,
      `aa       ${tt.T.msaa ? 'msaa' + tt.T.msaa : tt.T.aa}${tt.accum.enabled ? `  accum ${tt.accum.n}/${tt.accum.max}` : ''}${tt.sharpen.enabled ? `  sharpen ${tt.sharpenAmount.toFixed(2)}` : ''}`,
      `ao       ${tt.ao.enabled ? per('ao') + '/s' : 'off'}   shadows ${per('shadows')}/s`,
      `drawn    ${(drawn / sec).toFixed(1)}/s   resting ${drawn + rested ? Math.round(rested / (drawn + rested) * 100) : 0}%   dust only ${per('fx')}/s`,
      `build    ${s.build} ms   programs ${tt.renderer.info.programs?.length}`,
    ].join('\n');
    prev = { ...s }; at = now;
  }, 500);
}

function placeDeck(instant = false) {
  const r = $('#deck-zone').getBoundingClientRect();
  tt.setRegion({ x: r.left, y: r.top, w: r.width, h: r.height }, instant);
}
new ResizeObserver(() => placeDeck(true)).observe(document.documentElement);

function applyLook() {
  const m = MATERIALS.find((x) => x.id === prefs.material) || MATERIALS[0];
  const v = VINYLS.find((x) => x.id === prefs.vinyl) || VINYLS[0];
  tt.applyMaterial({ ...m, metal: prefs.metal }, v);
  tt.setLayout(prefs.layout);
  document.querySelectorAll('.layout-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === tt.layoutId)));
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
// The photo is blurred and given the cover's glow once, into a picture, instead of the browser blurring
// a full-screen layer and soft-light blending a glow under the live deck on every frame.
const canBake = (() => {
  try { const g = document.createElement('canvas').getContext('2d'); g.filter = 'blur(2px)'; return g.filter === 'blur(2px)'; } catch { return false; }
})();
let roomPhoto = null, bakeTimer, bakeSeq = 0;
const bakedUrls = new Set();
function bakeRoom(img) {
  // .room-img is inset by -4 %; background-size: cover gives CSS px per photo px
  const W = innerWidth * 1.08, H = innerHeight * 1.08, nw = img.naturalWidth, nh = img.naturalHeight;
  if (!W || !H || !nw || !nh) return Promise.resolve(null);   // a hidden window has no size yet
  const cover = Math.max(W / nw, H / nh), blur = prefs.blur;
  const cw = blur >= 6 ? 960 : blur >= 2 ? 1440 : nw, k = cw / nw, ch = Math.round(nh * k);
  const r = blur * k / cover, pad = Math.ceil(r * 3) + 1;
  // a bleed around the photo, so the blur never pulls transparency in from the edges
  const src = document.createElement('canvas'); src.width = cw + 2 * pad; src.height = ch + 2 * pad;
  const sg = src.getContext('2d');
  sg.drawImage(img, 0, 0, src.width, src.height);
  sg.drawImage(img, pad, pad, cw, ch);
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  g.filter = `blur(${r.toFixed(2)}px) saturate(1.04)`;
  g.drawImage(src, -pad, -pad);
  g.filter = 'none';
  const album = getComputedStyle(document.documentElement).getPropertyValue('--album').trim();
  if (prefs.glow && album && album !== 'transparent') {
    // the same glow as .room-glow: soft-light, 55 %, an ellipse 48 % x 60 % at 66 % 48 %
    g.fillStyle = album; const solid = g.fillStyle;
    g.save();
    g.globalCompositeOperation = 'soft-light'; g.globalAlpha = .55;
    g.translate(cw * .66, ch * .48); g.scale(1, (.6 * ch) / (.48 * cw));
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, .48 * cw);
    gr.addColorStop(0, solid); gr.addColorStop(.7, solid.startsWith('#') ? `${solid}00` : 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(-cw * 2, -ch * 4, cw * 4, ch * 8);
    g.restore();
  }
  return new Promise((res) => cv.toBlob((b) => res(b ? URL.createObjectURL(b) : null), 'image/jpeg', .9));
}
// show a newly baked backdrop: crossfaded for a new room or cover, straight away while dragging the blur
function showRoom(url, fade) {
  const layers = $('#room').querySelectorAll('.room-img');
  const [shown, hidden] = layers[0].classList.contains('on') ? [layers[0], layers[1]] : [layers[1], layers[0]];
  const target = fade ? hidden : shown;
  const old = target.dataset.url;
  target.style.backgroundImage = `url("${url}")`;
  target.dataset.url = url;
  if (fade) { hidden.classList.add('on'); shown.classList.remove('on'); }
  if (old && bakedUrls.has(old)) setTimeout(() => { URL.revokeObjectURL(old); bakedUrls.delete(old); }, 2000);
}
function rebake(fade, delay = 60) {
  if (!canBake || !roomPhoto) return;
  clearTimeout(bakeTimer);
  bakeTimer = setTimeout(async () => {
    const seq = ++bakeSeq, photo = roomPhoto, url = await bakeRoom(photo);
    if (!url) return;
    bakedUrls.add(url);
    if (seq !== bakeSeq || photo !== roomPhoto) { URL.revokeObjectURL(url); bakedUrls.delete(url); return; }
    showRoom(url, fade);
  }, delay);
}
addEventListener('resize', () => rebake(false, 400));

function applyRoom() {
  const room = ROOMS.find((r) => r.id === prefs.room) || ROOMS[0];
  const el = $('#room');
  el.classList.toggle('plain', !room.img);
  body.classList.toggle('tone-light', room.tone === 'light');
  body.classList.toggle('tone-dark', room.tone !== 'light');
  tt.setRoom({ id: room.id, img: room.img ? asset(room.img) : null, light: room.light });
  document.querySelector('meta[name=theme-color]').content = room.tone === 'light' ? '#efe9df' : '#17130f';
  document.documentElement.style.setProperty('--blur', `${prefs.blur}px`);
  el.classList.toggle('baked', canBake);
  if (room.img) {
    const img = new Image();
    img.onload = () => {
      if ((ROOMS.find((r) => r.id === prefs.room) || ROOMS[0]) !== room) return;   // another room was picked meanwhile
      roomPhoto = img;
      if (canBake) rebake(true, 0); else showRoom(img.src, true);
    };
    img.src = asset(room.img);
  } else roomPhoto = null;
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
  setTimeout(refreshQueue, 800);
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
  $('#sp-simple').hidden = !spotify.builtIn;
  $('#sp-dev').hidden = spotify.builtIn;
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
    // a YouTube "album" is the channel name: leave it out of the lookup
    const r = await fetchLyrics(active === youtube ? { ...t, album: '' } : t, lyricCtl.signal);
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
    queueTick(pos);
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
const next = () => { if (playNextQueued()) return; if (active) run(() => active.next()); };
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
const GROUPS = { library: 'Your library', spotify: 'Songs', artist: 'Artists', album: 'Albums', playlist: 'Playlists', youtube: 'YouTube', preview: '30-second previews' };
const groupOf = (r) => r.group || (r.source === 'spotify' ? (r.kind === 'track' ? 'spotify' : r.kind) : r.source);
// Liked Songs has no cover of its own: the app's violet tile with a heart
const LIKED_ART = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a2fc9"/><stop offset="1" stop-color="#b9a9f0"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><path d="M32 45s-12-7.3-12-15.2A6.8 6.8 0 0 1 32 26a6.8 6.8 0 0 1 12 3.8C44 37.7 32 45 32 45z" fill="#fff"/></svg>')}`;
const artOf = (r, big) => (r.kind === 'liked' ? LIKED_ART : big ? r.art || r.thumb : r.thumb || r.art);
const queueable = (r) => !r.act && r.kind !== 'artist';
function rowFor(r) {
  const img = document.createElement('img'); img.alt = ''; img.loading = 'lazy';
  const src = artOf(r); if (src) img.src = src;
  if (r.kind === 'artist') img.className = 'round';
  const t = document.createElement('div'); t.className = 't';
  const b = document.createElement('b'); b.textContent = r.title;
  const s = document.createElement('small'); s.textContent = [r.artist, r.album].filter(Boolean).join(' · ');
  t.append(b, s);
  return [img, t];
}
function renderResults(note) {
  const ul = $('#results');
  ul.replaceChildren();
  if (note) { const li = document.createElement('li'); li.className = 'note'; li.textContent = note; ul.append(li); }
  let group = '';
  results.forEach((r, i) => {
    if (groupOf(r) !== group) {
      group = groupOf(r);
      const h = document.createElement('li'); h.className = 'group'; h.setAttribute('role', 'presentation'); h.textContent = GROUPS[group] || group;
      ul.append(h);
    }
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.i = i;
    li.setAttribute('aria-selected', String(i === sel));
    li.append(...rowFor(r));
    if (queueable(r)) {
      const add = document.createElement('button');
      add.className = 'q-add'; add.type = 'button'; add.tabIndex = -1;
      add.setAttribute('aria-label', 'Add to queue'); add.title = 'Add to queue  (right-click, or Shift+Enter)';
      add.innerHTML = '<svg><use href="#i-plus"/></svg>';
      add.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); if (e.button === 0) addToQueue(r); });
      li.append(add);
    }
    // a right click queues, like the app's context menu; only the main button plays
    li.addEventListener('pointerdown', (e) => { e.preventDefault(); if (e.button === 0) choose(i); });
    li.addEventListener('contextmenu', (e) => { e.preventDefault(); if (queueable(r)) addToQueue(r); });
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
    const [sp, mine, yt, it] = await Promise.all([
      spotify.connected ? quiet(spotify.search(q)) : null,
      spotify.connected && !spotify.needsReconnect ? quiet(spotify.library()) : [],
      quiet(searchYouTube(q, signal, 8)),
      spotify.connected ? [] : quiet(itunes(q, signal)),
    ]);
    if (signal.aborted) return;
    // like the app: your own playlists and albums that match first, then songs, artists, albums, playlists
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = (mine || []).filter((x) => words.every((w) => x.title.toLowerCase().includes(w))).slice(0, 6).map((x) => ({ ...x, group: 'library' }));
    const own = new Set(hits.map((x) => x.uri));
    results = [
      ...hits, ...(sp?.tracks || []), ...(sp?.artists || []).slice(0, 3),
      ...(sp?.albums || []).filter((x) => !own.has(x.uri)).slice(0, 4), ...(sp?.playlists || []).filter((x) => !own.has(x.uri)).slice(0, 4),
      ...yt, ...it,
    ];
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
  play(r, list);
}
// plays a result, a library item, a link or a queued song; previews play on through their search's list
let playAskedAt = -1e9;
function play(r, list = [r]) {
  if (r.act) { r.act(); return; }
  playAskedAt = performance.now();
  if (r.source === 'spotify') {
    if (!spotify.connected) { toast('Connect Spotify to play Spotify links.', true); openSheet('sources'); return; }
    spotify.prime();
    run(async () => { activate(spotify); spotify.start(); await spotify.playItem(r); });
  } else if (r.source === 'youtube') {
    run(async () => { activate(youtube); await youtube.load(r.id); });
  } else {
    const items = list.includes(r) ? list : [r];
    run(async () => { activate(local); await local.loadItems(items, items.indexOf(r), 'preview'); });
  }
}
// With an empty search box, the box shows your library: Liked Songs, your playlists and saved albums
async function showLibrary() {
  if (!spotify.connected || $('#q').value.trim()) return;
  if (spotify.needsReconnect) {
    results = [{ source: 'spotify', kind: 'liked', group: 'library', title: 'Show your playlists here', artist: 'Connect Spotify once more to allow it', act: () => spotify.login() }];
    sel = -1; renderResults(); return;
  }
  const items = await spotify.library().catch(() => null);
  if (!items?.length || $('#q').value.trim() || document.activeElement !== $('#q')) return;
  results = items.slice(0, 60).map((x) => ({ ...x, group: 'library' }));
  sel = -1;
  renderResults();
}
function submitQuery(text) {
  const q = text.trim();
  if (!q) return;
  if (parseYouTube(q)) {
    closeResults(); $('#q').value = ''; $('#q').blur();
    run(async () => { activate(youtube); await youtube.load(q); });
    return;
  }
  // any Spotify link: a song or episode plays, an album, playlist, artist or show plays from its start
  const sp = parseSpotify(q);
  if (sp) {
    closeResults(); $('#q').value = ''; $('#q').blur();
    play({ source: 'spotify', kind: sp.type === 'show' ? 'playlist' : sp.type, uri: sp.uri, id: sp.id, title: '' });
    return;
  }
  if (sel >= 0) choose(sel); else search(q);
}
$('#q').addEventListener('focus', () => showLibrary());
// a pasted link opens at once
$('#q').addEventListener('paste', () => setTimeout(() => {
  const q = $('#q').value.trim();
  if (parseSpotify(q) || parseYouTube(q)) submitQuery(q);
}, 0));
$('#q').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) { closeResults(); showLibrary(); return; }
  if (/^https?:|^spotify:|youtu/.test(q)) { closeResults(); return; }
  searchTimer = setTimeout(() => search(q), 260);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!results.length) return;
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    markSelected();
  } else if (e.key === 'Enter' && e.shiftKey && results[sel]) { e.preventDefault(); if (queueable(results[sel])) addToQueue(results[sel]); }
  else if (e.key === 'Enter') { e.preventDefault(); submitQuery(e.target.value); }
  else if (e.key === 'Escape') { closeResults(); e.target.blur(); }
});
$('#q').addEventListener('blur', () => setTimeout(closeResults, 120));

// ---------- queue ----------
// While Spotify plays and nothing else waits, Spotify songs go into Spotify's own queue, so they behave
// as in the app (and show up there). Everything else waits here, in order: YouTube videos, previews,
// and Spotify songs queued while something else plays. Queued songs come before what the album,
// playlist or radio would play next, and Next skips to them, as in the app.
const upNext = [];
let spotifyNext = [], queueTimer;
async function addToQueue(r) {
  if (!queueable(r)) return;
  // nothing playing (and nothing just asked to start): it plays now instead of waiting
  if (!active || (!state.track && performance.now() - playAskedAt > 8000)) { play(r); return; }
  if (r.source === 'spotify' && active === spotify && !upNext.length) {
    await run(async () => {
      const n = await spotify.addToQueue(r);
      toast(n > 1 ? `${n} songs added to the queue` : n ? `Added to the queue: ${r.title}` : 'Nothing to add.');
      refreshQueue();
    });
    return;
  }
  upNext.push(r);
  toast(`Added to the queue: ${r.title}`);
  renderQueue();
}
function playNextQueued() {
  const r = upNext.shift();
  if (!r) return false;
  renderQueue();
  play(r);
  return true;
}
youtube.onEnded = () => playNextQueued();
local.onEnded = () => playNextQueued();
// Spotify gives no "ended" signal to a page: a waiting song takes over in the last second
let handingOver = false;
function queueTick(pos) {
  const t = state.track;
  if (handingOver || active !== spotify || !upNext.length || !state.playing || !t?.duration || t.duration - pos > 1200) return;
  handingOver = true;
  playNextQueued();
  setTimeout(() => { handingOver = false; }, 4000);
}

async function refreshQueue() {
  if ($('#queue-pop').hidden) return;
  // without Spotify's phantom entries: the playing song repeated when nothing is lined up
  spotifyNext = active === spotify && spotify.connected
    ? spotify.realNext(await spotify.queue().catch(() => []), state.track) : [];
  renderQueue();
}
function queueRow(r, { onPlay, onRemove } = {}) {
  const li = document.createElement('li');
  li.append(...rowFor(r));
  if (onPlay) { li.classList.add('can'); li.addEventListener('click', onPlay); }
  if (onRemove) {
    const x = document.createElement('button');
    x.className = 'q-x'; x.type = 'button'; x.setAttribute('aria-label', `Remove ${r.title} from the queue`); x.title = 'Remove';
    x.innerHTML = '<svg><use href="#i-x"/></svg>';
    x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    li.append(x);
  }
  return li;
}
function renderQueue() {
  const box = $('#queue-list');
  if (!box || $('#queue-pop').hidden) return;
  box.replaceChildren();
  const section = (title) => { const h = document.createElement('li'); h.className = 'group'; h.textContent = title; box.append(h); };
  const t = state.track;
  if (t) {
    section('Now playing');
    const now = queueRow({ title: t.title, artist: t.artist, thumb: t.art, art: t.art });
    now.classList.add('now');
    box.append(now);
  }
  if (upNext.length) {
    section('Next in queue');
    upNext.forEach((r, i) => box.append(queueRow(r, {
      onPlay: () => { upNext.splice(i, 1); play(r); renderQueue(); },
      onRemove: () => { upNext.splice(i, 1); renderQueue(); },
    })));
  }
  if (spotifyNext.length) {
    section(upNext.length ? 'Then, from Spotify' : 'Next up');
    spotifyNext.slice(0, 20).forEach((r) => box.append(queueRow(r, { onPlay: () => play(r) })));
  }
  if (!upNext.length && !spotifyNext.length) {
    const li = document.createElement('li'); li.className = 'note';
    li.textContent = t ? 'Nothing lined up. Right-click a search result, or use its + button, to add it here.'
      : 'Nothing playing. Search for a song, an album or one of your playlists.';
    box.append(li);
  }
}
function placeQueuePop() {
  const b = $('#b-queue').getBoundingClientRect(), pop = $('#queue-pop');
  const left = Math.max(12, Math.min(innerWidth - pop.offsetWidth - 12, b.left + b.width / 2 - pop.offsetWidth / 2));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.bottom = `${Math.round(innerHeight - b.top + 10)}px`;
}
function toggleQueue(open = $('#queue-pop').hidden) {
  $('#queue-pop').hidden = !open;
  $('#b-queue').setAttribute('aria-expanded', String(open));
  clearInterval(queueTimer);
  if (!open) return;
  renderQueue(); placeQueuePop(); refreshQueue();
  queueTimer = setInterval(refreshQueue, 8000);
}
$('#b-queue').addEventListener('click', () => toggleQueue());
addEventListener('pointerdown', (e) => { if (!$('#queue-pop').hidden && !e.target.closest('#queue-pop, #b-queue')) toggleQueue(false); });
addEventListener('resize', () => { if (!$('#queue-pop').hidden) placeQueuePop(); });

// ---------- chrome: idle, focus, fullscreen, lid, lyrics ----------
let idleTimer, idleZoom = null;
function wake() {
  // the idle layout gives the deck more room (see css), so its framing follows the class
  // waking takes back only the idle view's small grow, so a zoom made while idle is kept
  if (body.classList.contains('idle')) { requestAnimationFrame(() => placeDeck()); if (idleZoom != null) { tt.setZoom(tt.zoomTarget / 1.08); idleZoom = null; } }
  body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.querySelector('dialog[open]') || $('#dock').matches(':hover') || !$('#vol-pop').hidden || !$('#queue-pop').hidden || document.activeElement === $('#q')) return;
    body.classList.add('idle');
    requestAnimationFrame(() => placeDeck());
    // and the deck grows a touch, on top of whatever zoom is set; waking gives the zoom back
    if (!prefs.focus && !body.classList.contains('customizing')) { idleZoom = tt.zoomTarget; tt.setZoom(idleZoom * 1.08); }
    setTimeout(() => { lyricIndex = -1; }, 950);   // the lyrics box grew: re-centre the current line
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
// a side sheet closes on a click anywhere outside it; the dock button that opens it toggles it itself
addEventListener('pointerdown', (e) => {
  const side = document.querySelector('dialog.side[open]');
  if (side && !side.contains(e.target) && !e.target.closest('[data-open]')) side.close();
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
  // control layouts, each drawn as a small top view of the plinth (numbers only, from deck3d.js)
  const sketch = (L) => {
    const r = (x, z, w, d) => `<rect x="${x - w / 2}" y="${z - d / 2}" width="${w}" height="${d}" rx=".5"/>`;
    const c = (x, z, rad, cls = '') => `<circle${cls && ` class="${cls}"`} cx="${x}" cy="${z}" r="${rad}"/>`;
    const parts = [];
    if (L.start) parts.push(r(L.start.x, L.start.z, 5.2, 2.6));
    if (L.round) parts.push(c(L.round.x, L.round.z, 1.4));
    for (const [x, z] of L.speeds?.at || []) parts.push(r(x, z, 2.3, 1.3));
    if (L.selector) parts.push(c(L.selector.x, L.selector.z, 1.25));
    parts.push(c(L.knob.x, L.knob.z, 1.55 * L.knob.s));
    if (L.fader) parts.push(r(L.fader.x, L.fader.z, .8, 10));
    parts.push(c(L.lamp.x, L.lamp.z, .75));
    return `<svg viewBox="-24 -19 48 38" aria-hidden="true"><rect class="pl" x="-22.5" y="-17.5" width="45" height="35" rx="1.6"/>`
      + `${c(-5, 0, 15.6, 'pt')}${c(-5, 0, 5, 'pt')}${c(13.6, -11.2, 2.6, 'arm')}<path class="arm" d="M13.6 -11.2 L13.6 10"/><g class="ctl">${parts.join('')}</g></svg>`;
  };
  for (const [id, L] of Object.entries(LAYOUTS)) {
    const b = document.createElement('button');
    b.className = 'layout-card'; b.dataset.id = id; b.setAttribute('role', 'radio');
    b.innerHTML = `${sketch(L)}<b></b><small></small>`;
    b.querySelector('b').textContent = L.name;
    b.querySelector('small').textContent = L.note;
    b.addEventListener('click', () => { prefs.layout = id; save(); applyLook(); });
    $('#layouts').append(b);
  }
  for (const [id, name] of QUALITY) {
    const b = document.createElement('button');
    b.className = 'vinyl-chip text-chip'; b.dataset.id = id; b.setAttribute('role', 'radio'); b.textContent = name;
    b.setAttribute('aria-checked', String(prefs.quality === id));
    b.addEventListener('click', () => {
      prefs.quality = id; save();
      tt.setQuality(id);
      applyLook();               // the wood scans come at the tier's resolution
      document.querySelectorAll('#quality .text-chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === id)));
    });
    $('#quality').append(b);
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
    if (r.img) b.style.backgroundImage = `url("${asset(`${r.img}-thumb`)}")`;
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
  bind('#o-glow', 'glow', () => { body.classList.toggle('glow', prefs.glow && !!tt.albumColor); rebake(true); });
  $('#o-blur').value = prefs.blur;
  $('#o-blur').addEventListener('input', (e) => { prefs.blur = +e.target.value; save(); document.documentElement.style.setProperty('--blur', `${prefs.blur}px`); rebake(false, 120); });

  $('#sp-redirect').textContent = spotify.redirectUri;
  $('#sp-client').value = spotify.clientId;
  $('#sp-copy').addEventListener('click', () => navigator.clipboard?.writeText(spotify.redirectUri).then(() => toast('Redirect URI copied'), () => toast('Copy failed', true)));
  $('#sp-login').addEventListener('click', () => {
    if (/^[0-9a-f]{32}$/i.test(spotify.clientId)) run(() => spotify.login());
    else { openSheet('sources'); $('#sp-client').focus(); }
  });
  $('#sp-login2').addEventListener('click', () => run(() => spotify.login()));
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

// ---------- volume: one level for Spotify, YouTube and files; the deck's knob, the dock slider and
// the - and + keys all set it, and a change made in the Spotify app turns the knob too ----------
let volSave, lastUserVolume = 0;
function setVolume(v, { fromSource = false } = {}) {
  v = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
  prefs.volume = v;
  clearTimeout(volSave); volSave = setTimeout(save, 400);
  tt.volume = v;
  if (!fromSource) { lastUserVolume = Date.now(); spotify.setVolume(v); } else spotify.volume = v;
  youtube.setVolume(v);
  local.setVolume(v);
  const pct = Math.round(v * 100);
  if (+$('#vol').value !== pct) $('#vol').value = pct;
  $('#vol-val').textContent = pct;
  $('#b-vol use').setAttribute('href', v === 0 ? '#i-mute' : v < .45 ? '#i-vol-low' : '#i-vol');
}
tt.onVolume = (v) => setVolume(v);
spotify.onVolume = (v) => { if (Date.now() - lastUserVolume > 2500 && Math.abs(v - prefs.volume) > .005) setVolume(v, { fromSource: true }); };
function placeVolPop() {
  const b = $('#b-vol').getBoundingClientRect(), pop = $('#vol-pop');
  pop.style.left = `${Math.round(b.left + b.width / 2 - pop.offsetWidth / 2)}px`;
  pop.style.bottom = `${Math.round(innerHeight - b.top + 10)}px`;
}
function toggleVolPop(open = $('#vol-pop').hidden) {
  $('#vol-pop').hidden = !open;
  $('#b-vol').setAttribute('aria-expanded', String(open));
  if (open) placeVolPop();
}
$('#b-vol').addEventListener('click', () => toggleVolPop());
$('#vol').addEventListener('input', (e) => setVolume(+e.target.value / 100));
addEventListener('pointerdown', (e) => { if (!$('#vol-pop').hidden && !e.target.closest('#vol-pop, #b-vol')) toggleVolPop(false); });
addEventListener('resize', () => { if (!$('#vol-pop').hidden) placeVolPop(); });
setVolume(prefs.volume, { fromSource: true });

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
  e.preventDefault();
  const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  tt.setZoom(tt.zoomTarget * Math.exp(-step * (e.ctrlKey ? .01 : .0016)));
  showZoom();
}, { passive: false });
$('#deck').addEventListener('dblclick', () => { if (tt.zoomTarget !== 1) { tt.setZoom(1); showZoom(); } });
$('#b-lyrics').addEventListener('click', () => setLyricsOn(!prefs.lyrics));
$('#b-lid').addEventListener('click', () => setLid(!prefs.lid));
$('#b-full').addEventListener('click', toggleFullscreen);
// What brings the controls back: a click, a touch, a key, or a deliberate mouse movement. While the
// idle layout shows, the wheel only zooms and small drifts of the hand are ignored.
let travel = 0, travelAt = 0;
window.addEventListener('pointermove', (e) => {
  if (!body.classList.contains('idle')) { wake(); return; }
  const now = performance.now();
  if (now - travelAt > 600) travel = 0;          // slow drift spread over time does not add up
  travelAt = now;
  travel += Math.hypot(e.movementX || 0, e.movementY || 0);
  if (travel > 220) { travel = 0; wake(); }
}, { passive: true });
for (const ev of ['pointerdown', 'touchstart']) window.addEventListener(ev, wake, { passive: true });
window.addEventListener('wheel', () => { if (!body.classList.contains('idle')) wake(); }, { passive: true });

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
    '-': () => setVolume(prefs.volume - .05), '=': () => setVolume(prefs.volume + .05), '+': () => setVolume(prefs.volume + .05),
    m: () => { cycle(MATERIALS, 'material', e.shiftKey ? -1 : 1); applyLook(); },
    v: () => { cycle(VINYLS, 'vinyl', 1, (v) => `${v.name} pressing`); applyLook(); },
    r: () => { cycle(ROOMS, 'room', 1, (r) => `${r.name} room`); applyRoom(); },
    3: speed(33), 4: speed(45), 7: speed(78),
    s: () => openSheet('sources'), '?': () => openSheet('keys'), Enter: toggleFullscreen, q: () => toggleQueue(),
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

// ---------- install as an app ----------
// Chromium browsers offer installation through this event; the dock button appears only then, and
// disappears once installed or when already running as the app.
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#b-install').hidden = false; });
$('#b-install').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({}));
  if (outcome === 'accepted') $('#b-install').hidden = true;
  installPrompt = null;
});
addEventListener('appinstalled', () => { $('#b-install').hidden = true; toast('Crackle is installed. Open it from your apps.'); });
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => { /* the site still works without it */ });
