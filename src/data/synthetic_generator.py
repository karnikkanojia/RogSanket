"""
Synthetic Training Data Generator for Syndromic Extraction Fine-Tuning.

Generates diverse clinical encounter narratives paired with structured JSON extractions
covering all 8 WHO syndromic surveillance categories. This data will be used to LoRA
fine-tune MedGemma 4B for the novel task of epidemiological signal extraction.

Output format matches MedGemma's chat template for SFT with TRL.
"""

import json
import random
from datetime import datetime, timedelta
from typing import Any


# ============================================================================
# Clinical narrative templates — varied styles to simulate real CHW reporting
# ============================================================================

NARRATIVE_STYLES = {
    "formal_clinical": [
        "Patient is a {age_desc} {sex} presenting with {duration} history of {primary_symptoms}. "
        "On examination, {exam_findings}. {additional_context}",
        "{age_desc} {sex} presents to the facility with complaints of {primary_symptoms} "
        "for the past {duration}. {vital_signs} {additional_context}",
        "Chief complaint: {primary_symptoms}. Duration: {duration}. "
        "Patient is a {age_desc} {sex}. {exam_findings}. {additional_context}",
    ],
    "chw_informal": [
        "Saw a {age_desc} {sex} today who has been having {primary_symptoms} since {duration} ago. "
        "{additional_context} Looks {severity_desc}.",
        "This {age_desc} {sex} came in with {primary_symptoms}. Started {duration} ago. "
        "{additional_context}",
        "Patient {age_desc} {sex}, complaining of {primary_symptoms} x{duration}. "
        "{exam_findings}. {additional_context}",
    ],
    "speech_transcribed": [
        "so this patient is a {age_desc} {sex} came in with {primary_symptoms} um "
        "been going on for about {duration} and {additional_context}",
        "okay next patient {age_desc} {sex} {primary_symptoms} for {duration} "
        "{exam_findings} {additional_context}",
        "we have a {age_desc} {sex} here with {primary_symptoms} started {duration} ago "
        "uh {additional_context} {severity_desc}",
    ],
}

# ============================================================================
# Syndrome-specific clinical data pools
# ============================================================================

