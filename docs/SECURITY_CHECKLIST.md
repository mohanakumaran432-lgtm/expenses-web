# Security test checklist

Tick each item only after you have actually run it. `URL` = your Supabase project URL, `KEY` = the publishable key. Use two test accounts: an owner and a member.

## 1. Database (automatic)
- [ ] Run `supabase/tests/rls_tests.sql` in the SQL Editor. Expect `RLS TESTS: <n> passed, 0 failed`.
- [ ] Supabase > Advisors > Security: no warnings.

## 2. Signed-out access
- [ ] `curl "$URL/rest/v1/transactions?select=*" -H "apikey: $KEY"` returns an error with code `42501` (permission denied), not data and not `[]`. Repeat for `households`, `household_members`, `categories`, `invitations`.
- [ ] `curl -X POST "$URL/auth/v1/signup" -H "apikey: $KEY" -H "Content-Type: application/json" -d '{"email":"stranger@example.com","password":"Long-password-123"}'` is refused ("signups not allowed").
- [ ] `curl "$URL/rest/v1/rpc/bootstrap_first_owner" -X POST -H "apikey: $KEY"` returns 404 (the function is not exposed).

## 3. Member limits (sign in as the member; get a token with `POST $URL/auth/v1/token?grant_type=password`)
Use `-H "apikey: $KEY" -H "Authorization: Bearer $TOKEN"`.
- [ ] Insert a transaction with `created_by` set to the owner's id: rejected (42501).
- [ ] `PATCH /rest/v1/transactions?id=eq.<owner tx id>` with `-H "Prefer: return=representation"`: returns `[]`, and the owner's transaction is unchanged.
- [ ] `DELETE` on an owner's transaction: returns `[]`, still there.
- [ ] `PATCH /rest/v1/household_members?user_id=eq.<own id>` body `{"role":"owner"}`: rejected ("only an owner can change roles").
- [ ] `POST /rest/v1/invitations`, `POST /rest/v1/categories`: rejected (42501).
- [ ] In the app, the member sees every transaction but the owner's rows are greyed out and cannot be opened.

## 4. Owner limits
- [ ] Owner cannot change their own role, cannot remove themselves, cannot invite another owner (42501).
- [ ] A category used by a transaction cannot be deleted.

## 5. Household isolation
- [ ] With a second household created by SQL (see the test file for the pattern), a user of household A gets `[]` for any household B id and cannot insert into B. (Automated in section 1; repeat by hand only if you add real second households.)

## 6. Secrets and files
- [ ] `git ls-files | grep -i env` lists only `.env.example`.
- [ ] No `service_role` or secret key appears in Cloudflare variables, GitHub secrets for this repo, or the repository history.
- [ ] A build with a secret key in `VITE_SUPABASE_PUBLISHABLE_KEY` fails (checked automatically in CI).

## 7. Browser and PWA
- [ ] DevTools > Application > Cache Storage is empty and Local Storage holds only the Supabase session.
- [ ] Offline, the app shows only "You are offline" (no financial data).
- [ ] `curl -I https://YOUR-SITE/` shows `content-security-policy`, `x-frame-options: DENY`, `x-content-type-options: nosniff`.
- [ ] After sign-out, pressing Back does not show private data.
