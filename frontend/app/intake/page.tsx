"use client";

import { FormEvent, useRef, useState } from "react";
import { CheckCircle2, Send } from "lucide-react";
import { api, submitMultimodal, transcribeRecording } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Shell } from "@/components/shell";

export default function IntakePage() {
  const [form, setForm] = useState({ narrative: "", district: "", facility_name: "" });
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [image, setImage] = useState<File>();
  const [cough, setCough] = useState<File>();
  const [transcribing, setTranscribing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  async function transcribe(file?: File) {
    if (!file) return;
    setTranscribing(true); setStatus(null);
    try {
      const result = await transcribeRecording(file);
      setForm(previous => ({ ...previous, narrative: result.transcription }));
      setStatus({ kind: "success", message: "Transcript ready. Review and correct the narrative before submitting." });
    } catch (error) { setStatus({ kind: "error", message: error instanceof Error ? error.message : "Transcription failed." }); }
    finally { setTranscribing(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setSaving(true); setStatus(null);
    try { controller.current = new AbortController(); const result = image || cough ? (await submitMultimodal(form, image, cough, controller.current.signal)).encounter : await api.encounter(form); setStatus({ kind: "success", message: `Encounter ${result.encounter_id} submitted successfully.` }); setForm({ narrative: "", district: form.district, facility_name: form.facility_name }); }
    catch (error) { setStatus({ kind: "error", message: error instanceof Error ? error.message : "Encounter submission failed." }); }
    finally { setSaving(false); }
  }
  return <Shell><div className="mb-8"><p className="mb-2 text-sm font-medium text-primary">Frontline intake</p><h1 className="text-3xl font-semibold tracking-tight">Record an encounter</h1><p className="mt-2 text-muted-foreground">Capture and review a narrative. Optional image and cough recordings require verified local models.</p></div>
    <Card className="max-w-3xl"><CardHeader><CardTitle>Clinical encounter</CardTitle><CardDescription>Only include information appropriate for your configured surveillance workflow.</CardDescription></CardHeader><CardContent><form onSubmit={submit} className="space-y-5"><div className="grid gap-5 sm:grid-cols-2"><label className="space-y-2 text-sm font-medium">District<input required value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} placeholder="e.g. Central district" className="mt-2 flex h-10 w-full rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring" /></label><label className="space-y-2 text-sm font-medium">Facility name<input required value={form.facility_name} onChange={(e) => setForm({ ...form, facility_name: e.target.value })} placeholder="e.g. Riverside clinic" className="mt-2 flex h-10 w-full rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring" /></label></div><label className="block text-sm font-medium">Dictation recording<input type="file" accept="audio/*" disabled={saving || transcribing} onChange={e => void transcribe(e.target.files?.[0])} className="mt-2 block" /></label>
    {transcribing && <p role="status" className="text-sm">Transcribing…</p>}
    <label className="block text-sm font-medium">Clinical image<input type="file" accept="image/*" disabled={saving} onChange={e => setImage(e.target.files?.[0])} className="mt-2 block" /></label>
    <label className="block text-sm font-medium">Cough recording (up to two seconds)<input type="file" accept="audio/*" disabled={saving} onChange={e => setCough(e.target.files?.[0])} className="mt-2 block" /></label>
    <label className="block space-y-2 text-sm font-medium">Clinical narrative<textarea required minLength={10} value={form.narrative} onChange={(e) => setForm({ ...form, narrative: e.target.value })} placeholder="Describe symptoms, onset, relevant exposure history, and examination findings…" className="mt-2 min-h-40 w-full resize-y rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring" /></label>{status && <div className={`flex items-center gap-2 rounded-md border p-3 text-sm ${status.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>{status.kind === "success" && <CheckCircle2 className="h-4 w-4" />}{status.message}</div>}<Button type="submit" disabled={saving || transcribing}>{saving ? "Submitting…" : "Submit encounter"}<Send className="h-4 w-4" /></Button>{saving && (image || cough) && <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>Cancel</Button>}</form></CardContent></Card>
  </Shell>;
}
