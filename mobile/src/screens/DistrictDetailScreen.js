import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  Dimensions, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Spacing, BorderRadius, Shadows, SyndromeLabels } from '../utils/theme';
import { getDistrictTimeSeries, getRecentEncounters } from '../services/dashboardData';

const { width: SW } = Dimensions.get('window');
const CHART_WIDTH = SW - Spacing.xl * 2;

const TIME_RANGES = [
  { label: '4W', weeks: 4 },
  { label: '8W', weeks: 8 },
  { label: '12W', weeks: 12 },
  { label: '24W', weeks: 24 },
];

// Colors for up to 8 syndromes in the chart
const SYNDROME_COLORS = [
  Colors.syndrome.acute_watery_diarrhea || '#06B6D4',
  Colors.syndrome.acute_febrile_illness || '#EF4444',
  Colors.syndrome.acute_respiratory_infection || '#8B5CF6',
  Colors.syndrome.acute_bloody_diarrhea || '#F97316',
  Colors.syndrome.acute_rash_fever || '#F59E0B',
  Colors.syndrome.acute_neurological_syndrome || '#EC4899',
  Colors.syndrome.acute_hemorrhagic_fever || '#DC2626',
  Colors.syndrome.unexplained_cluster || '#6B7280',
];

function getSyndromeColor(syndrome, index) {
  return Colors.syndrome[syndrome] || SYNDROME_COLORS[index % SYNDROME_COLORS.length];
}

function getTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function DistrictDetailScreen({ route }) {
  const { districtId, syndrome: filterSyndrome, filterSeverity } = route.params || {};

  const [selectedWeeks, setSelectedWeeks] = useState(12);
  const [activeSyndrome, setActiveSyndrome] = useState(filterSyndrome || null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dataSource, setDataSource] = useState('live'); // 'live' | 'demo'

  const [timeSeries, setTimeSeries] = useState({});
  const [breakdown, setBreakdown] = useState([]);
  const [encounters, setEncounters] = useState([]);

  const loadData = useCallback(async () => {
    try {
      const [ts, enc] = await Promise.all([
        getDistrictTimeSeries(districtId, activeSyndrome, selectedWeeks),
        getRecentEncounters(districtId, 20),
      ]);
      setTimeSeries(ts);

      // Derive breakdown from the same time series data so numbers match the chart
      const bd = Object.entries(ts).map(([syndrome, points]) => ({
        syndrome,
        count: points.reduce((sum, p) => sum + p.count, 0),
      })).sort((a, b) => b.count - a.count);
      setBreakdown(bd);

      // Detect if time series is demo data
      const tsKeys = Object.keys(ts);
      const isDemoTs = tsKeys.length > 0 && tsKeys.includes('acute_watery_diarrhea') && tsKeys.includes('acute_respiratory_infection') && enc.length === 0;
      setDataSource(isDemoTs ? 'demo' : 'live');

      // Apply severity filter if requested
      const filtered = filterSeverity
        ? enc.filter(e => e.severity === 'severe' || e.severity === 'critical')
        : enc;
      setEncounters(filtered);
    } catch (e) {
      console.warn('DistrictDetailScreen load error:', e.message);
      setDataSource('demo');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [districtId, activeSyndrome, selectedWeeks, filterSeverity]);

  useEffect(() => { loadData(); }, [loadData]);

  const onRefresh = useCallback(() => { setRefreshing(true); loadData(); }, [loadData]);

  // Build chart data from timeSeries
  const chartData = buildChartData(timeSeries);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={Colors.accent.primary} />
      </View>
    );
  }

  const sevColors = { mild: Colors.severity.low, moderate: Colors.severity.watch, severe: Colors.severity.warning, critical: Colors.severity.emergency };
  const maxBreakdown = breakdown.length > 0 ? breakdown[0].count : 1;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent.primary} />}
      showsVerticalScrollIndicator={false}
    >
      {/* Time range selector */}
      <View style={styles.rangeRow}>
        {TIME_RANGES.map(({ label, weeks }) => (
          <TouchableOpacity
            key={label}
            style={[styles.rangeChip, selectedWeeks === weeks && styles.rangeChipActive]}
            onPress={() => setSelectedWeeks(weeks)}
          >
            <Text style={[styles.rangeChipText, selectedWeeks === weeks && styles.rangeChipTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Time Series Chart */}
      <View style={styles.section}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Text style={styles.sectionTitle}>Weekly Trend</Text>
          {dataSource === 'demo' && (
            <View style={{ backgroundColor: '#F59E0B20', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
              <Text style={{ fontSize: 9, fontWeight: '700', color: '#F59E0B', letterSpacing: 0.5 }}>DEMO</Text>
            </View>
          )}
        </View>
        <View style={styles.card}>
          {chartData.hasData ? (
            <>
              <LineChart
                data={{
                  labels: chartData.labels,
                  datasets: chartData.datasets,
                }}
                width={CHART_WIDTH - 32}
                height={220}
                bezier
                verticalLabelRotation={-90}
                chartConfig={{
                  backgroundColor: Colors.bg.card,
                  backgroundGradientFrom: Colors.bg.card,
                  backgroundGradientTo: Colors.bg.card,
                  decimalPlaces: 0,
                  color: (opacity = 1) => `rgba(16, 185, 129, ${opacity})`,
                  labelColor: () => Colors.text.tertiary,
                  style: { borderRadius: 8 },
                  propsForDots: { r: '3', strokeWidth: '1' },
                  propsForBackgroundLines: { stroke: Colors.border, strokeDasharray: '' },
                  propsForLabels: { fontSize: 9 },
                }}
                style={{ marginLeft: -8 }}
                withInnerLines
                withOuterLines={false}
                withShadow={false}
                fromZero
              />

              {/* Legend */}
              <View style={styles.legend}>
                {chartData.syndromes.map((syn, i) => {
                  const total = breakdown.find(b => b.syndrome === syn)?.count || 0;
                  return (
                    <TouchableOpacity
                      key={syn}
                      style={styles.legendItem}
                      onPress={() => setActiveSyndrome(activeSyndrome === syn ? null : syn)}
                    >
                      <View style={[styles.legendDot, {
                        backgroundColor: getSyndromeColor(syn, i),
                        opacity: activeSyndrome && activeSyndrome !== syn ? 0.3 : 1,
                      }]} />
                      <Text style={[styles.legendLabel, activeSyndrome === syn && { fontWeight: '600' }]} numberOfLines={1}>
                        {SyndromeLabels[syn] || syn.replace(/_/g, ' ')}
                      </Text>
                      <Text style={{ fontSize: 10, fontWeight: '700', color: getSyndromeColor(syn, i), marginLeft: 4 }}>{total}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          ) : (
            <View style={styles.emptyChart}>
              <Ionicons name="analytics-outline" size={32} color={Colors.text.tertiary} />
              <Text style={styles.emptyText}>No time series data yet</Text>
              <Text style={styles.emptySubtext}>Run the SQL migration to enable weekly aggregation</Text>
            </View>
          )}
        </View>
      </View>

      {/* Syndrome Breakdown */}
      {breakdown.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Syndrome Breakdown — Last {selectedWeeks}W</Text>
          <View style={styles.card}>
            {breakdown.slice(0, 8).map(({ syndrome, count }) => {
              const color = Colors.syndrome[syndrome] || Colors.text.tertiary;
              const label = SyndromeLabels[syndrome] || syndrome.replace(/_/g, ' ');
              const barWidth = maxBreakdown > 0 ? (count / maxBreakdown) * 100 : 0;
              const isActive = activeSyndrome === syndrome;
              return (
                <TouchableOpacity
                  key={syndrome}
                  style={styles.syndromeRow}
                  onPress={() => setActiveSyndrome(activeSyndrome === syndrome ? null : syndrome)}
                  activeOpacity={0.7}
                >
                  <View style={styles.syndromeInfo}>
                    <View style={[styles.syndromeDot, { backgroundColor: color, opacity: activeSyndrome && !isActive ? 0.3 : 1 }]} />
                    <Text style={[styles.syndromeLabel, isActive && { fontWeight: '600', color: Colors.text.primary }]} numberOfLines={1}>
                      {label}
                    </Text>
                  </View>
                  <View style={styles.syndromeBarBg}>
                    <View style={[styles.syndromeBarFill, { width: `${barWidth}%`, backgroundColor: color, opacity: activeSyndrome && !isActive ? 0.2 : 1 }]} />
                  </View>
                  <Text style={[styles.syndromeCount, { color }]}>{count}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Recent Encounters */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          {filterSeverity ? 'Severe / Critical Encounters' : 'Recent Encounters'}
          {activeSyndrome ? ` — ${SyndromeLabels[activeSyndrome] || activeSyndrome}` : ''}
        </Text>
        <View style={styles.card}>
          {encounters
            .filter(e => !activeSyndrome || e.syndrome_category === activeSyndrome)
            .slice(0, 15)
            .map((enc, i) => {
              const sevColor = sevColors[enc.severity] || Colors.text.tertiary;
              const synLabel = SyndromeLabels[enc.syndrome_category] || enc.syndrome_category || 'Unknown';
              const preview = enc.narrative_text ? enc.narrative_text.substring(0, 80) + '...' : '';
              return (
                <View key={enc.id || i} style={[styles.encounterCard, i > 0 && { borderTopWidth: 1, borderTopColor: Colors.divider }]}>
                  <View style={styles.encounterHeader}>
                    <View style={[styles.syndromePill, { backgroundColor: (Colors.syndrome[enc.syndrome_category] || Colors.accent.primary) + '15' }]}>
                      <Text style={[styles.syndromePillText, { color: Colors.syndrome[enc.syndrome_category] || Colors.accent.primary }]} numberOfLines={1}>
                        {synLabel}
                      </Text>
                    </View>
                    <View style={[styles.sevChip, { backgroundColor: sevColor + '15' }]}>
                      <Text style={[styles.sevChipText, { color: sevColor }]}>{(enc.severity || '').toUpperCase()}</Text>
                    </View>
                    <Text style={styles.timeAgo}>{getTimeAgo(enc.created_at)}</Text>
                  </View>
                  {preview ? <Text style={styles.narrativePreview} numberOfLines={2}>{preview}</Text> : null}
                </View>
              );
            })}
          {encounters.filter(e => !activeSyndrome || e.syndrome_category === activeSyndrome).length === 0 && (
            <Text style={styles.emptyText}>No encounters found</Text>
          )}
        </View>
      </View>
    </ScrollView>
  );
}

// ── Chart data builder ─────────────────────────────────────────────────────────

function buildChartData(timeSeries) {
  const syndromes = Object.keys(timeSeries);
  if (syndromes.length === 0) return { hasData: false, labels: [], datasets: [], syndromes: [] };

  // Collect all unique sorted labels
  const labelSet = new Set();
  syndromes.forEach(syn => timeSeries[syn].forEach(pt => labelSet.add(pt.label)));
  const allLabels = [...labelSet].sort();

  if (allLabels.length === 0) return { hasData: false, labels: [], datasets: [], syndromes: [] };

  // Downsample labels for readability (show at most 8 labels on the axis)
  const step = Math.ceil(allLabels.length / 8);
  const displayLabels = allLabels.filter((_, i) => i % step === 0 || i === allLabels.length - 1);
  // Build map of ISO label → date string (e.g. "2026-W07" → "2/9")
  const dateLabelMap = {};
  syndromes.forEach(syn =>
    timeSeries[syn].forEach(pt => { dateLabelMap[pt.label] = pt.dateStr || pt.label; })
  );
  const shortLabels = displayLabels.map(l => dateLabelMap[l] || l);

  const datasets = syndromes.slice(0, 5).map((syn, i) => {
    const dataMap = {};
    timeSeries[syn].forEach(pt => { dataMap[pt.label] = pt.count; });
    // Build data aligned to displayLabels
    const data = displayLabels.map(l => dataMap[l] || 0);
    const color = getSyndromeColor(syn, i);
    return {
      data,
      color: (opacity = 1) => {
        const hex = color.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
      },
      strokeWidth: 2,
    };
  });

  // react-native-chart-kit needs at least 1 non-zero point per dataset
  const hasAnyData = datasets.some(d => d.data.some(v => v > 0));
  if (!hasAnyData) return { hasData: false, labels: [], datasets: [], syndromes: [] };

  return { hasData: true, labels: shortLabels, datasets, syndromes: syndromes.slice(0, 5) };
}

// ─── Styles ───────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg.secondary },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.bg.secondary },

  rangeRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.xl,
    paddingVertical: 12,
    gap: 8,
  },
  rangeChip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.bg.card,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  rangeChipActive: {
    backgroundColor: Colors.accent.primaryDark,
    borderColor: Colors.accent.primaryDark,
  },
  rangeChipText: { fontSize: 13, fontWeight: '500', color: Colors.text.secondary },
  rangeChipTextActive: { color: '#fff' },

  section: { paddingHorizontal: Spacing.xl, marginBottom: 20 },
  sectionTitle: { fontSize: 12, color: Colors.text.tertiary, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  card: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl, padding: 16, borderWidth: 1, borderColor: Colors.border, ...Shadows.sm },

  emptyChart: { alignItems: 'center', paddingVertical: 32 },
  emptyText: { color: Colors.text.tertiary, fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  emptySubtext: { color: Colors.text.tertiary, fontSize: 11, textAlign: 'center', marginTop: 4 },

  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.border },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: (SW - Spacing.xl * 2 - 32) / 2 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendLabel: { fontSize: 11, color: Colors.text.secondary, flex: 1 },

  syndromeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  syndromeInfo: { flexDirection: 'row', alignItems: 'center', width: 130 },
  syndromeDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  syndromeLabel: { fontSize: 10, color: Colors.text.secondary, flex: 1 },
  syndromeBarBg: { flex: 1, height: 5, backgroundColor: Colors.bg.elevated, borderRadius: 3, marginHorizontal: 8, overflow: 'hidden' },
  syndromeBarFill: { height: '100%', borderRadius: 3 },
  syndromeCount: { fontSize: 12, fontWeight: '600', minWidth: 44, textAlign: 'right' },

  encounterCard: { paddingVertical: 12 },
  encounterHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  syndromePill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, maxWidth: 160 },
  syndromePillText: { fontSize: 11, fontWeight: '600' },
  sevChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  sevChipText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
  timeAgo: { fontSize: 10, color: Colors.text.tertiary, marginLeft: 'auto' },
  narrativePreview: { fontSize: 12, color: Colors.text.secondary, lineHeight: 17 },
});
