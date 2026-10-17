import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Dimensions } from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { Ionicons } from '@expo/vector-icons';
import { Colors, BorderRadius, Shadows, SyndromeLabels } from '../utils/theme';

const SCREEN_WIDTH = Dimensions.get('window').width;

/**
 * Linear trend forecast with Poisson 95% CI.
 * Takes the last `windowSize` weeks and projects `horizonWeeks` ahead.
 */
export function computeForecast(weeklyData, horizonWeeks = 2, windowSize = 6) {
  if (!weeklyData || weeklyData.length < 3) return null;

  const recent = weeklyData.slice(-windowSize);
  const n = recent.length;

  // Simple linear regression: y = a + b*x
  const xMean = (n - 1) / 2;
  const yMean = recent.reduce((s, v) => s + v, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (recent[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;

  const predictions = [];
  for (let h = 1; h <= horizonWeeks; h++) {
    const x = n - 1 + h;
    const predicted = Math.max(intercept + slope * x, 0);
    // Poisson 95% CI: mean +/- 1.96 * sqrt(mean)
    const lower = Math.max(predicted - 1.96 * Math.sqrt(Math.max(predicted, 1)), 0);
    const upper = predicted + 1.96 * Math.sqrt(Math.max(predicted, 1));
    predictions.push({ predicted: Math.round(predicted), lower: Math.round(lower), upper: Math.round(upper) });
  }

  // Outbreak threshold: mean + 2 * stddev of the window
  const std = Math.sqrt(recent.reduce((s, v) => s + (v - yMean) ** 2, 0) / n);
  const outbreakThreshold = Math.round(yMean + 2 * std);

  return { predictions, outbreakThreshold, trend: slope > 0.5 ? 'increasing' : slope < -0.5 ? 'decreasing' : 'stable' };
}

export default function ForecastChart({
  historicalData = [],
  forecastData = null,
  outbreakThreshold,
  selectedSyndrome,
  onSyndromeChange,
  syndromes = [],
  weekLabels = [],
}) {
  const forecast = useMemo(() => {
    if (forecastData) return forecastData;
    return computeForecast(historicalData);
  }, [historicalData, forecastData]);

  if (!historicalData.length) return null;

  // Build chart data
  const allValues = [...historicalData];
  const forecastValues = [];
  const upperValues = [];
  const lowerValues = [];

  if (forecast?.predictions) {
    for (const p of forecast.predictions) {
      allValues.push(p.predicted);
      forecastValues.push(p.predicted);
      upperValues.push(p.upper);
      lowerValues.push(p.lower);
    }
  }

  const threshold = outbreakThreshold || forecast?.outbreakThreshold || 0;

  // Labels
  const labels = weekLabels.length
    ? weekLabels
    : allValues.map((_, i) => {
        if (i < historicalData.length) return `W${i + 1}`;
        return `F${i - historicalData.length + 1}`;
      });
  // Only show every 2nd label to avoid crowding
  const displayLabels = labels.map((l, i) => i % 2 === 0 ? l : '');

  const chartWidth = Math.max(SCREEN_WIDTH - 64, allValues.length * 36);

  const datasets = [
    {
      data: allValues,
      color: (opacity = 1) => Colors.chart.historical,
      strokeWidth: 2,
    },
  ];

  // Threshold line
  if (threshold > 0) {
    datasets.push({
      data: allValues.map(() => threshold),
      color: () => Colors.chart.threshold,
      strokeWidth: 1,
      strokeDashArray: [6, 4],
      withDots: false,
    });
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="trending-up" size={16} color={Colors.accent.primaryDark} />
        <Text style={styles.title}>Disease Forecast</Text>
      </View>

      {/* Syndrome selector pills */}
      {syndromes.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pillScroll}>
          {syndromes.map((s) => {
            const active = s === selectedSyndrome;
            return (
              <TouchableOpacity
                key={s}
                style={[styles.pill, active && styles.pillActive]}
                onPress={() => onSyndromeChange?.(s)}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>
                  {SyndromeLabels[s] || s.replace(/_/g, ' ')}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Chart */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <LineChart
          data={{
            labels: displayLabels,
            datasets,
          }}
          width={chartWidth}
          height={180}
          chartConfig={{
            backgroundColor: Colors.bg.card,
            backgroundGradientFrom: Colors.bg.card,
            backgroundGradientTo: Colors.bg.card,
            decimalPlaces: 0,
            color: (opacity = 1) => `rgba(16, 185, 129, ${opacity})`,
            labelColor: () => Colors.text.tertiary,
            propsForDots: { r: '3', strokeWidth: '1', stroke: Colors.accent.primary },
            propsForBackgroundLines: { stroke: Colors.divider, strokeDasharray: '' },
          }}
          bezier
          style={styles.chart}
          withInnerLines={true}
          withOuterLines={false}
          fromZero
        />
      </ScrollView>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendLine, { backgroundColor: Colors.chart.historical }]} />
          <Text style={styles.legendText}>Historical</Text>
        </View>
        {forecast?.predictions && (
          <View style={styles.legendItem}>
            <View style={[styles.legendLine, { backgroundColor: Colors.chart.forecast, opacity: 0.6 }]} />
            <Text style={styles.legendText}>Forecast</Text>
          </View>
        )}
        {threshold > 0 && (
          <View style={styles.legendItem}>
            <View style={[styles.legendLine, { backgroundColor: Colors.chart.threshold }]} />
            <Text style={styles.legendText}>Threshold ({threshold})</Text>
          </View>
        )}
      </View>

      {/* Trend indicator */}
      {forecast?.trend && (
        <View style={styles.trendRow}>
          <Ionicons
            name={forecast.trend === 'increasing' ? 'arrow-up' : forecast.trend === 'decreasing' ? 'arrow-down' : 'remove'}
            size={14}
            color={forecast.trend === 'increasing' ? Colors.severity.warning : forecast.trend === 'decreasing' ? Colors.success : Colors.text.tertiary}
          />
          <Text style={styles.trendText}>Trend: {forecast.trend}</Text>
        </View>
      )}
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  title: { fontSize: 15, fontWeight: '500', color: Colors.text.primary },

  pillScroll: { marginBottom: 12 },
  pill: {
    backgroundColor: Colors.bg.card,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: Colors.border,
    marginRight: 8,
  },
  pillActive: { borderColor: Colors.accent.primary, backgroundColor: Colors.accent.ultraLight },
  pillText: { fontSize: 11, color: Colors.text.secondary },
  pillTextActive: { color: Colors.accent.primaryDark, fontWeight: '600' },

  chart: { borderRadius: 12, marginVertical: 4 },

  legend: { flexDirection: 'row', gap: 16, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendLine: { width: 16, height: 3, borderRadius: 2 },
  legendText: { fontSize: 10, color: Colors.text.tertiary },

  trendRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  trendText: { fontSize: 12, color: Colors.text.secondary, textTransform: 'capitalize' },
});
