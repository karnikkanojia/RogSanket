"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Bell, FileText, LayoutDashboard, Menu, PlusCircle, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const links = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/alerts", label: "Active alerts", icon: Bell },
  { href: "/intake", label: "Record encounter", icon: PlusCircle },
  { href: "/reports", label: "Situation reports", icon: FileText },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-muted/30">
      <aside className={cn("fixed inset-y-0 left-0 z-30 w-64 border-r bg-card p-5 transition-transform lg:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="mb-10 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="rounded-lg bg-primary p-2 text-primary-foreground"><Activity className="h-5 w-5" /></span>
            <span>Epi<span className="text-primary">Cast</span></span>
          </Link>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
        </div>
        <p className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Surveillance</p>
        <nav className="space-y-1">
          {links.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} onClick={() => setOpen(false)} className={cn("flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground", pathname === href && "bg-primary/10 text-primary")}>
              <Icon className="h-4 w-4" />{label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-5 left-5 right-5 rounded-lg border bg-muted/50 p-3 text-xs text-muted-foreground">
          <div className="mb-1 flex items-center gap-2 font-medium text-foreground"><ShieldCheck className="h-4 w-4 text-primary" />Edge-ready system</div>
          Data stays within your configured API.
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/95 px-5 backdrop-blur lg:px-8">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setOpen(true)}><Menu className="h-5 w-5" /></Button>
          <div className="hidden text-sm text-muted-foreground lg:block">Public health intelligence</div>
          <div className="ml-auto flex items-center gap-3 text-sm"><span className="hidden text-muted-foreground sm:inline">Connected workspace</span><span className="h-2 w-2 rounded-full bg-emerald-500" /></div>
        </header>
        <main className="mx-auto max-w-7xl p-5 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
