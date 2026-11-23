import express, { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "./db/index.ts";
import { mediaDeletions, posts, users } from "./db/schema.ts";
import { cookie, requireSessionUser, requireUser } from "./auth/request.ts";
import { readSession } from "./auth/session.ts";
import { AuthError } from "./auth/provider.ts";
import { getAvatar, requireAvatarStorage } from "./storage/r2.ts";
import { flushMediaDeletions } from "./storage/media-lifecycle.ts";
import { voiceUploadLimit } from "./storage/voice-audio.ts";
import { readVoiceSelection, signVoice } from "./storage/voice-selection.ts";

import { cancelVoiceJob, enqueueVoiceJob, processVoiceJob, readVoiceJob } from "./storage/voice-jobs.ts";

const router = Router();
const receiving = new Set<string>();
const inlineProcessingBudgetMs = 1250;

async function respondWithJob(res: Response, userId: string, id: string, readyStatus = 200) {
  const job = await readVoiceJob({ userId, id });
  if (!job) throw new AuthError(404, "voice_job_not_found");
  if (job.error === "voice_job_cancelled") throw new AuthError(404, "voice_job_not_found");
  if (job.error) throw new AuthError(400, job.error);
  if (!job.voice) {
    res.status(202).json({ pending: true, jobId: id });
    return;
  }
  res.status(readyStatus).json({ ...job.voice, token: signVoice(job.voice, userId, job.expiresAt.getTime()) });
}
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  next();
});
router.post("/", async (req, res) => {
  const user = await requireUser(req);
  requireAvatarStorage();
  if (
    !req.is([
      "audio/webm",
      "audio/ogg",
      "audio/mp4",
      "audio/wav",
      "audio/x-m4a",
    ])
  )
    throw new AuthError(415, "voice_audio_required");
  const id = z.uuid().safeParse(req.get("Idempotency-Key") ?? randomUUID());
  if (!id.success) throw new AuthError(400, "invalid_voice_job");
  const key = { userId: user.id, id: id.data };
  if (!(await readVoiceJob(key))) {
    if (receiving.has(user.id) || receiving.size >= 4)
      throw new AuthError(429, "voice_processing_busy");
    receiving.add(user.id);
    try {
      await new Promise<void>((resolve, reject) => {
        express.raw({ type: () => true, limit: voiceUploadLimit })(
          req,
          res,
          (error) => (error ? reject(error) : resolve()),
        );
      });
      if (!Buffer.isBuffer(req.body)) throw new AuthError(400, "invalid_voice");
      await enqueueVoiceJob(key, req.body);
    } finally {
      receiving.delete(user.id);
    }
  }
  // Give the fast path a short head start. Once the job is saved, an encode
  // or storage delay should return 202 instead of timing out the upload.
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, inlineProcessingBudgetMs);
    void processVoiceJob(key)
      .catch(() => console.warn({ event: "voice_job_fast_path_failed", jobId: key.id }))
      .finally(() => {
        clearTimeout(timeout);
        resolve();
      });
  });
  await respondWithJob(res, user.id, key.id, 201);
});

router.get("/jobs/:id", async (req, res) => {
  const user = await requireSessionUser(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "voice_job_not_found");
  await respondWithJob(res, user.id, id.data);
});

router.delete("/jobs/:id", async (req, res) => {
  const user = await requireUser(req);
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new AuthError(404, "voice_job_not_found");
  await cancelVoiceJob({ userId: user.id, id: id.data });
  res.status(204).end();
});

router.delete("/", async (req, res) => {
  const user = await requireUser(req);
  const input = z
    .strictObject({ token: z.string().min(1).max(4096) })
    .safeParse(req.body);
  if (!input.success) throw new AuthError(400, "invalid_voice_selection");
  const { voice } = readVoiceSelection(input.data.token, user.id);
  await db.transaction(async (tx) => {
    // Posting and discarding lock the same row. A published recording has no draft row.
    const [pending] = await tx
      .select()
      .from(mediaDeletions)
      .where(eq(mediaDeletions.key, voice.key))
      .for("update");
    if (pending)
      await tx
        .update(mediaDeletions)
        .set({ availableAt: new Date() })
        .where(eq(mediaDeletions.key, voice.key));
  });
  await flushMediaDeletions(voice.key);
  res.status(204).end();
});
router.get("/:file", async (req, res) => {
  const file = z
    .string()
    .regex(/^[a-f0-9-]{36}\.m4a$/)
    .safeParse(req.params.file);
  if (!file.success || !z.uuid().safeParse(file.data.split(".")[0]).success)
    throw new AuthError(404, "voice_not_found");
  const key = `voices/${file.data}`;
  const [post] = await db
    .select({ bannedAt: users.bannedAt, hiddenAt: posts.hiddenAt })
    .from(posts)
    .innerJoin(users, eq(posts.authorId, users.id))
    .where(eq(sql`${posts.voice}->>'key'`, key))
    .limit(1);
  if (!post) throw new AuthError(404, "voice_not_found");
  res.set("Cache-Control", "private, no-store");
  if (post.bannedAt || post.hiddenAt) {
    const session = await readSession(cookie(req, "session"));
    const viewer = session.kind === "authenticated" ? session.user : null;
    if (!viewer?.approvedAt || viewer.bannedAt || (viewer.role !== "admin" && viewer.role !== "moderator"))
      throw new AuthError(404, "voice_not_found");
  }
  const body = Buffer.from(await getAvatar(key));
  // Parse byte ranges to support seeking without streaming the entire recording.
  res.set("Accept-Ranges", "bytes");
  const range = req.range(body.length);
  if (range === -1) {
    res.set("Content-Range", `bytes */${body.length}`).sendStatus(416);
    return;
  }
  if (Array.isArray(range) && range.type === "bytes" && range.length === 1) {
    const part = range[0];
    res
      .status(206)
      .set("Content-Range", `bytes ${part.start}-${part.end}/${body.length}`)
      .type("audio/mp4")
      .send(body.subarray(part.start, part.end + 1));
    return;
  }
  res.type("audio/mp4").send(body);
});
export default router;
