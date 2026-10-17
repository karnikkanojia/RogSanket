"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { api, type Alert } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shell } from "@/components/shell";

const levelVariant = (level: string) => level === "emergency" ? "destructive" as const : level === "warning" ? "default" as const : "secondary" as const;

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState("");
  const load = () => { setError(""); api.alerts().then((result) => setAlerts(result.alerts)).catch((e: Error) => setError(e.message)); };
  useEffect(load, []);
  return <Shell><div className="mb-8 flex items-end justify-between gap-4"><div><p className="mb-2 text-sm font-medium text-primary">Signal review</p><h1 className="text-3xl font-semibold tracking-tight">Active alerts</h1><p className="mt-2 text-muted-foreground">Review anomalies detected by the surveillance agent.</p></div><Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4" />Refresh</Button></div>
    {error && <Card className="mb-6 border-destructive/40 bg-destructive/5"><CardContent className="p-4 text-sm text-destructive">Unable to load alerts: {error}</CardContent></Card>}
    <div className="space-y-4">{alerts.length ? alerts.map((alert) => <Card key={alert.alert_id}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-4"><div className="mt-1 rounded-lg bg-amber-50 p-2 text-amber-600"><AlertTriangle className="h-5 w-5" /></div><div><div className="mb-1 flex flex-wrap items-center gap-2"><h2 className="font-semibold">{alert.syndrome?.replaceAll("_", " ") || "Syndromic anomaly"}</h2><Badge variant={levelVariant(alert.alert_level)}>{alert.alert_level}</Badge></div><p className="text-sm text-muted-foreground">{alert.description || `Anomaly detected in ${alert.district || "an operating district"}.`}</p></div></div><div className="text-left text-sm sm:text-right"><p className="font-medium">{alert.district || "Unknown district"}</p><p className="text-muted-foreground">{alert.observed_count ?? "—"} observed cases</p></div></CardContent></Card>) : <Card><CardContent className="p-10 text-center text-sm text-muted-foreground">No active alerts returned by the surveillance API.</CardContent></Card>}</div>
  </Shell>;
}