SYNDROME_DATA = {
    "acute_watery_diarrhea": {
        "primary_symptoms_pool": [
            "profuse watery diarrhea and vomiting",
            "multiple episodes of rice-water stool with severe vomiting",
            "watery diarrhea 8-10 times per day with nausea and vomiting",
            "sudden onset of watery stool and retching",
            "copious watery diarrhea and inability to keep fluids down",
            "three days of loose watery stools getting progressively worse",
            "diarrhea with clear watery consistency, no blood",
            "profuse diarrhea described as fishy-smelling watery stool",
        ],
        "exam_findings_pool": [
            "Signs of moderate dehydration — dry mucous membranes, reduced skin turgor, sunken eyes",
            "Severely dehydrated, lethargic, weak radial pulse",
            "Mild dehydration, alert and drinking ORS",
            "Skin turgor reduced, eyes sunken, capillary refill 3 seconds",
            "Hypotensive, tachycardic, severely dehydrated with altered consciousness",
            "Dry tongue, decreased urine output, restless and irritable",
        ],
        "additional_context_pool": [
            "Several neighbors have had similar symptoms this week.",
            "No known sick contacts. Uses community well water.",
            "Reports 3 other family members with similar illness.",
            "Recently attended a funeral feast where many attendees became ill.",
            "Lives near river, drinks untreated water.",
            "Outbreak of similar cases reported in neighboring village.",
            "No travel history. Eats at local market daily.",
            "Water supply disrupted 5 days ago due to flooding.",
        ],
        "vital_signs_pool": [
            "BP 80/50, HR 120, Temp 37.2°C",
            "BP 90/60, HR 110, Temp 36.8°C, RR 20",
            "Vitals: afebrile, tachycardic at 130, hypotensive",
        ],
        "severity_weights": {"mild": 0.2, "moderate": 0.4, "severe": 0.3, "critical": 0.1},
        "icd10": ["A00", "A09"],
        "reportable": ["cholera"],
        "symptoms_normalized": [
            "watery_diarrhea", "vomiting", "dehydration", "rice_water_stool",
            "nausea", "abdominal_cramps"
        ],
    },

    "acute_bloody_diarrhea": {
        "primary_symptoms_pool": [
            "bloody diarrhea with mucus and severe abdominal cramps",
            "passing blood and mucus in stool for 4 days with tenesmus",
            "diarrhea with visible blood, crampy abdominal pain",
            "dysentery — blood and mucus in stool, straining to pass stool",
            "frequent bloody stools with fever and abdominal pain",
            "loose stool with streaks of blood and painful defecation",
        ],
        "exam_findings_pool": [
            "Abdomen tender, especially left lower quadrant. Mild dehydration.",
            "Febrile at 38.5°C, tender abdomen, rectal exam shows blood",
            "Mild dehydration, abdominal tenderness diffuse",
            "Febrile, mildly dehydrated, abdomen soft but tender on palpation",
        ],
        "additional_context_pool": [
            "No known contacts with similar symptoms.",
            "Child attends local school where several children have been absent sick.",
            "Lives in area with poor sanitation, shared pit latrines.",
            "Two other children in the household have similar symptoms.",
            "Recent food from roadside vendor.",
        ],
        "vital_signs_pool": [
            "Temp 38.5°C, HR 100, BP 100/70",
            "Temp 38.8°C, HR 95, RR 18",
        ],
        "severity_weights": {"mild": 0.2, "moderate": 0.5, "severe": 0.25, "critical": 0.05},
        "icd10": ["A03", "A06"],
        "reportable": ["shigellosis", "amebiasis"],
        "symptoms_normalized": [
            "bloody_diarrhea", "abdominal_cramps", "tenesmus", "fever", "mucus_stool"
        ],
    },

    "acute_febrile_illness": {
        "primary_symptoms_pool": [
            "high fever with chills and rigors for 5 days, severe headache and body aches",
            "intermittent fever peaking at night with profuse sweating, joint pain",
            "continuous high fever for 3 days, headache, muscle pain, fatigue",
            "fever with rash on trunk, severe joint pain especially in hands and knees",
            "high grade fever, retro-orbital headache, myalgia and bone pain",
            "recurrent fever episodes every 48 hours with chills and sweating",
            "sudden onset fever with severe headache and photophobia",
            "fever for one week not responding to paracetamol, with abdominal discomfort",
        ],
        "exam_findings_pool": [
            "Temp 39.5°C, splenomegaly noted, conjunctival pallor",
            "Febrile 40°C, petechial rash on extremities, hepatomegaly",
            "Temp 38.8°C, positive tourniquet test, no rash",
            "High fever, relative bradycardia, coated tongue, rose spots on abdomen",
            "Febrile, maculopapular rash on trunk, cervical lymphadenopathy",
            "Temp 39°C, injected conjunctivae, generalized lymphadenopathy",
        ],
        "additional_context_pool": [
            "Lives in malaria-endemic area. No bed net use.",
            "Recent travel to coastal region where dengue is circulating.",
            "Standing water near house from recent rains. Mosquito bites noted.",
            "Several cases of fever in the village this month.",
            "Returned from mining area 10 days ago.",
            "No travel history. Neighbor diagnosed with typhoid last week.",
            "Recent flooding in district, increase in mosquito population.",
        ],
        "vital_signs_pool": [
            "Temp 39.5°C, HR 100, BP 110/70, RR 20",
            "Temp 40.1°C, HR 88 (relative bradycardia), BP 100/65",
            "Temp 38.8°C, HR 115, BP 95/60, platelets unknown",
        ],
        "severity_weights": {"mild": 0.25, "moderate": 0.4, "severe": 0.25, "critical": 0.1},
        "icd10": ["B50", "A90", "A01", "A92"],
        "reportable": ["malaria", "dengue", "typhoid", "chikungunya"],
        "symptoms_normalized": [
            "high_fever", "chills", "headache", "myalgia", "joint_pain",
            "rash", "retro_orbital_pain", "fatigue"
        ],
    },

    "acute_respiratory_infection": {
        "primary_symptoms_pool": [
            "cough productive of yellow sputum for 5 days with fever and shortness of breath",
            "dry cough, high fever, and difficulty breathing worsening over 3 days",
            "sore throat, runny nose, cough and mild fever for 2 days",
            "severe cough with chest pain, fever 39°C, unable to lie flat",
            "sudden onset fever, body aches, dry cough, and loss of taste/smell",
            "cough with blood-tinged sputum, night sweats, weight loss over 3 weeks",
            "barking cough in child with stridor and intercostal retractions",
            "progressive shortness of breath, fever, and productive cough for one week",
        ],
        "exam_findings_pool": [
            "Bilateral crackles on auscultation, SpO2 88% on room air",
            "Clear lungs, mild pharyngeal erythema, rhinorrhea",
            "Right lower lobe consolidation, bronchial breath sounds, dull to percussion",
            "Diffuse wheezing, tachypneic at 28/min, using accessory muscles",
            "SpO2 92%, bilateral wheeze, prolonged expiratory phase",
            "Stridor at rest, subcostal retractions, barking cough",
        ],
        "additional_context_pool": [
            "Works in crowded market. Several co-workers also sick.",
            "Elderly patient living in care home where respiratory illness is spreading.",
            "Child in daycare center with outbreak of cough and cold.",
            "Healthcare worker exposed to confirmed COVID patient 5 days ago.",
            "No known contacts. Lives alone.",
            "Close contact with TB patient, no history of TB treatment.",
            "Recent increase in respiratory cases reported in the district.",
        ],
        "vital_signs_pool": [
            "Temp 38.5°C, HR 100, RR 24, SpO2 94%",
            "Temp 39.2°C, HR 110, RR 30, SpO2 88%",
            "Temp 37.8°C, HR 85, RR 18, SpO2 97%",
        ],
        "severity_weights": {"mild": 0.3, "moderate": 0.35, "severe": 0.25, "critical": 0.1},
        "icd10": ["J06", "J18", "J09", "U07", "J20"],
        "reportable": ["influenza", "covid19", "pneumonia", "SARI"],
        "symptoms_normalized": [
            "cough", "fever", "dyspnea", "sore_throat", "chest_pain",
            "anosmia", "sputum_production", "rhinorrhea"
        ],
    },

    "acute_neurological_syndrome": {
        "primary_symptoms_pool": [
            "severe headache with stiff neck and high fever for 2 days",
            "child with fever, altered consciousness, and convulsions",
            "sudden onset severe headache, photophobia, neck stiffness, and vomiting",
            "confusion, high fever, and inability to flex neck for 24 hours",
            "fever with seizures and bulging fontanelle in infant",
            "progressive headache, drowsiness, and neck rigidity over 3 days",
        ],
        "exam_findings_pool": [
            "Positive Kernig and Brudzinski signs, GCS 12, temp 39.5°C",
            "Neck rigidity, photophobia, petechial rash on trunk and legs",
            "GCS 8, opisthotonus, bulging fontanelle, febrile",
            "Febrile 40°C, confused, positive meningeal signs",
            "Altered mental status, focal neurological deficit right side",
        ],
        "additional_context_pool": [
            "Lives in meningitis belt area during dry season.",
            "University student living in dormitory. Two classmates hospitalized with similar symptoms.",
            "Unvaccinated child, no known contacts.",
            "Recent outbreak of meningitis reported in neighboring district.",
            "No travel history or known exposures.",
        ],
        "vital_signs_pool": [
            "Temp 39.5°C, HR 120, BP 140/90, GCS 12",
            "Temp 40°C, HR 130, BP 90/60, GCS 8",
        ],
        "severity_weights": {"mild": 0.05, "moderate": 0.2, "severe": 0.5, "critical": 0.25},
        "icd10": ["G00", "G03", "A39"],
        "reportable": ["meningitis", "encephalitis"],
        "symptoms_normalized": [
            "neck_stiffness", "severe_headache", "altered_consciousness",
            "seizures", "photophobia", "fever", "vomiting"
        ],
    },

    "acute_rash_fever": {
        "primary_symptoms_pool": [
            "fever for 3 days followed by widespread maculopapular rash starting on face",
            "child with fever, cough, runny nose, red eyes, and rash spreading head to toe",
            "vesicular rash all over body with fever and itching",
            "fever with generalized rash, sore throat, and swollen lymph nodes",
            "high fever followed by rash appearing on trunk and spreading to extremities",
            "child with rash starting behind ears, spreading to face and body, with conjunctivitis",
        ],
        "exam_findings_pool": [
            "Maculopapular rash on face and trunk, Koplik spots on buccal mucosa, conjunctivitis",
            "Vesicular rash in different stages (macules, papules, vesicles, crusts), febrile",
            "Generalized maculopapular rash, posterior cervical lymphadenopathy",
            "Rash on trunk spreading centrifugally, febrile, pharyngitis",
            "Confluent rash on face, discrete on extremities, bilateral conjunctivitis",
        ],
        "additional_context_pool": [
            "No vaccination history for measles. Lives in area with low vaccine coverage.",
            "Multiple children in school with similar rash this week.",
            "Recently traveled from area with measles outbreak.",
            "Contact with confirmed measles case 12 days ago.",
            "Unvaccinated, lives in community with vaccine hesitancy.",
            "Adult case, unclear vaccination status.",
        ],
        "vital_signs_pool": [
            "Temp 38.8°C, HR 100, RR 20",
            "Temp 39.5°C, HR 90, RR 18",
        ],
        "severity_weights": {"mild": 0.25, "moderate": 0.4, "severe": 0.25, "critical": 0.1},
        "icd10": ["B05", "B01", "B06"],
        "reportable": ["measles", "rubella", "chickenpox"],
        "symptoms_normalized": [
            "maculopapular_rash", "fever", "cough", "conjunctivitis",
            "coryza", "vesicular_rash", "lymphadenopathy"
        ],
    },

    "acute_hemorrhagic_fever": {
        "primary_symptoms_pool": [
            "high fever for 5 days with sudden onset of bleeding from gums and nose",
            "fever, severe headache, muscle pain, followed by bleeding from multiple sites",
            "fever with petechial rash, easy bruising, and blood in vomit",
            "high fever, prostration, abdominal pain, and passage of dark bloody stool",
            "sudden onset fever, sore throat, myalgia, followed by unexplained bleeding",
            "fever for one week with progressive bleeding tendency and shock",
        ],
        "exam_findings_pool": [
            "Temp 39°C, petechiae on extremities, bleeding from venipuncture sites, hypotensive",
            "Febrile, prostrated, ecchymoses on trunk, melena, hepatomegaly",
            "Severely ill, hemorrhagic conjunctivae, gum bleeding, DIC suspected",
            "Temp 40°C, purpuric rash, hypotensive, tachycardic, altered sensorium",
        ],
        "additional_context_pool": [
            "Recently handled bushmeat (bat, monkey). Lives near forest.",
            "Healthcare worker who treated a patient who died of febrile illness.",
            "Attended funeral with body washing of deceased person with hemorrhagic illness.",
            "Lives in area where Ebola was previously reported.",
            "Mining worker in forest area, no known contacts.",
            "Recent outbreak of hemorrhagic fever declared in neighboring country.",
        ],
        "vital_signs_pool": [
            "Temp 39.5°C, HR 130, BP 70/40, RR 28",
            "Temp 40°C, HR 140, BP 60/unrecordable",
        ],
        "severity_weights": {"mild": 0.0, "moderate": 0.1, "severe": 0.5, "critical": 0.4},
        "icd10": ["A98", "A91"],
        "reportable": ["ebola", "marburg", "dengue_hemorrhagic_fever", "crimean_congo_hf"],
        "symptoms_normalized": [
            "fever", "unexplained_bleeding", "petechiae", "ecchymosis",
            "hematemesis", "melena", "prostration"
        ],
    },

    "unexplained_cluster": {
        "primary_symptoms_pool": [
            "unusual illness with vomiting, confusion, and rapid deterioration not matching known patterns",
            "sudden onset of neurological symptoms in multiple patients from same village",
            "cluster of children with acute kidney injury and rash of unknown cause",
            "multiple cases of acute liver failure in same community this week",
            "group of workers from same factory presenting with respiratory failure and skin blistering",
            "three family members with sudden onset paralysis and respiratory compromise",
        ],
        "exam_findings_pool": [
            "Presentations do not fit typical syndromic categories",
            "Mixed clinical picture, multiple organ involvement",
            "Unusual combination of symptoms not matching known disease patterns",
            "Rapid clinical deterioration, etiology unclear",
        ],
        "additional_context_pool": [
            "Five patients from the same village presented within 48 hours.",
            "All affected individuals attended the same event 3 days ago.",
            "No common food or water source identified yet.",
            "Industrial spill reported upstream from the community water source.",
            "Similar cases reported in two adjacent districts.",
        ],
        "vital_signs_pool": [
            "Vitals vary between patients",
            "Multiple presentations with hemodynamic instability",
        ],
        "severity_weights": {"mild": 0.0, "moderate": 0.15, "severe": 0.5, "critical": 0.35},
        "icd10": ["R69"],
        "reportable": ["unknown_etiology"],
        "symptoms_normalized": [
            "unexplained_illness", "multiple_similar_cases", "rapid_deterioration"
        ],
    },
}

