import { cn } from "@/lib/utils";

export function Badge({ className, variant = "default", ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "secondary" | "destructive" | "outline" }) {
  return <div className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", variant === "destructive" && "border-transparent bg-destructive text-white", variant === "secondary" && "border-transparent bg-secondary text-secondary-foreground", variant === "outline" && "text-foreground", variant === "default" && "border-transparent bg-primary text-primary-foreground", className)} {...props} />;
}
