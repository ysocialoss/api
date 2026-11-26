-- Legacy DM attachments (Postgres bytea, voice notes only) are dropped instead of moved to R2.
-- Their messages are erased the same way eraseDmMessage does it, so they leave the chat.
CREATE TEMP TABLE legacy_dm_messages AS
  SELECT DISTINCT m.id, m.conversation_id FROM dm_messages m
  JOIN dm_attachments a ON a.message_id = m.id
  WHERE a.object_key IS NULL AND m.deleted_at IS NULL;--> statement-breakpoint
UPDATE dm_messages SET deleted_at = now(), iv = '', ciphertext = '', signature = '', envelopes = '{}'::jsonb
  WHERE id IN (SELECT id FROM legacy_dm_messages);--> statement-breakpoint
DELETE FROM dm_reactions WHERE message_id IN (SELECT id FROM legacy_dm_messages);--> statement-breakpoint
DELETE FROM dm_poll_votes WHERE message_id IN (SELECT id FROM legacy_dm_messages);--> statement-breakpoint
DELETE FROM notifications n USING legacy_dm_messages l
  WHERE n.conversation_id = l.conversation_id AND n.kind IN ('dm_message', 'dm_invite') AND n.subject = l.id::text;--> statement-breakpoint
SELECT pg_notify('live_dm', json_build_object(
  'userId', u.user_id,
  'change', json_build_object('type', 'conversation', 'id', l.conversation_id, 'roster', false, 'message', l.id)
)::text)
  FROM legacy_dm_messages l
  JOIN dm_conversations c ON c.id = l.conversation_id
  CROSS JOIN LATERAL (VALUES (c.first_user_id), (c.second_user_id)) AS u(user_id);--> statement-breakpoint
DROP TABLE legacy_dm_messages;--> statement-breakpoint
DELETE FROM dm_attachments WHERE object_key IS NULL;--> statement-breakpoint
ALTER TABLE "dm_attachments" DROP CONSTRAINT "dm_attachments_one_blob";--> statement-breakpoint
ALTER TABLE "dm_attachments" ALTER COLUMN "object_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_attachments" DROP COLUMN "data";
