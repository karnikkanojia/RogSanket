/**
 * Audio Preprocessing for HeAR Model
 *
 * Converts raw audio (base64 WAV) → mel spectrogram [1, 1, 192, 128]
 * matching HeAR's expected input format.
 *
 * Pipeline: base64 → PCM float32 → resample to 16kHz → STFT → mel filterbank → log → normalize
 *
 * All math runs in pure JS — no native dependencies beyond what's already installed.
 */

// HeAR expects exactly this shape
const TARGET_SR = 16000;        // 16 kHz sample rate
const N_FFT = 400;              // 25ms window at 16kHz
const HOP_LENGTH = 160;         // 10ms hop at 16kHz
const N_MELS = 128;             // mel frequency bins
const N_TIME_FRAMES = 192;      // time frames (≈1.2s of audio)
const AUDIO_DURATION_S = 2.0;   // HeAR expects ~2s chunks
const TARGET_SAMPLES = TARGET_SR * AUDIO_DURATION_S; // 32000

// ── WAV Decoding ──────────────────────────────────────────────────────────────

/**
 * Decode base64 WAV to Float32 PCM samples normalized to [-1, 1].
 */
function decodeWavBase64(base64Str) {
  const binaryStr = atob(base64Str);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const view = new DataView(bytes.buffer);

  // Parse WAV header
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  // Find data chunk
  let dataOffset = 44; // Standard WAV header size
  // Some WAV files have extra chunks — search for 'data'
  for (let i = 36; i < Math.min(bytes.length - 4, 200); i++) {
    if (bytes[i] === 0x64 && bytes[i + 1] === 0x61 &&
        bytes[i + 2] === 0x74 && bytes[i + 3] === 0x61) {
      dataOffset = i + 8; // Skip 'data' + chunk size (4 bytes each)
      break;
    }
  }

  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((bytes.length - dataOffset) / (bytesPerSample * numChannels));
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const offset = dataOffset + i * bytesPerSample * numChannels;
    let sample;

    if (bitsPerSample === 16) {
      sample = view.getInt16(offset, true) / 32768.0;
    } else if (bitsPerSample === 32) {
      sample = view.getFloat32(offset, true);
    } else if (bitsPerSample === 8) {
      sample = (bytes[offset] - 128) / 128.0;
    } else {
      sample = view.getInt16(offset, true) / 32768.0;
    }

    samples[i] = sample;
  }

  return { samples, sampleRate, numChannels };
}

// ── Resampling ────────────────────────────────────────────────────────────────

/**
 * Simple linear interpolation resampler.
 */
function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;

  const ratio = fromRate / toRate;
  const outLen = Math.round(samples.length / ratio);
  const out = new Float32Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = srcIdx - lo;
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac;
  }

  return out;
}

// ── Mel Filterbank ────────────────────────────────────────────────────────────

function hzToMel(hz) {
  return 2595.0 * Math.log10(1.0 + hz / 700.0);
}

function melToHz(mel) {
  return 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);
}

/**
 * Create mel filterbank matrix [N_MELS x (N_FFT/2 + 1)].
 */
function createMelFilterbank(sr, nFft, nMels) {
  const fMin = 0;
  const fMax = sr / 2;
  const nFreqs = Math.floor(nFft / 2) + 1;

  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);

  // Equally spaced mel points
  const melPoints = new Float32Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melPoints[i] = melMin + (i / (nMels + 1)) * (melMax - melMin);
  }

  // Convert back to Hz, then to FFT bin indices
  const binFreqs = new Float32Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    const hz = melToHz(melPoints[i]);
    binFreqs[i] = Math.floor((nFft + 1) * hz / sr);
  }

  // Build filterbank
  const filterbank = [];
  for (let m = 0; m < nMels; m++) {
    const filter = new Float32Array(nFreqs);
    const fLeft = binFreqs[m];
    const fCenter = binFreqs[m + 1];
    const fRight = binFreqs[m + 2];

    for (let k = 0; k < nFreqs; k++) {
      if (k >= fLeft && k <= fCenter && fCenter > fLeft) {
        filter[k] = (k - fLeft) / (fCenter - fLeft);
      } else if (k > fCenter && k <= fRight && fRight > fCenter) {
        filter[k] = (fRight - k) / (fRight - fCenter);
      }
    }

    filterbank.push(filter);
  }

  return filterbank;
}

// ── STFT ──────────────────────────────────────────────────────────────────────

/**
 * Hann window function.
 */
