-- ============================================
-- EpiCast Demo Accounts — Supabase
-- Run AFTER schema.sql and seed.sql
-- ============================================
-- Creates 5 demo users across different ECOWAS countries & roles.
-- All passwords: Demo1234!
-- ============================================

-- 1. Create demo auth users
-- The password hash below is bcrypt for 'Demo1234!'
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, confirmation_token, is_super_admin
) VALUES
-- Dr. Amina Bello — CHW in Kano, Nigeria
(
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4000-8000-000000000001',
  'authenticated', 'authenticated',
  'amina@epicast.demo',
  crypt('Demo1234!', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Dr. Amina Bello"}',
  '', false
),
-- Kwame Asante — District Officer in Greater Accra, Ghana
(
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4000-8000-000000000002',
  'authenticated', 'authenticated',
  'kwame@epicast.demo',
  crypt('Demo1234!', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Kwame Asante"}',
  '', false
),
-- Fatou Diallo — Regional Admin in Dakar, Senegal
(
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4000-8000-000000000003',
  'authenticated', 'authenticated',
  'fatou@epicast.demo',
  crypt('Demo1234!', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Fatou Diallo"}',
  '', false
),
-- Dr. Moussa Keita — National Officer, Guinea (Nzerekore VHF response)
(
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4000-8000-000000000004',
  'authenticated', 'authenticated',
  'moussa@epicast.demo',
  crypt('Demo1234!', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Dr. Moussa Keita"}',
  '', false
),
-- Aisha Ibrahim — ECOWAS Regional Admin (continental view)
(
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4000-8000-000000000005',
  'authenticated', 'authenticated',
  'aisha@epicast.demo',
  crypt('Demo1234!', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Aisha Ibrahim"}',
  '', false
)
ON CONFLICT (id) DO NOTHING;

-- Also need identities for each user (required by Supabase Auth)
INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
VALUES
  (gen_random_uuid(), '11111111-1111-4000-8000-000000000001', '{"sub":"11111111-1111-4000-8000-000000000001","email":"amina@epicast.demo"}', 'email', '11111111-1111-4000-8000-000000000001', now(), now(), now()),
  (gen_random_uuid(), '11111111-1111-4000-8000-000000000002', '{"sub":"11111111-1111-4000-8000-000000000002","email":"kwame@epicast.demo"}', 'email', '11111111-1111-4000-8000-000000000002', now(), now(), now()),
  (gen_random_uuid(), '11111111-1111-4000-8000-000000000003', '{"sub":"11111111-1111-4000-8000-000000000003","email":"fatou@epicast.demo"}', 'email', '11111111-1111-4000-8000-000000000003', now(), now(), now()),
  (gen_random_uuid(), '11111111-1111-4000-8000-000000000004', '{"sub":"11111111-1111-4000-8000-000000000004","email":"moussa@epicast.demo"}', 'email', '11111111-1111-4000-8000-000000000004', now(), now(), now()),
  (gen_random_uuid(), '11111111-1111-4000-8000-000000000005', '{"sub":"11111111-1111-4000-8000-000000000005","email":"aisha@epicast.demo"}', 'email', '11111111-1111-4000-8000-000000000005', now(), now(), now())
ON CONFLICT DO NOTHING;

-- 2. Create profiles linking users to geographic locations
INSERT INTO profiles (id, full_name, role, facility_id, district_id, region_id, country_id) VALUES
-- Amina: CHW at Kano General Hospital
(
  '11111111-1111-4000-8000-000000000001',
  'Dr. Amina Bello',
  'chw',
  (SELECT id FROM facilities WHERE district_id = 'c0000000-0000-4000-8000-000000000101' LIMIT 1),
  'c0000000-0000-4000-8000-000000000101',
  'b0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001'
),
-- Kwame: District Officer in Accra Metro
(
  '11111111-1111-4000-8000-000000000002',
  'Kwame Asante',
  'district_officer',
  NULL,
  (SELECT id FROM districts WHERE region_id = 'b0000000-0000-4000-8000-000000000010' LIMIT 1),
  'b0000000-0000-4000-8000-000000000010',
  'a0000000-0000-4000-8000-000000000002'
),
-- Fatou: Regional Admin in Dakar
(
  '11111111-1111-4000-8000-000000000003',
  'Fatou Diallo',
  'state_officer',
  NULL,
  NULL,
  'b0000000-0000-4000-8000-000000000020',
  'a0000000-0000-4000-8000-000000000003'
),
-- Moussa: National Officer in Guinea
(
  '11111111-1111-4000-8000-000000000004',
  'Dr. Moussa Keita',
  'national_officer',
  NULL,
  NULL,
  NULL,
  'a0000000-0000-4000-8000-000000000008'
),
-- Aisha: ECOWAS Regional Admin (no location bound)
(
  '11111111-1111-4000-8000-000000000005',
  'Aisha Ibrahim',
  'regional_admin',
  NULL,
  NULL,
  NULL,
  NULL
)
ON CONFLICT (id) DO NOTHING;

-- 3. Assign some existing encounters to demo users
UPDATE encounters SET user_id = '11111111-1111-4000-8000-000000000001'
WHERE district_id = 'c0000000-0000-4000-8000-000000000101'
  AND user_id IS NULL;

UPDATE encounters SET user_id = '11111111-1111-4000-8000-000000000002'
WHERE district_id IN (SELECT id FROM districts WHERE region_id = 'b0000000-0000-4000-8000-000000000010')
  AND user_id IS NULL;

UPDATE encounters SET user_id = '11111111-1111-4000-8000-000000000004'
WHERE district_id IN (SELECT id FROM districts WHERE region_id = 'b0000000-0000-4000-8000-000000000071')
  AND user_id IS NULL;

-- ============================================
-- DEMO ACCOUNTS SUMMARY
-- ============================================
-- | Email                  | Password   | Role            | Location                    |
-- |------------------------|------------|-----------------|----------------------------|
-- | amina@epicast.demo     | Demo1234!  | CHW             | Kano, Nigeria              |
-- | kwame@epicast.demo     | Demo1234!  | District Officer| Greater Accra, Ghana       |
-- | fatou@epicast.demo     | Demo1234!  | State Officer   | Dakar, Senegal             |
-- | moussa@epicast.demo    | Demo1234!  | National Officer| Guinea                     |
-- | aisha@epicast.demo     | Demo1234!  | Regional Admin  | ECOWAS (all countries)     |
-- ============================================
