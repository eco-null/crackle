// What to play next when the music would stop. Spotify's recommendation endpoints are closed to apps
// like this one, and its autoplay does not run in the browser player, so the suggestions come from
// Deezer's artist radio: free, no key, the same kind of mix a streaming app's radio plays (the artist
// and the artists its listeners play next). Deezer's API has no CORS, so it is read through JSONP.

const DEEZER = 'https://api.deezer.com';
const artistIds = new Map();

function jsonp(path, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cb = `__crackleDz${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const done = (fn, v) => { clearTimeout(timer); delete window[cb]; script.remove(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error('Deezer did not answer.')), timeout);
    window[cb] = (data) => (data?.error ? done(reject, new Error(data.error.message || 'Deezer error')) : done(resolve, data));
    script.onerror = () => done(reject, new Error('Deezer is unreachable.'));
    script.src = `${DEEZER}${path}${path.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
    document.head.append(script);
  });
}

async function artistId(name) {
  const key = name.toLowerCase();
  if (!artistIds.has(key)) {
    const j = await jsonp(`/search/artist?q=${encodeURIComponent(name)}&limit=5`);
    const list = j?.data || [];
    // the exact name if Deezer has it, else its best match
    const hit = list.find((a) => a.name.toLowerCase() === key) || list[0];
    artistIds.set(key, hit?.id || null);
  }
  return artistIds.get(key);
}

// [{ title, artist }] around an artist, in the radio's own order
export async function radioFor(artist, limit = 25) {
  const id = artist && await artistId(artist);
  if (!id) return [];
  const j = await jsonp(`/artist/${id}/radio?limit=${limit}`);
  return (j?.data || []).map((t) => ({ title: t.title_short || t.title, artist: t.artist?.name || '' })).filter((t) => t.title && t.artist);
}
