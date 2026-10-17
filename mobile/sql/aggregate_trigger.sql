-- ============================================
-- EpiCast Auto-Aggregation Trigger
-- Run this in the Supabase SQL Editor after schema.sql and seed.sql.
--
-- Automatically updates weekly_counts whenever a new encounter is inserted.
-- This keeps the time series dashboard current without manual aggregation.
-- ============================================

-- Trigger function: insert/update weekly_counts on encounter insert
CREATE OR REPLACE FUNCTION update_weekly_counts()
RETURNS TRIGGER AS $$
DECLARE
  w_start DATE;
BEGIN
  -- Skip if missing required fields
  IF NEW.district_id IS NULL OR NEW.syndrome_category IS NULL THEN
    RETURN NEW;
  END IF;

  -- Calculate Monday of the encounter's week (ISO week start)
  w_start := date_trunc('week', COALESCE(NEW.created_at, NOW()))::date;

  INSERT INTO weekly_counts (district_id, syndrome_category, week_start, count)
  VALUES (NEW.district_id, NEW.syndrome_category, w_start, 1)
  ON CONFLICT (district_id, syndrome_category, week_start)
  DO UPDATE SET count = weekly_counts.count + 1;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if any, then create
DROP TRIGGER IF EXISTS trigger_update_weekly_counts ON encounters;

CREATE TRIGGER trigger_update_weekly_counts
  AFTER INSERT ON encounters
  FOR EACH ROW
  EXECUTE FUNCTION update_weekly_counts();

-- Allow anyone to insert weekly_counts (for the trigger to work with anon/service role)
CREATE POLICY "Anyone can insert weekly_counts" ON weekly_counts FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update weekly_counts" ON weekly_counts FOR UPDATE USING (true);
