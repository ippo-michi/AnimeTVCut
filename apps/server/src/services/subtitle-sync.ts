import type { SubtitleEvent } from "@animetvcut/subtitles";

/** Estimate one episode's offset from caption activity, not subtitle text. */
export function estimateSubtitleOffset(
  reference: readonly SubtitleEvent[],
  target: readonly SubtitleEvent[],
): number | undefined {
  const usable = (events: readonly SubtitleEvent[]) =>
    events.filter(
      (e) =>
        Number.isFinite(e.start) &&
        Number.isFinite(e.end) &&
        e.start >= 0 &&
        e.end > e.start &&
        e.end - e.start <= 12 &&
        e.start < 3600,
    );
  const ref = usable(reference),
    sub = usable(target);
  if (
    ref.length < 12 ||
    sub.length < 12 ||
    ref.length > 5000 ||
    sub.length > 5000
  )
    return undefined;
  const step = 0.25;
  const duration = Math.min(
    3600,
    [...ref, ...sub].reduce((max, event) => Math.max(max, event.end), 0) + 1,
  );
  const length = Math.ceil(duration / step);
  const make = (events: readonly SubtitleEvent[]) => {
    const bins = new Uint8Array(length);
    for (const event of events)
      bins.fill(
        1,
        Math.max(0, Math.floor(event.start / step)),
        Math.min(length, Math.ceil(event.end / step)),
      );
    return bins;
  };
  const a = make(ref),
    b = make(sub);
  const countA = a.reduce((n, v) => n + v, 0),
    countB = b.reduce((n, v) => n + v, 0);
  if (countA < 80 || countB < 80) return undefined;
  const scores: { shift: number; score: number }[] = [];
  for (let shift = -360; shift <= 360; shift++) {
    let overlap = 0;
    const start = Math.max(0, -shift),
      end = Math.min(length, length - shift);
    for (let i = start; i < end; i++) overlap += b[i]! & a[i + shift]!;
    scores.push({ shift, score: (2 * overlap) / (countA + countB) });
  }
  scores.sort(
    (x, y) => y.score - x.score || Math.abs(x.shift) - Math.abs(y.shift),
  );
  const best = scores[0]!;
  const other = scores.find(
    (candidate) => Math.abs(candidate.shift - best.shift) >= 8,
  );
  if (best.score < 0.35 || (other && best.score - other.score < 0.04))
    return undefined;
  return best.shift * step;
}
