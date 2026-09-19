import { EngineError, type WorkRule } from './types';

/**
 * Returns the work rule in force on a date (R-25, R-27).
 * Throws NO_RULE instead of silently using a default.
 */
export function resolveRule(rules: WorkRule[], date: string): WorkRule {
  const rule = rules.find(
    (r) => r.effectiveFrom <= date && (r.effectiveTo === null || date <= r.effectiveTo),
  );
  if (!rule) throw new EngineError('NO_RULE', `No work rule is effective on ${date}.`);
  return rule;
}

/** True when two rule versions overlap in date range (R-26). */
export function rulesOverlap(a: WorkRule, b: WorkRule): boolean {
  const aEnd = a.effectiveTo ?? '9999-12-31';
  const bEnd = b.effectiveTo ?? '9999-12-31';
  return a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd;
}
