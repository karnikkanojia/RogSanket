/**
 * EpiCast 3-Tier Cache Manager
 *
 * Tier 1: In-memory LRU (per-session, instant)
 * Tier 2: AsyncStorage (per-device, persistent 24h TTL)
 * Tier 3: Supabase encounters table (cross-device, 7-day TTL)
 *
 * Cached: extract, cough/analyze, image/triage results
 * NOT cached: health, dashboard, alerts, surveillance/report (always fresh)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// ── Tier 1: In-Memory LRU ─────────────────────────────────────────────────

const MAX_MEMORY = 50;
const memoryCache = new Map();

function memGet(key) {
  if (!memoryCache.has(key)) return null;
  const entry = memoryCache.get(key);
  // Move to end (most recently used)
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.value;
}

function memSet(key, value) {
  if (memoryCache.size >= MAX_MEMORY) {
    // Evict oldest (first entry)
    const oldest = memoryCache.keys().next().value;
    memoryCache.delete(oldest);
  }
  memoryCache.set(key, { value, ts: Date.now() });
}

// ── Tier 2: AsyncStorage ──────────────────────────────────────────────────

const STORAGE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_STORAGE_ENTRIES = 200;
const STORAGE_PREFIX = 'epicast:';

async function storageGet(key) {
  try {
    const raw = await AsyncStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > STORAGE_TTL) {
      AsyncStorage.removeItem(`${STORAGE_PREFIX}${key}`).catch(() => {});
      return null;
    }
    return entry.value;
  } catch {
    return null;
  }
}

async function storageSet(key, value) {
  try {
    await AsyncStorage.setItem(
      `${STORAGE_PREFIX}${key}`,
      JSON.stringify({ value, ts: Date.now() }),
    );
    // Lazy eviction — run occasionally
    if (Math.random() < 0.05) storagePrune().catch(() => {});
  } catch {}
}

async function storagePrune() {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const epicastKeys = allKeys.filter(k => k.startsWith(STORAGE_PREFIX));
    if (epicastKeys.length <= MAX_STORAGE_ENTRIES) return;

    // Read all, sort by timestamp, evict oldest
    const entries = await AsyncStorage.multiGet(epicastKeys);
    const parsed = entries
      .map(([k, v]) => {
        try { return { key: k, ts: JSON.parse(v).ts }; }
        catch { return { key: k, ts: 0 }; }
      })
      .sort((a, b) => a.ts - b.ts);

    const toRemove = parsed.slice(0, parsed.length - MAX_STORAGE_ENTRIES).map(e => e.key);
    if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
  } catch {}
}

// ── Tier 3: Supabase ──────────────────────────────────────────────────────

const SUPABASE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

async function supabaseGet(narrativeHash) {
  try {
    const cutoff = new Date(Date.now() - SUPABASE_TTL).toISOString();
    const { data } = await supabase
      .from('encounters')
      .select('syndromic_signal')
      .eq('narrative_hash', narrativeHash)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    return data?.syndromic_signal || null;
  } catch {
    return null;
  }
}

// ── Hashing ───────────────────────────────────────────────────────────────

function normalizeText(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Simple djb2-style hash. Not cryptographic, but fast and collision-resistant
 * enough for a 200-entry cache. Returns a hex string.
 */
function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get a cached result. Checks Tier 1 → 2 → 3 and promotes hits upward.
 *
 * @param {string} type  - 'extract' | 'cough' | 'image'
 * @param {string} input - raw narrative/audio hash key
 * @returns {object|null}
 */
export async function cacheGet(type, input) {
  const key = `${type}:${hashString(normalizeText(input))}`;

  // Tier 1
  const mem = memGet(key);
  if (mem) return mem;

  // Tier 2
  const stored = await storageGet(key);
  if (stored) {
    memSet(key, stored); // promote
    return stored;
  }

  // Tier 3 (only for text extractions with narrative hash)
  if (type === 'extract') {
    const remote = await supabaseGet(hashString(normalizeText(input)));
    if (remote) {
      memSet(key, remote);
      storageSet(key, remote).catch(() => {});
      return remote;
    }
  }

  return null;
}

/**
 * Store a result in all cache tiers.
 *
 * @param {string} type  - 'extract' | 'cough' | 'image'
 * @param {string} input - raw narrative/audio hash key
 * @param {object} value - result to cache
 */
export async function cacheSet(type, input, value) {
  const key = `${type}:${hashString(normalizeText(input))}`;
  memSet(key, value);
  await storageSet(key, value);
  // Tier 3 (Supabase) is written by the encounter submission flow, not here
}

/**
 * Get the hash of a narrative for Supabase storage.
 */
export function narrativeHash(text) {
  return hashString(normalizeText(text));
}

/**
 * Clear all cache tiers (useful for logout / debug).
 */
export async function cacheClear() {
  memoryCache.clear();
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const epicastKeys = allKeys.filter(k => k.startsWith(STORAGE_PREFIX));
    if (epicastKeys.length) await AsyncStorage.multiRemove(epicastKeys);
  } catch {}
}

export default { cacheGet, cacheSet, narrativeHash, cacheClear };
