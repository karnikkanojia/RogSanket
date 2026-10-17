import React, { useCallback, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet, { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Colors, BorderRadius, Shadows } from '../utils/theme';

const LEVEL_ICONS = {
  continental: 'globe',
  country: 'flag',
  region: 'map',
  district: 'location',
  facility: 'medkit',
};

function alertColor(level) {
  if (level === 'emergency') return Colors.map.emergency;
  if (level === 'warning') return Colors.map.warning;
  if (level === 'watch') return Colors.map.watch;
  return Colors.map.normal;
}

function markerRadius(count) {
  return Math.max(8, Math.min(8 + Math.sqrt(count || 0) * 2, 28));
}

export default function DrillDownBottomSheet({
  level = 'continental',
  items = [],
  title = '',
  onItemPress,
  breadcrumbs = [],
  onBreadcrumbPress,
}) {
  const sheetRef = useRef(null);
  const snapPoints = useMemo(() => ['25%', '55%', '90%'], []);

  const renderBreadcrumbs = () => {
    if (!breadcrumbs.length) return null;
    return (
      <View style={styles.breadcrumbRow}>
        {breadcrumbs.map((bc, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Ionicons name="chevron-forward" size={12} color={Colors.text.tertiary} />}
            <TouchableOpacity onPress={() => onBreadcrumbPress?.(bc, i)}>
              <Text style={[styles.breadcrumbText, i === breadcrumbs.length - 1 && styles.breadcrumbActive]}>
                {bc.label}
              </Text>
            </TouchableOpacity>
          </React.Fragment>
        ))}
      </View>
    );
  };

  const renderItem = useCallback(({ item }) => {
    const color = alertColor(item.alert_level);
    const radius = markerRadius(item.count);
    const isFacility = item.itemType === 'facility';
    const isEncounter = item.itemType === 'encounter';

    return (
      <TouchableOpacity style={styles.itemRow} onPress={() => onItemPress?.(item)} activeOpacity={0.7}>
        <View style={[styles.marker, { width: radius, height: radius, borderRadius: radius / 2, backgroundColor: color }]}>
          {item.flag && <Text style={styles.flag}>{item.flag}</Text>}
          {!item.flag && isFacility && <Ionicons name="medkit" size={10} color="#fff" />}
          {!item.flag && isEncounter && <Ionicons name="pulse" size={10} color="#fff" />}
        </View>
        <View style={styles.itemInfo}>
          <Text style={styles.itemName} numberOfLines={1}>{item.name}</Text>
          {item.subtitle && <Text style={styles.itemSub} numberOfLines={1}>{item.subtitle}</Text>}
        </View>
        {item.alert_count > 0 && (
          <View style={[styles.countBadge, { backgroundColor: color + '20' }]}>
            <Text style={[styles.countText, { color }]}>{item.alert_count}</Text>
          </View>
        )}
        {item.count !== undefined && !item.alert_count && (
          <View style={[styles.countBadge, { backgroundColor: color + '20' }]}>
            <Text style={[styles.countText, { color }]}>{item.count}</Text>
          </View>
        )}
        <Ionicons name="chevron-forward" size={16} color={Colors.text.tertiary} />
      </TouchableOpacity>
    );
  }, [onItemPress]);

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handleIndicator}
    >
      <View style={styles.container}>
        {renderBreadcrumbs()}

        <View style={styles.headerRow}>
          <Ionicons name={LEVEL_ICONS[level] || 'globe'} size={18} color={Colors.accent.primaryDark} />
          <Text style={styles.title}>{title || `${level.charAt(0).toUpperCase() + level.slice(1)} View`}</Text>
          <Text style={styles.countLabel}>{items.length} {level === 'continental' ? 'countries' : 'locations'}</Text>
        </View>
      </View>

      <BottomSheetFlatList
        data={items}
        keyExtractor={(item) => item.id || item.code || item.name}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No data available for this level</Text>
        }
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheetBackground: {
    backgroundColor: Colors.bg.primary,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    ...Shadows.lg,
  },
  handleIndicator: {
    backgroundColor: Colors.text.tertiary,
    width: 40,
  },
  container: { paddingHorizontal: 16 },

  breadcrumbRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8 },
  breadcrumbText: { fontSize: 12, color: Colors.accent.primary },
  breadcrumbActive: { color: Colors.text.primary, fontWeight: '600' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  title: { fontSize: 16, fontWeight: '600', color: Colors.text.primary, flex: 1 },
  countLabel: { fontSize: 11, color: Colors.text.tertiary },

  list: { paddingHorizontal: 16, paddingBottom: 80 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    gap: 12,
  },
  marker: { alignItems: 'center', justifyContent: 'center' },
  flag: { fontSize: 12 },
  itemInfo: { flex: 1 },
  itemName: { fontSize: 14, fontWeight: '500', color: Colors.text.primary },
  itemSub: { fontSize: 11, color: Colors.text.tertiary, marginTop: 2 },
  countBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  countText: { fontSize: 12, fontWeight: '600' },

  emptyText: { textAlign: 'center', color: Colors.text.tertiary, padding: 40, fontSize: 14 },
});
