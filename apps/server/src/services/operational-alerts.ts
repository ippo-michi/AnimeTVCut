import type { CutSessionStore } from "./cut-session-store.js";
import type { OperationMetrics } from "./operation-metrics.js";
export function operationalAlerts(
  sessions: ReturnType<CutSessionStore["stats"]>,
  metrics: ReturnType<OperationMetrics["snapshot"]>,
  activeBuilds: number,
  buildLimit: number,
) {
  const alerts: { code: string; message: string }[] = [];
  if (
    sessions.active >= sessions.limit * 0.9 ||
    sessions.estimatedBytes >= sessions.maxMemoryBytes * 0.9
  )
    alerts.push({
      code: "session_pressure",
      message: "Cut session capacity is at least 90% used.",
    });
  if (activeBuilds >= buildLimit)
    alerts.push({
      code: "build_pressure",
      message: "All cut preparation slots are occupied.",
    });
  if (sessions.persistenceFailures > 0)
    alerts.push({
      code: "persistence_failure",
      message:
        "Session persistence has failed since this process started. Inspect storage before restarting.",
    });
  if ((metrics.playback?.recentFailures ?? 0) > 0)
    alerts.push({
      code: "playback_failures",
      message:
        "Media requests failed within the last five minutes (up to the latest 256 samples).",
    });
  if (
    ["cut_tv", "cut_season", "cut_series"].some(
      (mode) => (metrics[mode]?.recentFailures ?? 0) > 0,
    )
  )
    alerts.push({
      code: "preparation_failures",
      message:
        "Cut preparation failed within the last five minutes (up to the latest 256 samples).",
    });
  return alerts;
}
