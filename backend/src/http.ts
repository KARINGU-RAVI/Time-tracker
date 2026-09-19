import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { floorToMinute, istInstant } from '@oht/engine';
import { ApiError } from './errors';

/** Wraps an async route so rejections reach the error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'That is not a real calendar date.');

/** 'YYYY-MM-DD' <-> the Date stored in DATE columns. */
export const toDbDate = (s: string): Date => new Date(`${s}T00:00:00Z`);
export const fromDbDate = (d: Date): string => d.toISOString().slice(0, 10);

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;
const LOCAL_MINUTE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/;

/**
 * Parses an instant. A string with an offset ('2026-09-17T16:45:00+05:30' or 'Z') is used
 * as given. A local string ('2026-09-17T16:45') is read as IST. Result is floored to the minute.
 */
export function parseInstant(input: string): number {
  let ms: number;
  const local = LOCAL_MINUTE.exec(input);
  if (local && !HAS_OFFSET.test(input)) {
    ms = istInstant(local[1]!, local[2]!);
  } else if (HAS_OFFSET.test(input)) {
    ms = Date.parse(input);
  } else {
    throw new ApiError(400, 'INVALID_TIME', 'Use a time like 2026-09-17T16:45 (IST).');
  }
  if (Number.isNaN(ms)) throw new ApiError(400, 'INVALID_TIME', 'That is not a valid time.');
  return floorToMinute(ms);
}

export const instantStr = z.string().min(1);

export function paramDate(value: unknown): string {
  return dateStr.parse(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-09-21' -> '21 Sep 2026' (fixed names, independent of the server locale). */
export function prettyDate(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}
