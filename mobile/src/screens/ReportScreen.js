import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Image, Share, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown from 'react-native-markdown-display';
import { Colors, Typography, Spacing, BorderRadius, Shadows, SyndromeLabels } from '../utils/theme';
import api from '../services/api';
import { supabase } from '../services/supabase';
import GeoPickerCascade from '../components/GeoPickerCascade';
import ForecastChart, { computeForecast } from '../components/ForecastChart';
import SpectrogramView from '../components/SpectrogramView';

const SCOPE_LEVELS = ['district', 'region', 'country', 'continental'];
const REPORT_TYPES = [
  { key: 'situation', icon: 'document-text-outline', label: 'Situation' },
  { key: 'fhir', icon: 'code-slash-outline', label: 'FHIR' },
  { key: 'weekly', icon: 'calendar-outline', label: 'Weekly' },
];

/**
 * Normalize report output from RunPod 27B — handles multiple response formats.
 */
function extractReportText(data) {
  if (!data) return 'No report data available.';
  if (typeof data === 'string') return data;
  if (data.report && typeof data.report === 'string') return data.report;
  if (data.output && typeof data.output === 'string') return data.output;
  if (data.text && typeof data.text === 'string') return data.text;
  if (data.content && typeof data.content === 'string') return data.content;
  // If it's a nested object with output.report (RunPod wrapper)
  if (data.output?.report) return data.output.report;
  // Fallback: stringify
  return JSON.stringify(data, null, 2);
}