# Demographics pools
AGE_GROUPS = {
    "neonate": ["5-day-old", "2-week-old", "newborn", "10-day-old"],
    "infant": ["3-month-old", "6-month-old", "9-month-old", "8-month-old"],
    "child": ["2-year-old", "3-year-old", "4-year-old", "18-month-old"],
    "school_age": ["7-year-old", "10-year-old", "12-year-old", "8-year-old"],
    "adolescent": ["15-year-old", "17-year-old", "16-year-old", "19-year-old"],
    "adult": [
        "25-year-old", "32-year-old", "40-year-old", "45-year-old",
        "28-year-old", "55-year-old", "35-year-old", "50-year-old",
    ],
    "elderly": ["65-year-old", "70-year-old", "78-year-old", "82-year-old", "68-year-old"],
}

SEVERITY_DESCRIPTIONS = {
    "mild": ["appears well", "mild symptoms", "ambulatory", "comfortable"],
    "moderate": ["moderately ill", "uncomfortable but alert", "needs treatment", "somewhat distressed"],
    "severe": ["severely ill", "requiring urgent care", "very unwell", "toxic-appearing"],
    "critical": ["critically ill", "near collapse", "moribund", "in shock"],
}

DISTRICTS = [
    "Kintampo North", "Tamale Metro", "Wa Municipal", "Bolgatanga",
    "Ho Municipal", "Cape Coast Metro", "Sunyani Municipal", "Kumasi Metro",
    "Kassena Nankana", "Bawku West", "Nandom", "Jirapa",
]