function hannWindow(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

/**
 * Real FFT using Cooley-Tukey (radix-2).
 * Input length must be power of 2.
 * Returns magnitude squared for each frequency bin.
 */
function fftMagnitudeSquared(signal) {
  const n = signal.length;
  // Bit-reversal permutation
  const real = new Float32Array(n);
  const imag = new Float32Array(n);

  let bits = 0;
  let temp = n;
  while (temp > 1) { bits++; temp >>= 1; }

  for (let i = 0; i < n; i++) {
    let rev = 0;
    let num = i;
    for (let j = 0; j < bits; j++) {
      rev = (rev << 1) | (num & 1);
      num >>= 1;
    }
    real[rev] = signal[i];
  }

  // Cooley-Tukey butterfly
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const angle = -2 * Math.PI / size;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);

    for (let i = 0; i < n; i += size) {
      let curReal = 1;
      let curImag = 0;

      for (let j = 0; j < halfSize; j++) {
        const idx1 = i + j;
        const idx2 = i + j + halfSize;

        const tReal = curReal * real[idx2] - curImag * imag[idx2];
        const tImag = curReal * imag[idx2] + curImag * real[idx2];

        real[idx2] = real[idx1] - tReal;
        imag[idx2] = imag[idx1] - tImag;
        real[idx1] += tReal;
        imag[idx1] += tImag;

        const newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }

  // Magnitude squared for first N/2 + 1 bins
  const nFreqs = Math.floor(n / 2) + 1;
  const mag2 = new Float32Array(nFreqs);
  for (let i = 0; i < nFreqs; i++) {
    mag2[i] = real[i] * real[i] + imag[i] * imag[i];
  }
  return mag2;
}

/**
 * Next power of 2 >= n.
 */
function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Short-Time Fourier Transform → power spectrogram.
 * Returns array of magnitude-squared frames.
 */
function stft(samples, nFft, hopLength) {
  const window = hannWindow(nFft);
  const paddedFft = nextPow2(nFft);
  const nFreqs = Math.floor(paddedFft / 2) + 1;
  const numFrames = Math.floor((samples.length - nFft) / hopLength) + 1;

  const frames = [];
  for (let i = 0; i < numFrames; i++) {
    const start = i * hopLength;
    const windowed = new Float32Array(paddedFft); // zero-padded
    for (let j = 0; j < nFft && start + j < samples.length; j++) {
      windowed[j] = samples[start + j] * window[j];
    }
    frames.push(fftMagnitudeSquared(windowed));
  }

  return { frames, nFreqs, numFrames };
}

// ── Main Pipeline ─────────────────────────────────────────────────────────────

/**
 * Convert base64 WAV audio to mel spectrogram tensor for HeAR.
 *
 * @param {string} audioBase64 - Base64-encoded WAV audio
 * @returns {Float32Array} Flat tensor of shape [1, 1, 192, 128] (row-major)
 */
export function audioToMelSpectrogram(audioBase64) {
  // 1. Decode WAV
  const { samples: rawSamples, sampleRate } = decodeWavBase64(audioBase64);

  // 2. Resample to 16kHz
  let samples = resample(rawSamples, sampleRate, TARGET_SR);

  // 3. Trim or pad to exactly TARGET_SAMPLES (2 seconds)
  if (samples.length > TARGET_SAMPLES) {
    // Take center crop
    const start = Math.floor((samples.length - TARGET_SAMPLES) / 2);
    samples = samples.slice(start, start + TARGET_SAMPLES);
  } else if (samples.length < TARGET_SAMPLES) {
    // Zero-pad
    const padded = new Float32Array(TARGET_SAMPLES);
    padded.set(samples);
    samples = padded;
  }

  // 4. STFT → power spectrogram
  const { frames, nFreqs } = stft(samples, N_FFT, HOP_LENGTH);

  // 5. Apply mel filterbank
  const filterbank = createMelFilterbank(TARGET_SR, N_FFT, N_MELS);

  const melFrames = frames.map(frame => {
    const melBins = new Float32Array(N_MELS);
    for (let m = 0; m < N_MELS; m++) {
      let sum = 0;
      const filter = filterbank[m];
      for (let k = 0; k < Math.min(frame.length, filter.length); k++) {
        sum += frame[k] * filter[k];
      }
      melBins[m] = sum;
    }
    return melBins;
  });

  // 6. Log-mel spectrogram (with floor to avoid log(0))
  const LOG_FLOOR = 1e-10;
  for (const frame of melFrames) {
    for (let i = 0; i < frame.length; i++) {
      frame[i] = Math.log(Math.max(frame[i], LOG_FLOOR));
    }
  }

  // 7. Pad or truncate to exactly N_TIME_FRAMES
  while (melFrames.length < N_TIME_FRAMES) {
    melFrames.push(new Float32Array(N_MELS)); // zero-pad
  }

  // 8. Global normalization (zero mean, unit variance)
  let sum = 0;
  let sumSq = 0;
  const total = N_TIME_FRAMES * N_MELS;

  for (let t = 0; t < N_TIME_FRAMES; t++) {
    for (let m = 0; m < N_MELS; m++) {
      const v = melFrames[t][m];
      sum += v;
      sumSq += v * v;
    }
  }

  const mean = sum / total;
  const variance = sumSq / total - mean * mean;
  const std = Math.sqrt(Math.max(variance, 1e-8));

  // 9. Flatten to [1, 1, N_TIME_FRAMES, N_MELS] row-major
  const tensor = new Float32Array(N_TIME_FRAMES * N_MELS);
  for (let t = 0; t < N_TIME_FRAMES; t++) {
    for (let m = 0; m < N_MELS; m++) {
      tensor[t * N_MELS + m] = (melFrames[t][m] - mean) / std;
    }
  }

  return tensor;
}

/**
 * Get the expected tensor dimensions for documentation/validation.
 */
export const MEL_SHAPE = [1, 1, N_TIME_FRAMES, N_MELS]; // [1, 1, 192, 128]
