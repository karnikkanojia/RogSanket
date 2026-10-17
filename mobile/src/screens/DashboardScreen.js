import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  Dimensions, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Typography, Spacing, BorderRadius, Shadows, SyndromeLabels, AlertLevelConfig } from '../utils/theme';
import { supabase } from '../services/supabase';
import { getDashboardOverview, getSyndromeBreakdown, getRecentEncounters } from '../services/dashboardData';
import { getQueueStatus } from '../services/offlineQueue';

const { width: SW } = Dimensions.get('window');

function StatCard({ label, value, icon, color, subtitle, onPress }) {
  const card = (
    <View style={styles.statCard}>
      <View style={styles.statIcon}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {subtitle && <Text style={styles.statSubtitle}>{subtitle}</Text>}
      {onPress && <Ionicons name="chevron-forward" size={12} color={Colors.text.tertiary} style={styles.cardChevron} />}
    </View>
  );
  if (onPress) {
    return <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{card}</TouchableOpacity>;
  }
  return card;
}

function SyndromeBar({ syndrome, count, maxCount, onPress }) {
  const color = Colors.syndrome[syndrome] || Colors.text.tertiary;
  const label = SyndromeLabels[syndrome] || syndrome;
  const barWidth = maxCount > 0 ? (count / maxCount) * 100 : 0;
  const row = (
    <View style={styles.syndromeRow}>
      <View style={styles.syndromeInfo}>
        <View style={[styles.syndromeDot, { backgroundColor: color }]} />
        <Text style={styles.syndromeLabel} numberOfLines={1}>{label}</Text>
      </View>
      <View style={styles.syndromeBarBg}>
        <View style={[styles.syndromeBarFill, { width: `${barWidth}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.syndromeCount, { color }]}>{count}</Text>
    </View>
  );
  if (onPress) {
    return <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{row}</TouchableOpacity>;
  }
  return row;
}

function EncounterRow({ encounter, onPress }) {
  const sevColors = { mild: Colors.severity.low, moderate: Colors.severity.watch, severe: Colors.severity.warning, critical: Colors.severity.emergency };
  const color = sevColors[encounter.severity] || Colors.text.tertiary;
  const name = SyndromeLabels[encounter.syndrome_category] || encounter.syndrome_category || 'Unknown';
  const timeAgo = getTimeAgo(encounter.created_at);
  const row = (
    <View style={styles.encounterRow}>
      <View style={[styles.encounterDot, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.encounterName} numberOfLines={1}>{name}</Text>
        <Text style={styles.encounterMeta}>{encounter.district_name || 'Unknown'} · {timeAgo}</Text>
      </View>
      <View style={[styles.sevChip, { backgroundColor: color + '15' }]}>
        <Text style={[styles.sevChipText, { color }]}>{(encounter.severity || '').toUpperCase()}</Text>
      </View>
    </View>
  );
  if (onPress) {
    return <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{row}</TouchableOpacity>;
  }
  return row;
}

function getTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function DashboardScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dataSource, setDataSource] = useState('demo');

  const [totalEncounters, setTotalEncounters] = useState(0);
  const [weekChange, setWeekChange] = useState(0);
  const [severeCount, setSevereCount] = useState(0);
  const [totalAlerts, setTotalAlerts] = useState(0);
  const [alertsByLevel, setAlertsByLevel] = useState({});
  const [districtCount, setDistrictCount] = useState(0);
  const [syndromeDist, setSyndromeDist] = useState({});
  const [recentEncounters, setRecentEncounters] = useState([]);
  const [queueStatus, setQueueStatus] = useState({ pending: 0 });

  const fetchData = useCallback(async () => {
    try {
      // Offline queue status
      const qs = await getQueueStatus();
      setQueueStatus(qs);

      // Dashboard overview (this week vs last week)
      const overview = await getDashboardOverview();
      setTotalEncounters(overview.totalEncounters);
      setWeekChange(overview.weekChange);
      setSevereCount(overview.severeCount);
      setDistrictCount(overview.activeDistricts);

      // Syndrome breakdown
      const breakdown = await getSyndromeBreakdown(null, 4);
      const dist = {};
      breakdown.forEach(({ syndrome, count }) => { dist[syndrome] = count; });
      setSyndromeDist(dist);

      // Recent encounters with district name
      const recent = await getRecentEncounters(null, 6);
      const districtIds = [...new Set(recent.map(e => e.district_id).filter(Boolean))];
      let districtMap = {};
      if (districtIds.length > 0) {
        const { data: districts } = await supabase
          .from('districts')
          .select('id, name')
          .in('id', districtIds);
        (districts || []).forEach(d => { districtMap[d.id] = d.name; });
      }
      setRecentEncounters(recent.map(e => ({
        ...e,
        district_name: districtMap[e.district_id] || 'Unknown',
      })));

      // Alerts from existing alerts table
      const { data: alerts } = await supabase
        .from('alerts')
        .select('alert_level')
        .eq('is_active', true);
      const byLevel = {};
      (alerts || []).forEach(a => { byLevel[a.alert_level] = (byLevel[a.alert_level] || 0) + 1; });
      setTotalAlerts((alerts || []).length);
      setAlertsByLevel(byLevel);

      setDataSource('live');
    } catch {
      // Fallback to demo data
      setDataSource('demo');
      setTotalEncounters(DEMO_DASH.total_encounters);
      setTotalAlerts(DEMO_ALERTS.total_alerts);
      setAlertsByLevel(DEMO_ALERTS.by_level);
      setDistrictCount(DEMO_DASH.districts.length);
      setSyndromeDist(DEMO_DASH.syndrome_distribution);
      setRecentEncounters(DEMO_DASH.recent_encounters);
      setSevereCount(3);
      setWeekChange(12);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  const onRefresh = useCallback(() => { setRefreshing(true); fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={Colors.accent.primary} />
        <Text style={{ color: Colors.text.secondary, marginTop: 12, fontSize: 14 }}>Loading EpiCast...</Text>
      </View>
    );
  }

  const synEntries = Object.entries(syndromeDist).sort((a, b) => b[1] - a[1]);
  const maxSyn = synEntries.length > 0 ? synEntries[0][1] : 1;
  const weekChangeLabel = weekChange > 0 ? `+${weekChange}% vs last wk` : weekChange < 0 ? `${weekChange}% vs last wk` : 'vs last wk';

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent.primary} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Offline pending banner */}
        {queueStatus.pending > 0 && (
          <View style={styles.offlineBanner}>
            <Ionicons name="cloud-upload-outline" size={14} color={Colors.severity.watch} />
            <Text style={styles.offlineBannerText}>
              {queueStatus.pending} encounter{queueStatus.pending > 1 ? 's' : ''} queued — will sync when online
            </Text>
          </View>
        )}

        {/* Gradient Header */}
        <LinearGradient
          colors={['#10B981', '#14B8A6', '#06B6D4']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={[styles.header, { paddingTop: insets.top + 16 }]}
        >
          <View style={styles.headerTop}>
            <Text style={styles.appName}>epicast</Text>
            <View style={styles.statusPill}>
              <View style={[styles.statusDot, { backgroundColor: dataSource === 'live' ? '#10B981' : '#F59E0B' }]} />
              <Text style={styles.statusText}>{dataSource === 'live' ? 'LIVE' : 'DEMO'}</Text>
            </View>
          </View>

          <Text style={styles.headerSubtitle}>ECOWAS Disease Surveillance Platform</Text>

          {/* Stats summary card */}
          <View style={styles.summaryCard}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{totalEncounters}</Text>
              <Text style={styles.summaryLabel}>Encounters</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{totalAlerts}</Text>
              <Text style={styles.summaryLabel}>Active Alerts</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{districtCount}</Text>
              <Text style={styles.summaryLabel}>Districts</Text>
            </View>
          </View>
        </LinearGradient>

        {/* Alert Badges */}
        {totalAlerts > 0 && (
          <View style={styles.alertRow}>
            {['emergency', 'warning', 'watch'].map(lvl => {
              const count = alertsByLevel[lvl] || 0;
              if (count === 0) return null;
              const cfg = AlertLevelConfig[lvl];
              return (
                <View key={lvl} style={[styles.alertBadge, { backgroundColor: cfg.color + '12' }]}>
                  <View style={[styles.alertBadgeDot, { backgroundColor: cfg.color }]} />
                  <Text style={[styles.alertBadgeText, { color: cfg.color }]}>{count} {cfg.label}</Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Stats Grid */}
        <View style={styles.statsGrid}>
          <StatCard
            label="Encounters"
            value={totalEncounters}
            icon="people"
            color={Colors.accent.primary}
            subtitle={weekChangeLabel}
            onPress={() => navigation.navigate('DistrictDetail', { districtId: null, districtName: 'All Districts' })}
          />
          <StatCard
            label="Active Alerts"
            value={totalAlerts}
            icon="alert-circle"
            color={alertsByLevel.emergency > 0 ? Colors.severity.emergency : Colors.severity.watch}
            subtitle="Monitoring"
          />
          <StatCard
            label="Severe Cases"
            value={severeCount}
            icon="warning"
            color={Colors.severity.warning}
            subtitle="This week"
            onPress={() => navigation.navigate('DistrictDetail', { districtId: null, districtName: 'All Districts', filterSeverity: true })}
          />
          <StatCard
            label="Districts"
            value={districtCount}
            icon="location"
            color="#8B5CF6"
            subtitle="Reporting this week"
          />
        </View>

        {/* Syndrome Distribution */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Syndrome Distribution</Text>
          <View style={styles.card}>
            {synEntries.map(([s, c]) => (
              <SyndromeBar
                key={s}
                syndrome={s}
                count={c}
                maxCount={maxSyn}
                onPress={() => navigation.navigate('DistrictDetail', {
                  districtId: null,
                  districtName: 'All Districts',
                  syndrome: s,
                })}
              />
            ))}
            {synEntries.length === 0 && <Text style={styles.emptyText}>No encounters recorded yet</Text>}
          </View>
        </View>

        {/* Recent Encounters */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Encounters</Text>
          <View style={styles.card}>
            {recentEncounters.slice(0, 6).map((e, i) => (
              <EncounterRow
                key={e.id || i}
                encounter={e}
                onPress={e.district_id ? () => navigation.navigate('DistrictDetail', {
                  districtId: e.district_id,
                  districtName: e.district_name || 'District',
                }) : undefined}
              />
            ))}
            {recentEncounters.length === 0 && <Text style={styles.emptyText}>No encounters yet. Tap + to begin.</Text>}
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Powered by MedGemma · MedASR · MedSigLIP</Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Demo Data ────────────────────────────────────────
const DEMO_DASH = {
  total_encounters: 147,
  syndrome_distribution: {
    acute_watery_diarrhea: 38, acute_febrile_illness: 31, acute_respiratory_infection: 28,
    acute_bloody_diarrhea: 18, acute_rash_fever: 12, acute_neurological_syndrome: 8,
    acute_hemorrhagic_fever: 7, unexplained_cluster: 5,
  },
  districts: ['Kintampo North', 'Tamale Metro', 'Wa Municipal', 'Bolgatanga', 'Kassena Nankana'],
  recent_encounters: [
    { id: 'e1', created_at: new Date(Date.now() - 2 * 60000).toISOString(), district_name: 'Kano Municipal', syndrome_category: 'acute_watery_diarrhea', severity: 'severe' },
    { id: 'e2', created_at: new Date(Date.now() - 10 * 60000).toISOString(), district_name: 'Kano Municipal', syndrome_category: 'acute_watery_diarrhea', severity: 'moderate' },
    { id: 'e3', created_at: new Date(Date.now() - 20 * 60000).toISOString(), district_name: 'Accra Metropolis', syndrome_category: 'acute_febrile_illness', severity: 'moderate' },
    { id: 'e4', created_at: new Date(Date.now() - 30 * 60000).toISOString(), district_name: 'Nzerekore City', syndrome_category: 'acute_hemorrhagic_fever', severity: 'critical' },
    { id: 'e5', created_at: new Date(Date.now() - 60 * 60000).toISOString(), district_name: 'Dakar Plateau', syndrome_category: 'acute_respiratory_infection', severity: 'mild' },
    { id: 'e6', created_at: new Date(Date.now() - 90 * 60000).toISOString(), district_name: 'Ouagadougou', syndrome_category: 'acute_neurological_syndrome', severity: 'severe' },
  ],
};
const DEMO_ALERTS = { total_alerts: 4, by_level: { emergency: 1, warning: 2, watch: 1 } };

// ─── Styles ───────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg.secondary },
  center: { justifyContent: 'center', alignItems: 'center' },

  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.severity.watch + '15',
    paddingHorizontal: Spacing.xl,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.severity.watch + '30',
  },
  offlineBannerText: { fontSize: 12, color: Colors.severity.watch, fontWeight: '500', flex: 1 },

  header: { paddingHorizontal: Spacing.xl, paddingBottom: 24, borderBottomLeftRadius: BorderRadius.xl, borderBottomRightRadius: BorderRadius.xl },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  appName: { fontSize: Typography.size['2xl'], fontWeight: Typography.weight.medium, color: '#fff', letterSpacing: -0.5 },
  statusPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.95)', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20 },
  statusDot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  statusText: { fontSize: 10, fontWeight: '600', color: Colors.text.secondary, letterSpacing: 0.5 },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 4 },

  summaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: BorderRadius.lg,
    paddingVertical: 16,
    marginTop: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryValue: { fontSize: 24, fontWeight: '700', color: '#fff' },
  summaryLabel: { fontSize: 10, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  summaryDivider: { width: 1, height: 32, backgroundColor: 'rgba(255,255,255,0.25)' },

  alertRow: { flexDirection: 'row', paddingHorizontal: Spacing.xl, gap: 8, marginTop: 16, marginBottom: 16 },
  alertBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20 },
  alertBadgeDot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  alertBadgeText: { fontSize: 11, fontWeight: '600' },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: Spacing.xl, gap: 10, marginBottom: 24 },
  statCard: {
    width: (SW - Spacing.xl * 2 - 10) / 2,
    backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl,
    padding: 16, borderWidth: 1, borderColor: Colors.border, ...Shadows.sm,
  },
  statIcon: { marginBottom: 8 },
  statValue: { fontSize: 24, fontWeight: '500', color: Colors.text.primary, letterSpacing: -0.5 },
  statLabel: { fontSize: 11, color: Colors.text.secondary, fontWeight: '500', marginTop: 2 },
  statSubtitle: { fontSize: 10, color: Colors.text.tertiary, marginTop: 1 },
  cardChevron: { position: 'absolute', top: 12, right: 12 },

  section: { paddingHorizontal: Spacing.xl, marginBottom: 24 },
  sectionTitle: { fontSize: 12, color: Colors.text.tertiary, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
  card: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl, padding: 16, borderWidth: 1, borderColor: Colors.border, ...Shadows.sm },

  syndromeRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  syndromeInfo: { flexDirection: 'row', alignItems: 'center', width: 130 },
  syndromeDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  syndromeLabel: { fontSize: 10, color: Colors.text.secondary, flex: 1 },
  syndromeBarBg: { flex: 1, height: 5, backgroundColor: Colors.bg.elevated, borderRadius: 3, marginHorizontal: 8, overflow: 'hidden' },
  syndromeBarFill: { height: '100%', borderRadius: 3 },
  syndromeCount: { fontSize: 12, fontWeight: '600', minWidth: 44, textAlign: 'right' },

  encounterRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  encounterDot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  encounterName: { fontSize: 13, fontWeight: '500', color: Colors.text.primary },
  encounterMeta: { fontSize: 10, color: Colors.text.tertiary, marginTop: 2 },
  sevChip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  sevChipText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },

  emptyText: { color: Colors.text.tertiary, fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  footer: { alignItems: 'center', paddingVertical: 24 },
  footerText: { fontSize: 10, color: Colors.text.tertiary, letterSpacing: 0.3 },
});
