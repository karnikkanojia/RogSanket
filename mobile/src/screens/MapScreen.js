import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Colors, Typography, BorderRadius, Shadows, Spacing, SyndromeLabels } from '../utils/theme';
import { ECOWAS_COUNTRIES, CONTINENTAL_CENTER, ZOOM_LEVELS, getCountryFlag } from '../utils/geo';
import { supabase } from '../services/supabase';
import DrillDownBottomSheet from '../components/DrillDownBottomSheet';

const ALERT_COLORS = {
  emergency: Colors.map.emergency,
  warning: Colors.map.warning,
  watch: Colors.map.watch,
};

function getAlertColor(level) {
  return ALERT_COLORS[level] || Colors.map.normal;
}

function markerRadius(count, level) {
  const base = level === 'continental' ? 80000 : level === 'country' ? 40000 : level === 'region' ? 15000 : 5000;
  return base + Math.sqrt(count || 1) * (base * 0.3);
}

// Spike detection: compare last 7 days vs 4-week baseline average
function computeAlertLevel(current, baselineAvgPerWeek) {
  if (!current) return null;
  const b = Math.max(baselineAvgPerWeek || 0, 0);
  if (b === 0) return current >= 3 ? 'watch' : null;
  if (current > b * 3) return 'emergency';
  if (current > b * 2) return 'warning';
  if (current > b * 1.5) return 'watch';
  return null;
}

