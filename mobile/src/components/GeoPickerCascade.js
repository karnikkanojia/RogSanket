import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, FlatList, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, BorderRadius, Shadows } from '../utils/theme';
import { ECOWAS_COUNTRIES } from '../utils/geo';
import { supabase } from '../services/supabase';

const LEVELS = ['country', 'region', 'district'];

export default function GeoPickerCascade({ value = {}, onChange, maxLevel = 'district', label = 'Location' }) {
  const [countries, setCountries] = useState(ECOWAS_COUNTRIES);
  const [regions, setRegions] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modalLevel, setModalLevel] = useState(null);

  // Fetch countries from Supabase (they have UUID ids needed for region lookup)
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from('countries')
          .select('id, code, name, flag, latitude, longitude, population')
          .order('population', { ascending: false });
        if (data?.length) setCountries(data);
      } catch { /* keep static fallback */ }
    })();
  }, []);

  const fetchRegions = useCallback(async (countryId) => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('regions')
        .select('id, name, latitude, longitude, population')
        .eq('country_id', countryId)
        .order('name');
      setRegions(data || []);
    } catch {
      setRegions([]);
    }
    setLoading(false);
  }, []);

  const fetchDistricts = useCallback(async (regionId) => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('districts')
        .select('id, name, latitude, longitude, population')
        .eq('region_id', regionId)
        .order('name');
      setDistricts(data || []);
    } catch {
      setDistricts([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (value.country_id) fetchRegions(value.country_id);
  }, [value.country_id, fetchRegions]);

  useEffect(() => {
    if (value.region_id) fetchDistricts(value.region_id);
  }, [value.region_id, fetchDistricts]);

  const handleSelect = (level, item) => {
    if (level === 'country') {
      onChange({ country_code: item.code, country_name: item.name, country_id: item.id });
      setRegions([]);
      setDistricts([]);
    } else if (level === 'region') {
      onChange({ ...value, region_id: item.id, region_name: item.name, district_id: undefined, district_name: undefined });
      setDistricts([]);
    } else if (level === 'district') {
      onChange({ ...value, district_id: item.id, district_name: item.name });
    }
    setModalLevel(null);
  };

  const getLevelIndex = (l) => LEVELS.indexOf(l);

  const renderPicker = (level, selected, items) => {
    if (getLevelIndex(level) > getLevelIndex(maxLevel)) return null;
    const isDisabled = level === 'region' && !value.country_id || level === 'district' && !value.region_id;

    return (
      <TouchableOpacity
        key={level}
        style={[styles.pickerBtn, isDisabled && styles.pickerDisabled]}
        onPress={() => !isDisabled && setModalLevel(level)}
        disabled={isDisabled}
      >
        <Ionicons
          name={level === 'country' ? 'globe' : level === 'region' ? 'map' : 'location'}
          size={14}
          color={selected ? Colors.accent.primaryDark : Colors.text.tertiary}
        />
        <Text style={[styles.pickerText, selected && styles.pickerTextSelected]} numberOfLines={1}>
          {selected || `Select ${level}`}
        </Text>
        <Ionicons name="chevron-down" size={14} color={Colors.text.tertiary} />
      </TouchableOpacity>
    );
  };

  const getModalItems = () => {
    if (modalLevel === 'country') return countries.map(c => ({ ...c, label: `${c.flag} ${c.name}` }));
    if (modalLevel === 'region') return regions.map(r => ({ ...r, label: r.name }));
    if (modalLevel === 'district') return districts.map(d => ({ ...d, label: d.name }));
    return [];
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {renderPicker('country', value.country_name, countries)}
        {renderPicker('region', value.region_name, regions)}
        {renderPicker('district', value.district_name, districts)}
      </View>

      <Modal visible={modalLevel !== null} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select {modalLevel}</Text>
              <TouchableOpacity onPress={() => setModalLevel(null)}>
                <Ionicons name="close" size={22} color={Colors.text.secondary} />
              </TouchableOpacity>
            </View>
            {loading ? (
              <ActivityIndicator color={Colors.accent.primary} style={{ padding: 40 }} />
            ) : (
              <FlatList
                data={getModalItems()}
                keyExtractor={(item) => item.id || item.code}
                renderItem={({ item }) => (
                  <TouchableOpacity style={styles.modalItem} onPress={() => handleSelect(modalLevel, item)}>
                    <Text style={styles.modalItemText}>{item.label}</Text>
                    {item.population && (
                      <Text style={styles.modalItemSub}>Pop: {(item.population / 1e6).toFixed(1)}M</Text>
                    )}
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <Text style={styles.emptyText}>No {modalLevel}s available</Text>
                }
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '500', color: Colors.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8 },
  pickerBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.bg.input,
    borderRadius: BorderRadius.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  pickerDisabled: { opacity: 0.4 },
  pickerText: { flex: 1, fontSize: 12, color: Colors.text.tertiary },
  pickerTextSelected: { color: Colors.text.primary, fontWeight: '500' },

  modalOverlay: { flex: 1, backgroundColor: Colors.overlay, justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: Colors.bg.primary,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    maxHeight: '60%',
    paddingBottom: 34,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
  },
  modalTitle: { fontSize: 16, fontWeight: '600', color: Colors.text.primary, textTransform: 'capitalize' },
  modalItem: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.divider,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalItemText: { fontSize: 15, color: Colors.text.primary },
  modalItemSub: { fontSize: 11, color: Colors.text.tertiary },
  emptyText: { textAlign: 'center', color: Colors.text.tertiary, padding: 40, fontSize: 14 },
});
