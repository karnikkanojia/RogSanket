# EpiCast Privacy Policy

**Last updated: February 24, 2026**

## Overview

EpiCast is an AI-powered syndromic surveillance research tool designed for community health workers in West Africa. This policy explains exactly what data EpiCast collects, how it is processed, where it is sent, and who has access.

**EpiCast is not a diagnostic tool.** It does not provide medical diagnoses, treatment recommendations, or clinical decisions. All health decisions must be made by qualified healthcare professionals.

## How Data Is Processed

### On-Device Processing (No Data Leaves Your Phone)

**Clinical text narratives** — When you type or dictate a patient encounter, it is processed entirely on your device using MedGemma 4B (a 2.49 GB AI model running locally). The raw narrative text is never uploaded to any server. Only the structured output (syndrome category, severity, age group) is synced if you are online.

**Clinical photos** — Photos taken for symptom triage are analyzed on your device using MedSigLIP. Photos are never uploaded, stored on any server, or shared with any third party. Photos remain in your device's local cache and can be deleted at any time.

### Cloud Processing (Data Sent to Servers)

**Cough audio recordings** — When you use the cough analysis feature, a 2-second audio clip is sent to our secure cloud server for analysis using Google Health Acoustic Representations (HeAR). The audio is processed in memory and immediately deleted after classification. Audio recordings are never stored on any server.

**Situation reports** — When you generate a situation report, only the district name is sent to our cloud server running MedGemma 27B. No patient data, narratives, or personal information is included in the request.

**Cloud server provider:** Self-hosted on RunPod (GPU cloud infrastructure). All connections use HTTPS encryption in transit.

### Data Storage

**Syndromic signals** — De-identified, structured surveillance signals are stored in an encrypted database hosted by Supabase (supabase.com). Stored data includes:
- Syndrome category (e.g., "acute watery diarrhea")
- Severity level (mild, moderate, severe, critical)
- Age group and sex
- District and facility name
- Timestamp

**Data NOT collected or stored:**
- Patient names
- Patient addresses or GPS coordinates of patients
- Phone numbers or personal identifiers
- Raw clinical narrative text
- Clinical photos
- Cough audio recordings
- Device identifiers for tracking

## Third-Party Services

EpiCast uses the following third-party services:

| Service | Purpose | Data Sent | Data Retained |
|---------|---------|-----------|---------------|
| **Supabase** | Encrypted database for syndromic signals | De-identified syndromic signals | Yes, encrypted at rest |
| **RunPod** | Cloud GPU for HeAR cough analysis and 27B report generation | Cough audio (2s clips), district names | No — processed in memory, immediately deleted |
| **Expo / React Native** | App framework | Crash logs (no health data) | Anonymous crash data only |

**No data is sold, shared with advertisers, or provided to any other third parties.**

All third-party services provide encryption in transit (HTTPS/TLS) and at rest where applicable.

## AI Model Download

EpiCast requires downloading AI models for on-device processing:
- MedGemma 4B: 2.49 GB
- Vision Encoder (MedSigLIP): 851 MB

You will be prompted with the download size and asked for permission before any download begins. Downloads are recommended over Wi-Fi.

## User Consent

On first launch, EpiCast presents a data consent screen explaining all data processing described above. You must agree before using cloud-connected features. If you decline, only on-device features (text extraction, photo triage) are available — no data is sent to any server.

## Your Rights

You may request deletion of any submitted surveillance data by contacting us. All data associated with your submissions will be removed within 30 days.

You may revoke consent for cloud processing at any time in the app's Settings screen. This disables cough analysis and report generation but preserves full on-device functionality.

## Children's Privacy

EpiCast is not intended for use by individuals under 18. We do not knowingly collect data from children.

## Medical Disclaimer

EpiCast is a research prototype built for the Google Health AI Developer Foundations Challenge 2026. It assists community health workers in structuring clinical observations into WHO IDSR surveillance categories. It does NOT diagnose, treat, or recommend any medical interventions. It is not cleared or approved by the FDA, WHO, or any regulatory body for clinical diagnostic use. Always consult a licensed healthcare provider before making any medical or clinical decisions.

## Changes to This Policy

We may update this policy from time to time. Changes will be posted to this page with an updated date.

## Contact

For privacy questions, data deletion requests, or support:
- GitHub: [github.com/Janeodum/epicast/issues](https://github.com/Janeodum/epicast/issues)
- Email: janeodum@uga.edu
