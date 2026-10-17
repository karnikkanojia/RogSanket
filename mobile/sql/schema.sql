-- ============================================
-- EpiCast Database Schema — Supabase (PostgreSQL)
-- Paste this into the Supabase SQL Editor.
-- ============================================

-- ============================================
-- GEOGRAPHIC HIERARCHY
-- ============================================

CREATE TABLE countries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  flag TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  climate_zone TEXT,
  population BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE regions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  country_id UUID REFERENCES countries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  population BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE districts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  region_id UUID REFERENCES regions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  population INTEGER,
  climate_zone TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE facilities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  district_id UUID REFERENCES districts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  facility_type TEXT CHECK (facility_type IN ('hospital', 'health_center', 'clinic', 'CHPS', 'mobile_unit')),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- USER PROFILES
-- ============================================

CREATE TABLE profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  full_name TEXT,
  role TEXT CHECK (role IN ('chw', 'facility_officer', 'district_officer', 'state_officer', 'national_officer', 'regional_admin')) DEFAULT 'chw',
  facility_id UUID REFERENCES facilities(id),
  district_id UUID REFERENCES districts(id),
  region_id UUID REFERENCES regions(id),
  country_id UUID REFERENCES countries(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- ENCOUNTERS (Core surveillance data)
-- ============================================

CREATE TABLE encounters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  facility_id UUID REFERENCES facilities(id),
  district_id UUID REFERENCES districts(id),
  user_id UUID REFERENCES auth.users(id),

  -- Raw inputs
  narrative_text TEXT,
  audio_url TEXT,
  image_url TEXT,

  -- MedGemma extraction
  syndromic_signal JSONB,
  syndrome_category TEXT,
  severity TEXT CHECK (severity IN ('mild', 'moderate', 'severe', 'critical')),
  symptoms TEXT[],
  icd10_codes TEXT[],
  confidence_score DOUBLE PRECISION,
  reportable_conditions TEXT[],
  cluster_indicator BOOLEAN DEFAULT false,
  age_group TEXT,
  sex TEXT,

  -- HeAR cough analysis
  cough_analysis JSONB,

  -- MedSigLIP image triage
  image_analysis JSONB,

  -- Multi-modal fusion
  fusion_result JSONB,
  fused_confidence DOUBLE PRECISION,

  -- Location
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION
);

CREATE INDEX idx_encounters_facility ON encounters(facility_id, created_at DESC);
CREATE INDEX idx_encounters_district ON encounters(district_id, created_at DESC);
CREATE INDEX idx_encounters_syndrome ON encounters(syndrome_category, created_at DESC);

-- ============================================
-- WEEKLY AGGREGATES
-- ============================================

CREATE TABLE weekly_counts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  district_id UUID REFERENCES districts(id) ON DELETE CASCADE,
  syndrome_category TEXT NOT NULL,
  week_start DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(district_id, syndrome_category, week_start)
);

CREATE INDEX idx_weekly_district ON weekly_counts(district_id, week_start DESC);

-- ============================================
-- ALERTS
-- ============================================

CREATE TABLE alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  district_id UUID REFERENCES districts(id) ON DELETE CASCADE,
  country_code TEXT,
  alert_level TEXT CHECK (alert_level IN ('watch', 'warning', 'emergency')) NOT NULL,
  syndrome_category TEXT NOT NULL,
  case_count_current_week INTEGER,
  case_count_baseline DOUBLE PRECISION,
  ratio_to_baseline DOUBLE PRECISION,
  trend TEXT CHECK (trend IN ('increasing', 'stable', 'decreasing')),
  weeks_above_threshold INTEGER DEFAULT 1,
  situation_summary TEXT,
  recommended_actions TEXT[],
  evidence_summary TEXT,
  is_active BOOLEAN DEFAULT true,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_alerts_active ON alerts(is_active, alert_level, created_at DESC);

-- ============================================
-- FORECASTS
-- ============================================

CREATE TABLE forecasts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  district_id UUID REFERENCES districts(id) ON DELETE CASCADE,
  syndrome_category TEXT NOT NULL,
  forecast_week DATE NOT NULL,
  predicted_count DOUBLE PRECISION,
  lower_bound DOUBLE PRECISION,
  upper_bound DOUBLE PRECISION,
  outbreak_threshold DOUBLE PRECISION,
  trend TEXT,
  alert_message TEXT,
  method TEXT DEFAULT 'linear_trend_poisson'
);

-- ============================================
-- REPORTS
-- ============================================

CREATE TABLE reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  report_type TEXT CHECK (report_type IN ('situation_report', 'fhir_bundle', 'weekly_summary')),
  scope_type TEXT CHECK (scope_type IN ('district', 'region', 'country', 'continental')),
  scope_id UUID,
  generated_by UUID REFERENCES auth.users(id),
  content TEXT,
  fhir_bundle JSONB,
  metadata JSONB
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE countries ENABLE ROW LEVEL SECURITY;
ALTER TABLE regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE districts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facilities ENABLE ROW LEVEL SECURITY;

-- Geographic data: readable by everyone (including anon for demo)
CREATE POLICY "Anyone can read countries" ON countries FOR SELECT USING (true);
CREATE POLICY "Anyone can read regions" ON regions FOR SELECT USING (true);
CREATE POLICY "Anyone can read districts" ON districts FOR SELECT USING (true);
CREATE POLICY "Anyone can read facilities" ON facilities FOR SELECT USING (true);

-- Surveillance data: readable by anyone, insertable by anyone (demo-friendly)
CREATE POLICY "Anyone can read encounters" ON encounters FOR SELECT USING (true);
CREATE POLICY "Anyone can insert encounters" ON encounters FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can read alerts" ON alerts FOR SELECT USING (true);
CREATE POLICY "Anyone can read weekly_counts" ON weekly_counts FOR SELECT USING (true);
CREATE POLICY "Anyone can read forecasts" ON forecasts FOR SELECT USING (true);
CREATE POLICY "Anyone can read reports" ON reports FOR SELECT USING (true);
CREATE POLICY "Anyone can insert reports" ON reports FOR INSERT WITH CHECK (true);

-- ============================================
-- ENABLE REALTIME
-- ============================================
-- Run these in Supabase Dashboard > Database > Replication:
-- Enable realtime on: encounters, alerts
