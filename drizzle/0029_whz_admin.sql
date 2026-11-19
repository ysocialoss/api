UPDATE users
SET role = 'admin'
WHERE handle = 'whz'
  AND EXISTS (
    SELECT 1
    FROM auth_identities
    WHERE user_id = users.id
      AND deleted_at IS NULL
      AND lower(username) = 'whz'
  );
