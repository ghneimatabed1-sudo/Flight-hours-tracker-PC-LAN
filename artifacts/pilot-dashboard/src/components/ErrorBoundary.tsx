import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportRuntimeError } from "@/lib/runtimeErrorReporter";

/**
 * Top-level crash net. Without this, ANY runtime exception in a child
 * component unmounts the entire React tree and the user sees a blank
 * dark-navy page (the body bg) with no clue what happened — which is
 * exactly the "blue empty screen" symptom that prompted this component.
 *
 * What we render on catch:
 *   - The error message + first lines of the stack (so we — or the
 *     operator on the phone — can identify the culprit page).
 *   - A "Reload" button that hard-reloads the app and a "Sign out"
 *     button that wipes the session before reloading (in case the
 *     crash is tied to corrupted local user state).
 *
 * Reset behavior: when the route changes (location.hash mutates), we
 * clear the error so navigating to a different page automatically
 * recovers without requiring a reload.
 */
type State = { error: Error | null };

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  private hashListener: (() => void) | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      console.error("[ErrorBoundary]", error, info);
    } catch { /* ignore */ }
    // Task #265 Part F — surface React component crashes centrally so
    // super_admin can see what broke without walking every page.
    try {
      reportRuntimeError(error, {
        source: "errorBoundary",
        componentStack: info.componentStack ?? undefined,
      });
    } catch { /* reporter must never throw */ }
  }

  componentDidMount() {
    this.hashListener = () => {
      if (this.state.error) this.setState({ error: null });
    };
    window.addEventListener("hashchange", this.hashListener);
  }

  componentWillUnmount() {
    if (this.hashListener) window.removeEventListener("hashchange", this.hashListener);
  }

  reload = () => {
    try {
      const base = window.location.href.split("#")[0];
      window.location.replace(base + "#/");
    } catch {
      window.location.reload();
    }
  };

  signOutAndReload = () => {
    try {
      localStorage.removeItem("rjaf.user");
      sessionStorage.clear();
    } catch { /* ignore */ }
    this.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const e = this.state.error;
    const stackPreview = (e.stack || "").split("\n").slice(0, 8).join("\n");
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#0a1220] text-foreground p-6 overflow-auto">
        <div className="max-w-2xl w-full rounded-xl border border-amber-500/40 bg-card shadow-2xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-amber-500/20 border border-amber-500 flex items-center justify-center">
              <span className="text-amber-400 text-xl font-bold">!</span>
            </div>
            <div>
              <div className="text-lg font-bold text-amber-300">Something went wrong on this page</div>
              <div className="text-xs text-muted-foreground">The rest of the app is fine — try reloading or going back.</div>
            </div>
          </div>
          <div className="rounded border border-border bg-secondary/40 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all max-h-64 overflow-auto">
            <div className="text-amber-300 font-semibold mb-1">{e.name}: {e.message}</div>
            <div className="text-muted-foreground">{stackPreview}</div>
          </div>
          <div className="flex items-center justify-end gap-2 flex-wrap">
            <button
              onClick={this.signOutAndReload}
              className="px-4 py-2 rounded-md bg-secondary border border-border text-sm hover:bg-secondary/80"
              data-testid="error-boundary-signout"
            >
              Sign out & reload
            </button>
            <button
              onClick={this.reload}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90"
              data-testid="error-boundary-reload"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