export default function MapScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const mapRef = useRef(null);
  const [level, setLevel] = useState('continental');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [breadcrumbs, setBreadcrumbs] = useState([{ label: 'ECOWAS', level: 'continental' }]);

  const [selectedCountry, setSelectedCountry] = useState(null);
  const [selectedRegion, setSelectedRegion] = useState(null);

  const [totalEncounters, setTotalEncounters] = useState(0);
  const [totalAlerts, setTotalAlerts] = useState(0);

  // Refs so the realtime subscription always sees the current level/selection
  const levelRef = useRef(level);
  const selectedCountryRef = useRef(selectedCountry);
  const selectedRegionRef = useRef(selectedRegion);
  useEffect(() => { levelRef.current = level; }, [level]);
  useEffect(() => { selectedCountryRef.current = selectedCountry; }, [selectedCountry]);
  useEffect(() => { selectedRegionRef.current = selectedRegion; }, [selectedRegion]);

  const loadContinental = useCallback(async () => {
    setLoading(true);
    try {
      const { data: countries } = await supabase
        .from('countries')
        .select('id, code, name, flag, latitude, longitude, population')
        .order('population', { ascending: false });

      const { data: alerts } = await supabase
        .from('alerts')
        .select('country_code, alert_level')
        .eq('is_active', true);

      setTotalAlerts((alerts || []).length);

      const { count } = await supabase
        .from('encounters')
        .select('id', { count: 'exact', head: true });
      setTotalEncounters(count || 0);

      const countryData = (countries || ECOWAS_COUNTRIES).map(c => {
        const countryAlerts = (alerts || []).filter(a => a.country_code === c.code);
        const worstAlert = countryAlerts.find(a => a.alert_level === 'emergency')
          ? 'emergency'
          : countryAlerts.find(a => a.alert_level === 'warning')
            ? 'warning'
            : countryAlerts.find(a => a.alert_level === 'watch')
              ? 'watch'
              : null;
        return {
          ...c,
          alert_level: worstAlert,
          alert_count: countryAlerts.length,
          count: countryAlerts.length,
          subtitle: `Pop: ${((c.population || 0) / 1e6).toFixed(1)}M`,
        };
      });

      setItems(countryData);
    } catch {
      setItems(ECOWAS_COUNTRIES.map(c => ({
        ...c,
        alert_level: null,
        alert_count: 0,
        count: 0,
        subtitle: `Pop: ${(c.population / 1e6).toFixed(1)}M`,
      })));
    }
    setLoading(false);
  }, []);

  const loadRegions = useCallback(async (country) => {
    setLoading(true);
    try {
      const { data: regions } = await supabase
        .from('regions')
        .select('id, name, latitude, longitude, population')
        .eq('country_id', country.id)
        .order('name');

      const regionIds = (regions || []).map(r => r.id).filter(Boolean);
      const encByRegion = {};
      const alertByRegion = {};

      if (regionIds.length > 0) {
        // Get all districts belonging to these regions (name needed for alerts join)
        const { data: allDistricts } = await supabase
          .from('districts')
          .select('id, name, region_id')
          .in('region_id', regionIds);

        const districtIds = (allDistricts || []).map(d => d.id);
        const distToRegion = {};
        (allDistricts || []).forEach(d => { distToRegion[d.id] = d.region_id; });

        if (districtIds.length > 0) {
          const cutoff7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const cutoff35 = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();

          // Single query: all encounters for these districts (district_id + created_at)
          const { data: encs } = await supabase
            .from('encounters')
            .select('district_id, created_at')
            .in('district_id', districtIds);

          const cur7 = {};
          const prev28 = {};
          (encs || []).forEach(e => {
            const rid = distToRegion[e.district_id];
            if (!rid) return;
            encByRegion[rid] = (encByRegion[rid] || 0) + 1;
            if (e.created_at >= cutoff7) cur7[rid] = (cur7[rid] || 0) + 1;
            else if (e.created_at >= cutoff35) prev28[rid] = (prev28[rid] || 0) + 1;
          });

          regionIds.forEach(rid => {
            const lvl = computeAlertLevel(cur7[rid] || 0, (prev28[rid] || 0) / 4);
            if (lvl) alertByRegion[rid] = lvl;
          });

          // Overlay alerts table — map reflects same cases shown on Alerts screen
          const { data: dbAlerts } = await supabase
            .from('alerts')
            .select('district, alert_level, case_count_current_week')
            .eq('is_active', true)
            .eq('country_code', country.code);

          const alertOrder = { emergency: 3, warning: 2, watch: 1 };
          (dbAlerts || []).forEach(a => {
            const d = (allDistricts || []).find(dist => dist.name === a.district);
            if (!d) return;
            const rid = distToRegion[d.id];
            if (!rid) return;
            encByRegion[rid] = (encByRegion[rid] || 0) + (a.case_count_current_week || 0);
            const cur = alertByRegion[rid];
            if (!cur || (alertOrder[a.alert_level] || 0) > (alertOrder[cur] || 0)) {
              alertByRegion[rid] = a.alert_level;
            }
          });
        }
      }

      setItems((regions || []).map(r => ({
        ...r,
        alert_level: alertByRegion[r.id] || null,
        count: encByRegion[r.id] || 0,
        subtitle: r.population ? `Pop: ${(r.population / 1e6).toFixed(1)}M` : '',
      })));
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, []);

  const loadDistricts = useCallback(async (region) => {
    setLoading(true);
    try {
      const { data: districts } = await supabase
        .from('districts')
        .select('id, name, latitude, longitude, population, climate_zone')
        .eq('region_id', region.id)
        .order('name');

      const districtIds = (districts || []).map(d => d.id).filter(Boolean);
      const alertMap = {};
      const encCount = {};

      if (districtIds.length > 0) {
        const cutoff7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const cutoff35 = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();

        // All encounters for these districts — one query, total count + spike detection
        const { data: encs } = await supabase
          .from('encounters')
          .select('district_id, created_at')
          .in('district_id', districtIds);

        const cur7 = {};
        const prev28 = {};
        (encs || []).forEach(e => {
          encCount[e.district_id] = (encCount[e.district_id] || 0) + 1;
          if (e.created_at >= cutoff7) cur7[e.district_id] = (cur7[e.district_id] || 0) + 1;
          else if (e.created_at >= cutoff35) prev28[e.district_id] = (prev28[e.district_id] || 0) + 1;
        });

        districtIds.forEach(id => {
          const lvl = computeAlertLevel(cur7[id] || 0, (prev28[id] || 0) / 4);
          if (lvl) alertMap[id] = lvl;
        });

        // Overlay alerts table — district markers reflect same cases as Alerts screen
        const districtNames = (districts || []).map(d => d.name).filter(Boolean);
        if (districtNames.length > 0) {
          const { data: dbAlerts } = await supabase
            .from('alerts')
            .select('district, alert_level, case_count_current_week')
            .eq('is_active', true)
            .in('district', districtNames);

          const alertOrder = { emergency: 3, warning: 2, watch: 1 };
          (dbAlerts || []).forEach(a => {
            const d = (districts || []).find(dist => dist.name === a.district);
            if (!d) return;
            encCount[d.id] = (encCount[d.id] || 0) + (a.case_count_current_week || 0);
            const cur = alertMap[d.id];
            if (!cur || (alertOrder[a.alert_level] || 0) > (alertOrder[cur] || 0)) {
              alertMap[d.id] = a.alert_level;
            }
          });
        }
      }

      setItems((districts || []).map(d => ({
        ...d,
        alert_level: alertMap[d.id] || null,
        count: encCount[d.id] || 0,
        subtitle: [
          d.population ? `Pop: ${(d.population / 1e3).toFixed(0)}K` : '',
          d.climate_zone ? d.climate_zone.replace(/_/g, ' ') : '',
        ].filter(Boolean).join(' · '),
      })));
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, []);

  const loadFacilities = useCallback(async (district) => {
    setLoading(true);
    try {
      const { data: facilities } = await supabase
        .from('facilities')
        .select('id, name, facility_type, latitude, longitude')
        .eq('district_id', district.id)
        .order('name');

      const { data: encounters } = await supabase
        .from('encounters')
        .select('id, syndrome_category, severity, created_at, narrative_text')
        .eq('district_id', district.id)
        .order('created_at', { ascending: false })
        .limit(20);

      const facilityItems = (facilities || []).map(f => ({
        ...f,
        itemType: 'facility',
        subtitle: f.facility_type?.replace(/_/g, ' '),
        alert_level: null,
        count: 0,
      }));

      const encounterItems = (encounters || []).map(e => ({
        ...e,
        itemType: 'encounter',
        name: SyndromeLabels[e.syndrome_category] || e.syndrome_category || 'Encounter',
        subtitle: `${e.severity || 'unknown'} · ${new Date(e.created_at).toLocaleDateString()}`,
        alert_level: e.severity === 'critical' ? 'emergency' : e.severity === 'severe' ? 'warning' : null,
        count: 0,
      }));

      setItems([...facilityItems, ...encounterItems]);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadContinental(); }, [loadContinental]);

  // Realtime subscriptions — uses refs so we don't re-subscribe on every level change
  useEffect(() => {
    const handleEncounterInsert = () => {
      const l = levelRef.current;
      if (l === 'continental') loadContinental();
      else if (l === 'country' && selectedCountryRef.current) loadRegions(selectedCountryRef.current);
      else if (l === 'region' && selectedRegionRef.current) loadDistricts(selectedRegionRef.current);
    };

    const sub = supabase
      .channel('map-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'encounters' }, handleEncounterInsert)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, () => {
        if (levelRef.current === 'continental') loadContinental();
      })
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [loadContinental, loadRegions, loadDistricts]);

  const animateToRegion = (lat, lon, zoomLevel) => {
    const deltas = ZOOM_LEVELS[zoomLevel] || ZOOM_LEVELS.continental;
    mapRef.current?.animateToRegion({
      latitude: lat,
      longitude: lon,
      ...deltas,
    }, 800);
  };

  const drillDown = (item) => {
    if (!item.latitude || !item.longitude) return;

    if (level === 'continental') {
      setSelectedCountry(item);
      setLevel('country');
      setBreadcrumbs([
        { label: 'ECOWAS', level: 'continental' },
        { label: `${item.flag || ''} ${item.name}`, level: 'country' },
      ]);
      animateToRegion(item.latitude, item.longitude, 'country');
      loadRegions(item);
    } else if (level === 'country') {
      setSelectedRegion(item);
      setLevel('region');
      setBreadcrumbs(prev => [...prev, { label: item.name, level: 'region' }]);
      animateToRegion(item.latitude, item.longitude, 'region');
      loadDistricts(item);
    } else if (level === 'region') {
      setLevel('district');
      setBreadcrumbs(prev => [...prev, { label: item.name, level: 'district' }]);
      animateToRegion(item.latitude, item.longitude, 'district');
      loadFacilities(item);
    }
  };

  const goBack = (bc, index) => {
    const targetLevel = bc.level;
    if (targetLevel === level) return;

    if (targetLevel === 'continental') {
      setLevel('continental');
      setSelectedCountry(null);
      setSelectedRegion(null);
      setBreadcrumbs([{ label: 'ECOWAS', level: 'continental' }]);
      animateToRegion(CONTINENTAL_CENTER.latitude, CONTINENTAL_CENTER.longitude, 'continental');
      loadContinental();
    } else if (targetLevel === 'country' && selectedCountry) {
      setLevel('country');
      setSelectedRegion(null);
      setBreadcrumbs([
        { label: 'ECOWAS', level: 'continental' },
        { label: `${selectedCountry.flag || ''} ${selectedCountry.name}`, level: 'country' },
      ]);
      animateToRegion(selectedCountry.latitude, selectedCountry.longitude, 'country');
      loadRegions(selectedCountry);
    } else if (targetLevel === 'region' && selectedRegion) {
      setLevel('region');
      setBreadcrumbs(prev => prev.slice(0, 3));
      animateToRegion(selectedRegion.latitude, selectedRegion.longitude, 'region');
      loadDistricts(selectedRegion);
    }
  };

  const LEVEL_CONFIG = {
    continental: { icon: 'globe', label: 'ECOWAS Continental' },
    country: { icon: 'flag', label: selectedCountry?.name || 'Country' },
    region: { icon: 'map', label: selectedRegion?.name || 'Region' },
    district: { icon: 'location', label: 'District' },
  };
  const cfg = LEVEL_CONFIG[level];

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.container}>
        {/* Map */}
        <MapView
          ref={mapRef}
          style={styles.map}
          initialRegion={{
            latitude: CONTINENTAL_CENTER.latitude,
            longitude: CONTINENTAL_CENTER.longitude,
            ...ZOOM_LEVELS.continental,
          }}
          showsUserLocation
          showsMyLocationButton={false}
          mapPadding={{ top: insets.top + 100, bottom: 0, left: 0, right: 0 }}
        >
          {items.filter(it => it.latitude && it.longitude).map((item, i) => {
            const color = getAlertColor(item.alert_level);
            const isFacility = item.itemType === 'facility';
            const isEncounter = item.itemType === 'encounter';

            return (
              <Marker
                key={item.id || item.code || i}
                coordinate={{ latitude: item.latitude, longitude: item.longitude }}
                onPress={() => drillDown(item)}
                tracksViewChanges={false}
              >
                <View style={{ alignItems: 'center' }}>
                  <View style={{
                    width: isFacility || isEncounter ? 12 : level === 'continental' ? 28 : level === 'country' ? 22 : 16,
                    height: isFacility || isEncounter ? 12 : level === 'continental' ? 28 : level === 'country' ? 22 : 16,
                    borderRadius: 20,
                    backgroundColor: isFacility ? Colors.accent.primary : color,
                    borderWidth: 2,
                    borderColor: '#fff',
                    opacity: 0.9,
                  }} />
                  {!isFacility && !isEncounter && (
                    <Text style={{
                      fontSize: level === 'continental' ? 9 : 8,
                      fontWeight: '600',
                      color: Colors.text.primary,
                      marginTop: 2,
                      textAlign: 'center',
                      backgroundColor: 'rgba(255,255,255,0.8)',
                      paddingHorizontal: 3,
                      borderRadius: 3,
                    }} numberOfLines={1}>
                      {item.flag ? `${item.flag}` : item.name?.substring(0, 12)}
                    </Text>
                  )}
                </View>
              </Marker>
            );
          })}
        </MapView>

        {/* Header overlay */}
        <View style={[styles.headerOverlay, { top: insets.top + 8 }]}>
          <View style={styles.headerCard}>
            <View style={styles.headerLeft}>
              <Ionicons name={cfg.icon} size={16} color={Colors.accent.primaryDark} />
              <Text style={styles.headerTitle} numberOfLines={1}>{cfg.label}</Text>
            </View>
            <View style={styles.statsRow}>
              <View style={styles.statChip}>
                <Text style={styles.statValue}>{totalEncounters}</Text>
                <Text style={styles.statLabel}>enc</Text>
              </View>
              <View style={[styles.statChip, styles.alertChip]}>
                <Text style={[styles.statValue, { color: Colors.map.emergency }]}>{totalAlerts}</Text>
                <Text style={styles.statLabel}>alerts</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Loading overlay */}
        {loading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="small" color={Colors.accent.primary} />
          </View>
        )}

        {/* Bottom sheet */}
        <DrillDownBottomSheet
          level={level}
          items={items}
          title={cfg.label}
          onItemPress={drillDown}
          breadcrumbs={breadcrumbs}
          onBreadcrumbPress={goBack}
        />
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1 },

  map: { ...StyleSheet.absoluteFillObject },

  headerOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
  },
  headerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.bg.primary,
    borderRadius: BorderRadius.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...Shadows.md,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  headerTitle: { fontSize: 15, fontWeight: '600', color: Colors.text.primary },

  statsRow: { flexDirection: 'row', gap: 8 },
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: Colors.accent.ultraLight,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: BorderRadius.sm,
  },
  alertChip: { backgroundColor: '#FEF2F2' },
  statValue: { fontSize: 13, fontWeight: '700', color: Colors.accent.primaryDark },
  statLabel: { fontSize: 10, color: Colors.text.tertiary },

  loadingOverlay: {
    position: 'absolute',
    top: '50%',
    alignSelf: 'center',
    backgroundColor: Colors.bg.primary,
    borderRadius: BorderRadius.full,
    padding: 12,
    ...Shadows.md,
  },

});
