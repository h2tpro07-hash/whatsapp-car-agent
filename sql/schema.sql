-- =====================================================================
-- Agent WhatsApp — Schéma Supabase multi-garages (v2)
-- Pour un PROJET NEUF. Si vous avez déjà un projet avec la table `cars`
-- mono-garage de la v1, utilisez plutôt `sql/migrate_v2_multi_tenant.sql`.
-- À coller tel quel dans Supabase > SQL Editor > Run.
-- =====================================================================

create extension if not exists pgcrypto;

-- =====================================================================
-- Tenants
-- =====================================================================
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

-- Comptes liés à un garage (le propriétaire, puis employés plus tard).
-- v1 : un utilisateur n'appartient qu'à un seul garage.
create table if not exists public.garage_members (
  id         uuid primary key default gen_random_uuid(),
  garage_id  uuid not null references public.garages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  unique (garage_id, user_id),
  unique (user_id)
);

-- Super-admins (vous) : table dédiée, jamais un booléen éditable par un garage.
-- Alimentée manuellement en SQL, jamais via une interface.
create table if not exists public.superadmins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- Métier "vente" (revendeur de véhicules d'occasion)
-- =====================================================================
create table if not exists public.cars (
  id          bigint generated always as identity primary key,
  garage_id   uuid        not null references public.garages(id) on delete cascade,
  brand       text        not null,
  model       text        not null,
  year        int         not null,
  price       numeric(10,2) not null,
  mileage     int         not null,
  fuel        text        not null,
  description text,
  status      text        not null default 'available'
              check (status in ('available', 'reserved', 'sold')),
  created_at  timestamptz not null default now()
);
create index if not exists cars_garage_idx on public.cars (garage_id);
create index if not exists cars_brand_idx on public.cars (lower(brand));
create index if not exists cars_model_idx on public.cars (lower(model));
create index if not exists cars_status_idx on public.cars (status);

-- =====================================================================
-- Métier "réparation" (garage mécanique)
-- =====================================================================
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

-- Journal des messages (debug, futur contexte conversationnel).
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
-- Numéro WhatsApp dédié par garage + facturation Stripe
-- =====================================================================
create table if not exists public.garage_whatsapp_numbers (
  id                  uuid primary key default gen_random_uuid(),
  garage_id           uuid not null unique references public.garages(id) on delete cascade,
  twilio_account_sid  text not null,
  twilio_auth_token   text not null,
  whatsapp_number     text not null,
  status              text not null default 'pending'
                      check (status in ('pending', 'active', 'failed', 'released')),
  provisioning_error  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists garage_whatsapp_numbers_number_idx on public.garage_whatsapp_numbers (whatsapp_number);

create table if not exists public.subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  garage_id               uuid not null unique references public.garages(id) on delete cascade,
  stripe_customer_id      text not null,
  stripe_subscription_id  text,
  plan                    text not null default 'standard',
  status                  text not null default 'incomplete'
                          check (status in ('incomplete', 'trialing', 'active', 'past_due', 'unpaid', 'canceled')),
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists subscriptions_stripe_customer_idx on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_stripe_subscription_idx on public.subscriptions (stripe_subscription_id);

create table if not exists public.processed_stripe_events (
  event_id   text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_actions (
  id                  uuid primary key default gen_random_uuid(),
  superadmin_user_id  uuid references auth.users(id) on delete set null,
  garage_id           uuid references public.garages(id) on delete cascade,
  action              text not null,
  note                text,
  created_at          timestamptz not null default now()
);
create index if not exists admin_actions_garage_idx on public.admin_actions (garage_id);

-- =====================================================================
-- RLS : ligne de défense secondaire.
-- Le backend utilise la clé service_role (contourne RLS) et fait lui-même
-- le filtrage par garage_id. Ces policies ne servent que si une future
-- intégration interroge Supabase directement avec un JWT utilisateur.
-- =====================================================================
alter table public.garages enable row level security;
alter table public.garage_members enable row level security;
alter table public.cars enable row level security;
alter table public.services enable row level security;
alter table public.appointments enable row level security;
alter table public.quotes enable row level security;
alter table public.messages enable row level security;
alter table public.garage_whatsapp_numbers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.processed_stripe_events enable row level security;
alter table public.admin_actions enable row level security;

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

-- garage_whatsapp_numbers contient des secrets Twilio : super-admin uniquement,
-- jamais visible même par le propriétaire du garage.
drop policy if exists garage_whatsapp_numbers_scope on public.garage_whatsapp_numbers;
create policy garage_whatsapp_numbers_scope on public.garage_whatsapp_numbers for all
  using (public.is_superadmin())
  with check (public.is_superadmin());

drop policy if exists subscriptions_scope on public.subscriptions;
create policy subscriptions_scope on public.subscriptions for all
  using (garage_id = public.current_garage_id() or public.is_superadmin())
  with check (garage_id = public.current_garage_id() or public.is_superadmin());

drop policy if exists processed_stripe_events_scope on public.processed_stripe_events;
create policy processed_stripe_events_scope on public.processed_stripe_events for all
  using (public.is_superadmin())
  with check (public.is_superadmin());

drop policy if exists admin_actions_scope on public.admin_actions;
create policy admin_actions_scope on public.admin_actions for all
  using (public.is_superadmin())
  with check (public.is_superadmin());

-- =====================================================================
-- Données de démonstration : un garage par métier
-- =====================================================================
do $$
declare
  demo_vente_id       uuid;
  demo_reparation_id  uuid;
begin
  insert into public.garages (name, vertical, slug, status)
  values ('Demo Auto Occasion', 'vente', 'demo-auto-occasion', 'active')
  returning id into demo_vente_id;

  insert into public.cars (garage_id, brand, model, year, price, mileage, fuel, description, status) values
    (demo_vente_id, 'Peugeot', '208', 2019, 11990.00, 68000, 'Essence',
     'Peugeot 208 1.2 PureTech 82ch Active, 5 portes, climatisation auto, écran tactile, régulateur de vitesse. Carnet d''entretien complet, 2 clés, non-fumeur.',
     'available'),
    (demo_vente_id, 'Volkswagen', 'Golf 7', 2017, 14500.00, 112000, 'Diesel',
     'Golf 7 1.6 TDI 115ch Confortline BlueMotion, GPS, radar de recul, sièges chauffants. Distribution faite à 100 000 km, révision à jour.',
     'available'),
    (demo_vente_id, 'Renault', 'Clio 5', 2021, 13900.00, 41000, 'Essence',
     'Clio 5 1.0 TCe 100ch Intens, Apple CarPlay / Android Auto, caméra de recul, keyless. Première main, garantie constructeur restante.',
     'available');

  insert into public.garages (name, vertical, slug, status)
  values ('Demo Garage Mécanique', 'reparation', 'demo-garage-mecanique', 'active')
  returning id into demo_reparation_id;

  insert into public.services (garage_id, name, description, price_min, price_max, duration_min) values
    (demo_reparation_id, 'Vidange', 'Vidange huile + filtre, toutes motorisations', 69.00, 99.00, 45),
    (demo_reparation_id, 'Révision complète', 'Contrôle des 30 points + vidange', 149.00, 249.00, 90),
    (demo_reparation_id, 'Changement de pneus', 'Montage + équilibrage, 4 pneus', 280.00, 600.00, 60),
    (demo_reparation_id, 'Contrôle technique', 'Passage en centre partenaire', 78.00, 78.00, 30);

  raise notice 'DEFAULT_GARAGE_ID (vente, démo) = %', demo_vente_id;
  raise notice 'DEFAULT_GARAGE_ID (réparation, démo) = %', demo_reparation_id;
end $$;

-- Étape manuelle (une fois) pour vous connecter à /admin :
-- 1. Supabase Dashboard > Authentication > Users > Add user (email + mot de passe).
-- 2. Copier l'UUID généré, puis exécuter (remplacez les deux UUID) :
--    insert into public.garage_members (garage_id, user_id, role)
--    values ('<un des DEFAULT_GARAGE_ID ci-dessus>', '<UUID utilisateur>', 'owner');
--    insert into public.superadmins (user_id) values ('<UUID utilisateur>');
