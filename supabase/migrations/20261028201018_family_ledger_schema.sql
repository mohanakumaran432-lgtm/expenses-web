-- Family Ledger 1/2: tables and constraints. Apply this first, then 20261028000002_security.sql.
-- Nothing here is usable by the API until the second file grants access and enables RLS.

create schema if not exists private;  -- never exposed through the Supabase Data API

create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);

create table public.household_members (
  user_id      uuid primary key references auth.users (id) on delete cascade,  -- one household per login
  household_id uuid not null references public.households (id) on delete cascade,
  role         text not null check (role in ('owner', 'member')),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  email        text not null,
  created_at   timestamptz not null default now()
);
create index on public.household_members (household_id);

create table public.categories (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  kind         text not null check (kind in ('income', 'expense')),
  name         text not null check (name = btrim(name) and char_length(name) between 1 and 40),
  created_at   timestamptz not null default now(),
  unique (household_id, kind, name),
  unique (id, household_id, kind)  -- lets transactions reference a category of the SAME household and kind
);

create table public.transactions (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references public.households (id) on delete cascade,
  -- Deliberately no FK to auth.users: deleting a login must not rewrite or block ledger rows.
  -- Forgery is prevented by the RLS insert policy (created_by = auth.uid()) and the update guard.
  created_by     uuid default auth.uid(),
  kind           text not null check (kind in ('income', 'expense')),
  amount         numeric(12, 2) not null check (amount > 0),
  occurred_on    date not null check (occurred_on between date '2000-01-01' and date '2100-12-31'),
  category_id    uuid not null,
  payment_method text not null check (payment_method in ('cash', 'card', 'bank_transfer', 'other')),
  description    text not null default '' check (char_length(description) <= 300),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (category_id, household_id, kind)
    references public.categories (id, household_id, kind) on delete restrict
);
create index on public.transactions (household_id, occurred_on desc);
create index on public.transactions (created_by);

create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  email        text not null unique
               check (email = lower(btrim(email)) and char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role         text not null default 'member' check (role in ('owner', 'member')),
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 60),
  invited_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '14 days',
  accepted_at  timestamptz
);
create index on public.invitations (household_id);
