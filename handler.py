"""RunPod transport adapter. Configure EPICAST_API_URL to the canonical API.

The adapter never owns model objects or fabricates modality responses.
"""
import os
import httpx

ROUTES = {
    "health": ("GET", "/health"), "encounter": ("POST", "/encounter"),
    "cough/analyze": ("POST", "/cough/analyze"), "image/triage": ("POST", "/image-triage"),
    "surveillance/scan": ("GET", "/surveillance/scan"),
    "surveillance/report": ("GET", "/surveillance/report"),
    "alerts": ("GET", "/alerts"), "dashboard": ("GET", "/dashboard"),
    "encounter/multimodal": ("POST", "/jobs/multimodal"),
}


def handler(job):
    payload = job.get("input", {})
    route = payload.get("route", "health")
    if route not in ROUTES:
        return {"error": f"Unsupported route: {route}", "available_routes": sorted(ROUTES)}
    base = os.environ.get("EPICAST_API_URL")
    if not base:
        return {"error": "EPICAST_API_URL must point to the canonical EpiCast service"}
    method, path = ROUTES[route]
    data = payload.get("data", {})
    with httpx.Client(timeout=190, follow_redirects=False) as client:
        response = client.request(method, base.rstrip("/") + path,
                                  **({"params": data} if method == "GET" else {"json": data}))
        response.raise_for_status()
        return response.json()


if __name__ == "__main__":
    import runpod
    runpod.serverless.start({"handler": handler})
