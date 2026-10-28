-- Run ONCE in the Supabase SQL Editor, after both migrations are applied.
-- 1. Replace the three values below. 2. Press Run. 3. Read the message it returns.
-- It refuses to run a second time. Only the project admin can run it (the API cannot).
select private.bootstrap_first_owner(
  'you@example.com',   -- the owner's email (the login you will use)
  'Our Family',        -- household name
  'Your Name'          -- how your name appears in the app
);
