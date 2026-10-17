import requests
import json

PROJECT_ID = "elite-conquest-487716-d3"
ENDPOINT_ID = "mg-endpoint-ffb6adb6-446a-4493-b405-06e35767017d"
LOCATION = "us-central1"

# Get access token
import subprocess
token = subprocess.check_output(["gcloud", "auth", "print-access-token"]).decode().strip()

# Vertex AI endpoint URL
url = f"https://{LOCATION}-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/endpoints/{ENDPOINT_ID}:generateContent"

headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json",
}

payload = {
    "contents": [
        {"role": "user", "parts": [{"text": "Generate a short test response. Say hello."}]}
    ]
}

response = requests.post(url, headers=headers, json=payload)
print(response.status_code)
print(response.text[:500])