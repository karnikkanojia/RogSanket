/**
 * EpiCast Dashboard Data Service
 *
 * Query functions for the dashboard overview and district drill-down.
 * All queries are read-only (SELECT). Falls back gracefully to demo data
 * if tables don't exist yet or Supabase is unreachable.
 */

import { supabase } from './supabase';

// ── Dashboard Overview ────────────────────────────────────────────────────────

/**
 * High-level stats for the main dashboard.
 * Compares this week vs last week to compute weekChange %.
 *
 * @param {string|null} districtId - filter to a specific district, or null for all
 */
export async function getDashboardOverview(districtId = null) {
  const now = Date.now();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  // This week
  let q = supabase
    .from('encounters')
    .select('id,syndrome_category,severity', { count: 'exact' })
    .gte('created_at', weekAgo);
  if (districtId) q = q.eq('district_id', districtId);
  const { count: thisWeek, data: thisData } = await q;

  // Last week
  let pq = supabase
    .from('encounters')
    .select('id', { count: 'exact' })
    .gte('created_at', twoWeeksAgo)
    .lt('created_at', weekAgo);
  if (districtId) pq = pq.eq('district_id', districtId);
  const { count: lastWeek } = await pq;

  const rows = thisData || [];
  const uniqueSyndromes = [...new Set(rows.map(e => e.syndrome_category).filter(Boolean))];
  const severeCount = rows.filter(e => e.severity === 'severe' || e.severity === 'critical').length;
  const weekChange = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0;

  // Active districts this week
  const { data: distData } = await supabase
    .from('encounters')
    .select('district_id')
    .gte('created_at', weekAgo);
  const activeDistricts = [...new Set((distData || []).map(e => e.district_id).filter(Boolean))].length;

  return {
    totalEncounters: thisWeek || 0,
    weekChange,
    activeSyndromes: uniqueSyndromes,
    severeCount,
    activeDistricts,
    lastWeekCount: lastWeek || 0,
  };
}

// ── Time Series ───────────────────────────────────────────────────────────────

/**
 * Weekly time series from weekly_counts table.
 * Returns a map of syndrome → [{ label, week, year, count }].
 * Falls back to demo data if table doesn't exist or query fails.
 *
 * @param {string|null} districtId
 * @param {string|null} syndrome - filter to one syndrome
 * @param {number} weeks - how many weeks of history
 */
export async function getDistrictTimeSeries(districtId, syndrome = null, weeks = 12) {
  try {
    const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoff.toISOString().split('T')[0]; // DATE format

    let q = supabase
      .from('weekly_counts')
      .select('syndrome_category,week_start,count')
      .gte('week_start', cutoffStr)
      .order('week_start', { ascending: true });

    if (districtId) q = q.eq('district_id', districtId);
    if (syndrome) q = q.eq('syndrome_category', syndrome);

    const { data, error } = await q;
    if (error || !data || data.length === 0) {
      return generateDemoTimeSeries(weeks);
    }

    const series = {};
    for (const row of data) {
      if (!series[row.syndrome_category]) series[row.syndrome_category] = [];
      const d = new Date(row.week_start);
      const ew = getEpiWeek(d);
      const ey = d.getFullYear();
      const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
      series[row.syndrome_category].push({
        week: `W${ew}`,
        year: ey,
        count: row.count,
        severe: 0,
        label: `${ey}-W${String(ew).padStart(2, '0')}`,
        dateStr,
      });
    }
    return series;
  } catch {
    return generateDemoTimeSeries(weeks);
  }
}

// ── Syndrome Breakdown ────────────────────────────────────────────────────────

/**
 * Syndrome encounter counts for the last N weeks.
 * @param {string|null} districtId
 * @param {number} weeks
 * @returns {{ syndrome: string, count: number }[]} sorted descending by count
 */
