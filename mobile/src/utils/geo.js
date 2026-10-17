/**
 * ECOWAS Geographic Data — EpiCast
 *
 * Top-level country data for the 15 ECOWAS member states.
 * Region/district data lives in Supabase; this file provides
 * constants for map configuration and country-level lookups.
 */

export const CONTINENTAL_CENTER = { latitude: 8.5, longitude: -2.0 };

export const ZOOM_LEVELS = {
  continental: { latitudeDelta: 40, longitudeDelta: 40 },
  country: { latitudeDelta: 10, longitudeDelta: 10 },
  region: { latitudeDelta: 4, longitudeDelta: 4 },
  district: { latitudeDelta: 1, longitudeDelta: 1 },
};

export const ECOWAS_COUNTRIES = [
  { code: 'NG', name: 'Nigeria', flag: '🇳🇬', latitude: 9.082, longitude: 8.675, climate_zone: 'mixed', population: 223800000 },
  { code: 'GH', name: 'Ghana', flag: '🇬🇭', latitude: 7.946, longitude: -1.023, climate_zone: 'guinea_savanna', population: 33500000 },
  { code: 'SN', name: 'Senegal', flag: '🇸🇳', latitude: 14.497, longitude: -14.452, climate_zone: 'sahel', population: 17700000 },
  { code: 'CI', name: "Côte d'Ivoire", flag: '🇨🇮', latitude: 7.540, longitude: -5.547, climate_zone: 'forest', population: 28200000 },
  { code: 'ML', name: 'Mali', flag: '🇲🇱', latitude: 17.571, longitude: -4.000, climate_zone: 'sahel', population: 22400000 },
  { code: 'BF', name: 'Burkina Faso', flag: '🇧🇫', latitude: 12.364, longitude: -1.534, climate_zone: 'sahel', population: 22700000 },
  { code: 'NE', name: 'Niger', flag: '🇳🇪', latitude: 17.607, longitude: 8.082, climate_zone: 'sahel', population: 26200000 },
  { code: 'GN', name: 'Guinea', flag: '🇬🇳', latitude: 9.946, longitude: -9.697, climate_zone: 'forest', population: 13900000 },
  { code: 'BJ', name: 'Benin', flag: '🇧🇯', latitude: 9.308, longitude: 2.316, climate_zone: 'guinea_savanna', population: 13400000 },
  { code: 'TG', name: 'Togo', flag: '🇹🇬', latitude: 8.620, longitude: 0.825, climate_zone: 'guinea_savanna', population: 8800000 },
  { code: 'SL', name: 'Sierra Leone', flag: '🇸🇱', latitude: 8.460, longitude: -11.780, climate_zone: 'forest', population: 8600000 },
  { code: 'LR', name: 'Liberia', flag: '🇱🇷', latitude: 6.428, longitude: -9.429, climate_zone: 'forest', population: 5300000 },
  { code: 'GM', name: 'Gambia', flag: '🇬🇲', latitude: 13.443, longitude: -15.310, climate_zone: 'sahel', population: 2600000 },
  { code: 'GW', name: 'Guinea-Bissau', flag: '🇬🇼', latitude: 11.804, longitude: -15.180, climate_zone: 'forest', population: 2100000 },
  { code: 'CV', name: 'Cabo Verde', flag: '🇨🇻', latitude: 16.002, longitude: -24.014, climate_zone: 'coastal', population: 600000 },
];

export function getCountryByCode(code) {
  return ECOWAS_COUNTRIES.find(c => c.code === code) || null;
}

export function getCountryFlag(code) {
  return getCountryByCode(code)?.flag || '🌍';
}

export default { ECOWAS_COUNTRIES, CONTINENTAL_CENTER, ZOOM_LEVELS, getCountryByCode, getCountryFlag };
