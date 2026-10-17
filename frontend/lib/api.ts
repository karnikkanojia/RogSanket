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
