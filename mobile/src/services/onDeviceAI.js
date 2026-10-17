/**
 * EpiCast On-Device AI Service
 *
 * Wraps llama.rn (llama.cpp for React Native) to provide on-device inference
 * for syndromic extraction and image triage using MedGemma 4B Q4_K_M.
 *
 * Memory management: model is released when app goes to background,
 * re-initialized lazily on next API call.
 */

import { initLlama } from 'llama.rn';
import { AppState } from 'react-native';
import { getModelPaths, areLlamaModelsReady } from './modelManager';

let _context = null;
let _multimodalReady = false;
let _isLoading = false;
let _appStateSubscription = null;

// ── System Prompts ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are EpiCast, a clinical syndromic surveillance extraction system for West Africa.
Given a clinical encounter narrative in ANY language (English, Pidgin English, French, Hausa, Yoruba, Twi, or mixed),
extract structured epidemiological signals as JSON. Always output the same JSON schema regardless of input language.
Follow WHO IDSR syndromic surveillance categories.

Respond ONLY with valid JSON matching this schema:
{
  "symptoms": ["symptom1", "symptom2"],
  "symptom_onset_days": 0,
  "syndrome_category": "<category>",
  "secondary_syndromes": [],
  "severity": "mild|moderate|severe|critical",
  "age_group": "<group>",
  "sex": "male|female",
  "icd10_codes": ["A00"],
  "reportable_conditions_flagged": ["condition"],
  "travel_history": null,
  "contact_history": null,
  "cluster_indicator": false,
  "confidence_score": 0.85
}`;

const IMAGE_TRIAGE_PROMPT = `You are a clinical image triage system for disease surveillance in West Africa.
Analyze this clinical photograph and classify it into ONE of these categories:
["maculopapular_rash", "vesicular_rash", "petechial_rash", "jaundice", "conjunctivitis", "oral_lesions", "skin_ulcer", "edema", "normal_skin", "other"]

