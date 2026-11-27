// Spotify: Authorization Code + PKCE in the browser (no server, no secret).
// Two modes, picked automatically:
//  - "here": Web Playback SDK turns this page into a Spotify Connect device (Premium).
//  - "remote": mirrors whatever is playing on the account (phone, desktop) by polling.

import { SPOTIFY_CLIENT_ID } from '../config.js';

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
].join(' ');
const K = { client: 'vinyl.spotify.client', tok: 'vinyl.spotify.token', ver: 'vinyl.spotify.verifier' };

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// the same page can be opened as /crackle/ or /crackle/index.html: Spotify needs one exact address
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class SpotifySource {
  constructor({ onState, onStatus }) {
    this.id = 'spotify';
    this.onState = onState;
    this.onStatus = onStatus;
    this.deviceId = null;
    this.sdkActive = false;
    this.lastSdkAt = 0;
    this.pollTimer = null;
  }

  get clientId() { return store.get(K.client) || SPOTIFY_CLIENT_ID || ''; }
  set clientId(v) { store.set(K.client, (v || '').trim()); }
  get connected() { return !!store.get(K.tok); }
  // the site ships with its own client ID: visitors only see a login button, never app setup
  get builtIn() { return /^[0-9a-f]{32}$/i.test(SPOTIFY_CLIENT_ID); }
  get redirectUri() { return redirectUri(); }

  async login() {
    if (!/^[0-9a-f]{32}$/i.test(this.clientId)) throw new Error('Add a valid Spotify client ID first.');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    store.set(K.ver, verifier);
    const q = new URLSearchParams({
      client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri(),
      code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES,
    });
    location.assign(`${AUTH}?${q}`);
  }

  // Finish the redirect if this page load carries ?code=. Returns true when tokens were stored.
  async handleRedirect() {
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (!code && !err) return false;
    url.searchParams.delete('code'); url.searchParams.delete('error'); url.searchParams.delete('state');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    if (err) throw new Error(`Spotify sign-in was cancelled (${err}).`);
    const verifier = store.get(K.ver);
    store.del(K.ver);
    if (!verifier) throw new Error('Spotify sign-in expired. Try again.');
    await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
    return true;
  }

  async exchange(params) {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, ...params }),
    });
    if (!res.ok) throw new Error(`Spotify token request failed (${res.status}).`);
    const j = await res.json();
    const prev = store.get(K.tok) || {};
    store.set(K.tok, {
      access: j.access_token,
      refresh: j.refresh_token || prev.refresh,
      expires: Date.now() + (j.expires_in - 60) * 1000,
      scope: j.scope ?? prev.scope,      // what the user actually granted; the player needs "streaming"
    });
  }

  async token() {
    const t = store.get(K.tok);
    if (!t) throw new Error('Not connected to Spotify.');
    if (Date.now() < t.expires) return t.access;
    try {
      await this.exchange({ grant_type: 'refresh_token', refresh_token: t.refresh });
    } catch (e) {
      this.logout();
      throw e;
    }
    return store.get(K.tok).access;
  }

  async api(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${await this.token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    if (res.status === 401) { this.logout(); throw new Error('Spotify session ended. Connect again.'); }
    if (res.status === 403) {
      // 403 is not only "no Premium": Spotify also uses it for commands that do not fit the player's
      // state right now (resume while playing, skip where skipping is not allowed): RESTRICTION_VIOLATED
      let reason = '';
      try { const j = await res.json(); reason = j?.error?.reason || j?.error?.message || ''; } catch { /* no body */ }
      const e = new Error(reason === 'PREMIUM_REQUIRED' ? 'Spotify needs Premium for playback control.'
        : /RESTRICTION/i.test(reason) ? 'Spotify did not allow that right now. Try again in a moment.'
        : `Spotify refused the request${reason ? ` (${reason})` : ''}.`);
      e.status = 403; e.reason = reason;
      throw e;
    }
    if (res.status === 429) throw new Error('Spotify rate limit. Slowing down.');
    if (!res.ok) {
      let reason = '';
      try { const j = await res.json(); reason = j?.error?.reason || j?.error?.message || ''; } catch { /* no body */ }
      const e = new Error(res.status === 404
        ? 'No Spotify device is ready. Open Spotify on any device, or wait a second and try again.'
        : `Spotify request failed (${res.status}${reason ? `: ${reason}` : ''}).`);
      e.status = res.status; e.reason = reason;
      throw e;
    }
    const text = await res.text();
    // some player endpoints answer 200 with a plain-text body instead of JSON or 204
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }

  logout() {
    store.del(K.tok);
    this.stop();
    this.player?.disconnect();
    this.player = null;
    this.sdkActive = false;
    this.onStatus?.('spotify', 'disconnected');
  }

  // Load the in-browser player as soon as an account is connected, so a device exists before the
  // first play request (a play request without a device is answered with 404 NO_ACTIVE_DEVICE).
  warm() {
    if (!this.connected) return;
    this.startSdk().catch(() => { /* remote mode still works */ });
  }

  // Browsers block audio until a user gesture: call this synchronously inside the click handler.
  // The same gesture lets Firefox and its forks show their "allow DRM content" prompt.
  prime() {
    try { this.player?.activateElement?.(); } catch { /* older SDK */ }
    if (!this.drmOk) this.requestDrm();       // asked inside the click, so the browser may prompt
  }

  // Ask the browser for protected playback. Call it from a click: Firefox-family browsers answer with
  // their DRM permission prompt. Once allowed, the in-browser player starts without a reload.
  requestDrm() {
    this.drmPending ||= this.drmAvailable().then((ok) => {
      this.drmPending = null;
      if (ok && this.sdkError === 'drm') { this.resetSdk(); this.startSdk().catch(() => {}); }
      return ok;
    });
    return this.drmPending;
  }

  resetSdk() {
    this.player?.disconnect();
    Object.assign(this, { player: null, sdkPromise: null, sdkFailed: false, sdkError: null, sdkReason: null, deviceId: null, authRetried: false });
  }

  start() {
    this.onStatus?.('spotify', 'connecting');
    if (!this.user) this.api('/me').then((me) => { this.user = { name: me?.display_name || me?.id || '', premium: me?.product === 'premium' }; this.onStatus?.('spotify', 'profile'); }).catch(() => {});
    this.startSdk().catch(() => { /* remote mode still works */ });
    this.poll();
  }

  stop() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  // --- Web Playback SDK ---
  // Spotify's audio is DRM-protected (Widevine). Firefox forks often ship with DRM switched off;
  // without it the Web Playback SDK cannot start, so find that out first and say so plainly.
  async drmAvailable() {
    if (!navigator.requestMediaKeySystemAccess) return false;
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
      }]);
      this.drmOk = true;
      return true;
    } catch { return false; }
  }

  get sdkHelp() {
    if (this.sdkError === 'drm') {
      return /firefox|zen|librewolf|floorp|waterfox/i.test(navigator.userAgent)
        ? 'Protected playback (DRM) is off in this browser, so Spotify cannot play here. Crackle asks for it when you play a song: allow it when the browser asks. Or turn on Settings → General → "Play DRM-controlled content" and reload. Chrome and Edge work out of the box.'
        : 'This browser cannot play protected audio (DRM/Widevine), so Spotify cannot play here. In Brave, enable Widevine in Settings → Extensions. Chrome and Edge work out of the box.';
    }
    if (this.sdkError === 'premium') return 'Playing inside the browser needs Spotify Premium.';
    if (this.sdkReason === 'blocked') return 'Something in this browser is blocking Spotify’s player, usually tracking protection or an ad blocker. Allow this site in it, then reload.';
    if (this.sdkReason === 'account') return 'Spotify does not allow playing inside the browser for this account.';
    if (this.sdkError) return 'Spotify could not start its player in this browser. Chrome and Edge usually work.';
    return '';
  }

  startSdk() {
    if (this.sdkPromise) return this.sdkPromise;
    this.sdkPromise = this.drmAvailable().then((ok) => {
      if (!ok) { this.sdkError = 'drm'; this.onStatus?.('spotify', 'remote'); throw new Error(this.sdkHelp); }
      return this.loadSdk();
    });
    this.sdkPromise.catch(() => { this.sdkFailed = true; });
    return this.sdkPromise;
  }

  loadSdk() {
    return new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => {
        const player = new window.Spotify.Player({
          name: 'Crackle',
          getOAuthToken: (cb) => this.token().then(cb).catch(() => {}),
          volume: 0.8,
        });
        this.player = player;
        player.addListener('ready', ({ device_id }) => {
          this.deviceId = device_id;
          this.onStatus?.('spotify', 'ready');
          resolve();
        });
        player.addListener('not_ready', () => { this.deviceId = null; });
        player.addListener('account_error', () => {
          this.sdkError = 'premium';
          this.onStatus?.('spotify', 'remote');
          reject(new Error('Premium required for in-browser playback.'));
        });
        player.addListener('initialization_error', ({ message }) => { this.sdkError = message || 'initialization error'; this.onStatus?.('spotify', 'remote'); reject(new Error(message)); });
        // the player failed to sign in or connect: find out why once, say it plainly, fall back
        let failed = false;
        const fail = (kind, detail) => {
          if (failed) return;
          failed = true;
          this.sdkError = kind;
          this.diagnose(detail).then((reason) => { this.sdkReason = reason; this.onStatus?.('spotify', 'remote'); reject(new Error(this.sdkHelp)); });
        };
        player.addListener('authentication_error', ({ message }) => {
          // first a fresh token and one reconnect: a token that lapsed between refreshes fails the same way
          if (!this.authRetried) {
            this.authRetried = true;
            this.exchange({ grant_type: 'refresh_token', refresh_token: store.get(K.tok)?.refresh })
              .then(() => { player.disconnect(); return player.connect(); })
              .then((ok) => { if (!ok) fail('auth', message); })
              .catch(() => fail('auth', message));
            return;
          }
          fail('auth', message);
        });
        player.addListener('player_state_changed', (s) => this.fromSdk(s));
        player.connect().then((ok) => { if (!ok && !this.authRetried) fail('connect', 'connect() returned false'); });
      };
      if (!document.querySelector('script[data-spotify-sdk]')) {
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        s.dataset.spotifySdk = '1';
        s.onerror = () => reject(new Error('Could not load the Spotify player.'));
        document.head.appendChild(s);
      } else if (window.Spotify) {
        window.onSpotifyWebPlaybackSDKReady();
      }
    });
  }

  // Why the in-browser player could not start. The player reaches Spotify over apresolve and a dealer
  // websocket (the token rides in its URL); tracking protection and ad blockers often stop exactly
  // these, and the SDK then reports a bare "Authentication failed". The details go to the console.
  async diagnose(detail = '') {
    const status = async (u, opts = {}) => {
      try { return (await fetch(u, { ...opts, signal: AbortSignal.timeout(6000) })).status; } catch { return 0; }
    };
    let dealer = null, hosts = null;
    try { hosts = await (await fetch('https://apresolve.spotify.com/?type=dealer', { signal: AbortSignal.timeout(6000) })).json(); } catch { /* blocked */ }
    if (hosts?.dealer?.length) {
      const tok = await this.token().catch(() => '');
      dealer = await new Promise((res) => {
        let ws;
        const done = (v) => { clearTimeout(timer); try { ws?.close(); } catch { /* closed */ } res(v); };
        const timer = setTimeout(() => done(false), 6000);
        try {
          ws = new WebSocket(`wss://${hosts.dealer[0].replace(/:443$/, '')}/?access_token=${encodeURIComponent(tok)}`);
          ws.onopen = () => done(true);
          ws.onerror = () => done(false);
        } catch { done(false); }
      });
    }
    const scope = await status('https://api.spotify.com/v1/melody/v1/check_scope?scope=web-playback',
      { headers: { Authorization: `Bearer ${await this.token().catch(() => '')}` } });
    const reason = !hosts || dealer === false ? 'blocked' : scope === 403 ? 'account' : 'unknown';
    console.warn('[crackle] Spotify player could not start', { error: this.sdkError, detail, apresolve: !!hosts, dealerSocket: dealer, checkScope: scope, reason, browser: navigator.userAgent });
    return reason;
  }

  // Resolves with this screen's device id, or null when the in-browser player is unavailable.
  async readyDevice(ms = 8000) {
    if (this.deviceId) return this.deviceId;
    // DRM was off: the click that got here has asked for it (prime); if it is allowed now, wait for
    // the player it restarts instead of falling back to another device
    if (this.sdkError === 'drm' || this.drmPending) {
      if (!(await (this.drmPending || this.requestDrm()))) return null;
    }
    if (this.sdkFailed) return null;
    await Promise.race([this.startSdk().catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
    return this.deviceId;
  }

  // Picks where to play: this screen first, then the account's active device, then any device.
  async targetDevice() {
    const here = await this.readyDevice();
    if (here) return here;
    const list = (await this.api('/me/player/devices'))?.devices || [];
    const d = list.find((x) => x.is_active) || list.find((x) => !x.is_restricted);
    if (!d) throw new Error(`${this.sdkHelp ? `${this.sdkHelp} ` : ''}Open Spotify on your phone or computer and try again.`);
    return d.id;
  }

  // A freshly registered device can take a moment to appear in the Web API: retry the 404 briefly.
  async withDevice(fn) {
    const id = await this.targetDevice();
    for (let i = 0; ; i++) {
      try { return await fn(id); } catch (e) {
        if (e.status !== 404 || i >= 3) throw e;
        if (i === 0) await this.api('/me/player', { method: 'PUT', body: { device_ids: [id], play: false } }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600 + i * 500));
      }
    }
  }

  fromSdk(s) {
    if (!s || !s.track_window?.current_track) { this.sdkActive = false; return; }
    this.sdkActive = true;
    this.lastSdkAt = Date.now();
    const t = s.track_window.current_track;
    this.onState(this.mapTrack({
      id: t.id || t.uri, name: t.name, artists: t.artists, album: t.album, duration_ms: s.duration,
    }, { playing: !s.paused, position: s.position, device: 'this screen' }));
  }

  async playHere() {
    const id = await this.readyDevice();
    if (!id) throw new Error(this.sdkHelp || 'This browser cannot play Spotify. Play from your phone and Crackle will follow.');
    await this.api('/me/player', { method: 'PUT', body: { device_ids: [id], play: true } });
  }

  // --- remote mode ---
  async poll() {
    clearTimeout(this.pollTimer);
    let delay = 3000;
    try {
      if (!this.sdkActive || Date.now() - this.lastSdkAt > 8000) {
        const p = await this.api('/me/player?additional_types=episode');
        if (p && p.item) {
          this.onStatus?.('spotify', p.device?.id && p.device.id === this.deviceId ? 'ready' : 'remote');
          this.onState(this.mapTrack(p.item, { playing: p.is_playing, position: p.progress_ms, device: p.device?.name || '' }));
        } else {
          this.onStatus?.('spotify', 'idle');
          this.onState({ source: 'spotify', track: null, playing: false, position: 0 });
          delay = 5000;
        }
      }
    } catch (e) {
      if (!this.connected) return;
      delay = 10000;
      this.onStatus?.('spotify', 'error', e.message);
    }
    this.pollTimer = setTimeout(() => this.poll(), document.hidden ? 15000 : delay);
  }

  mapTrack(item, { playing, position, device }) {
    const album = item.album || item.show || {};
    const images = album.images || item.images || [];
    const art = images.length ? images[0].url : '';
    return {
      source: 'spotify',
      track: {
        id: item.id || item.uri,
        title: item.name || '',
        artist: (item.artists || []).map((a) => a.name).join(', ') || item.show?.publisher || '',
        album: album.name || '',
        albumKey: album.uri || album.name || item.id,
        art: art.startsWith('https://') ? art : '',
        duration: item.duration_ms || 0,
      },
      playing: !!playing,
      position: position || 0,
      device,
    };
  }

  async search(q) {
    const j = await this.api(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
    return (j?.tracks?.items || []).map((t) => ({
      source: 'spotify', uri: t.uri, title: t.name, artist: t.artists.map((a) => a.name).join(', '),
      album: t.album?.name || '', art: t.album?.images?.[0]?.url || '', thumb: t.album?.images?.at(-1)?.url || '',
    }));
  }

  // Plays on this screen when the Web Playback SDK is ready, otherwise on the account's active device.
  async playUri(uri) {
    await this.withDevice((id) => this.api(`/me/player/play?device_id=${id}`, { method: 'PUT', body: { uris: [uri] } }));
    setTimeout(() => this.poll(), 600);
  }

  async seek(ms) {
    if (this.sdkActive && this.player) return this.player.seek(Math.round(ms));
    await this.api(`/me/player/seek?position_ms=${Math.round(ms)}`, { method: 'PUT' });
    setTimeout(() => this.poll(), 400);
  }

  // Remote control of whatever the account is playing (the desktop or phone app). Ask the account for
  // its state first: this screen's idea of play/pause can be a few seconds old, and resuming must stay
  // on the device that holds the song instead of pulling it into the browser.
  async toggle(playing) {
    if (this.sdkActive && this.player) return this.player.togglePlay();
    const now = await this.api('/me/player').catch(() => null);
    const isPlaying = now ? !!now.is_playing : playing;
    await this.command(async () => {
      if (isPlaying) await this.api('/me/player/pause', { method: 'PUT' });
      else if (now?.device?.id) await this.api(`/me/player/play?device_id=${now.device.id}`, { method: 'PUT' });
      else await this.withDevice((id) => this.api(`/me/player/play?device_id=${id}`, { method: 'PUT' }));
    });
    setTimeout(() => this.poll(), 400);
  }
  async next() {
    if (this.sdkActive && this.player) return this.player.nextTrack();
    await this.command(() => this.api('/me/player/next', { method: 'POST' }));
    setTimeout(() => this.poll(), 500);
  }
  async prev() {
    if (this.sdkActive && this.player) return this.player.previousTrack();
    await this.command(() => this.api('/me/player/previous', { method: 'POST' }));
    setTimeout(() => this.poll(), 500);
  }
  // a command that no longer fits the player's state (it changed in the app meanwhile) is not an
  // error worth showing: the next poll brings the screen up to date
  async command(fn) {
    try { await fn(); } catch (e) { if (!/RESTRICTION/i.test(e.reason || '')) throw e; }
  }
}
