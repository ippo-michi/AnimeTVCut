export type PreparationStage =
  | "source_resolution"
  | "playlist_preparation"
  | "skip_lookup"
  | "chapter_lookup"
  | "subtitle_discovery"
  | "cut_tv"
  | "cut_season"
  | "cut_series"
  | "playback";
interface StageStats {
  count: number;
  failures: number;
  totalMs: number;
  lastMs: number;
  samples: { elapsedMs: number; failed: boolean; at: number }[];
}
export class OperationMetrics {
  private readonly stages = new Map<PreparationStage, StageStats>();
  public constructor(
    private readonly report?: (
      stage: PreparationStage,
      elapsedMs: number,
      failed: boolean,
    ) => void,
  ) {}
  public record(
    stage: PreparationStage,
    elapsedMs: number,
    failed: boolean,
  ): void {
    const stats = this.stages.get(stage) ?? {
      count: 0,
      failures: 0,
      totalMs: 0,
      lastMs: 0,
      samples: [],
    };
    stats.count += 1;
    stats.failures += Number(failed);
    stats.totalMs += elapsedMs;
    stats.lastMs = elapsedMs;
    stats.samples.push({ elapsedMs, failed, at: Date.now() });
    if (stats.samples.length > 256) stats.samples.shift();
    this.stages.set(stage, stats);
    this.report?.(stage, elapsedMs, failed);
  }
  public async measure<T>(
    stage: PreparationStage,
    work: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    let failed = true;
    try {
      const value = await work();
      failed = false;
      return value;
    } finally {
      this.record(stage, Math.round(performance.now() - started), failed);
    }
  }
  public snapshot() {
    return Object.fromEntries(
      [...this.stages].map(([stage, stats]) => {
        const values = stats.samples
          .map((sample) => sample.elapsedMs)
          .sort((a, b) => a - b);
        const percentile = (p: number) =>
          values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
        return [
          stage,
          {
            count: stats.count,
            failures: stats.failures,
            totalMs: stats.totalMs,
            lastMs: stats.lastMs,
            sampleCount: values.length,
            p50Ms: percentile(0.5),
            p95Ms: percentile(0.95),
            p99Ms: percentile(0.99),
            recentFailures: stats.samples.filter(
              (sample) => sample.failed && sample.at > Date.now() - 300_000,
            ).length,
          },
        ];
      }),
    );
  }
}
