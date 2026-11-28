// YouTube: IFrame Player API. Accepts a video link, playlist link or bare id.
// The player stays visible (YouTube requires a 200px+ visible player) in a small card.

import { YOUTUBE_API_KEY } from '../config.js';

// ---------- search ----------
// Public Piped mirrors that allow browser requests; the last one that answered is tried first.
const PIPED = ['https://api.piped.private.coffee', 'https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de'];
let pipedFirst = 0;
const ytResult = (id, title, channel, seconds) => {
  const { artist, title: t } = splitTitle(title, channel);
  return { source: 'youtube', id, title: t, artist, album: seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '', thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
};

export async function searchYouTube(q, signal, limit = 5) {
  if (YOUTUBE_API_KEY) {
    const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=${limit}&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;
    const r = await fetch(u, { signal });
    if (r.ok) return ((await r.json()).items || []).map((x) => ytResult(x.id.videoId, x.snippet.title, x.snippet.channelTitle));
  }
  for (let k = 0; k < PIPED.length; k++) {
    const i = (pipedFirst + k) % PIPED.length;
    try {
      const r = await fetch(`${PIPED[i]}/search?filter=music_songs&q=${encodeURIComponent(q)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(4500)].filter(Boolean)) });
      if (!r.ok) continue;
      const items = ((await r.json()).items || []).filter((x) => x.type === 'stream' && /v=([\w-]{11})/.test(x.url));
      pipedFirst = i;
      return items.slice(0, limit).map((x) => ytResult(x.url.match(/v=([\w-]{11})/)[1], x.title, x.uploaderName, x.duration > 0 ? x.duration : 0));
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  return [];
}

let apiPromise;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  apiPromise ||= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('Could not load YouTube.')); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export function parseYouTube(input) {
  const s = (input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return { video: s };
  if (/^(PL|OL|RD|UU|FL)[\w-]{10,}$/.test(s)) return { list: s };
  let u;
  try { u = new URL(s.startsWith('http') ? s : `https://${s}`); } catch { return null; }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(u.hostname)) return null;
  const list = u.searchParams.get('list') || undefined;
  let video = u.searchParams.get('v') || undefined;
  if (u.hostname.endsWith('youtu.be')) video = u.pathname.slice(1, 12);
  const m = u.pathname.match(/\/(embed|live|shorts|v)\/([\w-]{11})/);
  if (m) video = m[2];
  if (video && !/^[\w-]{11}$/.test(video)) video = undefined;
  return video || list ? { video, list } : null;
}

// "Artist - Title (Official Video) [4K]" → { artist, title }
export function splitTitle(raw, channel = '') {
  const clean = raw
    .replace(/\s*[([](official|lyric|lyrics|audio|video|visualizer|music video|hd|4k|mv|full album|live)[^)\]]*[)\]]/gi, '')
    .replace(/\s*\|.*$/, '')
    .trim();
  // the artist part never contains brackets: "Title (2015 - Remaster)" is not "artist - title"
  const m = clean.match(/^([^()[\]]+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim(), title: clean };
}

export class YouTubeSource {
  constructor({ onState, onStatus, mount }) {
    this.id = 'youtube';
    this.onState = onState;
    this.onStatus = onStatus;
    this.mount = mount;
    this.timer = null;
  }

  async load(input) {
    const ref = parseYouTube(input);
    if (!ref) throw new Error('That does not look like a YouTube link.');
    this.onStatus?.('youtube', 'connecting');
    await loadApi();
    if (this.player) {
      if (ref.list) this.player.loadPlaylist({ list: ref.list, listType: 'playlist' });
      else this.player.loadVideoById(ref.video);
    } else {
      const vars = { autoplay: 1, playsinline: 1, rel: 0, iv_load_policy: 3, controls: 1 };
      if (ref.list) Object.assign(vars, { listType: 'playlist', list: ref.list });
      const host = document.createElement('div');
      this.mount.replaceChildren(host);
      await new Promise((resolve, reject) => {
        this.player = new window.YT.Player(host, {
          width: '100%', height: '100%',
          host: 'https://www.youtube-nocookie.com',
          videoId: ref.video,
          playerVars: vars,
          events: {
            onReady: () => { this.player.setVolume?.(Math.round((this.volume ?? .8) * 100)); resolve(); },
            onStateChange: () => this.tick(),
            onError: (e) => {
              const msg = { 2: 'Invalid YouTube id.', 5: 'This video cannot play here.', 100: 'Video not found.', 101: 'The owner does not allow embedding.', 150: 'The owner does not allow embedding.' }[e.data] || 'YouTube error.';
              this.onStatus?.('youtube', 'error', msg);
              reject(new Error(msg));
            },
          },
        });
      });
    }
    this.onStatus?.('youtube', 'ready');
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 500);
  }

  tick() {
    const p = this.player;
    if (!p?.getPlayerState) return;
    const st = p.getPlayerState();           // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    if (st === 0 && this.lastSt !== 0) this.onEnded?.();
    this.lastSt = st;
    const data = p.getVideoData?.() || {};
    if (!data.video_id) return;
    const { artist, title } = splitTitle(data.title || '', data.author || '');
    const dur = p.getDuration?.() || 0;
    // right after loading, the duration reads 0 until the video's metadata arrives: that is "unknown",
    // not "live" (and lyrics are looked up once per track, so a wrong first guess would stick)
    if (!data.isLive && dur === 0) return;
    const live = !!data.isLive || dur > 6 * 3600;
    this.onState({
      source: 'youtube',
      track: {
        id: data.video_id,
        title: title || data.title || 'YouTube',
        artist,
        album: data.author || '',
        albumKey: data.video_id,
        art: `https://i.ytimg.com/vi/${data.video_id}/maxresdefault.jpg`,
        artFallback: `https://i.ytimg.com/vi/${data.video_id}/hqdefault.jpg`,
        duration: live ? 0 : dur * 1000,
        live,
      },
      playing: st === 1 || st === 3,
      position: (p.getCurrentTime?.() || 0) * 1000,
      device: 'YouTube',
    });
  }

  toggle(playing) { playing ? this.player?.pauseVideo() : this.player?.playVideo(); }
  next() { this.player?.nextVideo(); }
  prev() {
    const p = this.player;
    if (!p) return;
    if ((p.getCurrentTime?.() || 0) > 4 || !p.getPlaylist?.()) p.seekTo(0, true);
    else p.previousVideo();
  }
  seek(ms) { this.player?.seekTo?.(ms / 1000, true); }
  setVolume(v) { this.volume = v; this.player?.setVolume?.(Math.round(v * 100)); }
  stop() {
    clearInterval(this.timer);
    this.player?.pauseVideo?.();
  }
}
