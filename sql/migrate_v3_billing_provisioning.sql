-- =====================================================================
-- Migration v2 -> v3 : numéro WhatsApp dédié par garage + facturation Stripe
-- À exécuter UNE SEULE FOIS (Supabase > SQL Editor > coller > Run).
-- Sans effet sur les garages existants tant que le provisioning n'a pas
-- été déclenché pour eux (le webhook retombe sur DEFAULT_GARAGE_ID).
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

-- Idempotence des webhooks Stripe (une redélivrance ne doit jamais
-- re-déclencher le provisioning ou changer deux fois le statut).
create table if not exists public.processed_stripe_events (
  event_id   text primary key,
  created_at timestamptz not null default now()
);

-- Journal des actions manuelles du super-admin (suspension, relance, etc.).
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
-- RLS : ligne de défense secondaire (le backend utilise service_role).
-- garage_whatsapp_numbers contient des secrets Twilio : accès super-admin
-- uniquement, jamais visible même par le propriétaire du garage.
-- =====================================================================
alter table public.garage_whatsapp_numbers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.processed_stripe_events enable row level security;
alter table public.admin_actions enable row level security;

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
