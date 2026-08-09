const UNIT_SECONDS: Readonly<Record<string, number>> = {
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
};

export function parseRuntimeSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 && value <= 24 * 60
      ? Math.round(value * 60)
      : undefined;
  }
  if (typeof value !== "string" || value.length > 64) return undefined;
  const text = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const minutes = Number(text);
    return Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60
      ? Math.round(minutes * 60)
      : undefined;
  }
  let total = 0;
  let matched = 0;
  const pattern = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/g;
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || unit === undefined) return undefined;
    total += amount * UNIT_SECONDS[unit]!;
    matched += match[0].length;
  }
  const residue = text.replace(pattern, "").replace(/[\s,]+/g, "");
  if (matched === 0 || residue.length > 0 || total <= 0 || total > 24 * 3600) {
    return undefined;
  }
  return Math.round(total);
}
