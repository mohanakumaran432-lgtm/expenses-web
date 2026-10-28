# Family Ledger (expenses-web)

Private, mobile-first family income and expense tracker. React + TypeScript + Vite, Supabase (Auth, PostgreSQL, Row Level Security), installable Android PWA, hosted on Cloudflare Pages. Currency AED, time zone Asia/Dubai.

- One shared household ledger. **Owners** manage members, categories and all transactions. **Members** see every household transaction but can edit or delete only their own.
- Every permission is enforced in PostgreSQL (RLS policies, column grants, guard triggers) in `supabase/migrations`. The app only hides buttons.
- No public registration. The first owner is created by SQL that only the project admin can run; family members join by invitation.

## One-time setup

**A. Supabase** (dashboard labels can differ slightly)
1. SQL Editor: run the two files in `supabase/migrations/` in order. *(Already applied to project `family-finance-tracker`. Skip if the Table Editor shows `transactions`.)*
2. Authentication > Sign In / Providers: turn **off** "Allow new users to sign up". Leave "Confirm email" on.
3. Authentication > URL Configuration: set Site URL to your Cloudflare address (e.g. `https://expenses-web.pages.dev`) and add the same address under Redirect URLs.
4. Project Settings > API: "Exposed schemas" must contain `public` only (never `private`).
5. SQL Editor: open `supabase/seed/first_owner.sql`, put in your email, household name and name, press Run. It must say the owner invitation is saved or the owner is linked. It runs only once.
6. Authentication > Users > Add user: same email as step 5. Choose "Create new user", set a password of 10+ characters, tick auto-confirm.
7. SQL Editor: run `supabase/tests/rls_tests.sql`. Expected message: `RLS TESTS: <n> passed, 0 failed` (it is shown as an error on purpose, because that is how everything gets rolled back). If the editor warns about a destructive query, confirm it: the script only touches rows it creates itself and rolls everything back.

**B. Cloudflare Pages** (private GitHub repo)
1. Workers & Pages > Create > Pages > Connect to Git > pick this repository, production branch `main`.
2. Framework preset "React (Vite)": build command `npm run build`, output directory `dist`.
3. Settings > Environment variables (Production and Preview): `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (publishable key only, never a secret/service_role key). `.node-version` already selects Node 22.
4. Save and deploy. Then finish A3 using the real address.

**C. Invite a family member** (owner only)
1. In the app: Settings > Invitations: enter their email (and name), Add.
2. Supabase > Authentication > Users > Add user > Send invitation, same email. They open the emailed link, choose a password, and are in. Sign-up is refused for any email without an invitation.

**D. Install on Android**: open the site in Chrome, menu (three dots) > Install app (or Add to Home screen).

## Local development (optional)
```
cp .env.example .env.local   # fill in URL + publishable key; never commit it
npm install
npm run dev
```

## Tests
- `npm test` runs unit tests (money, Dubai dates, CSV formula-injection guard, summaries).
- `supabase/tests/rls_tests.sql` runs over 120 authorization checks against real Postgres in a rolled-back transaction (signed-out access, household isolation, owner/member rules, creator forgery, role escalation, invite-only sign-up).
- `docs/SECURITY_CHECKLIST.md` lists manual end-to-end checks for the live site.
- GitHub Actions (`.github/workflows/ci.yml`) runs type-check, unit tests and the production build on every push.

## Security notes
- Browser code only ever holds the publishable key. The build fails if a `VITE_` variable looks like a secret key.
- The service worker caches nothing, so financial data is never stored for offline use. `public/_headers` sets a strict CSP and other headers.
- Removing a member revokes access immediately; their past transactions stay in the ledger (owners can edit them).