FACILITIES = [
    "District Health Center", "Community Clinic", "Rural Health Post",
    "Sub-District Hospital", "CHPS Compound", "Mobile Health Unit",
]


def _weighted_choice(weight_dict: dict[str, float]) -> str:
    """Pick from a dict of {option: weight}."""
    options = list(weight_dict.keys())
    weights = list(weight_dict.values())
    return random.choices(options, weights=weights, k=1)[0]


def generate_single_example(
    syndrome: str,
    include_travel: bool = False,
    include_cluster: bool = False,
) -> dict[str, Any]:
    """Generate one clinical encounter → structured extraction training example."""

    data = SYNDROME_DATA[syndrome]

    # Pick demographics
    age_group = random.choice(list(AGE_GROUPS.keys()))
    # Weight towards adult/child for most syndromes
    if syndrome not in ("acute_neurological_syndrome",):
        age_group = random.choices(
            list(AGE_GROUPS.keys()),
            weights=[0.02, 0.05, 0.1, 0.1, 0.08, 0.5, 0.15],
            k=1,
        )[0]

    age_desc = random.choice(AGE_GROUPS[age_group])
    sex = random.choice(["male", "female"])
    severity = _weighted_choice(data["severity_weights"])

    # Pick narrative components
    primary_symptoms = random.choice(data["primary_symptoms_pool"])
    exam_findings = random.choice(data["exam_findings_pool"])
    additional_context = random.choice(data["additional_context_pool"])
    vital_signs = random.choice(data.get("vital_signs_pool", ["Vitals stable"]))
    severity_desc = random.choice(SEVERITY_DESCRIPTIONS[severity])

    duration_days = random.randint(1, 14)
    duration = random.choice([
        f"{duration_days} days",
        f"{duration_days} day" if duration_days == 1 else f"{duration_days} days",
        f"about {duration_days} days",
        f"{duration_days}d",
    ])

    # Pick narrative style and fill template
    style = random.choice(list(NARRATIVE_STYLES.keys()))
    template = random.choice(NARRATIVE_STYLES[style])

    narrative = template.format(
        age_desc=age_desc,
        sex=sex,
        duration=duration,
        primary_symptoms=primary_symptoms,
        exam_findings=exam_findings,
        additional_context=additional_context,
        vital_signs=vital_signs,
        severity_desc=severity_desc,
    )

    # Determine cluster indicator from context
    cluster_keywords = ["several", "multiple", "other family", "neighbors", "outbreak", "classmates"]
    cluster = include_cluster or any(kw in additional_context.lower() for kw in cluster_keywords)

    # Pick a subset of normalized symptoms (3-6 depending on narrative)
    num_symptoms = random.randint(3, min(6, len(data["symptoms_normalized"])))
    symptoms = random.sample(data["symptoms_normalized"], num_symptoms)

    # Pick ICD10 codes (1-3)
    num_codes = random.randint(1, min(3, len(data["icd10"])))
    icd10 = random.sample(data["icd10"], num_codes)

    # Pick reportable conditions
    reportable = data["reportable"] if random.random() > 0.3 else data["reportable"][:1]

    # Travel history
    travel = None
    if include_travel:
        travel = random.choice([
            "Traveled to coastal region 1 week ago",
            "Returned from mining area 10 days ago",
            "Recent visit to neighboring country",
            "Traveled to endemic area for funeral",
        ])

    # Contact history
    contact = None
    if cluster:
        contact = random.choice([
            "Multiple household members affected",
            "Classmates with similar symptoms",
            "Neighbors reporting same illness",
            "Co-workers from same facility affected",
        ])

    # Build the structured extraction (ground truth)
    extraction = {
        "symptoms": symptoms,
        "symptom_onset_days": duration_days,
        "syndrome_category": syndrome,
        "secondary_syndromes": [],
        "severity": severity,
        "age_group": age_group,
        "sex": sex,
        "icd10_codes": icd10,
        "reportable_conditions_flagged": reportable,
        "travel_history": travel,
        "contact_history": contact,
        "cluster_indicator": cluster,
        "confidence_score": round(random.uniform(0.75, 0.98), 2),
    }

    # Build the chat-format training example
    system_prompt = (
        "You are EpiCast, a clinical syndromic surveillance extraction system. "
        "Given a clinical encounter narrative, extract structured epidemiological signals "
        "as JSON. Follow the WHO IDSR syndromic surveillance categories. "
        "Be precise and conservative in your extraction — only include information "
        "explicitly present or strongly implied in the narrative."
    )

    user_message = (
        f"Extract syndromic surveillance signals from this clinical encounter:\n\n"
        f"{narrative}"
    )

    assistant_message = json.dumps(extraction, indent=2)

    return {
        "system": system_prompt,
        "user": user_message,
        "assistant": assistant_message,
        "narrative": narrative,
        "extraction": extraction,
        "syndrome": syndrome,
    }


