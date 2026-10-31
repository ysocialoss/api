-- Run against a disposable database after loading the bootstrap schema:
-- psql -v ON_ERROR_STOP=1 -d DATABASE -f tests/schema.sql
-- All fixtures roll back. Failures raise an exception and stop psql.
BEGIN;
CREATE FUNCTION pg_temp.expect_failure(statement TEXT, expected_state TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actual_state TEXT;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
        IF actual_state = expected_state THEN RETURN; END IF;
        RAISE EXCEPTION 'Expected SQLSTATE %, got % for %', expected_state, actual_state, statement;
    END;
    RAISE EXCEPTION 'Statement unexpectedly succeeded: %', statement;
END;
$$;

INSERT INTO users(id, handle) VALUES
    ('00000000-0000-0000-0000-000000000001', 'alice'),
    ('00000000-0000-0000-0000-000000000002', 'bob');
SELECT pg_temp.expect_failure($q$INSERT INTO users(handle) VALUES ('Alice')$q$, '23514');
SELECT pg_temp.expect_failure($q$INSERT INTO users(handle) VALUES ('alice')$q$, '23505');
SELECT pg_temp.expect_failure($q$INSERT INTO follows(follower, following) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001')$q$, '23514');
SELECT pg_temp.expect_failure($q$INSERT INTO posts(author) VALUES
    ('00000000-0000-0000-0000-000000000099')$q$, '23503');
SELECT pg_temp.expect_failure($q$INSERT INTO posts(author, type) VALUES
    ('00000000-0000-0000-0000-000000000001', 'image')$q$, '23514');
SELECT pg_temp.expect_failure($q$INSERT INTO posts(author, scheduled_at, published_at) VALUES
    ('00000000-0000-0000-0000-000000000001', now() + interval '5 minutes', NULL)$q$, '23514');

INSERT INTO communities(id, name, owner, tag) VALUES
    ('00000000-0000-0000-0000-000000000010', 'Test community',
     '00000000-0000-0000-0000-000000000001', 'test');
INSERT INTO community_members(community_id, user_id) VALUES
    ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001');
INSERT INTO posts(id, author, content) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', 'Hello');
INSERT INTO posts(author, community) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000010');
INSERT INTO posts(id, author, scheduled_at, published_at) VALUES
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001',
     now() + interval '11 minutes', NULL);
-- Editing a pending post must not revalidate an unchanged schedule.
UPDATE posts SET content = 'Edited' WHERE id = '00000000-0000-0000-0000-000000000021';
SELECT pg_temp.expect_failure($q$UPDATE posts SET scheduled_at = now() + interval '1 minute'
    WHERE id = '00000000-0000-0000-0000-000000000021'$q$, '23514');
INSERT INTO post_votes(post_id, user_id, value) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', 1),
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000002', -1);
INSERT INTO reposts(post_id, user_id) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000002');
SELECT pg_temp.expect_failure($q$INSERT INTO post_votes(post_id, user_id, value) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', -1)$q$, '23505');
INSERT INTO conversations(id, type) VALUES ('00000000-0000-0000-0000-000000000030', 'dm');
INSERT INTO conversation_members(conversation_id, user_id) VALUES
    ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000001');
INSERT INTO messages(conversation_id, sender, ciphertext, protocol_version) VALUES
    ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000001', decode('aabb', 'hex'), 1);
DELETE FROM conversation_members;
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM post_stats WHERE post_id = '00000000-0000-0000-0000-000000000020'
                   AND likes = 1 AND dislikes = 1 AND reposts = 2) THEN
        RAISE EXCEPTION 'Reaction counts are incorrect';
    END IF;
    IF (SELECT count(*) FROM posts WHERE community IS NULL AND published_at <= now()) <> 1 THEN
        RAISE EXCEPTION 'Main feed includes community or pending posts';
    END IF;
    IF (SELECT count(*) FROM messages) <> 1 THEN
        RAISE EXCEPTION 'Leaving a chat removed message history';
    END IF;
END;
$$;
DELETE FROM posts WHERE id = '00000000-0000-0000-0000-000000000020';
DO $$
BEGIN
    IF EXISTS (SELECT FROM post_votes) OR EXISTS (SELECT FROM reposts) THEN
        RAISE EXCEPTION 'Post deletion left orphan reactions';
    END IF;
END;
$$;
ROLLBACK;
