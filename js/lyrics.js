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
  const near = (x) => !duration || Math.abs(x.duration * 1000 - duration) < 8000;
  const pick = (list) => list.find((x) => x.syncedLyrics && near(x)) || list.find((x) => x.syncedLyrics) || list.find((x) => x.plainLyrics);
  if (!hit || (!hit.syncedLyrics && !hit.plainLyrics && !hit.instrumental)) {
    const q = new URLSearchParams(a ? { track_name: t, artist_name: a } : { q: t });
    hit = pick((await getJson(`${API}/search?${q}`, signal)) || []) || hit;
  }
  // video titles and channel names are loose ("Artist - Topic", a label's channel): fall back to a
  // free-text search, keeping only a match of the same length so a different song is not shown
  if (!hit || (!hit.syncedLyrics && !hit.plainLyrics && !hit.instrumental)) {
    const list = (await getJson(`${API}/search?${new URLSearchParams({ q: `${a} ${t}`.trim() })}`, signal)) || [];
    hit = (duration ? list.filter(near) : list).find((x) => x.syncedLyrics || x.plainLyrics) || hit;
  }
  const result = hit ? { synced: parseLrc(hit.syncedLyrics), plain: hit.plainLyrics || '', instrumental: !!hit.instrumental } : null;
  cache.set(key, result);
  return result;
}