export default function ReportScreen() {
  const insets = useSafeAreaInsets();
  const [geoSelection, setGeoSelection] = useState({});
  const [scopeLevel, setScopeLevel] = useState('district');
  const [reportType, setReportType] = useState('situation');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  // Saved reports
  const [showSaved, setShowSaved] = useState(false);
  const [savedReports, setSavedReports] = useState([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [expandedSavedId, setExpandedSavedId] = useState(null);

  const loadSavedReports = useCallback(async () => {
    setLoadingSaved(true);
    try {
      let q = supabase
        .from('reports')
        .select('id,report_type,scope_type,scope_id,content,created_at')
        .order('created_at', { ascending: false })
        .limit(30);
      if (geoSelection.district_id) q = q.eq('scope_id', geoSelection.district_id);
      else if (geoSelection.region_id) q = q.eq('scope_id', geoSelection.region_id);
      const { data } = await q;
      setSavedReports(data || []);
    } catch {
      setSavedReports([]);
    } finally {
      setLoadingSaved(false);
    }
  }, [geoSelection.district_id, geoSelection.region_id]);

  useEffect(() => {
    if (showSaved) loadSavedReports();
  }, [showSaved, loadSavedReports]);

  // Forecast data
  const [weeklyData, setWeeklyData] = useState([]);
  const [forecastSyndrome, setForecastSyndrome] = useState('acute_watery_diarrhea');
  const [availableSyndromes, setAvailableSyndromes] = useState([]);

  // Fetch weekly counts for forecast chart
  const fetchWeeklyData = useCallback(async () => {
    if (!geoSelection.district_id) return;
    try {
      const { data } = await supabase
        .from('weekly_counts')
        .select('syndrome_category, week_start, count')
        .eq('district_id', geoSelection.district_id)
        .order('week_start', { ascending: true });

      if (data && data.length > 0) {
        const syndromes = [...new Set(data.map(d => d.syndrome_category))];
        setAvailableSyndromes(syndromes);

        const filtered = data.filter(d => d.syndrome_category === forecastSyndrome);
        setWeeklyData(filtered.map(d => d.count));
      }
    } catch {
      // Use demo data
      setAvailableSyndromes(['acute_watery_diarrhea', 'acute_respiratory_infection', 'acute_febrile_illness']);
      setWeeklyData([4, 5, 3, 6, 8, 7, 12, 15, 18, 22, 25, 28]);
    }
  }, [geoSelection.district_id, forecastSyndrome]);

  useEffect(() => { fetchWeeklyData(); }, [fetchWeeklyData]);

  const generate = async () => {
    // Validate geo selection based on scope level
    if (scopeLevel === 'district' && !geoSelection.district_id) {
      Alert.alert('Select District', 'Please select a district before generating a report.');
      return;
    }
    if (scopeLevel === 'region' && !geoSelection.region_id) {
      Alert.alert('Select Region', 'Please select a region before generating a report.');
      return;
    }
    if (scopeLevel === 'country' && !geoSelection.country_id) {
      Alert.alert('Select Country', 'Please select a country before generating a report.');
      return;
    }

    setLoading(true); setReport(null);
    const districtName = geoSelection.district_name || geoSelection.region_name || geoSelection.country_name || 'ECOWAS';
    try {
      const data = reportType === 'fhir'
        ? await api.getFHIRReport(districtName)
        : await api.generateReport(districtName);
      setReport(data);

      // Save to Supabase
      try {
        await supabase.from('reports').insert({
          report_type: reportType === 'situation' ? 'situation_report' : reportType === 'fhir' ? 'fhir_bundle' : 'weekly_summary',
          scope_type: scopeLevel,
          scope_id: geoSelection.district_id || geoSelection.region_id || null,
          content: typeof data === 'string' ? data : JSON.stringify(data),
          fhir_bundle: reportType === 'fhir' ? data : null,
        });
      } catch { /* non-blocking */ }
    } catch (err) {
      Alert.alert('Report Generation Failed', err.message || 'Could not reach RunPod. Check your internet connection and RunPod endpoint status.');
    } finally { setLoading(false); }
  };

  const handleShare = async () => {
    try {
      const content = report?.report || JSON.stringify(report, null, 2);
      await Share.share({
        message: `EpiCast ${reportType.toUpperCase()} Report\n\n${content?.substring(0, 500)}...`,
        title: 'EpiCast Report',
      });
    } catch { /* ignore */ }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Reports</Text>
        <Text style={styles.subtitle}>Generate epidemiological reports and disease forecasts</Text>

        {/* Generate / Saved tab switcher */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tabBtn, !showSaved && styles.tabBtnActive]}
            onPress={() => setShowSaved(false)}
          >
            <Ionicons name="create-outline" size={14} color={!showSaved ? Colors.accent.primaryDark : Colors.text.tertiary} />
            <Text style={[styles.tabText, !showSaved && styles.tabTextActive]}>Generate</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, showSaved && styles.tabBtnActive]}
            onPress={() => setShowSaved(true)}
          >
            <Ionicons name="archive-outline" size={14} color={showSaved ? Colors.accent.primaryDark : Colors.text.tertiary} />
            <Text style={[styles.tabText, showSaved && styles.tabTextActive]}>Saved Reports</Text>
          </TouchableOpacity>
        </View>

        {/* Saved reports panel */}
        {showSaved && (
          <View style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <GeoPickerCascade value={geoSelection} onChange={sel => { setGeoSelection(sel); }} maxLevel="district" label="Filter by location" />
            </View>
            {loadingSaved ? (
              <ActivityIndicator color={Colors.accent.primary} style={{ marginVertical: 32 }} />
            ) : savedReports.length === 0 ? (
              <View style={styles.emptyCard}>
                <Ionicons name="document-outline" size={32} color={Colors.text.tertiary} />
                <Text style={styles.emptyText}>No saved reports yet</Text>
                <Text style={styles.emptySubtext}>Generate a report to save it here</Text>
              </View>
            ) : (
              savedReports.map(r => {
                const isExpanded = expandedSavedId === r.id;
                const date = new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                const typeLabel = r.report_type === 'situation_report' ? 'Situation' : r.report_type === 'fhir_bundle' ? 'FHIR' : 'Weekly';
                const text = (() => { try { return extractReportText(typeof r.content === 'string' ? JSON.parse(r.content) : r.content); } catch { return r.content || ''; } })();
                return (
                  <TouchableOpacity
                    key={r.id}
                    style={styles.savedRow}
                    onPress={() => setExpandedSavedId(isExpanded ? null : r.id)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.savedRowHeader}>
                      <View style={styles.savedTypeBadge}>
                        <Text style={styles.savedTypeBadgeText}>{typeLabel}</Text>
                      </View>
                      <Text style={styles.savedDate}>{date}</Text>
                      <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={Colors.text.tertiary} style={{ marginLeft: 'auto' }} />
                    </View>
                    <Text style={styles.savedScope}>{r.scope_type} report</Text>
                    {isExpanded && (
                      <View style={[styles.reportBody, { marginTop: 10 }]}>
                        <Markdown style={markdownStyles}>{text}</Markdown>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        )}

        {/* Report Type Toggle */}
        {!showSaved && <View style={styles.toggleRow}>
          {REPORT_TYPES.map(({ key, icon, label }) => (
            <TouchableOpacity key={key}
              style={[styles.toggleBtn, reportType === key && styles.toggleBtnActive]}
              onPress={() => { setReportType(key); setReport(null); }}>
              <Ionicons name={icon} size={15} color={reportType === key ? Colors.accent.primaryDark : Colors.text.tertiary} />
              <Text style={[styles.toggleText, reportType === key && styles.toggleTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>}

        {!showSaved && (
          <>
            {/* Scope Level Picker */}
            <Text style={styles.sectionLabel}>Scope Level</Text>
            <View style={styles.scopeRow}>
              {SCOPE_LEVELS.map(s => (
                <TouchableOpacity key={s}
                  style={[styles.scopeChip, scopeLevel === s && styles.scopeChipActive]}
                  onPress={() => setScopeLevel(s)}>
                  <Ionicons
                    name={s === 'continental' ? 'globe' : s === 'country' ? 'flag' : s === 'region' ? 'map' : 'location'}
                    size={12}
                    color={scopeLevel === s ? Colors.accent.primaryDark : Colors.text.tertiary}
                  />
                  <Text style={[styles.scopeText, scopeLevel === s && styles.scopeTextActive]}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Geo Picker */}
            {scopeLevel !== 'continental' && (
              <GeoPickerCascade
                value={geoSelection}
                onChange={setGeoSelection}
                maxLevel={scopeLevel}
                label="Select Area"
              />
            )}

            {/* Generate */}
            <TouchableOpacity style={[styles.genBtn, loading && { opacity: 0.7 }]} onPress={generate} disabled={loading}>
              {loading ? <ActivityIndicator color="#fff" /> : (
                <Text style={styles.genBtnText}>Generate {reportType === 'fhir' ? 'FHIR Bundle' : reportType === 'weekly' ? 'Weekly Summary' : 'Situation Report'}</Text>
              )}
            </TouchableOpacity>

            {loading && (
              <View style={styles.loadingCard}>
                <Text style={styles.loadingText}>MedGemma 27B is analyzing surveillance data...</Text>
              </View>
            )}

            {/* Forecast Chart */}
            {weeklyData.length > 0 && (
              <ForecastChart
                historicalData={weeklyData}
                selectedSyndrome={forecastSyndrome}
                onSyndromeChange={(s) => { setForecastSyndrome(s); }}
                syndromes={availableSyndromes}
              />
            )}

            {/* Situation Report */}
            {report && reportType === 'situation' && (
              <View style={styles.reportCard}>
                <View style={styles.reportHeader}>
                  <Ionicons name="document-text" size={16} color={Colors.accent.primaryDark} />
                  <Text style={styles.reportTitle}>Situation Report</Text>
                </View>
                <Text style={styles.reportDate}>{new Date().toLocaleDateString()}</Text>
                <View style={styles.reportBody}>
                  <Markdown style={markdownStyles}>{extractReportText(report)}</Markdown>
                </View>
                {report.alerts?.length > 0 && (
                  <View style={styles.reportAlerts}>
                    <Text style={styles.reportAlertsLabel}>Associated Alerts</Text>
                    {report.alerts.map((a, i) => (
                      <View key={i} style={styles.miniAlert}>
                        <View style={[styles.miniDot, { backgroundColor: a.alert_level === 'emergency' ? Colors.severity.emergency : Colors.severity.warning }]} />
                        <Text style={styles.miniText}>
                          {a.syndrome_category?.replace(/_/g, ' ')} — {a.case_count_current_week} cases ({a.ratio_to_baseline}x)
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
                <View style={styles.exportRow}>
                  <TouchableOpacity style={styles.exportBtn} onPress={handleShare}>
                    <Ionicons name="share-outline" size={14} color={Colors.accent.primaryDark} />
                    <Text style={styles.exportBtnText}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* FHIR Report */}
            {report && reportType === 'fhir' && (
              <View style={styles.reportCard}>
                <View style={styles.reportHeader}>
                  <Ionicons name="code-slash" size={16} color={Colors.accent.secondary} />
                  <Text style={styles.reportTitle}>FHIR Bundle</Text>
                </View>
                <View style={styles.fhirBlock}>
                  <Text style={styles.fhirText}>
                    {JSON.stringify(report, null, 2).substring(0, 1500)}
                    {JSON.stringify(report).length > 1500 ? '\n...(truncated)' : ''}
                  </Text>
                </View>
                <View style={styles.exportRow}>
                  <TouchableOpacity style={styles.exportBtn} onPress={handleShare}>
                    <Ionicons name="share-outline" size={14} color={Colors.accent.primaryDark} />
                    <Text style={styles.exportBtnText}>Export FHIR</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Weekly Report */}
            {report && reportType === 'weekly' && (
              <View style={styles.reportCard}>
                <View style={styles.reportHeader}>
                  <Ionicons name="calendar" size={16} color={Colors.accent.primaryDark} />
                  <Text style={styles.reportTitle}>Weekly Summary</Text>
                </View>
                <Text style={styles.reportDate}>{new Date().toLocaleDateString()}</Text>
                <View style={styles.reportBody}>
                  <Markdown style={markdownStyles}>{extractReportText(report)}</Markdown>
                </View>
                <View style={styles.exportRow}>
                  <TouchableOpacity style={styles.exportBtn} onPress={handleShare}>
                    <Ionicons name="share-outline" size={14} color={Colors.accent.primaryDark} />
                    <Text style={styles.exportBtnText}>Share</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}


const markdownStyles = {
  body: { color: Colors.text.primary, fontSize: 13, lineHeight: 21 },
  heading1: { color: Colors.accent.primary, fontSize: 17, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  heading2: { color: Colors.text.primary, fontSize: 15, fontWeight: '700', marginTop: 12, marginBottom: 4 },
  heading3: { color: Colors.text.secondary, fontSize: 13, fontWeight: '600', marginTop: 8, marginBottom: 4 },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  bullet_list_icon: { color: Colors.accent.primary },
  ordered_list_icon: { color: Colors.accent.primary },
  blockquote: { backgroundColor: Colors.bg.elevated, borderLeftColor: Colors.accent.primary, borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4, marginVertical: 6 },
  code_inline: { backgroundColor: Colors.bg.elevated, fontFamily: 'monospace', fontSize: 11 },
  code_block: { backgroundColor: Colors.bg.elevated, padding: 8, borderRadius: 6, fontFamily: 'monospace', fontSize: 11 },
  hr: { backgroundColor: Colors.border, marginVertical: 10 },
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg.secondary },
  scroll: { paddingHorizontal: Spacing.xl, paddingBottom: 60 },

  // Tab switcher
  tabRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  tabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 9, backgroundColor: Colors.bg.card, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border },
  tabBtnActive: { borderColor: Colors.accent.primary, backgroundColor: Colors.accent.ultraLight },
  tabText: { fontSize: 13, color: Colors.text.tertiary },
  tabTextActive: { color: Colors.accent.primaryDark, fontWeight: '600' },

  // Saved reports list
  emptyCard: { alignItems: 'center', paddingVertical: 40, gap: 8 },
  emptyText: { fontSize: 14, color: Colors.text.secondary, fontWeight: '500' },
  emptySubtext: { fontSize: 12, color: Colors.text.tertiary },
  savedRow: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.lg, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: Colors.border },
  savedRowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  savedTypeBadge: { backgroundColor: Colors.accent.ultraLight, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  savedTypeBadgeText: { fontSize: 10, fontWeight: '700', color: Colors.accent.primaryDark, letterSpacing: 0.3 },
  savedDate: { fontSize: 12, color: Colors.text.secondary },
  savedScope: { fontSize: 11, color: Colors.text.tertiary, marginTop: 3, textTransform: 'capitalize' },

  title: { fontSize: Typography.size.lg, fontWeight: '500', color: Colors.text.primary, marginTop: 16, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: Colors.text.secondary, marginTop: 4, marginBottom: 20 },

  sectionLabel: { fontSize: 10, color: Colors.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },

  toggleRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
  toggleBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, backgroundColor: Colors.bg.card, borderRadius: BorderRadius.md, borderWidth: 1, borderColor: Colors.border },
  toggleBtnActive: { borderColor: Colors.accent.primary, backgroundColor: Colors.accent.ultraLight },
  toggleText: { fontSize: 13, color: Colors.text.tertiary },
  toggleTextActive: { color: Colors.accent.primaryDark, fontWeight: '600' },

  scopeRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  scopeChip: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8, backgroundColor: Colors.bg.card, borderRadius: 20, borderWidth: 1, borderColor: Colors.border },
  scopeChipActive: { borderColor: Colors.accent.primary, backgroundColor: Colors.accent.ultraLight },
  scopeText: { fontSize: 11, color: Colors.text.tertiary },
  scopeTextActive: { color: Colors.accent.primaryDark, fontWeight: '600' },

  genBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.accent.primaryDark, borderRadius: BorderRadius.md, paddingVertical: 14, ...Shadows.md },
  genBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  loadingCard: { backgroundColor: Colors.accent.ultraLight, borderRadius: BorderRadius.md, padding: 14, marginTop: 12, alignItems: 'center' },
  loadingText: { color: Colors.accent.primaryDark, fontSize: 13 },

  reportCard: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl, padding: 16, marginTop: 20, borderWidth: 1, borderColor: Colors.border, ...Shadows.sm },
  reportHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  reportTitle: { fontSize: 15, fontWeight: '500', color: Colors.text.primary },
  reportDate: { fontSize: 10, color: Colors.text.tertiary, marginBottom: 12 },
  reportBody: { backgroundColor: Colors.bg.secondary, borderRadius: BorderRadius.md, padding: 14 },
  reportText: { fontSize: 12, color: Colors.text.secondary, lineHeight: 19 },

  reportAlerts: { marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: Colors.divider },
  reportAlertsLabel: { fontSize: 10, color: Colors.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  miniAlert: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  miniDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },
  miniText: { fontSize: 12, color: Colors.text.secondary },

  fhirBlock: { backgroundColor: Colors.bg.secondary, borderRadius: BorderRadius.md, padding: 12 },
  fhirText: { fontSize: 10, fontFamily: 'monospace', color: Colors.accent.secondary, lineHeight: 15 },

  exportRow: { flexDirection: 'row', gap: 10, marginTop: 14, justifyContent: 'center' },
  exportBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 20, borderWidth: 1, borderColor: Colors.accent.primary, borderRadius: BorderRadius.md },
  exportBtnText: { fontSize: 13, color: Colors.accent.primaryDark, fontWeight: '500' },
});
