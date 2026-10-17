/**
 * On-Device Cough Analysis via HeAR + ONNX Runtime
 *
 * Pipeline:
 *   1. Audio (base64 WAV) → mel spectrogram [1, 1, 192, 128]  (audioPreprocess.js)
 *   2. Mel spectrogram → HeAR embedding [1, 512]               (hear_embedding.onnx)
 *   3. Embedding → classification [healthy, symptomatic, covid] (classifier.onnx)
 *
 * Memory management:
 *   HeAR (1.4GB) and LLaMA (4GB) cannot coexist in RAM. We use a swap pattern:
 *   - Release LLaMA before loading HeAR sessions
 *   - Release HeAR after inference so LLaMA can reload lazily on next text call
 *
 * Sessions are loaded lazily on first cough analysis call, not at app startup.
 */

import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { AppState } from 'react-native';
import { audioToMelSpectrogram, MEL_SHAPE } from './audioPreprocess';
import { getHearModelUris, areHearModelsReady } from './modelManager';

let _embeddingSession = null;
let _classifierSession = null;
let _isLoading = false;
let _appStateSubscription = null;

const COUGH_CLASSES = ['healthy', 'symptomatic', 'covid_19'];

const COUGH_SYNDROME_MAP = {
  covid_19: 'acute_respiratory',
  symptomatic: 'influenza_like_illness',
  healthy: null,
};

// ── Initialization ────────────────────────────────────────────────────────────

/**
 * Initialize HeAR ONNX sessions.
 * Called lazily — only when cough analysis is requested.
 *
 * NOTE: Caller should release LLaMA first to avoid OOM.
 *
 * @param {function} onProgress - Optional: (message: string) => void
 * @returns {boolean} true if both sessions loaded successfully
 */
export async function initHearModel(onProgress) {
  if (_embeddingSession && _classifierSession) return true;
  if (_isLoading) return false;

  const modelsReady = await areHearModelsReady();
  if (!modelsReady) {
    console.warn('HeAR models not downloaded yet');
    return false;
  }

  _isLoading = true;

  try {
    const { embeddingUri, classifierUri } = getHearModelUris();

    // Load classifier first (29MB) to validate the setup before loading the big model
    onProgress?.('Loading cough classifier...');
    _classifierSession = await InferenceSession.create(classifierUri, {
      executionProviders: ['cpu'],
    });

    // Then load the large embedding model (1.2GB)
    onProgress?.('Loading HeAR embedding model...');
    _embeddingSession = await InferenceSession.create(embeddingUri, {
      executionProviders: ['cpu'],
    });

    setupAppStateListener();

    onProgress?.('HeAR ready');
    _isLoading = false;
    return true;
  } catch (error) {
    console.error('Failed to initialize HeAR models:', error);
    // Clean up whichever session was created before the crash
    await releaseHearModel();
    _isLoading = false;
    return false;
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

export function isHearReady() {
  return _embeddingSession !== null && _classifierSession !== null;
}

// ── Inference ─────────────────────────────────────────────────────────────────

/**
 * Analyze cough audio on-device using HeAR.
 *
 * @param {string} audioBase64 - Base64-encoded WAV audio
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
export async function analyzeCoughOnDevice(audioBase64) {
  if (!_embeddingSession || !_classifierSession) {
    throw new Error('HeAR models not initialized. Call initHearModel() first.');
  }

  // Step 1: Audio → mel spectrogram
  const melData = audioToMelSpectrogram(audioBase64);
  const melTensor = new Tensor('float32', melData, MEL_SHAPE);

  // Step 2: Mel spectrogram → HeAR embedding [1, 512]
  const embeddingResult = await _embeddingSession.run({ input: melTensor });

  // Output name may vary — grab whatever key is returned
  const embeddingKey = Object.keys(embeddingResult)[0];
  const embeddingOutput = embeddingResult[embeddingKey];

  if (!embeddingOutput) {
    return { success: false, error: 'HeAR embedding produced no output' };
  }

  // Step 3: Embedding → classification
  const classifierInput = new Tensor('float32', embeddingOutput.data, embeddingOutput.dims);
  const classResult = await _classifierSession.run({ input: classifierInput });

  const probKey = Object.keys(classResult)[0];
  const probOutput = classResult[probKey];

  if (!probOutput) {
    return { success: false, error: 'Classifier produced no output' };
  }

  // Parse probabilities
  const probs = Array.from(probOutput.data);
  const maxIdx = probs.indexOf(Math.max(...probs));
  const classification = COUGH_CLASSES[maxIdx] || 'unknown';
  const confidence = probs[maxIdx] || 0;

  const classProbabilities = {};
  COUGH_CLASSES.forEach((cls, i) => {
    classProbabilities[cls] = probs[i] || 0;
  });

  return {
    success: true,
    data: {
      classification,
      confidence,
      class_probabilities: classProbabilities,
      syndromic_relevance: COUGH_SYNDROME_MAP[classification] || null,
      model: 'HeAR-ondevice',
      source: 'HeAR-ONNX-ondevice',
      _source: 'on-device',
    },
  };
}

// ── Memory Management ─────────────────────────────────────────────────────────

/**
 * Release ONNX sessions from memory.
 */
export async function releaseHearModel() {
  try {
    if (_embeddingSession) await _embeddingSession.release();
  } catch (e) {
    console.warn('Error releasing HeAR embedding session:', e);
  }

  try {
    if (_classifierSession) await _classifierSession.release();
  } catch (e) {
    console.warn('Error releasing HeAR classifier session:', e);
  }

  _embeddingSession = null;
  _classifierSession = null;
}

function setupAppStateListener() {
  if (_appStateSubscription) return;

  _appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
    if (nextAppState === 'background') {
      releaseHearModel();
    }
  });
}
