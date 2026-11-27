// Lyrics from LRCLIB (free, no key). Prefers time-synced LRC, falls back to plain text.

const API = 'https://lrclib.net/api';
const cache = new Map();

const clean = (s = '') => s
  .replace(/\s*[([](feat|ft|with|prod)\.?[^)\]]*[)\]]/gi, '')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|live|mono|stereo|single|radio edit|version|edit)\b.*$/i, '')
  .replace(/\s*[([][^)\]]*(remaster|version|edit|mix)[^)\]]*[)\]]/gi, '')
  .trim();

export function parseLrc(text) {
  const out = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) out.push({ t: (+s[1] * 60 + +s[2]) * 1000, text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Lyrics service error (${res.status}).`);
  return res.json();
}

// Returns { synced: [{t,text}], plain: string, instrumental: bool } or null.
export async function fetchLyrics({ artist, title, album, duration }, signal) {
  const t = clean(title), a = (artist || '').split(',')[0].trim();
  if (!t) return null;
  const key = `${a}|${t}`.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  let hit = null;
  if (a) {
    const q = new URLSearchParams({ artist_name: a, track_name: t });
    if (album) q.set('album_name', clean(album));
    if (duration) q.set('duration', Math.round(duration / 1000));
    hit = await getJson(`${API}/get?${q}`, signal).catch((e) => { if (e.name === 'AbortError') throw e; return null; });
  }
  // Synced lyrics win whenever any version of the song has them: one entry can carry only plain text
  // while another (a re-release, the album cut) is timed. Plain text is the last resort.
  const near = (x) => !duration || Math.abs(x.duration * 1000 - duration) < 8000;
  const timed = (h) => !!(h && (h.syncedLyrics || h.instrumental));
  const syncedIn = (list) => list.find((x) => x.syncedLyrics && near(x)) || list.find((x) => x.syncedLyrics);
  const plainIn = (list) => list.find((x) => x.plainLyrics && near(x)) || list.find((x) => x.plainLyrics);
  if (!timed(hit)) {
    const q = new URLSearchParams(a ? { track_name: t, artist_name: a } : { q: t });
    const list = (await getJson(`${API}/search?${q}`, signal)) || [];
    hit = syncedIn(list) || (hit?.plainLyrics ? hit : plainIn(list)) || hit;
  }
  // video titles and channel names are loose ("Artist - Topic", a label's channel): a free-text search
  // as well, keeping only entries of the same length there so a different song is not shown
  if (!timed(hit)) {
    const list = ((await getJson(`${API}/search?${new URLSearchParams({ q: `${a} ${t}`.trim() })}`, signal)) || []).filter(near);
    hit = syncedIn(list) || (hit?.plainLyrics ? hit : plainIn(list)) || hit;
  }
  const result = hit ? { synced: parseLrc(hit.syncedLyrics), plain: hit.plainLyrics || '', instrumental: !!hit.instrumental } : null;
  cache.set(key, result);
  return result;
}
