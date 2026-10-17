import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, BorderRadius, Shadows, AlertLevelConfig, SyndromeLabels } from '../utils/theme';

export default function AlertCard({ alert, onViewOnMap, onGenerateReport, initialExpanded = false }) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const cfg = AlertLevelConfig[alert.alert_level] || { color: Colors.text.tertiary, label: 'UNKNOWN' };
  const syndrome = SyndromeLabels[alert.syndrome_category] || alert.syndrome_category?.replace(/_/g, ' ') || 'Unknown';
  const trendIcon = alert.trend === 'increasing' ? '↑' : alert.trend === 'decreasing' ? '↓' : '—';

  return (
    <TouchableOpacity
      style={[styles.card, { borderLeftColor: cfg.color }]}
      onPress={() => setExpanded(!expanded)}
      activeOpacity={0.7}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <View style={[styles.levelPill, { backgroundColor: cfg.color + '15' }]}>
          <View style={[styles.levelDot, { backgroundColor: cfg.color }]} />
          <Text style={[styles.levelText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
        <Text style={styles.district}>{alert.district || ''}</Text>
      </View>

      {/* Syndrome */}
      <Text style={styles.syndromeName}>{syndrome}</Text>
      {alert.country_name && <Text style={styles.countryLabel}>{alert.country_name}</Text>}

      {/* Metrics Row */}
      <View style={styles.metricsRow}>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>{alert.case_count_current_week}</Text>
          <Text style={styles.metricLabel}>This Week</Text>
        </View>
        <View style={styles.metricDivider} />
        <View style={styles.metric}>
          <Text style={styles.metricValue}>{Math.round((alert.case_count_baseline || 0) * 10) / 10}</Text>
          <Text style={styles.metricLabel}>Baseline</Text>
        </View>
        <View style={styles.metricDivider} />
        <View style={styles.metric}>
          <Text style={[styles.metricValue, { color: cfg.color }]}>{alert.ratio_to_baseline?.toFixed(1)}x</Text>
          <Text style={styles.metricLabel}>Ratio</Text>
        </View>
        <View style={styles.metricDivider} />
        <View style={styles.metric}>
          <Text style={[styles.metricValue, alert.trend === 'increasing' && { color: Colors.severity.emergency }]}>
            {trendIcon} {alert.trend || 'unknown'}
          </Text>
          <Text style={styles.metricLabel}>Trend</Text>
        </View>
      </View>

      {/* Expand indicator */}
      <View style={styles.expandRow}>
        <Text style={styles.expandHint}>{expanded ? 'Hide details' : 'Tap for details'}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={Colors.text.tertiary} />
      </View>

      {/* Expanded Detail */}
      {expanded && (
        <View style={styles.expandedContent}>
          {alert.situation_summary && (
            <View style={styles.detailBlock}>
              <Text style={styles.detailLabel}>Situation</Text>
              <Text style={styles.detailText}>{alert.situation_summary}</Text>
            </View>
          )}

          {alert.recommended_actions?.length > 0 && (
            <View style={styles.detailBlock}>
              <Text style={styles.detailLabel}>Recommended Actions</Text>
              {alert.recommended_actions.map((action, i) => (
                <View key={i} style={styles.actionRow}>
                  <Text style={styles.actionNum}>{i + 1}.</Text>
                  <Text style={styles.actionText}>{action}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Action Buttons */}
          <View style={styles.actionBtns}>
            {onViewOnMap && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => onViewOnMap(alert)}>
                <Ionicons name="map-outline" size={14} color={Colors.accent.primaryDark} />
                <Text style={styles.actionBtnText}>View on Map</Text>
              </TouchableOpacity>
            )}
            {onGenerateReport && (
              <TouchableOpacity style={styles.actionBtn} onPress={() => onGenerateReport(alert)}>
                <Ionicons name="document-text-outline" size={14} color={Colors.accent.primaryDark} />
                <Text style={styles.actionBtnText}>Generate Report</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.bg.card,
    borderRadius: BorderRadius.xl,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    borderLeftWidth: 4,
    ...Shadows.sm,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  levelPill: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  levelDot: { width: 6, height: 6, borderRadius: 3, marginRight: 4 },
  levelText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  district: { fontSize: 11, color: Colors.text.tertiary },

  syndromeName: { fontSize: 15, fontWeight: '500', color: Colors.text.primary, marginBottom: 2 },
  countryLabel: { fontSize: 11, color: Colors.text.tertiary, marginBottom: 10 },

  metricsRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bg.secondary, borderRadius: BorderRadius.md, padding: 10, marginBottom: 8 },
  metric: { flex: 1, alignItems: 'center' },
  metricValue: { fontSize: 13, fontWeight: '600', color: Colors.text.primary },
  metricLabel: { fontSize: 9, color: Colors.text.tertiary, marginTop: 2 },
  metricDivider: { width: 1, height: 24, backgroundColor: Colors.divider },

  expandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  expandHint: { fontSize: 10, color: Colors.text.tertiary },

  expandedContent: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.divider },
  detailBlock: { marginBottom: 12 },
  detailLabel: { fontSize: 10, color: Colors.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  detailText: { fontSize: 12, color: Colors.text.secondary, lineHeight: 18 },

  actionRow: { flexDirection: 'row', marginBottom: 4 },
  actionNum: { fontSize: 12, color: Colors.accent.primaryDark, fontWeight: '600', width: 18 },
  actionText: { fontSize: 12, color: Colors.text.secondary, flex: 1, lineHeight: 18 },

  actionBtns: { flexDirection: 'row', gap: 8, marginTop: 4 },
  actionBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderWidth: 1, borderColor: Colors.accent.primary, borderRadius: BorderRadius.md,
  },
  actionBtnText: { fontSize: 12, color: Colors.accent.primaryDark, fontWeight: '500' },
});
