const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Alert = {
  alert_id: string;
  alert_level: "emergency" | "warning" | "watch" | string;
  district?: string;
  syndrome?: string;
  observed_count?: number;
  baseline_mean?: number;
  deviation_score?: number;
  description?: string;
  detected_at?: string;
};

export type DashboardData = {
  timestamp: string;
  total_encounters: number;
  syndrome_distribution: Record<string, number>;
  districts: string[];
  active_alerts: { total: number; emergency: number; warning: number; watch: number };
  recent_encounters: Array<{ id: string; time: string; district?: string; syndrome?: string }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `API request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  dashboard: () => request<DashboardData>("/dashboard"),
  alerts: () => request<{ total_alerts: number; by_level: DashboardData["active_alerts"]; alerts: Alert[] }>("/alerts"),
  health: () => request<{ status: string; initialized: boolean; total_encounters: number }>("/health"),
  report: (district: string) => request<{ district: string; report_time: string; report: string; alerts: Alert[] }>(
    `/surveillance/report?district=${encodeURIComponent(district)}`,
  ),
  encounter: (payload: { narrative: string; district: string; facility_name: string }) =>
    request<{ encounter_id: string; timestamp: string; syndromic_signal: Record<string, unknown> | null; total_encounters: number }>(
      "/encounter",
      { method: "POST", body: JSON.stringify(payload) },
    ),
};

export type Job<T> = { id: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; result: T | null; error?: string };
export type SituationReport = { district: string; report_time: string; report: string; draft: boolean; provenance: { model: string; location: string }; fallback_reason?: string };

export async function waitForJob<T>(job: Job<T>, signal?: AbortSignal): Promise<T> {
  try {
    while (job.status === "queued" || job.status === "running") {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Cancelled", "AbortError")); return; }
        const abort = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 500);
        signal?.addEventListener("abort", abort, { once: true });
      });
      job = await request<Job<T>>(`/jobs/${job.id}`, { signal });
    }
    if (job.status !== "succeeded" || job.result === null) throw new Error(job.error || `Job ${job.status}`);
    return job.result;
  } catch (error) {
    if (signal?.aborted) await request(`/jobs/${job.id}`, { method: "DELETE" });
    throw error;
  }
}

export async function generateReport(district: string, signal?: AbortSignal) {
  const job = await request<Job<SituationReport>>("/jobs/report", { method: "POST", body: JSON.stringify({ district }) });
  return waitForJob(job, signal);
}

export function fileBase64(file: File): Promise<string> {
  if (file.size > 10_000_000) return Promise.reject(new Error("File exceeds 10 MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

export async function transcribeRecording(file: File) {
  return request<{ transcription: string; requires_review: boolean }>("/transcribe", {
    method: "POST", body: JSON.stringify({ audio_base64: await fileBase64(file), format: file.name.split(".").pop() }),
  });
}

export async function submitMultimodal(payload: { narrative: string; district: string; facility_name: string }, image?: File, cough?: File, signal?: AbortSignal) {
  const body = { ...payload, image_base64: image ? await fileBase64(image) : undefined, audio_base64: cough ? await fileBase64(cough) : undefined };
  const job = await request<Job<{ encounter: { encounter_id: string } }>>("/jobs/multimodal", { method: "POST", body: JSON.stringify(body) });
  return waitForJob(job, signal);
}
