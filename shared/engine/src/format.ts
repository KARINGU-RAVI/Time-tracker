/**
 * Formats minutes as "Xh Ym" (never decimal hours).
 *   480 -> "8h 00m", 35 -> "35m", -100 -> "-1h 40m", 0 -> "0m".
 * With signed = true a positive value gets a leading "+".
 */
export function formatDuration(minutes: number, options: { signed?: boolean } = {}): string {
  const rounded = Math.round(minutes);
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const body = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  if (rounded < 0) return `-${body}`;
  if (rounded > 0 && options.signed) return `+${body}`;
  return body;
}

/** Leave days such as 12.75, always two decimals. */
export function formatLeaveDays(days: number): string {
  return (Math.round(days * 100) / 100).toFixed(2);
}

/** A running-clock style duration, 'H:MM:SS' (for example 6:55:07). Negative values show as 0:00:00. */
export function formatClockDuration(totalSeconds: number): string {
  const t = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
