# Media lifecycle

No cron job is required. Profile replacements and removals record the old object key in `media_deletions` in the same transaction as the profile update, then attempt deletion immediately after commit. A failed deletion does not undo a successful profile change.

The API resumes cleanup on startup and polls every 30 seconds. Failures retry with exponential backoff up to an hour. Workers lock jobs with `SKIP LOCKED`, check active references, and safely repeat R2 deletes after crashes.

Uploads register a pending deletion before the R2 write. Attaching the object clears that pending job in the database transaction. If the request crashes before attachment, cleanup reclaims the object after an hour. Normal failed saves make the job immediately due.

A sweep runs at startup and every six hours to find historical unreferenced avatar and banner objects older than 24 hours. It queues deletions rather than deleting directly. `pnpm storage:prune` runs a manual dry run; add `--delete` to queue those orphans and attempt cleanup. Do not use blanket R2 expiration rules on active media prefixes.

Future media features must use `stageMediaUpload`, clear its pending deletion when attaching the file, and queue the replaced or removed key in the same transaction. Call `flushMediaDeletions(previousKey)` after commit. Extend the active-reference check and sweep registry for new media tables. Never reuse object keys. Third-party URLs, including KLIPY GIFs, are not bucket objects and must not enter the deletion queue.
