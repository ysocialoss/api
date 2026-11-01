-- Run against a disposable database after applying Drizzle migrations:
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
SELECT pg_temp.expect_failure($q$INSERT INTO users(handle, display_name)
    VALUES ('long_name', repeat('x', 81))$q$, '23514');
SELECT pg_temp.expect_failure($q$INSERT INTO posts(author_id, content) VALUES
    ('00000000-0000-0000-0000-000000000099', 'Hello')$q$, '23503');
SELECT pg_temp.expect_failure($q$INSERT INTO posts(author_id, content) VALUES
    ('00000000-0000-0000-0000-000000000001', '')$q$, '23514');
SELECT pg_temp.expect_failure($q$INSERT INTO posts(author_id, content) VALUES
    ('00000000-0000-0000-0000-000000000001', '   ')$q$, '23514');
SELECT pg_temp.expect_failure($q$INSERT INTO posts(author_id, content) VALUES
    ('00000000-0000-0000-0000-000000000001', repeat('x', 2001))$q$, '23514');
INSERT INTO posts(id, author_id, content) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', repeat('😀', 2000));
INSERT INTO post_likes(post_id, user_id) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000002');
SELECT pg_temp.expect_failure($q$INSERT INTO post_likes(post_id, user_id) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001')$q$, '23505');
SELECT pg_temp.expect_failure($q$INSERT INTO post_likes(post_id, user_id) VALUES
    ('00000000-0000-0000-0000-000000000099', '00000000-0000-0000-0000-000000000001')$q$, '23503');
SELECT pg_temp.expect_failure($q$INSERT INTO post_likes(post_id, user_id) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000099')$q$, '23503');
DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000002';
DO $$
BEGIN
    IF (SELECT count(*) FROM post_likes WHERE post_id = '00000000-0000-0000-0000-000000000020') <> 1 THEN
        RAISE EXCEPTION 'User deletion did not remove their like';
    END IF;
END;
$$;
DELETE FROM users WHERE id = '00000000-0000-0000-0000-000000000001';
DO $$
BEGIN
    IF EXISTS (SELECT FROM posts WHERE id = '00000000-0000-0000-0000-000000000020') OR
       EXISTS (SELECT FROM post_likes WHERE post_id = '00000000-0000-0000-0000-000000000020') THEN
        RAISE EXCEPTION 'Author deletion left orphan posts or likes';
    END IF;
END;
$$;
ROLLBACK;
