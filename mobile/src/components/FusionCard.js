import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, BorderRadius, Shadows } from '../utils/theme';
import { computeFusion } from '../services/fusion';

const AGREEMENT_CONFIG = {
  corroborated: { color: Colors.success, icon: 'checkmark-circle', label: 'Corroborated' },
  partial: { color: Colors.severity.watch, icon: 'alert-circle', label: 'Partial Agreement' },
  conflicting: { color: Colors.severity.emergency, icon: 'close-circle', label: 'Conflicting Signals' },
};

export default function FusionCard({ syndromicResult, coughResult, imageResult }) {
  if (!syndromicResult && !coughResult && !imageResult) return null;

  const fusion = computeFusion(syndromicResult, coughResult, imageResult);
  const agCfg = AGREEMENT_CONFIG[fusion.agreement];

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="git-merge" size={16} color={Colors.accent.primaryDark} />
        <Text style={styles.title}>Multi-Modal Signal Fusion</Text>
      </View>

      {/* Signal Rows */}
      {fusion.signals.map((sig, i) => (
        <View key={i} style={styles.signalRow}>
          <Ionicons name={sig.icon} size={16} color={agCfg.color} style={{ width: 24 }} />
          <Text style={styles.signalSource}>{sig.source}</Text>
          <Text style={styles.signalResult} numberOfLines={1}>{sig.result}</Text>
          <View style={styles.confBarBg}>
            <View style={[styles.confBarFill, { width: `${Math.round(sig.confidence * 100)}%`, backgroundColor: Colors.accent.primary }]} />
          </View>
          <Text style={styles.confText}>{Math.round(sig.confidence * 100)}%</Text>
        </View>
      ))}

      {/* Agreement */}
      <View style={styles.agreementRow}>
        <Ionicons name={agCfg.icon} size={16} color={agCfg.color} />
        <Text style={[styles.agreementLabel, { color: agCfg.color }]}>{agCfg.label}</Text>
      </View>

      {/* Fused Confidence */}
      <View style={styles.fusedRow}>
        <Text style={styles.fusedLabel}>Fused Confidence</Text>
        <View style={styles.fusedBarBg}>
          <View style={[styles.fusedBarFill, { width: `${Math.round(fusion.fusedConfidence * 100)}%` }]} />
        </View>
        <Text style={styles.fusedValue}>{Math.round(fusion.fusedConfidence * 100)}%</Text>
      </View>

      {/* Recommendation */}
      <Text style={styles.recommendation}>{fusion.recommendation}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.bg.card,
    borderRadius: BorderRadius.xl,
    padding: 16,
    marginTop: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadows.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 },
  title: { fontSize: 15, fontWeight: '500', color: Colors.text.primary },

  signalRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  signalSource: { fontSize: 11, color: Colors.text.tertiary, width: 80 },
  signalResult: { fontSize: 12, color: Colors.text.secondary, flex: 1, textTransform: 'capitalize' },
  confBarBg: { width: 50, height: 5, backgroundColor: Colors.bg.elevated, borderRadius: 3, marginHorizontal: 8, overflow: 'hidden' },
  confBarFill: { height: '100%', borderRadius: 3 },
  confText: { fontSize: 11, fontWeight: '600', color: Colors.text.primary, width: 32, textAlign: 'right' },

  agreementRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, marginBottom: 10 },
  agreementLabel: { fontSize: 13, fontWeight: '600' },

  fusedRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  fusedLabel: { fontSize: 11, color: Colors.text.tertiary, width: 110 },
  fusedBarBg: { flex: 1, height: 8, backgroundColor: Colors.bg.elevated, borderRadius: 4, overflow: 'hidden', marginRight: 8 },
  fusedBarFill: { height: '100%', borderRadius: 4, backgroundColor: Colors.accent.primary },
  fusedValue: { fontSize: 13, fontWeight: '600', color: Colors.accent.primaryDark, width: 36, textAlign: 'right' },

  recommendation: { fontSize: 12, color: Colors.text.secondary, lineHeight: 18, fontStyle: 'italic' },
});
