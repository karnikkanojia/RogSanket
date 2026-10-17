/**
 * EpiCast Data Store — Single authoritative Supabase write for encounters.
 * All encounter saves go through here. Handles optional cough/image sub-records.
 * Uses expo-file-system (NOT react-native-fs).
 */

import { supabase } from './supabase';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Save a complete encounter to Supabase with optional cough/image sub-records.
 * Throws on primary encounters write failure (non-blocking sub-records catch internally).
 *
 * @param {object} params
 * @param {string} params.narrative
 * @param {object} params.extraction - syndromic signal from extractSyndrome()
 * @param {string|null} params.districtId
 * @param {object|null} params.location - { name: string }
 * @param {object|null} params.coughResult
 * @param {object|null} params.imageResult
 * @param {string|null} params.imageUri - local file:// URI for image upload
 * @param {string|null} params.coughAudioUri - local file:// URI of recorded cough WAV
 */
export async function saveEncounter({
  narrative,
  extraction,
  districtId,
  location,
  coughResult,
  imageResult,
  imageUri,
  coughAudioUri,
}) {
  const { data: user } = await supabase.auth.getUser();

  const { data, error } = await supabase.from('encounters').insert({
    narrative_text: narrative,
    syndromic_signal: extraction,
    syndrome_category: extraction?.syndrome_category,
    severity: extraction?.severity,
    confidence_score: extraction?.confidence_score,
    icd10_codes: extraction?.icd10_codes || [],
    symptoms: extraction?.symptoms || [],
    cluster_indicator: extraction?.cluster_indicator || false,
    reportable_conditions: extraction?.reportable_conditions_flagged || [],
    district_id: districtId || null,
    cough_analysis: coughResult || null,
    image_analysis: imageResult || null,
    image_url: imageUri || null,
    user_id: user?.user?.id || null,
  }).select().single();

  if (error) throw error;

  // Save cough analysis to dedicated table if present (non-blocking)
  if (coughResult && data.id) {
    // Upload WAV audio to storage if available
    let audioPath = null;
    if (coughAudioUri) {
      try {
        const base64 = await FileSystem.readAsStringAsync(
          coughAudioUri.replace('file://', ''),
          { encoding: FileSystem.EncodingType.Base64 }
        );
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const filename = `${data.id}.wav`;
        const { error: upErr } = await supabase.storage
          .from('cough-audio')
          .upload(filename, bytes.buffer, { contentType: 'audio/wav', upsert: true });
        if (!upErr) audioPath = filename;
      } catch {
        // Audio upload is best-effort
      }
    }
    supabase.from('cough_analyses').insert({
      encounter_id: data.id,
      classification: coughResult.classification || coughResult.prediction,
      confidence: coughResult.confidence,
      probabilities: coughResult.class_probabilities || null,
      audio_storage_path: audioPath,
      processed_on_device: coughResult._source === 'on-device',
    }).catch(() => { });
  }

  // Save image analysis to dedicated table + upload image to storage (non-blocking)
  if (imageResult && data.id) {
    let imagePath = null;

    if (imageUri) {
      try {
        const localPath = imageUri.replace('file://', '');
        const base64 = await FileSystem.readAsStringAsync(localPath, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const filename = `${data.id}.jpg`;
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const { error: upErr } = await supabase.storage
          .from('encounter-images')
          .upload(filename, bytes.buffer, { contentType: 'image/jpeg', upsert: true });
        if (!upErr) imagePath = filename;
      } catch {
        // Image upload is best-effort
      }
    }

    supabase.from('image_analyses').insert({
      encounter_id: data.id,
      triage_category: imageResult.classification || 'unknown',
      confidence: imageResult.confidence,
      findings: imageResult,
      image_storage_path: imagePath,
      processed_on_device: imageResult._source === 'on-device',
    }).catch(() => { });
  }

  return data;
}