def generate_training_dataset(
    num_examples: int = 2000,
    output_path: str = "data/syndromic_training_data.jsonl",
) -> list[dict]:
    """Generate full training dataset balanced across syndromes."""

    examples = []
    syndromes = list(SYNDROME_DATA.keys())
    examples_per_syndrome = num_examples // len(syndromes)
    remainder = num_examples % len(syndromes)

    for i, syndrome in enumerate(syndromes):
        count = examples_per_syndrome + (1 if i < remainder else 0)
        for j in range(count):
            include_travel = random.random() > 0.7
            include_cluster = random.random() > 0.6
            example = generate_single_example(
                syndrome,
                include_travel=include_travel,
                include_cluster=include_cluster,
            )
            examples.append(example)

    random.shuffle(examples)

    # Convert to chat format for TRL SFTTrainer
    chat_examples = []
    for ex in examples:
        chat_examples.append({
            "messages": [
                {"role": "system", "content": ex["system"]},
                {"role": "user", "content": ex["user"]},
                {"role": "assistant", "content": ex["assistant"]},
            ]
        })

    # Save
    import os
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        for item in chat_examples:
            f.write(json.dumps(item) + "\n")

    print(f"Generated {len(chat_examples)} training examples → {output_path}")

    # Print distribution
    from collections import Counter
    dist = Counter(ex["syndrome"] for ex in examples)
    print("\nSyndrome distribution:")
    for syn, count in sorted(dist.items()):
        print(f"  {syn}: {count}")

    return chat_examples


if __name__ == "__main__":
    generate_training_dataset(num_examples=2000)
