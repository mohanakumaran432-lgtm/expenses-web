-- Family Ledger authorization tests. Run in the Supabase SQL Editor (paste all, press Run).
-- It builds throw-away users/households inside ONE transaction and ALWAYS rolls back, so nothing is saved.
-- The report arrives as an "error" (that is how the rollback is forced):
--   "RLS TESTS: <n> passed, 0 failed"  = everything held.  Any failure is listed by name.
-- Needs both migrations applied. Safe to re-run any time, including after real data exists.

create temp table t_results (ok boolean, name text, got text);

-- Run a statement as a signed-in user (uid) or signed-out visitor (null), through the same roles the API uses.
create function pg_temp.run_as(uid uuid, stmt text) returns text language plpgsql as $$
declare n bigint; res text;
begin
  perform set_config('request.jwt.claims',
    case when uid is null then '' else json_build_object('sub', uid, 'role', 'authenticated')::text end, true);
  perform set_config('request.jwt.claim.sub', coalesce(uid::text, ''), true);
  execute case when uid is null then 'set local role anon' else 'set local role authenticated' end;
  begin
    execute stmt;
    get diagnostics n = row_count;
    res := 'ok:' || n;
  exception when others then
    res := 'err:' || sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return res;
end $$;

create function pg_temp.run_admin(stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  begin execute stmt; get diagnostics n = row_count; return 'ok:' || n;
  exception when others then return 'err:' || sqlstate; end;
end $$;

create function pg_temp.expect(test text, got text, want text) returns void language plpgsql as $$
begin insert into t_results values (coalesce(got = want, false), test, coalesce(got, 'NULL') || ' (wanted ' || want || ')'); end $$;

do $$
declare
  hA uuid; hB uuid;
  oa uuid := gen_random_uuid(); ma uuid := gen_random_uuid(); ob uuid := gen_random_uuid(); nobody uuid := gen_random_uuid();
  cAx uuid; cAi uuid; cBx uuid; tOa uuid; tMa uuid; tB uuid; tM2 uuid;
  tbl text; priv text; p int; f int; fails text; notes text := '';
  tx_cols text := 'household_id, created_by, kind, amount, occurred_on, category_id, payment_method, description';
begin
  -- 0. First-owner bootstrap (only testable while the project has no household yet)
  if not exists (select 1 from public.households) then
    perform private.bootstrap_first_owner('boot@test.invalid', 'Boot Home', 'Boot');
    perform pg_temp.expect('bootstrap saves an owner invitation', (select role from public.invitations where email = 'boot@test.invalid'), 'owner');
    perform pg_temp.expect('bootstrap seeds 14 categories', (select count(*) from public.categories)::text, '14');
    perform pg_temp.expect('bootstrap refuses a second run', pg_temp.run_admin($q$select private.bootstrap_first_owner('b@test.invalid','x','y')$q$), 'err:P0001');
    insert into auth.users (id, email) values (gen_random_uuid(), 'boot@test.invalid');
    perform pg_temp.expect('invited bootstrap email becomes owner', (select role from public.household_members where email = 'boot@test.invalid'), 'owner');
    perform pg_temp.expect('last owner login cannot be deleted', pg_temp.run_admin($q$delete from auth.users where email = 'boot@test.invalid'$q$), 'err:23514');
    delete from public.households where name = 'Boot Home';  -- cascade must still work when a household is removed (only the test's own row)
    delete from auth.users where email = 'boot@test.invalid';
  else
    notes := E'\nNote: bootstrap tests skipped because a household already exists (expected after real setup).';
  end if;

  -- Fixtures (as admin): household A (owner oa, member ma), household B (owner ob)
  insert into public.households (name) values ('Test A') returning id into hA;
  insert into public.households (name) values ('Test B') returning id into hB;
  insert into public.invitations (household_id, email, role) values
    (hA, 'owner-a@test.invalid', 'owner'), (hA, 'member-a@test.invalid', 'member'), (hB, 'owner-b@test.invalid', 'owner');
  insert into auth.users (id, email) values (oa, 'owner-a@test.invalid'), (ma, 'member-a@test.invalid'), (ob, 'owner-b@test.invalid');
  perform pg_temp.expect('invitations create memberships on sign-up', (select count(*) from public.household_members where user_id in (oa, ma, ob))::text, '3');
  insert into public.categories (household_id, kind, name) values (hA, 'expense', 'T-Food') returning id into cAx;
  insert into public.categories (household_id, kind, name) values (hA, 'income', 'T-Pay') returning id into cAi;
  insert into public.categories (household_id, kind, name) values (hB, 'expense', 'T-FoodB') returning id into cBx;
  insert into public.transactions (household_id, created_by, kind, amount, occurred_on, category_id, payment_method, description)
    values (hA, oa, 'expense', 10, current_date, cAx, 'cash', 'owner tx') returning id into tOa;
  insert into public.transactions (household_id, created_by, kind, amount, occurred_on, category_id, payment_method, description)
    values (hA, ma, 'expense', 20, current_date, cAx, 'card', 'member tx') returning id into tMa;
  insert into public.transactions (household_id, created_by, kind, amount, occurred_on, category_id, payment_method, description)
    values (hB, ob, 'expense', 30, current_date, cBx, 'cash', 'B tx') returning id into tB;

  -- A. Signed out
  foreach tbl in array array['households', 'household_members', 'categories', 'transactions', 'invitations'] loop
    perform pg_temp.expect('anon cannot read ' || tbl, pg_temp.run_as(null, 'select * from public.' || tbl), 'err:42501');
  end loop;
  perform pg_temp.expect('anon cannot insert a transaction', pg_temp.run_as(null,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 1, current_date, %L, ''cash'', '''')', tx_cols, hA, oa, cAx)), 'err:42501');
  perform pg_temp.expect('anon cannot call private functions', pg_temp.run_as(null, 'select private.current_household()'), 'err:42501');

  -- B. Signed in, but in no household
  foreach tbl in array array['households', 'household_members', 'categories', 'transactions', 'invitations'] loop
    perform pg_temp.expect('no-household user sees 0 rows of ' || tbl, pg_temp.run_as(nobody, 'select * from public.' || tbl), 'ok:0');
  end loop;
  perform pg_temp.expect('no-household user cannot write into household A', pg_temp.run_as(nobody,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 1, current_date, %L, ''cash'', '''')', tx_cols, hA, nobody, cAx)), 'err:42501');

  -- C. Reads are household-scoped
  perform pg_temp.expect('owner A sees only A transactions', pg_temp.run_as(oa, 'select * from public.transactions'), 'ok:2');
  perform pg_temp.expect('member A sees all A transactions', pg_temp.run_as(ma, 'select * from public.transactions'), 'ok:2');
  perform pg_temp.expect('owner B sees only B transactions', pg_temp.run_as(ob, 'select * from public.transactions'), 'ok:1');
  perform pg_temp.expect('A sees only A categories', pg_temp.run_as(oa, 'select * from public.categories'), 'ok:2');
  perform pg_temp.expect('A sees only A members', pg_temp.run_as(oa, 'select * from public.household_members'), 'ok:2');
  perform pg_temp.expect('A sees only its own household', pg_temp.run_as(oa, 'select * from public.households'), 'ok:1');
  perform pg_temp.expect('owner sees own invitations only', pg_temp.run_as(oa, 'select * from public.invitations'), 'ok:2');
  perform pg_temp.expect('member cannot see invitations', pg_temp.run_as(ma, 'select * from public.invitations'), 'ok:0');

  -- D. Household isolation on writes (owner of A attacking B)
  perform pg_temp.expect('A cannot update B transaction', pg_temp.run_as(oa, format('update public.transactions set amount = 99 where id = %L', tB)), 'ok:0');
  perform pg_temp.expect('A cannot delete B transaction', pg_temp.run_as(oa, format('delete from public.transactions where id = %L', tB)), 'ok:0');
  perform pg_temp.expect('A cannot insert into B', pg_temp.run_as(oa,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 1, current_date, %L, ''cash'', '''')', tx_cols, hB, oa, cBx)), 'err:42501');
  perform pg_temp.expect('A cannot add category to B', pg_temp.run_as(oa, format('insert into public.categories (household_id, kind, name) values (%L, ''expense'', ''x'')', hB)), 'err:42501');
  perform pg_temp.expect('A cannot invite into B', pg_temp.run_as(oa, format('insert into public.invitations (household_id, email) values (%L, ''x@test.invalid'')', hB)), 'err:42501');
  perform pg_temp.expect('A cannot rename B', pg_temp.run_as(oa, format('update public.households set name = ''hack'' where id = %L', hB)), 'ok:0');
  perform pg_temp.expect('A cannot remove B members', pg_temp.run_as(oa, format('delete from public.household_members where household_id = %L', hB)), 'ok:0');
  perform pg_temp.expect('A cannot use a B category', pg_temp.run_as(oa,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 5, current_date, %L, ''cash'', '''')', tx_cols, hA, oa, cBx)), 'err:23503');
  perform pg_temp.expect('category kind must match transaction kind', pg_temp.run_as(oa,
    format('insert into public.transactions (%s) values (%L, %L, ''income'', 5, current_date, %L, ''cash'', '''')', tx_cols, hA, oa, cAx)), 'err:23503');
  perform pg_temp.expect('B transaction unchanged', (select amount::text from public.transactions where id = tB), '30.00');

  -- E. Member permissions
  perform pg_temp.expect('member can add own transaction', pg_temp.run_as(ma,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 7, current_date, %L, ''card'', ''ma own'')', tx_cols, hA, ma, cAx)), 'ok:1');
  perform pg_temp.expect('creator defaults to the signed-in user', pg_temp.run_as(ma,
    format('insert into public.transactions (household_id, kind, amount, occurred_on, category_id, payment_method) values (%L, ''expense'', 3, current_date, %L, ''cash'')', hA, cAx)), 'ok:1');
  perform pg_temp.expect('default creator is the caller', (select count(*) from public.transactions where household_id = hA and created_by = ma and amount = 3)::text, '1');
  perform pg_temp.expect('member cannot forge created_by', pg_temp.run_as(ma,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 7, current_date, %L, ''card'', '''')', tx_cols, hA, oa, cAx)), 'err:42501');
  perform pg_temp.expect('member cannot insert null creator', pg_temp.run_as(ma,
    format('insert into public.transactions (%s) values (%L, null, ''expense'', 7, current_date, %L, ''card'', '''')', tx_cols, hA, cAx)), 'err:42501');
  perform pg_temp.expect('member cannot update owner transaction', pg_temp.run_as(ma, format('update public.transactions set amount = 1 where id = %L', tOa)), 'ok:0');
  perform pg_temp.expect('member cannot delete owner transaction', pg_temp.run_as(ma, format('delete from public.transactions where id = %L', tOa)), 'ok:0');
  perform pg_temp.expect('member can update own transaction', pg_temp.run_as(ma, format('update public.transactions set amount = 8 where id = %L', tMa)), 'ok:1');
  perform pg_temp.expect('member cannot re-assign creator', pg_temp.run_as(ma, format('update public.transactions set created_by = %L where id = %L', oa, tMa)), 'err:42501');
  perform pg_temp.expect('member cannot move transaction to B', pg_temp.run_as(ma, format('update public.transactions set household_id = %L where id = %L', hB, tMa)), 'err:42501');
  perform pg_temp.expect('member can delete own transaction', pg_temp.run_as(ma, format('delete from public.transactions where id = %L', tMa)), 'ok:1');
  perform pg_temp.expect('member cannot add category', pg_temp.run_as(ma, format('insert into public.categories (household_id, kind, name) values (%L, ''expense'', ''m'')', hA)), 'err:42501');
  perform pg_temp.expect('member cannot rename category', pg_temp.run_as(ma, format('update public.categories set name = ''m'' where id = %L', cAx)), 'ok:0');
  perform pg_temp.expect('member cannot delete category', pg_temp.run_as(ma, format('delete from public.categories where id = %L', cAi)), 'ok:0');
  perform pg_temp.expect('member cannot invite', pg_temp.run_as(ma, format('insert into public.invitations (household_id, email) values (%L, ''m@test.invalid'')', hA)), 'err:42501');
  perform pg_temp.expect('member cannot remove members', pg_temp.run_as(ma, format('delete from public.household_members where user_id = %L', oa)), 'ok:0');
  perform pg_temp.expect('member cannot remove self', pg_temp.run_as(ma, format('delete from public.household_members where user_id = %L', ma)), 'ok:0');
  perform pg_temp.expect('member cannot rename household', pg_temp.run_as(ma, format('update public.households set name = ''m'' where id = %L', hA)), 'ok:0');

  -- F. Owner permissions
  select id into tM2 from public.transactions where created_by = ma limit 1;
  perform pg_temp.expect('owner can edit a member transaction', pg_temp.run_as(oa, format('update public.transactions set description = ''edited'' where id = %L', tM2)), 'ok:1');
  perform pg_temp.expect('owner can delete a member transaction', pg_temp.run_as(oa, format('delete from public.transactions where id = %L', tM2)), 'ok:1');
  perform pg_temp.expect('owner can add category', pg_temp.run_as(oa, format('insert into public.categories (household_id, kind, name) values (%L, ''expense'', ''Temp'')', hA)), 'ok:1');
  perform pg_temp.expect('owner can rename category', pg_temp.run_as(oa, format('update public.categories set name = ''Temp2'' where household_id = %L and name = ''Temp''', hA)), 'ok:1');
  perform pg_temp.expect('owner can delete unused category', pg_temp.run_as(oa, format('delete from public.categories where household_id = %L and name = ''Temp2''', hA)), 'ok:1');
  perform pg_temp.expect('category in use cannot be deleted', pg_temp.run_as(oa, format('delete from public.categories where id = %L', cAx)), 'err:23503');
  perform pg_temp.expect('category kind cannot change', pg_temp.run_as(oa, format('update public.categories set kind = ''expense'' where id = %L', cAi)), 'err:42501');
  perform pg_temp.expect('owner can invite a member', pg_temp.run_as(oa, format('insert into public.invitations (household_id, email, display_name) values (%L, ''kid@test.invalid'', ''Kid'')', hA)), 'ok:1');
  perform pg_temp.expect('owner cannot invite an owner', pg_temp.run_as(oa, format('insert into public.invitations (household_id, email, role) values (%L, ''o2@test.invalid'', ''owner'')', hA)), 'err:42501');
  perform pg_temp.expect('owner cannot forge accepted_at', pg_temp.run_as(oa, format('insert into public.invitations (household_id, email, accepted_at) values (%L, ''o3@test.invalid'', now())', hA)), 'err:42501');
  perform pg_temp.expect('invalid invite email rejected', pg_temp.run_as(oa, format('insert into public.invitations (household_id, email) values (%L, ''not-an-email'')', hA)), 'err:23514');
  perform pg_temp.expect('duplicate invite rejected', pg_temp.run_as(oa, format('insert into public.invitations (household_id, email) values (%L, ''kid@test.invalid'')', hA)), 'err:23505');
  perform pg_temp.expect('owner can revoke invitation', pg_temp.run_as(oa, 'delete from public.invitations where email = ''kid@test.invalid'''), 'ok:1');
  perform pg_temp.expect('owner can rename household', pg_temp.run_as(oa, format('update public.households set name = ''Renamed'' where id = %L', hA)), 'ok:1');
  perform pg_temp.expect('amount must be positive', pg_temp.run_as(oa,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 0, current_date, %L, ''cash'', '''')', tx_cols, hA, oa, cAx)), 'err:23514');
  perform pg_temp.expect('payment method is validated', pg_temp.run_as(oa,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 1, current_date, %L, ''bitcoin'', '''')', tx_cols, hA, oa, cAx)), 'err:23514');
  perform pg_temp.expect('description length is limited', pg_temp.run_as(oa,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 1, current_date, %L, ''cash'', repeat(''x'', 301))', tx_cols, hA, oa, cAx)), 'err:23514');

  -- G. Role escalation
  perform pg_temp.expect('member cannot self-promote', pg_temp.run_as(ma, format('update public.household_members set role = ''owner'' where user_id = %L', ma)), 'err:42501');
  perform pg_temp.expect('member cannot change another role', pg_temp.run_as(ma, format('update public.household_members set role = ''member'' where user_id = %L', oa)), 'ok:0');
  perform pg_temp.expect('member cannot change own household', pg_temp.run_as(ma, format('update public.household_members set household_id = %L where user_id = %L', hB, ma)), 'err:42501');
  perform pg_temp.expect('member cannot change own email', pg_temp.run_as(ma, format('update public.household_members set email = ''z@test.invalid'' where user_id = %L', ma)), 'err:42501');
  perform pg_temp.expect('member can change own display name', pg_temp.run_as(ma, format('update public.household_members set display_name = ''Mia'' where user_id = %L', ma)), 'ok:1');
  perform pg_temp.expect('sole owner cannot demote self (last-owner guard)', pg_temp.run_as(oa, format('update public.household_members set role = ''member'' where user_id = %L', oa)), 'err:23514');
  perform pg_temp.expect('owner can promote a member', pg_temp.run_as(oa, format('update public.household_members set role = ''owner'' where user_id = %L', ma)), 'ok:1');
  perform pg_temp.expect('promotion took effect', (select role from public.household_members where user_id = ma), 'owner');
  -- With two owners the last-owner guard stays quiet, so this reaches the "never on yourself" rule.
  perform pg_temp.expect('owner cannot change own role (two owners)', pg_temp.run_as(oa, format('update public.household_members set role = ''member'' where user_id = %L', oa)), 'err:42501');
  perform pg_temp.expect('role unchanged after self-demotion attempt', (select role from public.household_members where user_id = oa), 'owner');
  perform pg_temp.expect('owner can demote another owner', pg_temp.run_as(oa, format('update public.household_members set role = ''member'' where user_id = %L', ma)), 'ok:1');
  perform pg_temp.expect('owner cannot remove self', pg_temp.run_as(oa, format('delete from public.household_members where user_id = %L', oa)), 'ok:0');
  perform pg_temp.expect('last owner cannot be demoted (even by admin)', pg_temp.run_admin(format('update public.household_members set role = ''member'' where user_id = %L', oa)), 'err:23514');
  perform pg_temp.expect('last owner cannot be deleted (even by admin)', pg_temp.run_admin(format('delete from public.household_members where user_id = %L', oa)), 'err:23514');
  perform pg_temp.expect('owner can remove a member', pg_temp.run_as(oa, format('delete from public.household_members where user_id = %L', ma)), 'ok:1');
  perform pg_temp.expect('removed member sees nothing', pg_temp.run_as(ma, 'select * from public.transactions'), 'ok:0');
  perform pg_temp.expect('removed member cannot write', pg_temp.run_as(ma,
    format('insert into public.transactions (%s) values (%L, %L, ''expense'', 1, current_date, %L, ''cash'', '''')', tx_cols, hA, ma, cAx)), 'err:42501');
  perform pg_temp.expect('removed member''s past transactions stay in the ledger', (select (count(*) > 0)::text from public.transactions where created_by = ma), 'true');

  -- H. Invite-only sign-up
  perform pg_temp.expect('sign-up without invitation is blocked', pg_temp.run_admin($q$insert into auth.users (id, email) values (gen_random_uuid(), 'nobody@test.invalid')$q$), 'err:42501');
  perform pg_temp.expect('sign-up without email is blocked', pg_temp.run_admin($q$insert into auth.users (id) values (gen_random_uuid())$q$), 'err:42501');
  insert into public.invitations (household_id, email, role) values (hA, 'new@test.invalid', 'member');
  perform pg_temp.expect('invited sign-up works', pg_temp.run_admin($q$insert into auth.users (id, email) values (gen_random_uuid(), 'new@test.invalid')$q$), 'ok:1');
  perform pg_temp.expect('invited user is a plain member', (select role from public.household_members where email = 'new@test.invalid'), 'member');
  perform pg_temp.expect('invitation marked accepted', (select (accepted_at is not null)::text from public.invitations where email = 'new@test.invalid'), 'true');
  perform pg_temp.expect('accepted invitation cannot be reused', pg_temp.run_admin($q$insert into auth.users (id, email) values (gen_random_uuid(), 'NEW@test.invalid')$q$), 'err:42501');
  insert into public.invitations (household_id, email, role, expires_at) values (hA, 'old@test.invalid', 'member', now() - interval '1 day');
  perform pg_temp.expect('expired invitation is rejected', pg_temp.run_admin($q$insert into auth.users (id, email) values (gen_random_uuid(), 'old@test.invalid')$q$), 'err:42501');

  -- I. Bootstrap and catalog checks
  perform pg_temp.expect('API users cannot run bootstrap', pg_temp.run_as(oa, $q$select private.bootstrap_first_owner('e@test.invalid','x','y')$q$), 'err:42501');
  perform pg_temp.expect('bootstrap cannot run twice', pg_temp.run_admin($q$select private.bootstrap_first_owner('e@test.invalid','x','y')$q$), 'err:P0001');
  foreach tbl in array array['households', 'household_members', 'categories', 'transactions', 'invitations'] loop
    perform pg_temp.expect('RLS enabled on ' || tbl, (select relrowsecurity::text from pg_class where oid = ('public.' || tbl)::regclass), 'true');
    foreach priv in array array['select', 'insert', 'update', 'delete'] loop
      perform pg_temp.expect('anon has no ' || priv || ' on ' || tbl, has_table_privilege('anon', 'public.' || tbl, priv)::text, 'false');
    end loop;
  end loop;
  perform pg_temp.expect('nobody can insert households via API', has_table_privilege('authenticated', 'public.households', 'insert')::text, 'false');
  perform pg_temp.expect('nobody can insert members via API', has_table_privilege('authenticated', 'public.household_members', 'insert')::text, 'false');
  perform pg_temp.expect('no policy targets anon/public', (select count(*) from pg_policies where schemaname = 'public' and (roles && array['anon', 'public']::name[]))::text, '0');

  select count(*) filter (where ok), count(*) filter (where not ok),
         coalesce(string_agg('FAIL: ' || name || ' -> ' || got, E'\n') filter (where not ok), 'No failures.')
    into p, f, fails from t_results;
  raise exception E'RLS TESTS: % passed, % failed\n%\n(Everything was rolled back on purpose; this "error" is just the report.)', p, f, fails || notes;
end $$;
