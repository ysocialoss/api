type Entry = { png: Buffer; at: number };

export class PngCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private bytes = 0;

  constructor(maxEntries: number, maxBytes: number, ttlMs: number) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
  }

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= this.ttlMs) {
      this.remove(key, entry);
      return undefined;
    }
    return entry.png;
  }

  set(key: string, png: Buffer) {
    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);
    if (png.length > this.maxBytes) return;
    this.evictExpired();
    while (this.entries.size >= this.maxEntries || this.bytes + png.length > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value, this.entries.get(oldest.value)!);
    }
    this.entries.set(key, { png, at: Date.now() });
    this.bytes += png.length;
  }

  private evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.remove(key, entry);
    }
  }

  private remove(key: string, entry: Entry) {
    this.entries.delete(key);
    this.bytes -= entry.png.length;
  }
}
