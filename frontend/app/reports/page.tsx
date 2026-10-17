"use client";

import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shell } from "@/components/shell";

export default function ReportsPage() {
  const [district, setDistrict] = useState("");
  const [report, setReport] = useState<{ district: string; report_time: string; report: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function generate() { setLoading(true); setError(""); setReport(null); try { setReport(await api.report(district)); } catch (e) { setError(e instanceof Error ? e.message : "Report generation failed."); } finally { setLoading(false); } }
  return <Shell><div className="mb-8"><p className="mb-2 text-sm font-medium text-primary">Decision support</p><h1 className="text-3xl font-semibold tracking-tight">Situation reports</h1><p className="mt-2 text-muted-foreground">Generate an agent-written report for a selected district.</p></div><Card className="mb-6 max-w-3xl"><CardHeader><CardTitle>Choose a district</CardTitle></CardHeader><CardContent><div className="flex flex-col gap-3 sm:flex-row"><input value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="Enter district name" className="h-10 flex-1 rounded-md border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" /><Button onClick={generate} disabled={!district.trim() || loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}{loading ? "Generating…" : "Generate report"}</Button></div>{error && <p className="mt-4 text-sm text-destructive">Unable to generate report: {error}</p>}</CardContent></Card>{report && <Card className="max-w-4xl"><CardHeader><CardTitle>{report.district} situation report</CardTitle><p className="text-sm text-muted-foreground">{new Date(report.report_time).toLocaleString()}</p></CardHeader><CardContent><div className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{report.report}</div></CardContent></Card>}</Shell>;
}