Respond ONLY with valid JSON:
{"classification": "<category>", "confidence": 0.0, "description": "<brief description>", "syndromic_relevance": "<syndrome or none>"}`;

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the on-device MedGemma model.
 * Takes 5-15 seconds on iPhone 13+.
 *
 * @param {function} onProgress - Optional: (message: string) => void
 * @returns {boolean} true if model loaded successfully
 */
export async function initOnDeviceModel(onProgress) {
  if (_context) return true;
  if (_isLoading) return false;

  const modelsReady = await areLlamaModelsReady();
  if (!modelsReady) {
    console.warn('Models not downloaded yet');
    return false;
  }

  _isLoading = true;

  try {
    const { textModelPath, visionModelPath } = getModelPaths();

    onProgress?.('Loading MedGemma 4B...');

    _context = await initLlama({
      model: textModelPath,
      n_ctx: 2048,
      n_gpu_layers: 99,
      n_threads: 4,
      use_mlock: true,
    });

    onProgress?.('Loading vision encoder...');

    try {
      const success = await _context.initMultimodal({
        path: visionModelPath,
        use_gpu: true,
      });
      _multimodalReady = !!success;
      if (_multimodalReady) {
        onProgress?.('Vision ready');
      } else {
        console.warn('Vision model failed to load — text-only mode');
      }
    } catch (e) {
      console.warn('Multimodal init error:', e);
      _multimodalReady = false;
    }

    // Set up AppState listener for memory management
    setupAppStateListener();

    onProgress?.('MedGemma ready');
    _isLoading = false;
    return true;
  } catch (error) {
    console.error('Failed to initialize on-device model:', error);
    _context = null;
    _isLoading = false;
    return false;
  }
}

// ── Status Checks ────────────────────────────────────────────────────────────

export function isModelReady() {
  return _context !== null;
}

export function isVisionReady() {
  return _multimodalReady;
}

export function getModelStats() {
  if (!_context) return null;
  return {
    modelLoaded: true,
    visionReady: _multimodalReady,
    engine: 'llama.rn (llama.cpp)',
    quantization: 'Q4_K_M',
    modelSize: '2.49 GB',
  };
}

// ── Inference Functions ──────────────────────────────────────────────────────

/**
 * Extract syndromic signal from narrative text — ON DEVICE.
 * Returns same JSON structure as RunPod /extract endpoint.
 *
 * @param {string} narrative - Clinical encounter text
 * @returns {{ success: boolean, data?: object, error?: string, model: string }}
 */
export async function extractSyndromeOnDevice(narrative) {
  if (!_context) throw new Error('Model not initialized. Call initOnDeviceModel() first.');

  const prompt = `<start_of_turn>user\n${SYSTEM_PROMPT}\n\nExtract syndromic surveillance signals from this clinical encounter:\n\n${narrative}<end_of_turn>\n<start_of_turn>model\n`;

  const result = await _context.completion({
    prompt,
    n_predict: 512,
    temperature: 0.1,
    top_p: 0.9,
    stop: ['<end_of_turn>', '<eos>'],
  });

  // Parse JSON from response
  const parsed = tryParseJSON(result.text);
  if (parsed) {
    return { success: true, data: parsed, model: 'MedGemma-4B-ondevice' };
  }

  // Retry with forced JSON start
  const retryResult = await _context.completion({
    prompt: prompt + '{',
    n_predict: 512,
    temperature: 0.05,
    stop: ['<end_of_turn>', '<eos>'],
  });

  const retryParsed = tryParseJSON('{' + retryResult.text);
  if (retryParsed) {
    return { success: true, data: retryParsed, model: 'MedGemma-4B-ondevice' };
  }

  return { success: false, error: 'Failed to parse extraction', raw: retryResult.text };
}

/**
 * Triage clinical image — ON DEVICE (requires vision model).
 *
 * @param {string} imagePath - Local file path to the image
 * @param {string} clinicalContext - Optional narrative context
 * @returns {{ success: boolean, data?: object, error?: string }}
 */
export async function triageImageOnDevice(imagePath, clinicalContext = '') {
  if (!_context || !_multimodalReady) {
    throw new Error('Vision model not ready');
  }

  const contextLine = clinicalContext ? `\nPatient context: ${clinicalContext}` : '';
  const prompt = `<start_of_turn>user\n${IMAGE_TRIAGE_PROMPT}${contextLine}<end_of_turn>\n<start_of_turn>model\n`;

  const result = await _context.completion({
    prompt,
    n_predict: 256,
    temperature: 0.1,
    stop: ['<end_of_turn>', '<eos>'],
    media: [imagePath],
  });

  const parsed = tryParseJSON(result.text);
  if (parsed) {
    parsed.model = 'MedGemma-4B-vision-ondevice';
    parsed.source = 'MedSigLIP-ondevice';
    return { success: true, data: parsed };
  }

  return { success: false, error: 'Failed to parse image triage', raw: result.text };
}

/**
 * Generate an epidemiological report — ON DEVICE using MedGemma 4B.
 * Streams tokens via optional onToken callback for live progress.
 *
 * @param {string} district - District or region name
 * @param {string} reportType - e.g. 'situation_report', 'weekly_summary'
 * @param {function} onToken - Optional: (token: string, fullText: string) => void
 * @returns {{ report: string, tokens_used: number, _source: string }}
 */
export async function generateReportOnDevice(district, reportType = 'situation_report') {
  if (!_context) throw new Error('Model not initialized. Call initOnDeviceModel() first.');

  const reportTypeLabel = reportType.replace(/_/g, ' ');
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `<start_of_turn>user\nYou are EpiCast, an AI epidemiological reporting system for WHO IDSR surveillance in West Africa.\n\nGenerate a concise ${reportTypeLabel} for ${district} district, dated ${today}.\n\nStructure the report with these markdown sections:\n# Situation Report: ${district}\n## Summary\n## Active Alerts\n## Syndromic Trends\n## Risk Assessment\n## Recommended Actions\n\nKeep it concise and professional.\n<end_of_turn>\n<start_of_turn>model\n`;

  const result = await _context.completion({
    prompt,
    n_predict: 800,
    temperature: 0.4,
    top_p: 0.9,
    stop: ['<end_of_turn>', '<eos>'],
  });

  return {
    report: (result.text || '').trim(),
    tokens_used: result.tokens_predicted || 0,
    _source: 'on-device',
    _model: 'MedGemma-4B-ondevice',
  };
}

/**
 * Streaming extraction — for real-time UI token feedback.
 */
export async function extractSyndromeStreaming(narrative, onToken) {
  if (!_context) throw new Error('Model not initialized');

  const prompt = `<start_of_turn>user\n${SYSTEM_PROMPT}\n\nExtract syndromic surveillance signals from this clinical encounter:\n\n${narrative}<end_of_turn>\n<start_of_turn>model\n`;

  let fullText = '';

  await _context.completion(
    {
      prompt,
      n_predict: 512,
      temperature: 0.1,
      stop: ['<end_of_turn>', '<eos>'],
    },
    (data) => {
      fullText += data.token;
      onToken?.(data.token, fullText);
    }
  );

  return fullText;
}

// ── Memory Management ────────────────────────────────────────────────────────

/**
 * Release model from memory. Call when app goes to background.
 */
export async function releaseModel() {
  if (_context) {
    try {
      if (_multimodalReady) {
        await _context.releaseMultimodal();
      }
      await _context.release();
    } catch (e) {
      console.warn('Error releasing model:', e);
    }
    _context = null;
    _multimodalReady = false;
  }
}

function setupAppStateListener() {
  if (_appStateSubscription) return;

  _appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
    // Only release on actual background — NOT 'inactive' (notification center, control center, etc.)
    if (nextAppState === 'background') {
      releaseModel();
    }
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tryParseJSON(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }

  // Extract first JSON object
  const jsonStart = trimmed.indexOf('{');
  const jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(trimmed.substring(jsonStart, jsonEnd + 1));
    } catch { /* continue */ }
  }

  return null;
}
