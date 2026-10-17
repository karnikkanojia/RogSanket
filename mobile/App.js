import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Typography, Shadows } from './src/utils/theme';
import DashboardScreen from './src/screens/DashboardScreen';
import DistrictDetailScreen from './src/screens/DistrictDetailScreen';
import MapScreen from './src/screens/MapScreen';
import IntakeScreen from './src/screens/IntakeScreen';
import AlertsScreen from './src/screens/AlertsScreen';
import ReportScreen from './src/screens/ReportScreen';
import { ensureModelsDownloaded, areAllModelsReady } from './src/services/modelManager';
import { initializeEpiCast } from './src/services/api';
import { startAutoSync } from './src/services/offlineQueue';

const Tab = createBottomTabNavigator();
const HomeStack = createNativeStackNavigator();

function HomeStackScreen() {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="Dashboard" component={DashboardScreen} />
      <HomeStack.Screen
        name="DistrictDetail"
        component={DistrictDetailScreen}
        options={({ route }) => ({
          headerShown: true,
          title: route.params?.districtName || 'District Detail',
          headerBackTitle: ' ',
          headerStyle: { backgroundColor: Colors.bg.primary },
          headerTintColor: Colors.accent.primaryDark,
          headerTitleStyle: { fontSize: 16, fontWeight: '600', color: Colors.text.primary },
        })}
      />
    </HomeStack.Navigator>
  );
}

function CenterTabButton({ children, onPress }) {
  return (
    <TouchableOpacity style={styles.centerBtn} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.centerBtnInner}>
        {children}
      </View>
    </TouchableOpacity>
  );
}

function LoadingScreen({ status, percent, onSkip }) {
  return (
    <View style={styles.loadingContainer}>
      <StatusBar style="dark" />
      <View style={styles.loadingContent}>
        <View style={styles.loadingIconWrap}>
          <Ionicons name="medical" size={48} color={Colors.accent.primary} />
        </View>
        <Text style={styles.loadingTitle}>EpiCast</Text>
        <Text style={styles.loadingSubtitle}>On-Device AI Setup</Text>

        <View style={styles.progressSection}>
          <ActivityIndicator size="small" color={Colors.accent.primary} style={{ marginBottom: 12 }} />
          <Text style={styles.loadingStatus}>{status}</Text>

          {percent > 0 && percent < 100 && (
            <View style={styles.progressBarBg}>
              <View style={[styles.progressBarFill, { width: `${percent}%` }]} />
            </View>
          )}

          {percent > 0 && percent < 100 && (
            <Text style={styles.percentText}>{percent}%</Text>
          )}
        </View>

        <TouchableOpacity style={styles.skipBtn} onPress={onSkip}>
          <Text style={styles.skipBtnText}>Skip — use cloud mode</Text>
        </TouchableOpacity>

        <Text style={styles.loadingNote}>
          First-time download: ~4.6 GB{'\n'}
          After setup, works fully offline
        </Text>
      </View>
    </View>
  );
}

