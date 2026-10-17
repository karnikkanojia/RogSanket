/**
 * EpiCast Offline Queue
 *
 * Buffers encounter submissions when offline (AsyncStorage).
 * Auto-syncs to Supabase when connectivity is restored.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { saveEncounter } from './dataStore';

const QUEUE_KEY = '@epicast_offline_queue';

/**
 * Add an encounter to the offline queue and attempt immediate sync if online.
 * @param {object} encounterData - same shape as saveEncounter() params
 */
export async function queueEncounter(encounterData) {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  const queue = JSON.parse(raw || '[]');
  queue.push({
    type: 'encounter',
    data: encounterData,
    id: `enc_${Date.now()}`,
    timestamp: new Date().toISOString(),
  });
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

  const net = await NetInfo.fetch();
  if (net.isConnected) {
    syncQueue().catch(() => {});
  }
}

/**
 * Drain the offline queue, saving each item to Supabase.
 * Items that fail are kept for the next sync attempt.
 */
export async function syncQueue() {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  const queue = JSON.parse(raw || '[]');
  if (!queue.length) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;
  const remaining = [];

  for (const item of queue) {
    try {
      await saveEncounter(item.data);
      synced++;
    } catch {
      remaining.push(item);
      failed++;
    }
  }

  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  return { synced, failed, remaining: remaining.length };
}

/**
 * Return the number of encounters pending sync.
 */
export async function getQueueStatus() {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  const queue = JSON.parse(raw || '[]');
  return { pending: queue.length };
}

/**
 * Start a NetInfo listener that drains the queue whenever connectivity is restored.
 * Returns an unsubscribe function — call it on app teardown if needed.
 */
export function startAutoSync() {
  return NetInfo.addEventListener(state => {
    if (state.isConnected) {
      syncQueue().catch(() => {});
    }
  });
}
