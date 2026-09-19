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
