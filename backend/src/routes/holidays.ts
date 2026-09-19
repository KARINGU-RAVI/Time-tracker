import { Router } from 'express';
import { z } from 'zod';
import { istDateOf } from '@oht/engine';
import { currentUser } from '../auth';
import { ApiError } from '../errors';
import { asyncHandler, dateStr, fromDbDate, toDbDate } from '../http';
import type { AppDeps } from '../app';

const holidayBody = z.object({
  date: dateStr,
  name: z.string().trim().min(1, 'Enter a name.').max(120),
  type: z.enum(['COMPANY', 'OPTIONAL']).default('COMPANY'),
  description: z.string().max(500).nullable().optional(),
});

const serialize = (h: { id: string; date: Date; name: string; type: string; description: string | null }) => ({
  id: h.id,
  date: fromDbDate(h.date),
  name: h.name,
  type: h.type,
  description: h.description,
});

// ---- CSV import (R-41..R-47) -------------------------------------------------

/** Minimal RFC 4180 style parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Accepts 2026-10-19, 19-10-2026, 19/10/2026 and 19-Oct-2026. Returns null when invalid. */
export function parseFlexibleDate(input: string): string | null {
  const s = input.trim();
  let y: number, m: number, d: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})$/.exec(s))) {
    d = Number(match[1]);
    m = MONTHS.indexOf(match[2]!.toLowerCase()) + 1;
    y = Number(match[3]);
    if (m === 0) return null;
  } else {
    return null;
  }
  const out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const check = new Date(`${out}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== out) return null;
  return out;
}

export interface ImportRow {
  row: number;
  date: string | null;
  name: string;
  type: 'COMPANY' | 'OPTIONAL' | null;
  description: string | null;
  status: 'NEW' | 'DUPLICATE' | 'ERROR';
  error?: string;
}

export function analyseImport(csv: string, existingDates: Set<string>): ImportRow[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const first = rows[0]!.map((c) => c.trim().toLowerCase());
  const hasHeader = first.includes('date') && first.includes('name');
  const col = (name: string, fallback: number) => (hasHeader ? first.indexOf(name) : fallback);
  const iDate = col('date', 0);
  const iName = col('name', 1);
  const iType = col('type', 2);
  const iDesc = col('description', 3);

  const seen = new Set<string>();
  return rows.slice(hasHeader ? 1 : 0).map((cells, idx): ImportRow => {
    const rowNo = idx + (hasHeader ? 2 : 1);
    const get = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
    const date = parseFlexibleDate(get(iDate));
    const name = get(iName);
    const typeRaw = get(iType).toUpperCase();
    const type: 'COMPANY' | 'OPTIONAL' | null =
      typeRaw === '' ? 'COMPANY' : typeRaw === 'COMPANY' || typeRaw === 'OPTIONAL' ? typeRaw : null;
    const description = get(iDesc) || null;
    const base = { row: rowNo, date, name, type, description };

    if (!date) return { ...base, status: 'ERROR', error: 'Invalid date' };
    if (!name) return { ...base, status: 'ERROR', error: 'Name is empty' };
    if (!type) return { ...base, status: 'ERROR', error: 'Type must be COMPANY or OPTIONAL' };
    if (seen.has(date)) return { ...base, status: 'ERROR', error: 'Duplicate date in the file' };
    seen.add(date);
    return { ...base, status: existingDates.has(date) ? 'DUPLICATE' : 'NEW' };
  });
}

export function holidayRoutes({ prisma, clock }: AppDeps): Router {
  const router = Router();

  router.get(
    '/holidays',
    asyncHandler(async (req, res) => {
      const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }).parse(req.query);
      const rows = await prisma.holiday.findMany({
        where: {
          userId: currentUser(req).id,
          ...(year ? { date: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } } : {}),
        },
        orderBy: { date: 'asc' },
      });
      const optionalUsed = 0;
      res.json({
        holidays: rows.map(serialize),
        summary: {
          company: rows.filter((h) => h.type === 'COMPANY').length,
          optional: rows.filter((h) => h.type === 'OPTIONAL').length,
          optionalUsed,
        },
      });
    }),
  );

  router.post(
    '/holidays',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const b = holidayBody.parse(req.body);
      const row = await prisma.holiday.create({
        data: { userId: user.id, date: toDbDate(b.date), name: b.name, type: b.type, description: b.description ?? null },
      });
      // Changing a past date changes past calculations (R-46): the client shows a confirmation next time.
      res.status(201).json({ ...serialize(row), affectsPastDays: b.date < istDateOf(clock()) });
    }),
  );

  router.put(
    '/holidays/:id',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const b = holidayBody.parse(req.body);
      const existing = await prisma.holiday.findFirst({ where: { id, userId: user.id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Holiday not found.');
      const row = await prisma.holiday.update({
        where: { id },
        data: { date: toDbDate(b.date), name: b.name, type: b.type, description: b.description ?? null },
      });
      res.json(serialize(row));
    }),
  );

  router.delete(
    '/holidays/:id',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const id = z.string().uuid().parse(req.params.id);
      const existing = await prisma.holiday.findFirst({ where: { id, userId: user.id } });
      if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Holiday not found.');
      await prisma.holiday.delete({ where: { id } });
      res.status(204).end();
    }),
  );

  const importBody = z.object({
    csv: z.string().min(1, 'The file is empty.').max(500_000),
    duplicates: z.enum(['skip', 'overwrite']).default('skip'),
  });

  /** Step 2 of the import dialog: nothing is saved. */
  router.post(
    '/holidays/import/preview',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const { csv } = importBody.parse(req.body);
      const existing = await prisma.holiday.findMany({ where: { userId: user.id }, select: { date: true } });
      const rows = analyseImport(csv, new Set(existing.map((h) => fromDbDate(h.date))));
      res.json({
        rows,
        summary: {
          new: rows.filter((r) => r.status === 'NEW').length,
          duplicates: rows.filter((r) => r.status === 'DUPLICATE').length,
          errors: rows.filter((r) => r.status === 'ERROR').length,
        },
      });
    }),
  );

  /** Step 3: all-or-nothing (R-44). Rows with errors are never imported. */
  router.post(
    '/holidays/import/commit',
    asyncHandler(async (req, res) => {
      const user = currentUser(req);
      const { csv, duplicates } = importBody.parse(req.body);
      const existing = await prisma.holiday.findMany({ where: { userId: user.id }, select: { date: true } });
      const rows = analyseImport(csv, new Set(existing.map((h) => fromDbDate(h.date))));

      const toCreate = rows.filter((r) => r.status === 'NEW');
      const toOverwrite = duplicates === 'overwrite' ? rows.filter((r) => r.status === 'DUPLICATE') : [];

      await prisma.$transaction(async (tx) => {
        if (toCreate.length) {
          await tx.holiday.createMany({
            data: toCreate.map((r) => ({
              userId: user.id,
              date: toDbDate(r.date!),
              name: r.name,
              type: r.type!,
              description: r.description,
            })),
          });
        }
        for (const r of toOverwrite) {
          await tx.holiday.update({
            where: { userId_date: { userId: user.id, date: toDbDate(r.date!) } },
            data: { name: r.name, type: r.type!, description: r.description },
          });
        }
      });
      res.json({
        imported: toCreate.length,
        overwritten: toOverwrite.length,
        skippedDuplicates: rows.filter((r) => r.status === 'DUPLICATE').length - toOverwrite.length,
        errors: rows.filter((r) => r.status === 'ERROR').length,
      });
    }),
  );

  return router;
}
