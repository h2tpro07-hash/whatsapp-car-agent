-- =====================================================================
-- Agent WhatsApp - Schéma Supabase
-- À coller tel quel dans Supabase > SQL Editor > Run
-- =====================================================================

create table if not exists public.cars (
  id          bigint generated always as identity primary key,
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

-- Recherche rapide par marque / modèle (insensible à la casse)
create index if not exists cars_brand_idx on public.cars (lower(brand));
create index if not exists cars_model_idx on public.cars (lower(model));
create index if not exists cars_status_idx on public.cars (status);

-- RLS : activé, aucune policy publique.
-- Le backend utilise la clé service_role qui contourne RLS.
alter table public.cars enable row level security;

-- =====================================================================
-- Données de test
-- =====================================================================
insert into public.cars (brand, model, year, price, mileage, fuel, description, status) values
  ('Peugeot', '208', 2019, 11990.00, 68000, 'Essence',
   'Peugeot 208 1.2 PureTech 82ch Active, 5 portes, climatisation auto, écran tactile, régulateur de vitesse. Carnet d''entretien complet, 2 clés, non-fumeur.',
   'available'),
  ('Volkswagen', 'Golf 7', 2017, 14500.00, 112000, 'Diesel',
   'Golf 7 1.6 TDI 115ch Confortline BlueMotion, GPS, radar de recul, sièges chauffants. Distribution faite à 100 000 km, révision à jour.',
   'available'),
  ('Renault', 'Clio 5', 2021, 13900.00, 41000, 'Essence',
   'Clio 5 1.0 TCe 100ch Intens, Apple CarPlay / Android Auto, caméra de recul, keyless. Première main, garantie constructeur restante.',
   'available');
