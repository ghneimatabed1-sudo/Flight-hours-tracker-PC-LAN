import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { AlertCircle, Home } from "lucide-react";
import { Card } from "@/components/Layout";

export default function NotFound() {
  const [loc] = useLocation();
  useEffect(() => {
    // Log the bad URL so an operator (or a test harness) can prove a
    // sidebar link is broken instead of getting a silent redirect home.
    // eslint-disable-next-line no-console
    console.warn("[NotFound] No route matched:", loc);
  }, [loc]);
  return (
    <div className="min-h-[50vh] w-full flex items-center justify-center">
      <Card className="max-w-md w-full mx-4 text-center">
        <div className="flex items-center justify-center gap-2 mb-3">
          <AlertCircle className="h-6 w-6 text-rose-400" />
          <h1 className="text-xl font-semibold">Page not found</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          No route matched <code className="px-1.5 py-0.5 rounded bg-muted/40 font-mono text-xs">{loc}</code>.
          The page may have been removed or your sidebar shortcut is stale.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium"
          data-testid="link-not-found-home"
        >
          <Home className="h-3.5 w-3.5" /> Back to home
        </Link>
      </Card>
    </div>
  );
}
