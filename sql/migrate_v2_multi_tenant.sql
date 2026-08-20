-- =====================================================================
-- Migration v1 -> v2 : passage au multi-garages
-- À exécuter UNE SEULE FOIS sur un projet Supabase qui a déjà la table
-- `cars` mono-garage de la v1 (sinon utilisez `sql/schema.sql` directement).
-- Supabase > SQL Editor > coller > Run.
-- =====================================================================

create extension if not exists pgcrypto;

create table if not exists public.garages (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  vertical             text not null check (vertical in ('vente', 'reparation')),
  slug                 text unique,
  status               text not null default 'onboarding'
                       check (status in ('onboarding', 'active', 'suspended', 'canceled')),
  owner_user_id        uuid references auth.users(id) on delete set null,
  timezone             text not null default 'Europe/Paris',
  locale               text not null default 'fr-FR',
  ai_persona_overrides jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.garage_members (
  id         uuid primary key default gen_random_uuid(),
  garage_id  uuid not null references public.garages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  unique (garage_id, user_id),
  unique (user_id)
);

create table if not exists public.superadmins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.services (
  id           uuid primary key default gen_random_uuid(),
  garage_id    uuid not null references public.garages(id) on delete cascade,
  name         text not null,
  description  text,
  price_min    numeric(10,2),
  price_max    numeric(10,2),
  duration_min integer,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists services_garage_idx on public.services (garage_id);
create index if not exists services_name_idx on public.services (lower(name));

create table if not exists public.appointments (
  id             uuid primary key default gen_random_uuid(),
  garage_id      uuid not null references public.garages(id) on delete cascade,
  service_id     uuid references public.services(id) on delete set null,
  customer_phone text not null,
  customer_name  text,
  vehicle_desc   text,
  requested_at   timestamptz,
  scheduled_at   timestamptz,
  status         text not null default 'requested'
                 check (status in ('requested', 'confirmed', 'completed', 'canceled', 'no_show')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists appointments_garage_status_idx on public.appointments (garage_id, status);
create index if not exists appointments_garage_phone_idx on public.appointments (garage_id, customer_phone);

create table if not exists public.quotes (
  id             uuid primary key default gen_random_uuid(),
  garage_id      uuid not null references public.garages(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  customer_phone text not null,
  description    text not null,
  amount         numeric(10,2),
  status         text not null default 'draft'
                 check (status in ('draft', 'sent', 'accepted', 'declined')),
  created_at     timestamptz not null default now()
);
create index if not exists quotes_garage_idx on public.quotes (garage_id);

create table if not exists public.messages (
  id             bigint generated always as identity primary key,
  garage_id      uuid not null references public.garages(id) on delete cascade,
  direction      text not null check (direction in ('in', 'out')),
  customer_phone text not null,
  channel        text not null,
  body           text,
  created_at     timestamptz not null default now()
);
create index if not exists messages_garage_phone_idx on public.messages (garage_id, customer_phone, created_at desc);

-- =====================================================================
-- Rattache le stock existant (v1, mono-garage) à un garage "pilote".
-- Renommez `name` ci-dessous si vous voulez un nom différent.
-- =====================================================================
insert into public.garages (name, vertical, slug, status)
select 'Mon garage', 'vente', 'garage-pilote', 'active'
where not exists (select 1 from public.garages where slug = 'garage-pilote');

alter table public.cars add column if not exists garage_id uuid references public.garages(id) on delete cascade;

update public.cars
set garage_id = (select id from public.garages where slug = 'garage-pilote')
where garage_id is null;

alter table public.cars alter column garage_id set not null;

create index if not exists cars_garage_idx on public.cars (garage_id);
create index if not exists cars_brand_idx on public.cars (lower(brand));
create index if not exists cars_model_idx on public.cars (lower(model));
create index if not exists cars_status_idx on public.cars (status);

-- =====================================================================
-- RLS (identique à sql/schema.sql) — ligne de défense secondaire.
-- =====================================================================
alter table public.garages enable row level security;
alter table public.garage_members enable row level security;
alter table public.cars enable row level security;
alter table public.services enable row level security;
alter table public.appointments enable row level security;
alter table public.quotes enable row level security;
alter table public.messages enable row level security;

create or replace function public.current_garage_id()
returns uuid language sql stable as $$
  select garage_id from public.garage_members where user_id = auth.uid() limit 1
$$;

create or replace function public.is_superadmin()
returns boolean language sql stable as $$
  select exists (select 1 from public.superadmins where user_id = auth.uid())
$$;

drop policy if exists garages_scope on public.garages;
create policy garages_scope on public.garages for all
  using (id = public.current_garage_id() or public.is_superadmin())
  with check (id = public.current_garage_id() or public.is_superadmin());

drop policy if exists cars_scope on public.cars;
create policy cars_scope on public.cars for all
  using (garage_id = public.current_garage_id() or public.is_superadmin())
  with check (garage_id = public.current_garage_id() or public.is_superadmin());

drop policy if exists services_scope on public.services;
create policy services_scope on public.services for all
  using (garage_id = public.current_garage_id() or public.is_superadmin())
  with check (garage_id = public.current_garage_id() or public.is_superadmin());

drop policy if exists appointments_scope on public.appointments;
create policy appointments_scope on public.appointments for all
  using (garage_id = public.current_garage_id() or public.is_superadmin())
  with check (garage_id = public.current_garage_id() or public.is_superadmin());

drop policy if exists quotes_scope on public.quotes;
create policy quotes_scope on public.quotes for all
  using (garage_id = public.current_garage_id() or public.is_superadmin())
  with check (garage_id = public.current_garage_id() or public.is_superadmin());

drop policy if exists messages_scope on public.messages;
create policy messages_scope on public.messages for all
  using (garage_id = public.current_garage_id() or public.is_superadmin())
  with check (garage_id = public.current_garage_id() or public.is_superadmin());

drop policy if exists garage_members_scope on public.garage_members;
create policy garage_members_scope on public.garage_members for select
  using (user_id = auth.uid() or public.is_superadmin());

-- Affiche l'UUID du garage pilote pour le mettre dans DEFAULT_GARAGE_ID.
do $$
declare
  pilot_id uuid;
begin
  select id into pilot_id from public.garages where slug = 'garage-pilote';
  raise notice 'DEFAULT_GARAGE_ID = %', pilot_id;
end $$;

-- =====================================================================
-- Étape manuelle (une fois) pour vous connecter à /admin :
-- 1. Supabase Dashboard > Authentication > Users > Add user (email + mot de passe).
-- 2. Copier l'UUID généré, puis exécuter (remplacez les deux UUID) :
--    insert into public.garage_members (garage_id, user_id, role)
--    values ('<DEFAULT_GARAGE_ID ci-dessus>', '<UUID utilisateur>', 'owner');
--    insert into public.superadmins (user_id) values ('<UUID utilisateur>');
-- =====================================================================
