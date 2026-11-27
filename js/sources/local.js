// Plays a queue of audio URLs with <audio>: dropped/picked files, or 30-second store previews.

export class LocalSource {
  constructor({ onState, onStatus }) {
    this.id = 'local';
    this.onState = onState;
    this.onStatus = onStatus;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];
    this.index = 0;
    this.kind = 'files';
    for (const ev of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'seeked']) {
      this.audio.addEventListener(ev, () => this.emit());
    }
    this.audio.addEventListener('ended', () => { if (this.index < this.queue.length - 1) this.next(); else this.emit(); });
    this.audio.addEventListener('error', () => this.onStatus?.('local', 'error', 'This audio cannot be played.'));
  }

  load(files) {
    const list = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(f.name));
    if (!list.length) throw new Error('No audio files found.');
    const items = list
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((f) => ({ url: URL.createObjectURL(f), album: 'Local files', albumKey: 'local', owned: true, ...this.parseName(f.name) }));
    return this.loadItems(items, 0, 'files');
  }

  // items: [{ url, title, artist, album, albumKey, art }]
  loadItems(items, start = 0, kind = 'preview') {
    this.queue.filter((q) => q.owned).forEach((q) => URL.revokeObjectURL(q.url));
    this.queue = items;
    this.kind = kind;
    this.onStatus?.('local', 'ready');
    return this.play(start);
  }

  parseName(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '').replace(/_/g, ' ');
    const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base.trim() };
  }

  play(i) {
    if (!this.queue.length) return Promise.resolve();
    this.index = (i + this.queue.length) % this.queue.length;
    this.audio.src = this.queue[this.index].url;
    return this.audio.play().catch(() => {});
  }

  emit() {
    const q = this.queue[this.index];
    if (!q) return;
    this.onState({
      source: 'local',
      track: {
        id: q.url, title: q.title, artist: q.artist, album: q.album || '', albumKey: q.albumKey || q.url,
        art: q.art || '', duration: (this.audio.duration || 0) * 1000,
      },
      playing: !this.audio.paused,
      position: this.audio.currentTime * 1000,
      device: this.kind === 'preview' ? 'preview' : 'this screen',
    });
  }

  toggle() { this.audio.paused ? this.audio.play().catch(() => {}) : this.audio.pause(); }
  next() { return this.play(this.index + 1); }
  prev() { if (this.audio.currentTime > 4) this.audio.currentTime = 0; else this.play(this.index - 1); }
  seek(ms) { if (Number.isFinite(this.audio.duration)) this.audio.currentTime = Math.max(0, Math.min(this.audio.duration - .2, ms / 1000)); }
  stop() { this.audio.pause(); }
}