export async function getSyndromeBreakdown(districtId, weeks = 4) {
  const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
  let q = supabase.from('encounters').select('syndrome_category').gte('created_at', cutoff);
  if (districtId) q = q.eq('district_id', districtId);
  const { data } = await q;

  const counts = {};
  for (const row of data || []) {
    if (row.syndrome_category) {
      counts[row.syndrome_category] = (counts[row.syndrome_category] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([syndrome, count]) => ({ syndrome, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Recent Encounters ─────────────────────────────────────────────────────────

/**
 * Most recent encounters, optionally filtered by district.
 * @param {string|null} districtId
 * @param {number} limit
 */
export async function getRecentEncounters(districtId, limit = 20) {
  let q = supabase
    .from('encounters')
    .select(
      'id,narrative_text,syndrome_category,severity,confidence_score,icd10_codes,symptoms,created_at,district_id,cough_analysis,image_analysis'
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (districtId) q = q.eq('district_id', districtId);
  const { data } = await q;
  return data || [];
}

// ── Spike Alerts ──────────────────────────────────────────────────────────────

/**
 * Detect syndromes with >50% spike vs recent baseline.
 * Uses weekly_counts table. Returns [] if table doesn't exist.
 *
 * @param {string|null} districtId
 */
export async function getAlerts(districtId = null) {
  try {
    const { data, error } = await supabase
      .from('weekly_counts')
      .select('district_id,syndrome_category,week_start,count')
      .order('week_start', { ascending: false })
      .limit(500);

    if (error) return [];

    // Group by district+syndrome
    const groups = {};
    for (const row of data || []) {
      const k = `${row.district_id}__${row.syndrome_category}`;
      if (!groups[k]) groups[k] = [];
      groups[k].push(row);
    }

    const alerts = [];
    for (const [k, rows] of Object.entries(groups)) {
      if (rows.length < 2) continue;
      const latest = rows[0].count;
      const baselineRows = rows.slice(1, 5);
      const baseline = baselineRows.reduce((s, r) => s + r.count, 0) / baselineRows.length;
      if (baseline > 0 && latest > baseline * 1.5) {
        const [distId, syndrome] = k.split('__');
        if (districtId && distId !== districtId) continue;
        alerts.push({
          district_id: distId,
          syndrome,
          current: latest,
          baseline: Math.round(baseline * 10) / 10,
          increase_pct: Math.round(((latest - baseline) / baseline) * 100),
        });
      }
    }
    return alerts.sort((a, b) => b.increase_pct - a.increase_pct);
  } catch {
    return [];
  }
}

// ── Demo Data ─────────────────────────────────────────────────────────────────

/**
 * Generate realistic demo time series data when Supabase is unavailable.
 * Returns the same format as getDistrictTimeSeries().
 */
function generateDemoTimeSeries(weeks = 12) {
  const now = new Date();
  const syndromes = {
    acute_watery_diarrhea: { base: 15, variance: 8, trend: 0.5 },
    acute_febrile_illness: { base: 22, variance: 10, trend: -0.3 },
    acute_respiratory_infection: { base: 18, variance: 7, trend: 1.2 },
    acute_rash_fever: { base: 4, variance: 3, trend: 0.1 },
  };

  const series = {};
  for (const [syn, cfg] of Object.entries(syndromes)) {
    series[syn] = [];
    for (let w = weeks - 1; w >= 0; w--) {
      const d = new Date(now.getTime() - w * 7 * 24 * 60 * 60 * 1000);
      const ew = getEpiWeek(d);
      const ey = d.getFullYear();
      // Pseudo-random but deterministic per week+syndrome
      const seed = (ew * 7 + syn.length) % 17;
      const count = Math.max(1, Math.round(
        cfg.base + cfg.trend * (weeks - w) + (seed - 8) * (cfg.variance / 8)
      ));
      const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
      series[syn].push({
        week: `W${ew}`,
        year: ey,
        count,
        severe: 0,
        label: `${ey}-W${String(ew).padStart(2, '0')}`,
        dateStr,
      });
    }
  }
  return series;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEpiWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
