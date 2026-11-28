import { env } from "../config.ts";
import { ImageWorkGate } from "./image-work-gate.ts";

const gate = new ImageWorkGate(env.IMAGE_WORK_CONCURRENCY, env.IMAGE_WORK_QUEUE, env.IMAGE_WORK_WAIT_MS);

/** Wrap every sharp decode/encode of user-controlled input. Never nest calls: with one slot it would deadlock. */
export const runImageWork = <T>(work: () => Promise<T>) => gate.run(work);
export const imageWorkStats = () => gate.stats();
