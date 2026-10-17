/**
 * EpiCast RunPod Serverless Client
 *
 * Handles the RunPod async job pattern:
 *   1. POST /runsync  — tries synchronous (up to 90s)
 *   2. If IN_QUEUE     — fall back to polling /status/{jobId}
 *   3. Poll every 5s   — with onProgress callbacks for UI
 *
 * Cold starts take 3-5 min (model loading). This client shows
 * user-friendly progress messages throughout.
 *
 * Used for cloud-only features: HeAR cough analysis, 27B reports,
 * dashboard, alerts, and as fallback for on-device inference.
 */

import NetInfo from '@react-native-community/netinfo';

const RUNPOD_ENDPOINT_ID = process.env.EXPO_PUBLIC_RUNPOD_ENDPOINT_ID || '';
const RUNPOD_API_KEY = process.env.EXPO_PUBLIC_RUNPOD_API_KEY || '';
const RUNPOD_BASE = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

const POLL_INTERVAL = 5000;     // 5 seconds between polls
const MAX_POLL_TIME = 600000;   // 10 minutes max wait

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call a RunPod route with automatic sync/async handling.
 *
 * @param {string} route        - RunPod handler route (e.g. 'extract', 'cough/analyze')
 * @param {object} data         - Input data for the route
 * @param {function} onProgress - Optional callback: (message: string) => void
 * @returns {object} The output from RunPod
 */
export async function callRunPod(route, data = {}, onProgress = null) {
  if (!RUNPOD_ENDPOINT_ID || !RUNPOD_API_KEY) {
    throw new Error('RunPod not configured. Set EXPO_PUBLIC_RUNPOD_ENDPOINT_ID and EXPO_PUBLIC_RUNPOD_API_KEY.');
  }

  // Check connectivity before attempting cloud call
  const net = await NetInfo.fetch();
  if (!net.isConnected) {
    throw new Error('No internet connection. This feature requires cloud access.');
  }

  const headers = {
    'Authorization': `Bearer ${RUNPOD_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const body = JSON.stringify({
    input: { route, data },
  });

  // ── Step 1: Try synchronous call ──────────────────────────────────────
  onProgress?.('Sending to AI...');

  let syncResult;
  try {
    const syncResponse = await fetch(`${RUNPOD_BASE}/runsync`, {
      method: 'POST',
      headers,
      body,
    });

    if (!syncResponse.ok) {
      const errText = await syncResponse.text().catch(() => '');
      throw new Error(`RunPod HTTP ${syncResponse.status}: ${errText}`);
    }

    syncResult = await syncResponse.json();
  } catch (err) {
    if (err.message.includes('Network request failed')) {
      throw new Error('Cannot reach RunPod. Check your internet connection.');
    }
    throw err;
  }

  // Completed synchronously (warm worker)
  if (syncResult.status === 'COMPLETED') {
    if (syncResult.output?.error) {
      throw new Error(syncResult.output.error);
    }
    return syncResult.output;
  }

  // Failed immediately
  if (syncResult.status === 'FAILED') {
    throw new Error(syncResult.error || 'RunPod job failed');
  }

  // ── Step 2: Job queued — poll for result ──────────────────────────────
  const jobId = syncResult.id;
  if (!jobId) {
    throw new Error('RunPod returned no job ID');
  }

  onProgress?.('AI models loading (first request takes 3-5 min)...');

  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await sleep(POLL_INTERVAL);
    pollCount++;

    // Progress messages
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed < 60) {
      onProgress?.('Loading AI models...');
    } else if (elapsed < 180) {
      onProgress?.(`Loading models (${elapsed}s)... Almost ready`);
    } else if (elapsed < 300) {
      onProgress?.(`Still loading (${elapsed}s)... Large models take time`);
    } else {
      onProgress?.(`Processing (${elapsed}s)...`);
    }

    let statusResult;
    try {
      const statusResponse = await fetch(`${RUNPOD_BASE}/status/${jobId}`, {
        headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` },
      });
      statusResult = await statusResponse.json();
    } catch {
      // Network blip — keep polling
      continue;
    }

    if (statusResult.status === 'COMPLETED') {
      if (statusResult.output?.error) {
        throw new Error(statusResult.output.error);
      }
      return statusResult.output;
    }

    if (statusResult.status === 'FAILED') {
      throw new Error(statusResult.error || 'RunPod job failed');
    }

    // IN_QUEUE or IN_PROGRESS — keep waiting
  }

  throw new Error('Request timed out after 10 minutes. Try again — the worker may still be loading.');
}

/**
 * Quick health check — tests if the RunPod worker is warm.
 * Returns model status or throws if unreachable.
 */
export async function checkHealth() {
  return callRunPod('health', {});
}

/**
 * Pre-warm the RunPod worker by sending a lightweight health check.
 * Call this on app open so the worker starts loading models in the background.
 * Runs silently — never throws.
 */
export async function warmUp() {
  try {
    await callRunPod('health', {});
  } catch {
    // Silent — this is best-effort background warming
  }
}

export default { callRunPod, checkHealth, warmUp };
