"""
WHO IDSR Syndromic Surveillance Category Definitions.

Reference: WHO Integrated Disease Surveillance and Response (IDSR) Technical Guidelines, 3rd Edition
These are the standard syndromic categories used globally for community-based surveillance.
"""

SYNDROME_CATEGORIES = {
    "acute_watery_diarrhea": {
        "name": "Acute Watery Diarrhea",
        "case_definition": "A person aged 2 years or older with 3 or more loose or watery stools within 24 hours, with or without dehydration",
        "signals": ["cholera", "rotavirus", "norovirus", "ETEC"],
        "immediate_report": True,
        "icd10": ["A00", "A09"],
    },
    "acute_bloody_diarrhea": {
        "name": "Acute Bloody Diarrhea",
        "case_definition": "A person with diarrhea and visible blood in the stool",
        "signals": ["shigellosis", "amebiasis", "EHEC"],
        "immediate_report": True,
        "icd10": ["A03", "A06"],
    },
    "acute_febrile_illness": {
        "name": "Acute Febrile Illness",
        "case_definition": "A person with acute onset of fever (≥38°C) lasting less than 2 weeks with no identified cause",
        "signals": ["malaria", "dengue", "typhoid", "chikungunya", "Zika"],
        "immediate_report": False,
        "icd10": ["B50", "A90", "A01", "A92"],
    },
    "acute_respiratory_infection": {
        "name": "Acute Respiratory Infection",
        "case_definition": "A person with sudden onset of fever and cough or sore throat, with or without shortness of breath",
        "signals": ["influenza", "COVID-19", "SARI", "pneumonia"],
        "immediate_report": False,
        "icd10": ["J06", "J18", "J09", "U07"],
    },
    "acute_neurological_syndrome": {
        "name": "Acute Neurological Syndrome",
        "case_definition": "A person with acute onset of fever and one or more of: neck stiffness, altered consciousness, new onset seizures",
        "signals": ["meningitis", "encephalitis"],
        "immediate_report": True,
        "icd10": ["G00", "G03", "A39"],
    },
    "acute_rash_fever": {
        "name": "Acute Rash with Fever",
        "case_definition": "A person with acute onset of fever and generalized maculopapular rash with one or more of: cough, coryza, conjunctivitis",
        "signals": ["measles", "rubella", "chickenpox"],
        "immediate_report": True,
        "icd10": ["B05", "B01", "B06"],
    },
    "acute_hemorrhagic_fever": {
        "name": "Acute Hemorrhagic Fever",
        "case_definition": "A person with acute onset of fever of less than 3 weeks and any 2 of: hemorrhagic or purpuric rash, epistaxis, hematemesis, hemoptysis, blood in stools, other hemorrhagic symptoms with no known predisposing factors",
        "signals": ["Ebola", "Marburg", "Lassa", "CCHF", "dengue hemorrhagic fever"],
        "immediate_report": True,
        "icd10": ["A98", "A91"],
    },
    "unexplained_cluster": {
        "name": "Unexplained Cluster of Illness",
        "case_definition": "Two or more cases of similar unexplained illness linked by time or place",
        "signals": ["unknown etiology", "novel pathogen", "poisoning"],
        "immediate_report": True,
        "icd10": ["R69"],
    },
}
