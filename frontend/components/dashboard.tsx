"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, ArrowUpRight, Clock3, MapPinned, RefreshCw, Users } from "lucide-react";
import { api, type DashboardData } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Shell } from "@/components/shell";

function Metric({ label, value, icon: Icon, tone = "text-primary" }: { label: string; value: string | number; icon: typeof Activity; tone?: string }) {
  return <Card><CardContent className="flex items-center justify-between p-5"><div><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p></div><div className={`rounded-lg bg-muted p-3 ${tone}`}><Icon className="h-5 w-5" /></div></CardContent></Card>;
}

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const load = () => { setError(""); api.dashboard().then(setData).catch((e: Error) => setError(e.message)); };
  useEffect(load, []);
  return <Shell><div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="mb-2 text-sm font-medium text-primary">EpiCast workspace</p><h1 className="text-3xl font-semibold tracking-tight">Surveillance overview</h1><p className="mt-2 text-muted-foreground">A live view of syndromic signals across your operating area.</p></div><Button variant="outline" onClick={load}><RefreshCw className="h-4 w-4" />Refresh data</Button></div>
    {error && <Card className="mb-6 border-destructive/40 bg-destructive/5"><CardContent className="flex items-center gap-3 p-4 text-sm text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" /><span>Unable to load dashboard: {error}. Check that the FastAPI server is running.</span></CardContent></Card>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Total encounters" value={data?.total_encounters ?? "—"} icon={Users} /><Metric label="Active alerts" value={data?.active_alerts.total ?? "—"} icon={AlertTriangle} tone="text-amber-600" /><Metric label="Districts reporting" value={data?.districts.length ?? "—"} icon={MapPinned} tone="text-blue-600" /><Metric label="Last updated" value={data ? new Date(data.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"} icon={Clock3} tone="text-violet-600" /></div>
    <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]"><Card><CardHeader><CardTitle>Syndrome distribution</CardTitle><CardDescription>Signals captured from reported encounters</CardDescription></CardHeader><CardContent>{data ? Object.entries(data.syndrome_distribution).length ? <div className="space-y-4">{Object.entries(data.syndrome_distribution).map(([name, count]) => <div key={name}><div className="mb-1 flex justify-between text-sm"><span className="capitalize">{name.replaceAll("_", " ")}</span><span className="font-medium">{count}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, count / Math.max(1, data.total_encounters) * 100)}%` }} /></div></div>)}</div> : <p className="text-sm text-muted-foreground">No encounters have been recorded yet.</p> : <p className="text-sm text-muted-foreground">Loading surveillance signals…</p>}</CardContent></Card>
      <Card><CardHeader><CardTitle>Alert posture</CardTitle><CardDescription>Current anomaly severity</CardDescription></CardHeader><CardContent className="space-y-4">{[["Emergency", data?.active_alerts.emergency, "bg-red-500"], ["Warning", data?.active_alerts.warning, "bg-amber-500"], ["Watch", data?.active_alerts.watch, "bg-blue-500"]].map(([label, count, color]) => <div key={String(label)} className="flex items-center justify-between rounded-lg border p-3"><div className="flex items-center gap-3"><span className={`h-2.5 w-2.5 rounded-full ${color}`} /><span className="text-sm">{label}</span></div><span className="font-semibold">{count ?? "—"}</span></div>)}<Button asChild variant="outline" className="w-full"><a href="/alerts">Review all alerts <ArrowUpRight className="h-4 w-4" /></a></Button></CardContent></Card></div>
    <Card className="mt-6"><CardHeader><CardTitle>Recent encounters</CardTitle><CardDescription>Latest records entering the surveillance pipeline</CardDescription></CardHeader><CardContent>{data?.recent_encounters?.length ? <div className="divide-y">{data.recent_encounters.map((item) => <div key={item.id} className="flex items-center justify-between py-3 text-sm"><div><p className="font-medium">{item.syndrome?.replaceAll("_", " ") || "Unclassified signal"}</p><p className="text-muted-foreground">{item.district || "District pending"}</p></div><Badge variant="outline">{new Date(item.time).toLocaleDateString()}</Badge></div>)}</div> : <p className="text-sm text-muted-foreground">No recent encounters available.</p>}</CardContent></Card>
  </Shell>;
}
