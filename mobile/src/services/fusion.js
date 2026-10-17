/**
 * EpiCast Multi-Modal Signal Fusion
 *
 * Pure JS math — runs entirely on-device, no network needed.
 * Combines text extraction + cough analysis + image triage signals
 * using weighted confidence averaging and agreement checking.
 */

const WEIGHTS = { text: 0.50, cough: 0.30, image: 0.20 };

const COUGH_SYNDROME_MAP = {
  cough_detected: 'acute_respiratory_infection',
  symptomatic: 'acute_respiratory_infection',
  'COVID-19': 'acute_respiratory_infection',
  healthy: null,
};

const IMAGE_SYNDROME_MAP = {
  measles_rash: 'acute_rash_fever',
  chickenpox_rash: 'acute_rash_fever',
  hemorrhagic_signs: 'acute_hemorrhagic_fever',
  cholera_dehydration: 'acute_watery_diarrhea',
  meningitis_signs: 'acute_neurological_syndrome',
  pneumonia_xray: 'acute_respiratory_infection',
  healthy_normal: null,
  normal_skin: null,
  maculopapular_rash: 'acute_rash_fever',
  vesicular_rash: 'acute_rash_fever',
  petechial_rash: 'acute_hemorrhagic_fever',
  jaundice: 'acute_jaundice_syndrome',
  conjunctivitis: 'acute_febrile_illness',
};

/**
 * Compute multi-modal fusion from available modality results.
 *
 * @param {object|null} syndromicResult - From MedGemma text extraction
 * @param {object|null} coughResult - From HeAR cough analysis
 * @param {object|null} imageResult - From MedSigLIP image triage
 * @returns {{ signals, agreement, fusedConfidence, recommendation }}
 */
export function computeFusion(syndromicResult, coughResult, imageResult) {
  const signals = [];
  let weightedSum = 0;
  let totalWeight = 0;
  let agreedSyndromes = [];

  if (syndromicResult) {
    const conf = syndromicResult.confidence_score || 0;
    signals.push({ source: 'MedGemma 4B', type: 'text', icon: 'mic', result: syndromicResult.syndrome_category, confidence: conf });
    weightedSum += conf * WEIGHTS.text;
    totalWeight += WEIGHTS.text;
    agreedSyndromes.push(syndromicResult.syndrome_category);
  }

  if (coughResult) {
    const conf = coughResult.confidence || 0;
    const cls = coughResult.classification || coughResult.prediction || '';
    const mapped = COUGH_SYNDROME_MAP[cls] || null;
    signals.push({ source: 'HeAR', type: 'cough', icon: 'ear', result: cls.replace(/_/g, ' '), confidence: conf });
    weightedSum += conf * WEIGHTS.cough;
    totalWeight += WEIGHTS.cough;
    if (mapped) agreedSyndromes.push(mapped);
  }

  if (imageResult) {
    const topCls = imageResult.classifications?.[0];
    const conf = topCls?.score || imageResult.confidence || 0;
    const pattern = imageResult.top_pattern || topCls?.pattern || imageResult.classification || 'unknown';
    const mapped = IMAGE_SYNDROME_MAP[pattern] || null;
    signals.push({ source: 'MedSigLIP', type: 'image', icon: 'camera', result: pattern.replace(/_/g, ' '), confidence: conf });
    weightedSum += conf * WEIGHTS.image;
    totalWeight += WEIGHTS.image;
    if (mapped) agreedSyndromes.push(mapped);
  }

  const fusedConfidence = totalWeight > 0 ? Math.min(weightedSum / totalWeight, 0.99) : 0;

  // Agreement check
  const unique = [...new Set(agreedSyndromes.filter(Boolean))];
  let agreement, multiplier;
  if (unique.length <= 1 && agreedSyndromes.length >= 2) {
    agreement = 'corroborated';
    multiplier = 1.15;
  } else if (unique.length === agreedSyndromes.length && unique.length > 1) {
    agreement = 'conflicting';
    multiplier = 0.75;
  } else {
    agreement = 'partial';
    multiplier = 1.0;
  }

  const finalConfidence = Math.min(fusedConfidence * multiplier, 0.99);

  const recommendations = {
    corroborated: 'All signals support the same syndromic classification. High confidence in assessment.',
    partial: 'Signals partially agree. Clinical follow-up recommended for confirmation.',
    conflicting: 'Signals disagree across modalities. Recommend clinical review and additional testing.',
  };

  return { signals, agreement, fusedConfidence: finalConfidence, recommendation: recommendations[agreement] };
}
