import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, BorderRadius } from '../utils/theme';

export default function SpectrogramView({ base64Image, style }) {
  return (
    <View style={[styles.container, style]}>
      {base64Image ? (
        <Image
          source={{ uri: `data:image/png;base64,${base64Image}` }}
          style={styles.image}
          resizeMode="contain"
        />
      ) : (
        <View style={styles.placeholder}>
          <Ionicons name="analytics-outline" size={28} color={Colors.text.tertiary} />
          <Text style={styles.placeholderText}>Spectrogram unavailable in demo mode</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.bg.secondary,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  image: { width: '100%', height: 180 },
  placeholder: { height: 180, alignItems: 'center', justifyContent: 'center', gap: 8 },
  placeholderText: { fontSize: 12, color: Colors.text.tertiary },
});
