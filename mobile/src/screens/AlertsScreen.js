import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, RefreshControl,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Typography, Spacing, BorderRadius, Shadows, SyndromeLabels, AlertLevelConfig } from '../utils/theme';
import { ECOWAS_COUNTRIES, getCountryFlag } from '../utils/geo';
import AlertCard from '../components/AlertCard';

const FILTER_LEVELS = ['all', 'emergency', 'warning', 'watch'];
const SORT_OPTIONS = ['severity', 'recent'];

export default function AlertsScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filterLevel, setFilterLevel] = useState('all');
  const [filterCountry, setFilterCountry] = useState(null);
  const [sortBy, setSortBy] = useState('severity');
  const [showCountryFilter, setShowCountryFilter] = useState(false);

  const fetchAlerts = useCallback(() => {
    let filtered = DEMO_ALERTS;
    if (filterLevel !== 'all') {
      filtered = filtered.filter(a => a.alert_level === filterLevel);
    }
    if (filterCountry) {
      filtered = filtered.filter(a => a.country_code === filterCountry);
    }
    setAlerts(filtered);
    setLoading(false);
    setRefreshing(false);
  }, [filterLevel, filterCountry]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  const onRefresh = useCallback(() => { setRefreshing(true); fetchAlerts(); }, [fetchAlerts]);

  // Sort
  const sorted = [...alerts].sort((a, b) => {
    if (sortBy === 'severity') {
      const o = { emergency: 0, warning: 1, watch: 2 };
      return (o[a.alert_level] ?? 3) - (o[b.alert_level] ?? 3);
    }
    return new Date(b.created_at) - new Date(a.created_at);
  });

  // Count by level
  const countByLevel = {};
  alerts.forEach(a => { countByLevel[a.alert_level] = (countByLevel[a.alert_level] || 0) + 1; });

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={Colors.accent.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accent.primary} />}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Surveillance Alerts</Text>

        {/* Level summary chips */}
        <View style={styles.countRow}>
          {['emergency', 'warning', 'watch'].map(lvl => {
            const n = countByLevel[lvl] || 0;
            const c = AlertLevelConfig[lvl];
            return (
              <View key={lvl} style={[styles.countChip, { backgroundColor: c.color + '12' }]}>
                <Text style={[styles.countChipText, { color: c.color }]}>{n} {c.label}</Text>
              </View>
            );
          })}
        </View>

        {/* Filter chips */}
        <View style={styles.filterRow}>
          {FILTER_LEVELS.map(lvl => {
            const active = lvl === filterLevel;
            return (
              <TouchableOpacity
                key={lvl}
                style={[styles.filterChip, active && styles.filterChipActive]}
                onPress={() => setFilterLevel(lvl)}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                  {lvl === 'all' ? 'All' : AlertLevelConfig[lvl]?.label || lvl}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Country filter + sort */}
        <View style={styles.controlRow}>
          <TouchableOpacity style={styles.countryFilterBtn} onPress={() => setShowCountryFilter(!showCountryFilter)}>
            <Ionicons name="globe-outline" size={14} color={Colors.text.secondary} />
            <Text style={styles.countryFilterText}>
              {filterCountry ? `${getCountryFlag(filterCountry)} ${filterCountry}` : 'All countries'}
            </Text>
            <Ionicons name="chevron-down" size={12} color={Colors.text.tertiary} />
          </TouchableOpacity>

          <View style={styles.sortRow}>
            {SORT_OPTIONS.map(s => (
              <TouchableOpacity key={s} style={[styles.sortChip, sortBy === s && styles.sortChipActive]} onPress={() => setSortBy(s)}>
                <Ionicons name={s === 'severity' ? 'alert-circle-outline' : 'time-outline'} size={12} color={sortBy === s ? Colors.accent.primaryDark : Colors.text.tertiary} />
                <Text style={[styles.sortText, sortBy === s && styles.sortTextActive]}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Country filter dropdown */}
        {showCountryFilter && (
          <View style={styles.countryDropdown}>
            <TouchableOpacity style={styles.countryItem} onPress={() => { setFilterCountry(null); setShowCountryFilter(false); }}>
              <Text style={[styles.countryItemText, !filterCountry && styles.countryItemActive]}>All Countries</Text>
            </TouchableOpacity>
            {ECOWAS_COUNTRIES.map(c => (
              <TouchableOpacity key={c.code} style={styles.countryItem} onPress={() => { setFilterCountry(c.code); setShowCountryFilter(false); }}>
                <Text style={[styles.countryItemText, filterCountry === c.code && styles.countryItemActive]}>
                  {c.flag} {c.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Alert list */}
        {sorted.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="shield-checkmark-outline" size={44} color={Colors.success} />
            <Text style={styles.emptyTitle}>All Clear</Text>
            <Text style={styles.emptyText}>No active alerts matching your filters.</Text>
          </View>
        ) : (
          sorted.map((a, i) => (
            <AlertCard
              key={a.alert_id || a.id || i}
              alert={a}
              onViewOnMap={() => navigation?.navigate('Map')}
              onGenerateReport={() => navigation?.navigate('Reports')}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const DEMO_ALERTS = [
  { alert_id: 'a1', alert_level: 'emergency', syndrome_category: 'acute_watery_diarrhea', district: 'Kintampo North', country_code: 'GH', case_count_current_week: 25, case_count_baseline: 5.2, ratio_to_baseline: 4.81, trend: 'increasing', weeks_above_threshold: 3, situation_summary: 'Significant cluster of acute watery diarrhea. 25 cases this week — nearly 5× above baseline. Pattern consistent with possible cholera outbreak. Water source contamination suspected in 2 communities.', recommended_actions: ['Deploy rapid diagnostic testing', 'Activate oral rehydration stations', 'Investigate water sources', 'Alert neighboring districts', 'Mobilize community health workers'] },
  { alert_id: 'a2', alert_level: 'emergency', syndrome_category: 'acute_hemorrhagic_fever', district: 'Maiduguri Metro', country_code: 'NG', case_count_current_week: 8, case_count_baseline: 0.8, ratio_to_baseline: 10.0, trend: 'increasing', weeks_above_threshold: 2, situation_summary: 'Lassa fever cluster confirmed. 8 cases this week including 3 healthcare workers. One fatality reported. Contact tracing ongoing across 4 wards.', recommended_actions: ['Activate IHR Emergency Response', 'Strict PPE for all healthcare workers', 'Collect specimens for national reference lab', 'Contact trace all exposures', 'Suspend elective procedures at index facility'] },
  { alert_id: 'a3', alert_level: 'emergency', syndrome_category: 'acute_meningitis', district: 'Ouagadougou Baskuy', country_code: 'BF', case_count_current_week: 31, case_count_baseline: 4.1, ratio_to_baseline: 7.6, trend: 'increasing', weeks_above_threshold: 2, situation_summary: 'Meningococcal meningitis outbreak in the meningitis belt. 31 suspected cases; 4 deaths. Attack rate highest in children under 5 and adults 15–29. Peak dry season risk.', recommended_actions: ['Mass vaccination with MenAfriVac', 'Reactive vaccination in adjacent districts', 'CSF specimen collection for serotyping', 'Strengthen case management capacity', 'Activate district emergency operations center'] },
  { alert_id: 'a4', alert_level: 'warning', syndrome_category: 'acute_hemorrhagic_fever', district: 'Bolgatanga Municipal', country_code: 'GH', case_count_current_week: 3, case_count_baseline: 0.5, ratio_to_baseline: 6.0, trend: 'increasing', weeks_above_threshold: 1, situation_summary: 'Three hemorrhagic fever cases — two are healthcare workers at Bolgatanga Regional Hospital. Viral hemorrhagic fever not yet excluded. Specimen sent to Noguchi Memorial Institute.', recommended_actions: ['Full infection prevention and control protocol', 'Case investigation with contact tracing', 'Collect specimens for lab confirmation', 'Notify regional health directorate'] },
  { alert_id: 'a5', alert_level: 'warning', syndrome_category: 'acute_rash_fever', district: 'Tamale Metro', country_code: 'GH', case_count_current_week: 12, case_count_baseline: 3.0, ratio_to_baseline: 4.0, trend: 'increasing', weeks_above_threshold: 2, situation_summary: 'Measles-like illness cluster in unvaccinated children aged 1–5 in Tamale. School-based transmission suspected. Last confirmed measles outbreak in this district was 2021.', recommended_actions: ['Laboratory confirmation (IgM serology)', 'Ring vaccination campaign', 'Enhanced surveillance in schools and markets', 'Engage community health nurses'] },
  { alert_id: 'a6', alert_level: 'warning', syndrome_category: 'acute_jaundice_syndrome', district: 'Dakar Plateau', country_code: 'SN', case_count_current_week: 7, case_count_baseline: 1.2, ratio_to_baseline: 5.8, trend: 'increasing', weeks_above_threshold: 1, situation_summary: 'Yellow fever-compatible cases in unvaccinated adults. Urban yellow fever transmission is a public health emergency. Port-of-entry screening advised given Dakar international hub status.', recommended_actions: ['Immediate yellow fever serology', 'Emergency vaccination of unvaccinated residents', 'Vector control — Aedes aegypti breeding site removal', 'Notify WHO Regional Office for Africa'] },
  { alert_id: 'a7', alert_level: 'warning', syndrome_category: 'acute_rash_fever', district: 'Kano Municipal', country_code: 'NG', case_count_current_week: 19, case_count_baseline: 5.5, ratio_to_baseline: 3.5, trend: 'increasing', weeks_above_threshold: 2, situation_summary: 'Mpox (monkeypox) cluster with 19 confirmed/probable cases. Skin lesions consistent with mpox clade II. Majority are adults aged 18–35. No pediatric deaths to date.', recommended_actions: ['Notify NCDC Nigeria', 'Contact tracing of all sexual and household contacts', 'JYNNEOS vaccine for close contacts if available', 'Safe burial protocols for any fatalities', 'Risk communication to high-risk groups'] },
  { alert_id: 'a8', alert_level: 'watch', syndrome_category: 'acute_respiratory_infection', district: 'Wa Municipal', country_code: 'GH', case_count_current_week: 18, case_count_baseline: 12.0, ratio_to_baseline: 1.5, trend: 'stable', weeks_above_threshold: 1, situation_summary: 'Moderate increase in acute respiratory infections likely linked to harmattan dust season. No severe acute respiratory illness (SARI) cases identified. Situation is being monitored.', recommended_actions: ['Continue routine surveillance', 'Screen for SARI in health facilities', 'Advise mask use during heavy dust periods'] },
  { alert_id: 'a9', alert_level: 'watch', syndrome_category: 'malaria', district: 'Conakry Ratoma', country_code: 'GN', case_count_current_week: 340, case_count_baseline: 210.0, ratio_to_baseline: 1.62, trend: 'increasing', weeks_above_threshold: 3, situation_summary: 'Malaria cases 62% above seasonal baseline following late rains and flooding of low-lying areas. Children under 5 and pregnant women most affected. Bed net distribution incomplete in peri-urban zones.', recommended_actions: ['Accelerate insecticide-treated net distribution', 'Increase artemisinin-based combination therapy stocks', 'Indoor residual spraying in high-burden wards', 'Community sensitization on care-seeking'] },
  { alert_id: 'a10', alert_level: 'watch', syndrome_category: 'acute_watery_diarrhea', district: 'Freetown Western Urban', country_code: 'SL', case_count_current_week: 44, case_count_baseline: 29.0, ratio_to_baseline: 1.52, trend: 'stable', weeks_above_threshold: 2, situation_summary: 'Elevated diarrheal disease following flooding in Freetown peri-urban areas. Piped water supply disrupted in 3 wards. WASH assessments underway. No cholera confirmed yet.', recommended_actions: ['Water quality testing in affected wards', 'Chlorination of emergency water supplies', 'Deploy oral rehydration therapy kits', 'Prepare for potential cholera response if confirmed'] },
];

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg.secondary },
  scroll: { paddingHorizontal: Spacing.xl, paddingBottom: 40 },

  title: { fontSize: Typography.size.lg, fontWeight: '500', color: Colors.text.primary, marginTop: 16, marginBottom: 10, letterSpacing: -0.3 },

  countRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  countChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  countChipText: { fontSize: 10, fontWeight: '700' },

  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, backgroundColor: Colors.bg.card, borderRadius: 20, borderWidth: 1, borderColor: Colors.border },
  filterChipActive: { borderColor: Colors.accent.primary, backgroundColor: Colors.accent.ultraLight },
  filterChipText: { fontSize: 12, color: Colors.text.secondary, textTransform: 'capitalize' },
  filterChipTextActive: { color: Colors.accent.primaryDark, fontWeight: '600' },

  controlRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  countryFilterBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.bg.card, borderRadius: BorderRadius.sm, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: Colors.border },
  countryFilterText: { fontSize: 12, color: Colors.text.secondary },
  sortRow: { flexDirection: 'row', gap: 6 },
  sortChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: Colors.bg.card, borderRadius: 16, borderWidth: 1, borderColor: Colors.border },
  sortChipActive: { borderColor: Colors.accent.primary, backgroundColor: Colors.accent.ultraLight },
  sortText: { fontSize: 11, color: Colors.text.tertiary, textTransform: 'capitalize' },
  sortTextActive: { color: Colors.accent.primaryDark, fontWeight: '600' },

  countryDropdown: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border, marginBottom: 12, maxHeight: 200, overflow: 'hidden', ...Shadows.sm },
  countryItem: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  countryItemText: { fontSize: 13, color: Colors.text.secondary },
  countryItemActive: { color: Colors.accent.primaryDark, fontWeight: '600' },

  emptyState: { alignItems: 'center', paddingVertical: 60 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: Colors.success, marginTop: 12 },
  emptyText: { fontSize: 13, color: Colors.text.tertiary, textAlign: 'center', marginTop: 6 },
});
