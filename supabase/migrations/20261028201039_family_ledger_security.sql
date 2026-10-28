-- Family Ledger 2/2: security. Apply after 20261028000001_schema.sql.
-- Row Level Security, least-privilege grants, role/creator guards, invite-only sign-up,
-- and the one-time owner bootstrap. All permission rules live HERE, not in the frontend.

-- ── Helpers (private schema: not exposed by the Data API) ───────────────────────────
create function private.current_household() returns uuid
language sql stable security definer set search_path = ''
as $$ select m.household_id from public.household_members m where m.user_id = (select auth.uid()) $$;

create function private.is_owner(h uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (
  select 1 from public.household_members m
  where m.user_id = (select auth.uid()) and m.household_id = h and m.role = 'owner') $$;

revoke all on function private.current_household(), private.is_owner(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.current_household(), private.is_owner(uuid) to authenticated;

-- ── Row Level Security on every table ───────────────────────────────────────────────
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.categories        enable row level security;
alter table public.transactions      enable row level security;
alter table public.invitations       enable row level security;

-- ── Grants: signed-out (anon) gets nothing; signed-in gets only what the app needs ──
revoke all on public.households, public.household_members, public.categories,
              public.transactions, public.invitations from anon, authenticated;

grant select on public.households, public.household_members, public.categories,
                public.transactions, public.invitations to authenticated;
grant update (name) on public.households to authenticated;
grant update (display_name, role) on public.household_members to authenticated;
grant delete on public.household_members to authenticated;
grant insert (household_id, kind, name) on public.categories to authenticated;
grant update (name) on public.categories to authenticated;
grant delete on public.categories to authenticated;
grant insert (household_id, created_by, kind, amount, occurred_on, category_id, payment_method, description)
  on public.transactions to authenticated;
grant update (kind, amount, occurred_on, category_id, payment_method, description)
  on public.transactions to authenticated;
grant delete on public.transactions to authenticated;
grant insert (household_id, email, role, display_name) on public.invitations to authenticated;
grant delete on public.invitations to authenticated;

-- ── Policies ────────────────────────────────────────────────────────────────────────
create policy households_select on public.households for select to authenticated
  using (id = private.current_household());
create policy households_update on public.households for update to authenticated
  using (private.is_owner(id)) with check (private.is_owner(id));

create policy members_select on public.household_members for select to authenticated
  using (household_id = private.current_household());
create policy members_update on public.household_members for update to authenticated
  using (household_id = private.current_household()
         and (user_id = (select auth.uid()) or private.is_owner(household_id)))
  with check (household_id = private.current_household()
         and (user_id = (select auth.uid()) or private.is_owner(household_id)));
create policy members_delete on public.household_members for delete to authenticated
  using (private.is_owner(household_id) and user_id <> (select auth.uid()));

create policy categories_select on public.categories for select to authenticated
  using (household_id = private.current_household());
create policy categories_insert on public.categories for insert to authenticated
  with check (private.is_owner(household_id));
create policy categories_update on public.categories for update to authenticated
  using (private.is_owner(household_id)) with check (private.is_owner(household_id));
create policy categories_delete on public.categories for delete to authenticated
  using (private.is_owner(household_id));

create policy transactions_select on public.transactions for select to authenticated
  using (household_id = private.current_household());
create policy transactions_insert on public.transactions for insert to authenticated
  with check (household_id = private.current_household() and created_by = (select auth.uid()));
create policy transactions_update on public.transactions for update to authenticated
  using (household_id = private.current_household()
         and (created_by = (select auth.uid()) or private.is_owner(household_id)))
  with check (household_id = private.current_household()
         and (created_by = (select auth.uid()) or private.is_owner(household_id)));
create policy transactions_delete on public.transactions for delete to authenticated
  using (household_id = private.current_household()
         and (created_by = (select auth.uid()) or private.is_owner(household_id)));

create policy invitations_select on public.invitations for select to authenticated
  using (private.is_owner(household_id));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (private.is_owner(household_id) and role = 'member' and accepted_at is null);
create policy invitations_delete on public.invitations for delete to authenticated
  using (private.is_owner(household_id));

-- ── Guards: second line of defence behind the policies ──────────────────────────────
create function private.guard_transaction_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.id <> old.id or new.household_id <> old.household_id or new.created_at <> old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'id, household, creator and created_at cannot be changed' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger guard_update before update on public.transactions
  for each row execute function private.guard_transaction_update();

create function private.guard_category_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.id <> old.id or new.household_id <> old.household_id or new.kind <> old.kind
     or new.created_at <> old.created_at then
    raise exception 'category id, household and kind cannot be changed' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_update before update on public.categories
  for each row execute function private.guard_category_update();

create function private.guard_member_update() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.user_id <> old.user_id or new.household_id <> old.household_id
     or new.email <> old.email or new.created_at <> old.created_at then
    raise exception 'member identity cannot be changed' using errcode = '42501';
  end if;
  -- Role changes: only an owner of this household, and never on yourself.
  -- (auth.uid() is null for the SQL editor / service role, which stay unrestricted here.)
  if new.role <> old.role and (select auth.uid()) is not null then
    if not private.is_owner(old.household_id) then
      raise exception 'only an owner can change roles' using errcode = '42501';
    end if;
    if old.user_id = (select auth.uid()) then
      raise exception 'you cannot change your own role' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger guard_update before update on public.household_members
  for each row execute function private.guard_member_update();

-- A household must always keep at least one owner (also blocks deleting the last owner's login).
create function private.guard_last_owner() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.households h where h.id = old.household_id)  -- skip when the household itself is being deleted
     and not exists (select 1 from public.household_members m
                     where m.household_id = old.household_id and m.role = 'owner' and m.user_id <> old.user_id) then
    raise exception 'a household must keep at least one owner' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger guard_last_owner before update or delete on public.household_members
  for each row execute function private.guard_last_owner();

-- ── Invite-only sign-up (defence in depth; ALSO turn off public sign-ups in the dashboard) ──
create function private.guard_signup() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.invitations i
                 where i.email = lower(btrim(new.email)) and i.accepted_at is null and i.expires_at > now()) then
    raise exception 'Sign-up is by invitation only' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger guard_signup before insert on auth.users
  for each row execute function private.guard_signup();

create function private.accept_invitation() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare inv public.invitations;
begin
  select * into inv from public.invitations i
  where i.email = lower(btrim(new.email)) and i.accepted_at is null and i.expires_at > now()
  for update;
  if not found then return new; end if;
  insert into public.household_members (user_id, household_id, role, display_name, email)
  values (new.id, inv.household_id, inv.role, coalesce(inv.display_name, split_part(inv.email, '@', 1)), inv.email);
  update public.invitations set accepted_at = now() where id = inv.id;
  return new;
end $$;
create trigger accept_invitation after insert on auth.users
  for each row execute function private.accept_invitation();

-- ── One-time first-owner setup. Only the project admin (SQL editor / service role) can run it. ──
create function private.bootstrap_first_owner(p_email text, p_household_name text, p_display_name text)
returns text language plpgsql security definer set search_path = ''
as $$
declare
  e text := lower(btrim(p_email));
  h uuid;
  u uuid;
begin
  if exists (select 1 from public.households) then
    raise exception 'Setup already done: a household already exists.';
  end if;
  insert into public.households (name) values (btrim(p_household_name)) returning id into h;
  insert into public.categories (household_id, kind, name)
  select h, k, n from (values
    ('income', 'Salary'), ('income', 'Business'), ('income', 'Gift'), ('income', 'Other income'),
    ('expense', 'Groceries'), ('expense', 'Rent'), ('expense', 'Utilities'), ('expense', 'Transport'),
    ('expense', 'Dining'), ('expense', 'Health'), ('expense', 'Education'), ('expense', 'Shopping'),
    ('expense', 'Family'), ('expense', 'Other')) v (k, n);
  select id into u from auth.users where lower(email) = e;
  if u is not null then
    insert into public.household_members (user_id, household_id, role, display_name, email)
    values (u, h, 'owner', btrim(p_display_name), e);
    return 'Done: ' || e || ' is now the owner. You can sign in.';
  end if;
  insert into public.invitations (household_id, email, role, display_name)
  values (h, e, 'owner', btrim(p_display_name));
  return 'Owner invitation saved for ' || e || '. Now create that user in Authentication > Users.';
end $$;
revoke all on function private.bootstrap_first_owner(text, text, text) from public, anon, authenticated;
