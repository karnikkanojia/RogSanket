/**
 * EpiCast Model Manager
 *
 * Downloads and manages GGUF model files for on-device inference.
 * Uses expo-file-system for resumable downloads with progress tracking.
 *
 * Models stored in: DocumentDirectory/models/
 * Total size: ~4.6GB (one-time download: MedGemma 3.3GB + HeAR 1.2GB)
 */

import * as FileSystem from 'expo-file-system/legacy';

const MODEL_DIR = FileSystem.documentDirectory + 'models/';

const MODELS = {
  text: {
    filename: 'medgemma-4b-epicast-Q4_K_M.gguf',
    url: 'https://huggingface.co/Janeodum/epicast-medgemma-4b-gguf/resolve/main/medgemma-4b-epicast-Q4_K_M.gguf',
    expectedSize: 2490000000,
    label: 'MedGemma 4B (text)',
    group: 'llama',
  },
  vision: {
    filename: 'mmproj-medgemma-4b-it-F16.gguf',
    url: 'https://huggingface.co/kelkalot/medgemma-4b-it-GGUF/resolve/main/mmproj-medgemma-4b-it-F16.gguf',
    expectedSize: 851000000,
    label: 'MedGemma Vision',
    group: 'llama',
  },
  hearEmbedding: {
    filename: 'hear_embedding.onnx',
    url: 'https://huggingface.co/Janeodum/epicast-hear-mobile/resolve/main/hear_embedding.onnx',
    expectedSize: 1200000000,
    label: 'HeAR Embedding',
    group: 'onnx',
  },
  hearClassifier: {
    filename: 'classifier.onnx',
    url: 'https://huggingface.co/Janeodum/epicast-hear-mobile/resolve/main/classifier.onnx',
    expectedSize: 28700000,
    label: 'HeAR Classifier',
    group: 'onnx',
  },
};

const LLAMA_SIZE = MODELS.text.expectedSize + MODELS.vision.expectedSize;
const HEAR_SIZE = MODELS.hearEmbedding.expectedSize + MODELS.hearClassifier.expectedSize;
const TOTAL_SIZE = LLAMA_SIZE + HEAR_SIZE;

/**
 * Check if a single model file is downloaded and valid.
 */
async function isModelDownloaded(modelKey) {
  const model = MODELS[modelKey];
  if (!model) return false;

  const path = MODEL_DIR + model.filename;
  try {
    const info = await FileSystem.getInfoAsync(path);
    // Consider valid if file exists and is at least 90% of expected size
    // (exact size may vary slightly between builds)
    return info.exists && info.size > model.expectedSize * 0.9;
  } catch {
    return false;
  }
}

/**
 * Check if all required models are downloaded.
 */
export async function areAllModelsReady() {
  const results = await Promise.all(
    Object.keys(MODELS).map(k => isModelDownloaded(k))
  );
  return results.every(Boolean);
}

/**
 * Check if LLaMA models (text + vision) are downloaded.
 */
export async function areLlamaModelsReady() {
  const textReady = await isModelDownloaded('text');
  const visionReady = await isModelDownloaded('vision');
  return textReady && visionReady;
}

/**
 * Check if HeAR ONNX models are downloaded.
 */
export async function areHearModelsReady() {
  const embReady = await isModelDownloaded('hearEmbedding');
  const clsReady = await isModelDownloaded('hearClassifier');
  return embReady && clsReady;
}

/**
 * Get file paths for downloaded models.
 * Returns paths with file:// prefix stripped (llama.rn needs raw paths).
 */
export function getModelPaths() {
  const dir = MODEL_DIR.replace('file://', '');
  return {
    textModelPath: dir + MODELS.text.filename,
    visionModelPath: dir + MODELS.vision.filename,
    hearEmbeddingPath: dir + MODELS.hearEmbedding.filename,
    hearClassifierPath: dir + MODELS.hearClassifier.filename,
  };
}

/**
 * Get file:// URIs for ONNX models (ONNX Runtime uses URI format).
 */
export function getHearModelUris() {
  return {
    embeddingUri: MODEL_DIR + MODELS.hearEmbedding.filename,
    classifierUri: MODEL_DIR + MODELS.hearClassifier.filename,
  };
}

/**
 * Get download status info for UI.
 */
export async function getModelSizes() {
  let downloaded = 0;
  for (const model of Object.values(MODELS)) {
    const path = MODEL_DIR + model.filename;
    try {
      const info = await FileSystem.getInfoAsync(path);
      if (info.exists) downloaded += info.size;
    } catch { /* ignore */ }
  }
  return { downloaded, total: TOTAL_SIZE };
}

/**
 * Download a single model with progress callback.
 */
async function downloadModel(modelKey, onProgress) {
  const model = MODELS[modelKey];
  if (!model) throw new Error(`Unknown model: ${modelKey}`);

  // Ensure models directory exists
  const dirInfo = await FileSystem.getInfoAsync(MODEL_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(MODEL_DIR, { intermediates: true });
  }

  // Skip if already downloaded
  if (await isModelDownloaded(modelKey)) {
    onProgress?.(model.label, 100);
    return;
  }

  const destPath = MODEL_DIR + model.filename;

  // Remove partial download if exists
  try {
    const existing = await FileSystem.getInfoAsync(destPath);
    if (existing.exists) {
      await FileSystem.deleteAsync(destPath, { idempotent: true });
    }
  } catch { /* ignore */ }

  const downloadResumable = FileSystem.createDownloadResumable(
    model.url,
    destPath,
    {},
    (downloadProgress) => {
      const percent = Math.round(
        (downloadProgress.totalBytesWritten / downloadProgress.totalBytesExpectedToWrite) * 100
      );
      onProgress?.(model.label, percent);
    }
  );

  onProgress?.(model.label, 0);

  const result = await downloadResumable.downloadAsync();
  if (!result) {
    throw new Error(`Download failed for ${model.label}`);
  }

  onProgress?.(model.label, 100);
}

/**
 * Download all models sequentially with overall progress.
 *
 * @param {function} onProgress - (message: string, percent: number) => void
 */
export async function ensureModelsDownloaded(onProgress) {
  // Check disk space
  try {
    const freeSpace = await FileSystem.getFreeDiskStorageAsync();
    if (freeSpace < TOTAL_SIZE * 1.2) { // Need 20% extra headroom
      throw new Error(
        `Not enough storage. Need ~${Math.round(TOTAL_SIZE / 1e9)}GB free, ` +
        `but only ${Math.round(freeSpace / 1e9)}GB available.`
      );
    }
  } catch (e) {
    if (e.message.includes('Not enough storage')) throw e;
    // getFreeDiskStorageAsync may not be available — proceed anyway
  }

  // Download sequentially to avoid memory pressure
  const downloadOrder = ['text', 'vision', 'hearEmbedding', 'hearClassifier'];
  let completedBytes = 0;

  for (const key of downloadOrder) {
    const model = MODELS[key];
    await downloadModel(key, (label, percent) => {
      const modelProgress = (percent / 100) * model.expectedSize;
      const overallPercent = Math.round(((completedBytes + modelProgress) / TOTAL_SIZE) * 100);
      onProgress?.(`Downloading ${label}...`, overallPercent);
    });
    completedBytes += model.expectedSize;
  }

  onProgress?.('Models ready', 100);
}

/**
 * Delete all downloaded models (free storage).
 */
export async function deleteModels() {
  try {
    await FileSystem.deleteAsync(MODEL_DIR, { idempotent: true });
  } catch { /* ignore */ }
}
