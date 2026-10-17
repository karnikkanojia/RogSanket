/**
 * EpiCast Design System — Nexus-Inspired
 *
 * Aesthetic: Clean, premium fintech. White backgrounds with emerald/teal/cyan accents.
 * Refined typography, generous whitespace, subtle shadows, rounded corners.
 * Inspired by the Nexus finance dashboard — light, airy, trustworthy.
 */

export const Colors = {
  // Core — clean whites and soft grays
  bg: {
    primary: '#FFFFFF',
    secondary: '#F8FAFB',
    card: '#FFFFFF',
    elevated: '#F1F5F9',
    input: '#F8FAFB',
    gradient: ['#10B981', '#14B8A6', '#06B6D4'], // emerald → teal → cyan
  },

  // Text — high contrast on light
  text: {
    primary: '#111827',
    secondary: '#6B7280',
    tertiary: '#9CA3AF',
    inverse: '#FFFFFF',
    accent: '#059669',
  },

  // Accent — the emerald/teal family
  accent: {
    primary: '#10B981',      // Emerald 500
    primaryDark: '#059669',  // Emerald 600
    secondary: '#14B8A6',    // Teal 500
    cyan: '#06B6D4',         // Cyan 500
    light: '#D1FAE5',        // Emerald 100
    ultraLight: '#ECFDF5',   // Emerald 50
  },

  // Alert severity — refined, not harsh
  severity: {
    low: '#10B981',
    watch: '#F59E0B',
    warning: '#F97316',
    emergency: '#EF4444',
    critical: '#DC2626',
  },

  // Syndrome category colors — distinct and easy to differentiate
  syndrome: {
    acute_watery_diarrhea: '#0EA5E9',      // Sky blue
    acute_bloody_diarrhea: '#F97316',       // Orange
    acute_febrile_illness: '#EF4444',       // Red
    acute_respiratory_infection: '#8B5CF6', // Purple
    acute_neurological_syndrome: '#EC4899', // Pink
    acute_rash_fever: '#EAB308',            // Yellow (was amber, too close to orange)
    acute_hemorrhagic_fever: '#991B1B',     // Dark red (was same red as febrile)
    unexplained_cluster: '#6B7280',         // Gray
  },

  // Chart colors (for ForecastChart)
  chart: {
    historical: '#10B981',
    forecast: '#14B8A6',
    confidenceInterval: '#06B6D4',
    threshold: '#EF4444',
  },

  // Map marker colors
  map: {
    emergency: '#EF4444',
    warning: '#F97316',
    watch: '#F59E0B',
    normal: '#10B981',
  },

  // Utility
  border: '#E5E7EB',
  borderLight: '#F3F4F6',
  divider: '#F3F4F6',
  success: '#10B981',
  error: '#EF4444',
  overlay: 'rgba(0, 0, 0, 0.4)',
  shadow: 'rgba(0, 0, 0, 0.08)',
};

export const Typography = {
  family: {
    display: 'System',
    body: 'System',
    mono: 'monospace',
  },
  size: {
    xs: 10,
    sm: 12,
    base: 14,
    md: 16,
    lg: 18,
    xl: 22,
    '2xl': 28,
    '3xl': 34,
    '4xl': 40,
  },
  weight: {
    light: '300',
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 40,
  '4xl': 48,
};

export const BorderRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  full: 999,
};

export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 5,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 8,
  },
};

export const AlertLevelConfig = {
  watch: { color: Colors.severity.watch, label: 'WATCH' },
  warning: { color: Colors.severity.warning, label: 'WARNING' },
  emergency: { color: Colors.severity.emergency, label: 'EMERGENCY' },
};

export const SyndromeLabels = {
  acute_watery_diarrhea: 'Acute Watery Diarrhea',
  acute_bloody_diarrhea: 'Acute Bloody Diarrhea',
  acute_febrile_illness: 'Acute Febrile Illness',
  acute_respiratory_infection: 'Acute Respiratory Infection',
  acute_neurological_syndrome: 'Acute Neurological Syndrome',
  acute_rash_fever: 'Acute Rash & Fever',
  acute_hemorrhagic_fever: 'Acute Hemorrhagic Fever',
  unexplained_cluster: 'Unexplained Cluster',
};

export default { Colors, Typography, Spacing, BorderRadius, Shadows };
