import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, BorderRadius, Shadows, SyndromeLabels } from '../utils/theme';

const SEV_COLORS = {
  mild: Colors.severity.low,
  moderate: Colors.severity.watch,
  severe: Colors.severity.warning,
  critical: Colors.severity.emergency,
};

export default function EncounterCard({ encounter, onPress }) {
  const color = SEV_COLORS[encounter.severity] || Colors.text.tertiary;
  const syndrome = SyndromeLabels[encounter.syndrome_category] || encounter.syndrome_category || 'Unknown';
  const timeLabel = encounter.time || new Date(encounter.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <TouchableOpacity style={styles.card} onPress={() => onPress?.(encounter)} activeOpacity={0.7}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={styles.body}>
        <Text style={styles.syndrome} numberOfLines={1}>{syndrome}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {encounter.district || 'Unknown'} · {timeLabel}
        </Text>
        {encounter.narrative_text && (
          <Text style={styles.narrative} numberOfLines={2}>{encounter.narrative_text}</Text>
        )}
      </View>
      <View style={[styles.sevChip, { backgroundColor: color + '15' }]}>
        <Text style={[styles.sevText, { color }]}>{(encounter.severity || '').toUpperCase()}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: Colors.bg.card,
    borderRadius: BorderRadius.xl,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadows.sm,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6, marginRight: 10 },
  body: { flex: 1 },
  syndrome: { fontSize: 13, fontWeight: '500', color: Colors.text.primary },
  meta: { fontSize: 10, color: Colors.text.tertiary, marginTop: 2 },
  narrative: { fontSize: 11, color: Colors.text.secondary, marginTop: 4, lineHeight: 15 },
  sevChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, marginLeft: 8 },
  sevText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
});
