import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, Alert, Animated, Image, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AudioModule, RecordingPresets, useAudioRecorder } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { Colors, Typography, Spacing, BorderRadius, Shadows, SyndromeLabels } from '../utils/theme';
import api from '../services/api';
import { queueEncounter } from '../services/offlineQueue';
import GeoPickerCascade from '../components/GeoPickerCascade';
import FusionCard from '../components/FusionCard';

// WAV/LPCM preset — required for the on-device mel spectrogram pipeline (HeAR)
const COUGH_WAV_PRESET = {
  ...RecordingPresets.HIGH_QUALITY,
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
    extension: '.wav',
    outputFormat: 'lpcm',
    sampleRate: 16000,
    numberOfChannels: 1,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
};

export default function IntakeScreen() {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef(null);
  const [narrative, setNarrative] = useState('');
  const [geoSelection, setGeoSelection] = useState({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  // Voice recording state (expo-speech-recognition — on-device STT)
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const durationInterval = useRef(null);

  // MedSigLIP image state
  const [imageUri, setImageUri] = useState(null);
  const [imageResult, setImageResult] = useState(null);
  const [isClassifying, setIsClassifying] = useState(false);

  // HeAR cough state
  const [coughResult, setCoughResult] = useState(null);
  const [coughAudioUri, setCoughAudioUri] = useState(null);
  const [showCoughModal, setShowCoughModal] = useState(false);
  const [coughCountdown, setCoughCountdown] = useState(0);
  const [isCoughRecording, setIsCoughRecording] = useState(false);
  const [isAnalyzingCough, setIsAnalyzingCough] = useState(false);
  const coughRecorder = useAudioRecorder(COUGH_WAV_PRESET);
  const coughTimer = useRef(null);

  // Model swap state — shows fullscreen overlay during MedGemma ↔ HeAR swap
  const [modelSwapState, setModelSwapState] = useState(null); // null | 'switching_to_cough' | 'analyzing' | 'switching_back'

  // On-device speech recognition events
  useSpeechRecognitionEvent('start', () => setIsRecording(true));
  useSpeechRecognitionEvent('end', () => setIsRecording(false));
  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results?.[0]?.transcript;
    if (transcript) { setNarrative(transcript); setResult(null); }
  });
  useSpeechRecognitionEvent('error', (event) => {
    setIsRecording(false);
    Alert.alert('Voice Input', event.message || 'Speech recognition failed. Please try again.');
  });

  // Pulse animation for recording indicator
  useEffect(() => {
    if (isRecording || isCoughRecording) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.4, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [isRecording, isCoughRecording]);

  // Duration timer
  useEffect(() => {
    if (isRecording) {
      durationInterval.current = setInterval(() => setRecordingDuration(d => d + 1), 1000);
      return () => clearInterval(durationInterval.current);
    } else {
      clearInterval(durationInterval.current);
    }
  }, [isRecording]);

  // ─── Voice (on-device STT via expo-speech-recognition) ───
  const startRecording = async () => {
    try {
      const { granted } = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!granted) {
        Alert.alert('Permission Required', 'Microphone access is needed for voice input.');
        return;
      }
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        requiresOnDeviceRecognition: true,
      });
      setRecordingDuration(0);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch (e) {
      Alert.alert('Voice Input Error', e.message);
    }
  };

  const stopRecording = () => {
    ExpoSpeechRecognitionModule.stop();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  // ─── Cough (HeAR) ───
  const openCoughModal = () => {
    setCoughCountdown(3);
    setShowCoughModal(true);
    // Countdown 3-2-1 then start recording
    let count = 3;
    const interval = setInterval(() => {
      count--;
      setCoughCountdown(count);
      if (count <= 0) {
        clearInterval(interval);
        startCoughRecording();
      }
    }, 1000);
    coughTimer.current = interval;
  };

  const startCoughRecording = async () => {
    try {
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await coughRecorder.prepareToRecordAsync();
      coughRecorder.record();
      setIsCoughRecording(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Auto-stop after 5 seconds
      setTimeout(() => {
        stopCoughRecording();
      }, 5000);
    } catch (e) {
      setShowCoughModal(false);
      Alert.alert('Recording Error', e.message);
    }
  };

  const stopCoughRecording = async () => {
    try {
      await coughRecorder.stop();
      setIsCoughRecording(false);
      await AudioModule.setAudioModeAsync({ allowsRecording: false });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const uri = coughRecorder.uri;
      if (!uri) { setShowCoughModal(false); return; }
      setCoughAudioUri(uri);

      // Verify recording file exists before reading
      const fileInfo = await FileSystem.getInfoAsync(uri);
      if (!fileInfo.exists) {
        Alert.alert('Recording Error', 'Cough recording was not saved. Please try again.');
        setShowCoughModal(false);
        return;
      }

      setIsAnalyzingCough(true);
      setShowCoughModal(false);
      setModelSwapState('switching_to_cough');
      try {
        const base64Audio = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        const format = uri.toLowerCase().endsWith('.wav') ? 'wav' : 'm4a';
        const analysisTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Analysis timed out. Check your internet connection and try again.')), 60000)
        );
        const res = await Promise.race([
          api.analyzeCough(base64Audio, format, (progressMsg) => {
            if (progressMsg?.includes('Analyzing')) setModelSwapState('analyzing');
          }),
          analysisTimeout,
        ]);
        setCoughResult(res);
      } catch (err) {
        Alert.alert('Cough Analysis', err.message || 'Cloud analysis failed. Check internet connection.');
      } finally {
        setIsAnalyzingCough(false);
        setModelSwapState(null);
      }
    } catch (e) {
      setIsCoughRecording(false);
      setShowCoughModal(false);
      Alert.alert('Error', e.message);
    }
  };

  const pickCoughFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      setIsAnalyzingCough(true);
      try {
        const base64 = await FileSystem.readAsStringAsync(
          asset.uri.replace('file://', ''),
          { encoding: FileSystem.EncodingType.Base64 }
        );
        const ext = asset.name?.split('.').pop()?.toLowerCase() || 'wav';
        const format = ['m4a', 'aac', 'mp4', 'mp3'].includes(ext) ? ext : 'wav';
        const res = await api.analyzeCough(base64, format);
        setCoughResult(res);
        setCoughAudioUri(asset.uri);
      } catch (err) {
        Alert.alert('Upload Failed', err.message || 'Could not analyze audio file.');
      } finally {
        setIsAnalyzingCough(false);
      }
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  };

  // ─── Image (MedSigLIP) ───
  const pickImage = () => {
    Alert.alert('Clinical Image', 'Choose image source', [
      { text: 'Camera', onPress: () => captureImage('camera') },
      { text: 'Photo Library', onPress: () => captureImage('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const captureImage = async (source) => {
    try {
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) { Alert.alert('Permission Required', 'Camera access is needed.'); return; }
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) { Alert.alert('Permission Required', 'Photo library access is needed.'); return; }
      }
      const options = { base64: true, quality: 0.7, allowsEditing: true };
      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync(options)
        : await ImagePicker.launchImageLibraryAsync({ ...options, mediaTypes: ['images'] });

      if (result.canceled) return;
      const asset = result.assets[0];
      setImageUri(asset.uri);
      setImageResult(null);
      setIsClassifying(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      try {
        const res = await api.classifyImage(asset.base64, narrative || null);
        setImageResult(res);
      } catch (err) {
        Alert.alert('Image Triage', err.message || 'MedSigLIP analysis failed. Check RunPod connection.');
        setImageUri(null);
      } finally {
        setIsClassifying(false);
      }
    } catch (e) {
      Alert.alert('Image Error', e.message);
    }
  };

  // ─── Submit ───
  const [savedToDistrict, setSavedToDistrict] = useState(null); // name of district after save

  const handleSubmit = async () => {
    if (!narrative.trim()) { Alert.alert('Missing Information', 'Please enter a clinical narrative.'); return; }
    setLoading(true); setResult(null); setSavedToDistrict(null);
    try {
      const res = await api.submitEncounter({
        narrative: narrative.trim(),
        district: geoSelection.district_name || 'Unknown',
        facilityName: 'Mobile Field Unit',
      });
      setResult(res);
    } catch (err) {
      Alert.alert('Extraction Failed', err.message || 'On-device AI failed. Please try again.');
    } finally { setLoading(false); scrollRef.current?.scrollToEnd({ animated: true }); }
  };

  const handleSaveToDistrict = async () => {
    if (!geoSelection.district_id) {
      Alert.alert('Select District', 'Please select a district using the Location picker above before saving.');
      return;
    }
    if (!result?.syndromic_signal) {
      Alert.alert('No Data', 'Please extract syndromic signals first.');
      return;
    }
    try {
      await queueEncounter({
        narrative: narrative.trim(),
        extraction: result.syndromic_signal,
        districtId: geoSelection.district_id,
        location: { name: geoSelection.district_name },
        coughResult: coughResult || null,
        imageResult: imageResult || null,
        imageUri: imageUri || null,
        coughAudioUri: coughAudioUri || null,
      });
      setSavedToDistrict(geoSelection.district_name || 'District');
    } catch {
      Alert.alert('Save Failed', 'Could not save encounter. It will be retried automatically.');
    }
  };

  const loadExample = (ex) => { setNarrative(ex); setResult(null); setSavedToDistrict(null); };

  const hasMultipleModalities = [result?.syndromic_signal, coughResult, imageResult].filter(Boolean).length >= 2;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

          <Text style={styles.title}>Clinical Intake</Text>
          <Text style={styles.subtitle}>Multi-modal encounter capture with AI-powered syndromic extraction.</Text>

          {/* Geo Picker */}
          <GeoPickerCascade value={geoSelection} onChange={setGeoSelection} label="Location" />

          {/* 3 Modality Buttons */}
          <Text style={styles.sectionLabel}>Capture Modalities</Text>
          <View style={styles.modalityRow}>
            <TouchableOpacity style={[styles.modalityBtn, isRecording && styles.modalityBtnActive]} onPress={isRecording ? stopRecording : startRecording}>
              <View style={[styles.modalityIcon, isRecording && { backgroundColor: Colors.severity.emergency + '15' }]}>
                <Ionicons name={isRecording ? 'stop-circle' : 'mic'} size={22} color={isRecording ? Colors.severity.emergency : Colors.accent.primaryDark} />
              </View>
              <Text style={styles.modalityLabel}>Voice</Text>
              <Text style={styles.modalityModel}>MedASR</Text>
              {isRecording && <Text style={styles.recordingBadge}>{recordingDuration}s</Text>}
            </TouchableOpacity>

            <TouchableOpacity style={[styles.modalityBtn, coughResult && styles.modalityBtnDone]} onPress={openCoughModal}>
              <View style={[styles.modalityIcon, coughResult && { backgroundColor: Colors.success + '15' }]}>
                <Ionicons name="ear" size={22} color={coughResult ? Colors.success : Colors.accent.primaryDark} />
              </View>
              <Text style={styles.modalityLabel}>Cough</Text>
              <Text style={styles.modalityModel}>HeAR</Text>
              {coughResult && <Ionicons name="checkmark-circle" size={14} color={Colors.success} style={{ marginTop: 2 }} />}
              {isAnalyzingCough && <ActivityIndicator size="small" color={Colors.accent.primary} style={{ marginTop: 2 }} />}
            </TouchableOpacity>

            <TouchableOpacity style={[styles.modalityBtn, imageResult && styles.modalityBtnDone]} onPress={pickImage}>
              <View style={[styles.modalityIcon, imageResult && { backgroundColor: Colors.success + '15' }]}>
                <Ionicons name="camera" size={22} color={imageResult ? Colors.success : Colors.accent.primaryDark} />
              </View>
              <Text style={styles.modalityLabel}>Photo</Text>
              <Text style={styles.modalityModel}>MedSigLIP</Text>
              {imageResult && <Ionicons name="checkmark-circle" size={14} color={Colors.success} style={{ marginTop: 2 }} />}
            </TouchableOpacity>
          </View>

          {/* Upload pre-recorded cough audio */}
          <TouchableOpacity style={styles.uploadAudioLink} onPress={pickCoughFile} disabled={isAnalyzingCough}>
            <Ionicons name="cloud-upload-outline" size={13} color={Colors.accent.primaryDark} />
            <Text style={styles.uploadAudioText}>Upload cough recording from library</Text>
          </TouchableOpacity>

          {/* Narrative Input */}
          <View style={styles.inputCard}>
            <TextInput
              style={styles.textInput}
              placeholder={"Describe the clinical encounter...\n\nExample: Patient is a 45-year-old male presenting with 3 days of profuse watery diarrhea, vomiting, and signs of severe dehydration."}
              placeholderTextColor={Colors.text.tertiary}
              value={narrative} onChangeText={(t) => { setNarrative(t); setResult(null); }}
              multiline numberOfLines={8} textAlignVertical="top"
            />
            <View style={styles.inputFooter}>
              <Text style={styles.charCount}>{narrative.length} chars</Text>
              {narrative.length > 0 && (
                <TouchableOpacity onPress={() => { setNarrative(''); setResult(null); }}>
                  <Ionicons name="close-circle" size={18} color={Colors.text.tertiary} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Image Preview */}
          {imageUri && (
            <View style={styles.imagePreviewCard}>
              <Image source={{ uri: imageUri }} style={styles.imageThumbnail} />
              <View style={styles.imagePreviewInfo}>
                <Text style={styles.imagePreviewLabel}>Clinical Image Attached</Text>
                {isClassifying ? (
                  <ActivityIndicator size="small" color={Colors.accent.primary} />
                ) : (
                  <TouchableOpacity onPress={() => { setImageUri(null); setImageResult(null); }}>
                    <Ionicons name="close-circle" size={18} color={Colors.text.tertiary} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}

          {/* Cough result badge */}
          {coughResult && (
            <View style={styles.coughBadge}>
              <Ionicons name="ear" size={14} color={Colors.accent.cyan} />
              <Text style={styles.coughBadgeText}>
                HeAR: {(coughResult.classification || coughResult.prediction || '').replace(/_/g, ' ')} ({Math.round((coughResult.confidence || 0) * 100)}%)
              </Text>
              <SourceBadge source={coughResult._source} />
              <TouchableOpacity onPress={() => setCoughResult(null)}>
                <Ionicons name="close-circle" size={16} color={Colors.text.tertiary} />
              </TouchableOpacity>
            </View>
          )}

          {/* Quick Examples */}
          <Text style={styles.exLabel}>Quick examples</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
            {EXAMPLES.map(([label, ex]) => (
              <TouchableOpacity key={label} style={styles.exChip} onPress={() => loadExample(ex)}>
                <Text style={styles.exChipText}>{label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Submit */}
          <TouchableOpacity style={[styles.submitBtn, loading && { opacity: 0.7 }]} onPress={handleSubmit} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : (
              <><Ionicons name="scan" size={18} color="#fff" /><Text style={styles.submitBtnText}>Extract Syndromic Signals</Text></>
            )}
          </TouchableOpacity>

          {loading && (
            <View style={styles.processingCard}>
              <Text style={styles.processingText}>MedGemma is analyzing the encounter...</Text>
            </View>
          )}

          {/* Fusion Card */}
          {hasMultipleModalities && (
            <FusionCard
              syndromicResult={result?.syndromic_signal}
              coughResult={coughResult}
              imageResult={imageResult}
            />
          )}

          {/* Result */}
          {result?.syndromic_signal && (
            <View style={styles.resultContainer}>
              <View style={styles.resultHeader}>
                <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
                <Text style={styles.resultTitle}>Syndromic Signal Extracted</Text>
                <SourceBadge source={result.syndromic_signal._source} model={result.syndromic_signal._model} />
              </View>
              <View style={styles.resultCard}>
                <Row label="Syndrome">
                  <View style={[styles.synChip, { backgroundColor: (Colors.syndrome[result.syndromic_signal.syndrome_category] || Colors.accent.primary) + '15' }]}>
                    <Text style={[styles.synChipText, { color: Colors.syndrome[result.syndromic_signal.syndrome_category] || Colors.accent.primary }]}>
                      {SyndromeLabels[result.syndromic_signal.syndrome_category] || result.syndromic_signal.syndrome_category}
                    </Text>
                  </View>
                </Row>
                <Row label="Severity">
                  <Text style={[styles.rowValue, { color: sevColor(result.syndromic_signal.severity) }]}>
                    {result.syndromic_signal.severity?.toUpperCase()}
                  </Text>
                </Row>
                <View style={styles.rowSection}>
                  <Text style={styles.rowLabel}>Symptoms Extracted</Text>
                  <View style={styles.chipWrap}>
                    {(result.syndromic_signal.symptoms || []).map((s, i) => (
                      <View key={i} style={styles.symptomChip}>
                        <Text style={styles.symptomChipText}>{s.replace(/_/g, ' ')}</Text>
                      </View>
                    ))}
                  </View>
                </View>
                <Row label="ICD-10">
                  <Text style={styles.monoValue}>{(result.syndromic_signal.icd10_codes || []).join(', ')}</Text>
                </Row>
                {result.syndromic_signal.reportable_conditions_flagged?.length > 0 && (
                  <View style={styles.flagCard}>
                    <Ionicons name="flag" size={13} color={Colors.severity.emergency} />
                    <Text style={styles.flagText}>REPORTABLE: {result.syndromic_signal.reportable_conditions_flagged.join(', ')}</Text>
                  </View>
                )}
                {result.syndromic_signal.cluster_indicator && (
                  <View style={[styles.flagCard, { backgroundColor: Colors.severity.watch + '12' }]}>
                    <Ionicons name="people" size={13} color={Colors.severity.watch} />
                    <Text style={[styles.flagText, { color: Colors.severity.watch }]}>CLUSTER DETECTED — Multiple cases</Text>
                  </View>
                )}
                <Row label="Confidence">
                  <Text style={styles.rowValue}>{Math.round((result.syndromic_signal.confidence_score || 0) * 100)}%</Text>
                </Row>
              </View>

              {/* Image Triage Results */}
              {imageResult && (
                <View style={styles.imageResultCard}>
                  <View style={styles.resultHeader}>
                    <Ionicons name="image" size={16} color={Colors.accent.secondary} />
                    <Text style={styles.imageResultTitle}>Image Triage — MedSigLIP</Text>
                  </View>
                  {imageResult.classifications?.slice(0, 4).map((cls, i) => (
                    <View key={i} style={styles.classificationRow}>
                      <Text style={styles.classificationLabel}>{cls.pattern.replace(/_/g, ' ')}</Text>
                      <View style={styles.scoreBarBg}>
                        <View style={[styles.scoreBarFill, {
                          width: `${Math.round(cls.score * 100)}%`,
                          backgroundColor: i === 0 ? Colors.accent.primary : Colors.text.tertiary,
                        }]} />
                      </View>
                      <Text style={styles.scoreText}>{Math.round(cls.score * 100)}%</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          {/* Save to District Button */}
          {result?.syndromic_signal && !savedToDistrict && (
            <TouchableOpacity style={styles.saveBtn} onPress={handleSaveToDistrict}>
              <Ionicons name="cloud-upload" size={18} color="#fff" />
              <Text style={styles.saveBtnText}>
                Save to {geoSelection.district_name || 'District'} Database
              </Text>
            </TouchableOpacity>
          )}

          {/* Success Banner */}
          {savedToDistrict && (
            <View style={styles.successBanner}>
              <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
              <Text style={styles.successText}>Saved to {savedToDistrict}</Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Cough Recording Modal */}
      <Modal visible={showCoughModal} transparent animationType="fade">
        <View style={styles.coughModalOverlay}>
          <View style={styles.coughModalContent}>
            <Text style={styles.coughModalTitle}>Cough Analysis — HeAR</Text>

            {coughCountdown > 0 ? (
              <View style={styles.coughCountdownContainer}>
                <Text style={styles.coughCountdownText}>{coughCountdown}</Text>
                <Text style={styles.coughCountdownLabel}>Get ready to cough...</Text>
              </View>
            ) : isAnalyzingCough ? (
              <View style={styles.coughCountdownContainer}>
                <ActivityIndicator size="large" color={Colors.accent.primary} />
                <Text style={styles.coughCountdownLabel}>Analyzing cough biomarkers...</Text>
              </View>
            ) : isCoughRecording ? (
              <View style={styles.coughCountdownContainer}>
                <Animated.View style={[styles.coughRecordDot, { transform: [{ scale: pulseAnim }] }]} />
                <Text style={styles.coughRecordingLabel}>Recording... Cough now!</Text>
                <Text style={styles.coughRecordingSub}>Auto-stops in 5 seconds</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={styles.coughCancelBtn}
              onPress={() => {
                clearInterval(coughTimer.current);
                if (isCoughRecording) {
                  coughRecorder.stop().catch(() => { });
                }
                setIsCoughRecording(false);
                setShowCoughModal(false);
              }}
            >
              <Text style={styles.coughCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Cough Analysis Loading Overlay — absoluteFill View avoids iOS Modal ghost touch layer */}
      {!!modelSwapState && (
        <View style={[StyleSheet.absoluteFill, styles.swapOverlay]}>
          <View style={styles.swapCard}>
            <ActivityIndicator size="large" color={Colors.accent.primary} />
            <Text style={styles.swapTitle}>
              {modelSwapState === 'switching_to_cough'
                ? 'Sending to HeAR cloud...'
                : 'Analyzing cough biomarkers...'}
            </Text>
            <Text style={styles.swapSubtitle}>
              {modelSwapState === 'switching_to_cough'
                ? 'Uploading your cough recording for analysis'
                : 'HeAR is processing your cough recording'}
            </Text>
            <TouchableOpacity
              style={[styles.coughCancelBtn, { marginTop: 16 }]}
              onPress={() => { setModelSwapState(null); setIsAnalyzingCough(false); }}
            >
              <Text style={styles.coughCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

function Row({ label, children }) {
  return <View style={styles.row}><Text style={styles.rowLabel}>{label}</Text>{children}</View>;
}

function SourceBadge({ source, model }) {
  const cfg = {
    'on-device': { icon: 'phone-portrait', color: Colors.success, label: 'On-Device' },
    'cloud': { icon: 'cloud', color: Colors.accent.primary, label: 'Cloud AI' },
    'demo': { icon: 'alert-circle', color: Colors.severity.watch, label: 'Demo Mode' },
  }[source] || { icon: 'help-circle', color: Colors.text.tertiary, label: 'Unknown' };

  return (
    <View style={[styles.sourceBadge, { borderColor: cfg.color + '40', backgroundColor: cfg.color + '12' }]}>
      <Ionicons name={cfg.icon} size={11} color={cfg.color} />
      <Text style={[styles.sourceBadgeText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
}

function sevColor(s) {
  return { mild: Colors.severity.low, moderate: Colors.severity.watch, severe: Colors.severity.warning, critical: Colors.severity.emergency }[s] || Colors.text.primary;
}

const EXAMPLES = [
  ['Cholera suspect', 'Patient is a 35-year-old male presenting with 3 days of profuse watery diarrhea and vomiting. Reports rice-water consistency stool. Severely dehydrated with sunken eyes and weak pulse. Three neighbors have similar symptoms this week. Uses community well water.'],
  ['Measles suspect', 'Child is a 4-year-old female with fever for 3 days, cough, runny nose, red eyes, and a rash starting on the face spreading to body. No vaccination history. Multiple children in her school absent with similar symptoms.'],
  ['Hemorrhagic fever', 'Patient is a 28-year-old healthcare worker presenting with 5 days of high fever, severe headache and muscle pain, followed by bleeding from gums and nose. Recently treated a patient who died of hemorrhagic illness. Petechial rash on extremities.'],
];

function generateDemoResult(narrative) {
  const l = narrative.toLowerCase();
  let syn = 'acute_febrile_illness', sev = 'moderate', symp = ['fever', 'headache'], icd = ['R50'], rep = [], clust = false;
  if (l.includes('diarrhea') || l.includes('watery')) { syn = 'acute_watery_diarrhea'; symp = ['watery_diarrhea', 'vomiting', 'dehydration']; icd = ['A00', 'A09']; rep = ['cholera']; sev = l.includes('severe') ? 'severe' : 'moderate'; }
  else if (l.includes('rash') && l.includes('fever')) { syn = 'acute_rash_fever'; symp = ['maculopapular_rash', 'fever', 'cough', 'conjunctivitis']; icd = ['B05']; rep = ['measles']; }
  else if (l.includes('bleeding') || l.includes('hemorrhag')) { syn = 'acute_hemorrhagic_fever'; symp = ['fever', 'unexplained_bleeding', 'petechiae']; icd = ['A98']; rep = ['hemorrhagic_fever_suspect']; sev = 'severe'; }
  if (l.includes('neighbor') || l.includes('multiple') || l.includes('school')) clust = true;
  return { encounter_id: Math.random().toString(36).substr(2, 8), timestamp: new Date().toISOString(), syndromic_signal: { symptoms: symp, syndrome_category: syn, severity: sev, age_group: 'adult', icd10_codes: icd, reportable_conditions_flagged: rep, cluster_indicator: clust, confidence_score: 0.89, _source: 'demo', _model: 'keyword-template' } };
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg.secondary },
  scroll: { paddingHorizontal: Spacing.xl, paddingBottom: 60 },

  title: { fontSize: Typography.size.lg, fontWeight: '500', color: Colors.text.primary, marginTop: 16, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: Colors.text.secondary, marginTop: 4, marginBottom: 16, lineHeight: 18 },

  sectionLabel: { fontSize: 10, color: Colors.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },

  // Modality buttons
  modalityRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  modalityBtn: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: Colors.bg.card,
    borderRadius: BorderRadius.xl,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadows.sm,
  },
  modalityBtnActive: { borderColor: Colors.severity.emergency, backgroundColor: Colors.severity.emergency + '08' },
  modalityBtnDone: { borderColor: Colors.success, backgroundColor: Colors.success + '08' },
  modalityIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.accent.ultraLight, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  modalityLabel: { fontSize: 13, fontWeight: '600', color: Colors.text.primary },
  modalityModel: { fontSize: 10, color: Colors.text.tertiary, marginTop: 1 },
  recordingBadge: { fontSize: 11, fontWeight: '700', color: Colors.severity.emergency, marginTop: 4 },
  uploadAudioLink: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'center', paddingVertical: 6, marginBottom: 4 },
  uploadAudioText: { fontSize: 12, color: Colors.accent.primaryDark },

  inputCard: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl, borderWidth: 1, borderColor: Colors.border, marginBottom: 12, ...Shadows.sm },
  textInput: { padding: 16, fontSize: 14, color: Colors.text.primary, minHeight: 140, lineHeight: 20 },

  inputFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10 },
  charCount: { fontSize: 10, color: Colors.text.tertiary },

  processingCard: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.accent.ultraLight, borderRadius: BorderRadius.md, padding: 14, marginTop: 12 },
  processingText: { color: Colors.accent.primaryDark, fontSize: 13 },

  imagePreviewCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: Colors.border, ...Shadows.sm },
  imageThumbnail: { width: 60, height: 60, borderRadius: BorderRadius.md },
  imagePreviewInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginLeft: 12 },
  imagePreviewLabel: { fontSize: 13, color: Colors.text.secondary, fontWeight: '500' },

  coughBadge: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: Colors.accent.cyan + '10', borderRadius: BorderRadius.md, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: Colors.accent.cyan + '30' },
  coughBadgeText: { flex: 1, fontSize: 13, color: Colors.accent.cyan, fontWeight: '500' },

  exLabel: { fontSize: 10, color: Colors.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  exChip: { backgroundColor: Colors.bg.card, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7, marginRight: 8, borderWidth: 1, borderColor: Colors.border },
  exChipText: { fontSize: 12, color: Colors.accent.primaryDark, fontWeight: '500' },

  submitBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.accent.primaryDark, borderRadius: BorderRadius.md, paddingVertical: 14, gap: 8, ...Shadows.md },
  submitBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  saveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#2563EB', borderRadius: BorderRadius.md, paddingVertical: 14, gap: 8, marginTop: 16, ...Shadows.md },
  saveBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  successBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: Colors.success + '12', borderRadius: BorderRadius.md, paddingVertical: 12, marginTop: 12, borderWidth: 1, borderColor: Colors.success + '30' },
  successText: { fontSize: 14, fontWeight: '600', color: Colors.success },

  resultContainer: { marginTop: 24 },
  resultHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  resultTitle: { fontSize: 15, fontWeight: '600', color: Colors.success, flex: 1 },
  sourceBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  sourceBadgeText: { fontSize: 10, fontWeight: '600' },

  resultCard: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl, padding: 16, borderWidth: 1, borderColor: Colors.border, ...Shadows.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  rowSection: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.divider },
  rowLabel: { fontSize: 11, color: Colors.text.tertiary, textTransform: 'uppercase', letterSpacing: 0.5 },
  rowValue: { fontSize: 14, fontWeight: '600', color: Colors.text.primary },
  monoValue: { fontSize: 13, fontFamily: 'monospace', color: Colors.accent.secondary },

  synChip: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 },
  synChipText: { fontSize: 12, fontWeight: '600' },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  symptomChip: { backgroundColor: Colors.accent.ultraLight, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 3 },
  symptomChipText: { fontSize: 11, color: Colors.accent.primaryDark },

  flagCard: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: Colors.severity.emergency + '10', borderRadius: 10, padding: 10, marginTop: 8 },
  flagText: { fontSize: 12, fontWeight: '700', color: Colors.severity.emergency },

  imageResultCard: { backgroundColor: Colors.bg.card, borderRadius: BorderRadius.xl, padding: 16, marginTop: 12, borderWidth: 1, borderColor: Colors.border, ...Shadows.sm },
  imageResultTitle: { fontSize: 15, fontWeight: '500', color: Colors.accent.secondary },
  classificationRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  classificationLabel: { width: 120, fontSize: 12, color: Colors.text.secondary, textTransform: 'capitalize' },
  scoreBarBg: { flex: 1, height: 6, backgroundColor: Colors.bg.elevated, borderRadius: 3, marginHorizontal: 8, overflow: 'hidden' },
  scoreBarFill: { height: '100%', borderRadius: 3 },
  scoreText: { width: 36, fontSize: 11, fontWeight: '600', color: Colors.text.primary, textAlign: 'right' },

  // Cough modal
  coughModalOverlay: { flex: 1, backgroundColor: Colors.overlay, justifyContent: 'center', alignItems: 'center' },
  coughModalContent: { backgroundColor: Colors.bg.primary, borderRadius: BorderRadius['2xl'], padding: 32, width: 280, alignItems: 'center', ...Shadows.lg },
  coughModalTitle: { fontSize: 16, fontWeight: '600', color: Colors.text.primary, marginBottom: 24 },
  coughCountdownContainer: { alignItems: 'center', marginBottom: 24 },
  coughCountdownText: { fontSize: 64, fontWeight: '700', color: Colors.accent.primary },
  coughCountdownLabel: { fontSize: 14, color: Colors.text.secondary, marginTop: 8 },
  coughRecordDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.severity.emergency },
  coughRecordingLabel: { fontSize: 16, fontWeight: '600', color: Colors.text.primary, marginTop: 16 },
  coughRecordingSub: { fontSize: 12, color: Colors.text.tertiary, marginTop: 4 },
  coughCancelBtn: { paddingVertical: 10, paddingHorizontal: 24 },
  coughCancelText: { fontSize: 14, color: Colors.text.secondary },

  // Model swap overlay
  swapOverlay: { flex: 1, backgroundColor: Colors.overlay, justifyContent: 'center', alignItems: 'center' },
  swapCard: { backgroundColor: Colors.bg.primary, borderRadius: BorderRadius['2xl'], padding: 36, width: 300, alignItems: 'center', ...Shadows.lg },
  swapTitle: { fontSize: 16, fontWeight: '600', color: Colors.text.primary, marginTop: 20, textAlign: 'center' },
  swapSubtitle: { fontSize: 13, color: Colors.text.secondary, marginTop: 8, textAlign: 'center', lineHeight: 18 },
});