export default function App() {
  const [appReady, setAppReady] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('Checking models...');
  const [downloadPercent, setDownloadPercent] = useState(0);

  useEffect(() => {
    bootstrap();
  }, []);

  async function bootstrap() {
    try {
      const modelsReady = await areAllModelsReady();

      if (!modelsReady) {
        setLoadingStatus('Downloading AI models...');
        try {
          await ensureModelsDownloaded((msg, percent) => {
            setLoadingStatus(msg);
            setDownloadPercent(percent);
          });
        } catch (err) {
          console.warn('Model download failed:', err.message);
          setLoadingStatus('Download failed — using cloud mode');
          // Continue to app in cloud-only mode
        }
      }

      // Initialize on-device AI — wait for it so model is ready before user interacts
      setLoadingStatus('Initializing AI engine...');
      try {
        await initializeEpiCast((msg) => setLoadingStatus(msg));
      } catch {
        // Model init failed — app works in cloud-only mode
      }

      setAppReady(true);
      // Start offline sync listener — runs for app lifetime
      startAutoSync();
    } catch (err) {
      console.warn('Bootstrap error:', err.message);
      setAppReady(true);
      startAutoSync();
    }
  }

  function handleSkip() {
    setAppReady(true);
    // Model init continues in background if download completed
    initializeEpiCast(() => { }).catch(() => { });
  }

  if (!appReady) {
    return (
      <LoadingScreen
        status={loadingStatus}
        percent={downloadPercent}
        onSkip={handleSkip}
      />
    );
  }

  return (
    <NavigationContainer
      theme={{
        ...DefaultTheme,
        dark: false,
        colors: {
          ...DefaultTheme.colors,
          primary: Colors.accent.primary,
          background: Colors.bg.primary,
          card: Colors.bg.primary,
          text: Colors.text.primary,
          border: Colors.border,
          notification: Colors.severity.emergency,
        },
      }}
    >
      <StatusBar style="dark" />
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarStyle: {
            backgroundColor: Colors.bg.primary,
            borderTopColor: Colors.border,
            borderTopWidth: 1,
            height: 84,
            paddingBottom: 26,
            paddingTop: 8,
          },
          tabBarActiveTintColor: Colors.accent.primaryDark,
          tabBarInactiveTintColor: Colors.text.tertiary,
          tabBarLabelStyle: {
            fontSize: Typography.size.xs,
            fontWeight: Typography.weight.medium,
          },
          tabBarIcon: ({ focused, color }) => {
            let iconName;
            if (route.name === 'Home') iconName = focused ? 'home' : 'home-outline';
            else if (route.name === 'Map') iconName = focused ? 'map' : 'map-outline';
            else if (route.name === 'Intake') iconName = 'add';
            else if (route.name === 'Alerts') iconName = focused ? 'warning' : 'warning-outline';
            else if (route.name === 'Reports') iconName = focused ? 'document-text' : 'document-text-outline';

            if (route.name === 'Intake') {
              return <Ionicons name="add" size={28} color="#fff" />;
            }
            return <Ionicons name={iconName} size={22} color={color} />;
          },
        })}
      >
        <Tab.Screen name="Home" component={HomeStackScreen} />
        <Tab.Screen name="Map" component={MapScreen} />
        <Tab.Screen
          name="Intake"
          component={IntakeScreen}
          options={{
            tabBarLabel: () => null,
            tabBarButton: (props) => <CenterTabButton {...props} />,
          }}
        />
        <Tab.Screen name="Alerts" component={AlertsScreen} />
        <Tab.Screen name="Reports" component={ReportScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  centerBtn: {
    top: -18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerBtnInner: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.accent.primaryDark,
    justifyContent: 'center',
    alignItems: 'center',
    ...Shadows.lg,
  },

  // Loading screen
  loadingContainer: {
    flex: 1,
    backgroundColor: Colors.bg.primary,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingContent: {
    alignItems: 'center',
    width: '100%',
    maxWidth: 320,
  },
  loadingIconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.accent.ultraLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  loadingTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: Colors.text.primary,
    letterSpacing: -0.5,
  },
  loadingSubtitle: {
    fontSize: 14,
    color: Colors.text.secondary,
    marginTop: 4,
    marginBottom: 32,
  },
  progressSection: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 24,
  },
  loadingStatus: {
    fontSize: 13,
    color: Colors.accent.primaryDark,
    textAlign: 'center',
    marginBottom: 12,
  },
  progressBarBg: {
    width: '100%',
    height: 6,
    backgroundColor: Colors.bg.elevated,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: Colors.accent.primary,
    borderRadius: 3,
  },
  percentText: {
    fontSize: 12,
    color: Colors.text.tertiary,
    marginTop: 6,
  },
  skipBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginBottom: 24,
  },
  skipBtnText: {
    fontSize: 14,
    color: Colors.text.secondary,
    textDecorationLine: 'underline',
  },
  loadingNote: {
    fontSize: 11,
    color: Colors.text.tertiary,
    textAlign: 'center',
    lineHeight: 16,
  },
});
