import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

/** An error that is safe to show to the user. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Turns a database constraint violation into a clear API error. The constraint
 * names come from prisma/migrations/*_integrity_constraints.
 */
export function mapDbError(e: unknown): ApiError | null {
  const text = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code;

  if (text.includes('session_no_overlap')) {
    return new ApiError(409, 'OVERLAP', 'This check-in overlaps another session.');
  }
  if (text.includes('session_one_open_per_user')) {
    return new ApiError(409, 'ALREADY_CHECKED_IN', 'You are already checked in.');
  }
  if (text.includes('session_out_after_in') || text.includes('ZERO_LENGTH')) {
    return new ApiError(400, 'OUT_BEFORE_IN', 'OUT must be after IN.');
  }
  if (text.includes('not on the attendance date')) {
    return new ApiError(400, 'IN_DATE_MISMATCH', 'The IN time must fall on the selected date.');
  }
  if (text.includes('work_rule_no_overlap')) {
    return new ApiError(409, 'RULE_OVERLAP', 'This rule overlaps another rule version.');
  }
  if (text.includes('attendance_bereavement_link')) {
    return new ApiError(400, 'BEREAVEMENT_EVENT_REQUIRED', 'Choose or add the death in the family first.');
  }
  if (text.includes('attendance_half_day_only_casual_sick')) {
    return new ApiError(400, 'HALF_DAY_NOT_ALLOWED', 'Only casual or sick leave can be a half day.');
  }
  if (code === 'P2002') {
    return new ApiError(409, 'DUPLICATE', 'This record already exists.');
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: err.issues[0]?.message ?? 'Invalid request.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if ((err as { type?: string } | null)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } });
    return;
  }
  if ((err as { type?: string } | null)?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is too large (the limit is 6 MB).' } });
    return;
  }
  const mapped = mapDbError(err);
  if (mapped) {
    res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
    return;
  }
  // Unknown: never leak internals (SQL, stack traces) to the client.
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
};
