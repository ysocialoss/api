import { readFileSync } from "node:fs";
import { imageWorkStats } from "./storage/image-work.ts";

const mib = (bytes: number) => Math.round(bytes / 1048576);

/** The container memory limit, or null when unlimited or unreadable (cgroup v2, then v1). */
export function containerMemoryLimit(read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | null {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const value = Number(read(path).trim());
      // cgroup v1 reports a huge number, and v2 the word "max", when there is no limit.
      if (Number.isFinite(value) && value > 0 && value < 2 ** 50) return value;
    } catch {
      // try the next layout
    }
  }
  return null;
}

export function memorySnapshot(limit = containerMemoryLimit()) {
  const usage = process.memoryUsage();
  return {
    rssMiB: mib(usage.rss),
    heapUsedMiB: mib(usage.heapUsed),
    externalMiB: mib(usage.external),
    arrayBuffersMiB: mib(usage.arrayBuffers),
    limitMiB: limit ? mib(limit) : null,
    usedPercent: limit ? Math.round((usage.rss / limit) * 100) : null,
    imageWork: imageWorkStats(),
  };
}

/**
 * Logs `memory_pressure` once a minute while the process is above `warnAt` of its
 * container limit, a `memory_usage` line every 10 minutes, and a final
 * `memory_shutdown` line when stopped. A pod killed for memory leaves no other trace.
 */
export function startMemoryMonitor({ intervalMs = 30_000, warnAt = 0.8 } = {}) {
  const limit = containerMemoryLimit();
  let lastWarn = 0;
  let lastInfo = 0;
  const check = () => {
    const snapshot = memorySnapshot(limit);
    const now = Date.now();
    if (limit && process.memoryUsage.rss() / limit >= warnAt) {
      if (now - lastWarn >= 60_000) {
        lastWarn = now;
        console.warn({ event: "memory_pressure", ...snapshot });
      }
    } else if (now - lastInfo >= 600_000) {
      lastInfo = now;
      console.info({ event: "memory_usage", ...snapshot });
    }
  };
  check();
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    console.info({ event: "memory_shutdown", ...memorySnapshot(limit) });
  };
}
