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

export interface SubtitleTimingSample {
  events: readonly SubtitleEvent[];
  window: { start: number; end: number };
}

/** Compare subtitle activity in one or two separated source-timeline windows. */
export function estimateSubtitleSamplesOffset(
  samples: readonly SubtitleTimingSample[],
  target: readonly SubtitleEvent[],
  expectedOffset?: number,
): number | undefined {
  if (samples.length < 1 || samples.length > 2) return undefined;
  const step = 0.25;
  const valid = (e: SubtitleEvent) =>
    Number.isFinite(e.start) &&
    Number.isFinite(e.end) &&
    e.end > e.start &&
    e.end - e.start <= 12;
  const windows = samples.map(({ events, window }) => {
    const length = Math.ceil((window.end - window.start) / step);
    if (
      !Number.isFinite(window.start) ||
      !Number.isFinite(window.end) ||
      window.start < 0 ||
      length < 120 ||
      length > 480
    )
      return undefined;
    const reference = events.filter(
      (e) => valid(e) && e.start < window.end && e.end > window.start,
    );
    const candidates = target.filter(
      (e) => valid(e) && e.start < window.end + 90 && e.end > window.start - 90,
    );
    if (
      reference.length < 8 ||
      reference.length > 200 ||
      candidates.length < 8 ||
      candidates.length > 1000
    )
      return undefined;
    const fill = (items: readonly SubtitleEvent[], shift: number) => {
      const bins = new Uint8Array(length);
      for (const event of items) {
        const left = Math.max(
          0,
          Math.floor((event.start + shift - window.start) / step),
        );
        const right = Math.min(
          length,
          Math.ceil((event.end + shift - window.start) / step),
        );
        if (right > left) bins.fill(1, left, right);
      }
      return bins;
    };
    const bins = fill(reference, 0),
      count = bins.reduce((sum, item) => sum + item, 0);
    if (count < 40) return undefined;
    return {
      length,
      bins,
      count,
      candidates,
      fill,
      reference,
      window,
      candidateStarts: candidates
        .map((event) => event.start)
        .sort((left, right) => left - right),
    };
  });
  if (windows.some((window) => window === undefined)) return undefined;
  const usable = windows.filter((window) => window !== undefined);
  const scores: { shift: number; score: number }[] = [];
  for (let shift = -360; shift <= 360; shift++) {
    let score = 0;
    for (const window of usable) {
      const b = window.fill(window.candidates, shift * step);
      let count = 0,
        overlap = 0;
      for (let i = 0; i < window.length; i++) {
        count += b[i]!;
        overlap += window.bins[i]! & b[i]!;
      }
      score += count > 0 ? (2 * overlap) / (window.count + count) : 0;
    }
    scores.push({ shift, score: score / usable.length });
  }
  scores.sort(
    (left, right) =>
      right.score - left.score || Math.abs(left.shift) - Math.abs(right.shift),
  );
  const best = scores[0]!;
  const alternative = scores.find(
    (candidate) => Math.abs(candidate.shift - best.shift) >= 16,
  );
  let selected = best.shift;
  if (
    best.score < 0.6 ||
    !alternative ||
    best.score - alternative.score < 0.06
  ) {
    if (usable.length !== 2) return undefined;
    const starts = usable.map((item) =>
      item.reference.filter(
        (event) =>
          event.start >= item.window.start && event.start < item.window.end,
      ),
    );
    if (starts.some((items) => items.length < 8)) return undefined;
    const onsetScores: { shift: number; score: number; parts: number[] }[] = [];
    for (let shift = -360; shift <= 360; shift++) {
      const parts = usable.map((item, index) => {
        let score = 0;
        for (const event of starts[index]!) {
          const desired = event.start - shift * step;
          let left = 0,
            right = item.candidateStarts.length;
          while (left < right) {
            const middle = (left + right) >>> 1;
            if (item.candidateStarts[middle]! < desired) left = middle + 1;
            else right = middle;
          }
          const distance = Math.min(
            1.5,
            left < item.candidateStarts.length
              ? Math.abs(item.candidateStarts[left]! - desired)
              : 1.5,
            left > 0
              ? Math.abs(item.candidateStarts[left - 1]! - desired)
              : 1.5,
          );
          score += 1 - distance / 1.5;
        }
        return score / starts[index]!.length;
      });
      onsetScores.push({ shift, score: (parts[0]! + parts[1]!) / 2, parts });
    }
    onsetScores.sort(
      (left, right) =>
        right.score - left.score ||
        Math.abs(left.shift) - Math.abs(right.shift),
    );
    const onsetBest = onsetScores[0]!;
    const onsetOther = onsetScores.find(
      (candidate) => Math.abs(candidate.shift - onsetBest.shift) >= 16,
    );
    const sampleMaxima = [0, 1].map((index) =>
      Math.max(...onsetScores.map((candidate) => candidate.parts[index]!)),
    );
    const supportedByOtherEpisodes =
      expectedOffset !== undefined &&
      Math.abs(onsetBest.shift * step - expectedOffset) <= 1.5;
    if (
      onsetBest.score < 0.62 ||
      onsetBest.parts.some((part) => part < 0.55) ||
      onsetBest.parts.some(
        (part, index) => sampleMaxima[index]! - part > 0.12,
      ) ||
      !onsetOther ||
      (!supportedByOtherEpisodes && onsetBest.score - onsetOther.score < 0.08)
    )
      return undefined;
    selected = onsetBest.shift;
  }
  // A valid match must explain speech across both halves of every sample.
  for (const window of usable) {
    const aligned = window.fill(window.candidates, selected * step),
      middle = Math.floor(window.length / 2);
    for (const [start, end] of [
      [0, middle],
      [middle, window.length],
    ] as const) {
      let referenceCount = 0,
        targetCount = 0,
        overlap = 0;
      for (let i = start; i < end; i++) {
        referenceCount += window.bins[i]!;
        targetCount += aligned[i]!;
        overlap += window.bins[i]! & aligned[i]!;
      }
      if (
        referenceCount < 12 ||
        targetCount < 12 ||
        (2 * overlap) / (referenceCount + targetCount) < 0.45
      )
        return undefined;
    }
  }
  return selected * step;
}

export function estimateSubtitleSampleOffset(
  reference: readonly SubtitleEvent[],
  target: readonly SubtitleEvent[],
  window: { start: number; end: number },
): number | undefined {
  return estimateSubtitleSamplesOffset([{ events: reference, window }], target);
}
