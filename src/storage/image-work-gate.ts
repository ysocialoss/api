import { AuthError } from "../auth/provider.ts";

export type ImageWorkStats = { active: number; queued: number; completed: number; rejected: number };

/**
 * Runs memory-heavy image work (libvips decode and AVIF encode) a few jobs at a
 * time. One large photo costs roughly 120-170 MiB; unbounded parallel jobs are
 * what pushed API pods past their memory limit. Waiting jobs queue instead of
 * failing, up to a small queue size and wait time, so a burst of uploads slows
 * down rather than killing the process.
 */
export class ImageWorkGate {
  private active = 0;
  private completed = 0;
  private rejected = 0;
  private readonly waiting: { start: () => void; timer: NodeJS.Timeout }[] = [];
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private readonly maxWaitMs: number;

  constructor(maxActive: number, maxQueued: number, maxWaitMs: number) {
    this.maxActive = Math.max(1, maxActive);
    this.maxQueued = Math.max(0, maxQueued);
    this.maxWaitMs = Math.max(0, maxWaitMs);
  }

  stats(): ImageWorkStats {
    return { active: this.active, queued: this.waiting.length, completed: this.completed, rejected: this.rejected };
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxActive) await this.wait();
    else this.active++;
    try {
      return await work();
    } finally {
      this.completed++;
      this.release();
    }
  }

  private wait() {
    if (this.waiting.length >= this.maxQueued) {
      this.rejected++;
      throw new AuthError(429, "post_image_busy");
    }
    return new Promise<void>((resolve, reject) => {
      const entry: { start: () => void; timer: NodeJS.Timeout } = {
        // The finishing job hands its slot straight to the next one, so `active` stays unchanged.
        start: () => {
          clearTimeout(entry.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          this.rejected++;
          reject(new AuthError(429, "post_image_busy"));
        }, this.maxWaitMs),
      };
      this.waiting.push(entry);
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next.start();
    else this.active--;
  }
}
