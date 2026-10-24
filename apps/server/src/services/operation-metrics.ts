export type PreparationStage =
  | "source_resolution"
  | "playlist_preparation"
  | "skip_lookup"
  | "chapter_lookup"
  | "subtitle_discovery";

export class OperationMetrics {
  private readonly stages = new Map<
    PreparationStage,
    { count: number; failures: number; totalMs: number; lastMs: number }
  >();

  public constructor(
    private readonly report?: (
      stage: PreparationStage,
      elapsedMs: number,
      failed: boolean,
    ) => void,
  ) {}

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
      const elapsedMs = Math.round(performance.now() - started);
      const stats = this.stages.get(stage) ?? {
        count: 0,
        failures: 0,
        totalMs: 0,
        lastMs: 0,
      };
      stats.count += 1;
      stats.failures += Number(failed);
      stats.totalMs += elapsedMs;
      stats.lastMs = elapsedMs;
      this.stages.set(stage, stats);
      this.report?.(stage, elapsedMs, failed);
    }
  }

  public snapshot() {
    return Object.fromEntries(
      [...this.stages].map(([stage, stats]) => [stage, { ...stats }]),
    );
  }
}
