"use client";

import { FormEvent, useState } from "react";
import { CheckCircle2, Send } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Shell } from "@/components/shell";

export default function IntakePage() {
  const [form, setForm] = useState({ narrative: "", district: "", facility_name: "" });
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setStatus(null);
    try { const result = await api.encounter(form); setStatus({ kind: "success", message: `Encounter ${result.encounter_id} submitted successfully.` }); setForm({ narrative: "", district: form.district, facility_name: form.facility_name }); }
    catch (error) { setStatus({ kind: "error", message: error instanceof Error ? error.message : "Encounter submission failed." }); }
    finally { setSaving(false); }
  }
  return <Shell><div className="mb-8"><p className="mb-2 text-sm font-medium text-primary">Frontline intake</p><h1 className="text-3xl font-semibold tracking-tight">Record an encounter</h1><p className="mt-2 text-muted-foreground">Capture a clinical narrative for syndromic extraction and anomaly detection.</p></div>
    <Card className="max-w-3xl"><CardHeader><CardTitle>Clinical encounter</CardTitle><CardDescription>Only include information appropriate for your configured surveillance workflow.</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="space-y-5"><div className="grid gap-5 sm:grid-cols-2"><label className="space-y-2 text-sm font-medium">District<input required value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} placeholder="e.g. Central district" className="mt-2 flex h-10 w-full rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring" /></label><label className="space-y-2 text-sm font-medium">Facility name<input required value={form.facility_name} onChange={(e) => setForm({ ...form, facility_name: e.target.value })} placeholder="e.g. Riverside clinic" className="mt-2 flex h-10 w-full rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring" /></label></div><label className="block space-y-2 text-sm font-medium">Clinical narrative<textarea required minLength={10} value={form.narrative} onChange={(e) => setForm({ ...form, narrative: e.target.value })} placeholder="Describe symptoms, onset, relevant exposure history, and examination findings…" className="mt-2 min-h-40 w-full resize-y rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring" /></label>{status && <div className={`flex items-center gap-2 rounded-md border p-3 text-sm ${status.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>{status.kind === "success" && <CheckCircle2 className="h-4 w-4" />}{status.message}</div>}<Button type="submit" disabled={saving}>{saving ? "Submitting…" : "Submit encounter"}<Send className="h-4 w-4" /></Button></form></CardContent></Card>
  </Shell>;
}
