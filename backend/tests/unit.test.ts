import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app';
import { mapDbError } from '../src/errors';
import { prettyDate } from '../src/http';
import { analyseImport, parseCsv, parseFlexibleDate } from '../src/routes/holidays';

const verify = vi.hoisted(() => vi.fn());
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = verify;
  },
}));

describe('database error mapping', () => {
  const cases: Array<[string, number, string]> = [
    ['conflicting key value violates exclusion constraint "session_no_overlap"', 409, 'OVERLAP'],
    ['duplicate key value violates unique constraint "session_one_open_per_user"', 409, 'ALREADY_CHECKED_IN'],
    ['new row violates check constraint "session_out_after_in"', 400, 'OUT_BEFORE_IN'],
    ['Session IN time (x) is not on the attendance date y (IST)', 400, 'IN_DATE_MISMATCH'],
    ['conflicting key value violates exclusion constraint "work_rule_no_overlap"', 409, 'RULE_OVERLAP'],
    ['violates check constraint "attendance_bereavement_link"', 400, 'BEREAVEMENT_EVENT_REQUIRED'],
    ['violates check constraint "attendance_half_day_only_casual_sick"', 400, 'HALF_DAY_NOT_ALLOWED'],
  ];

  it.each(cases)('maps "%s"', (message, status, code) => {
    const mapped = mapDbError(new Error(message));
    expect(mapped).toMatchObject({ status, code });
  });

  it('maps a Prisma unique violation to DUPLICATE', () => {
    expect(mapDbError(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }))).toMatchObject({ status: 409, code: 'DUPLICATE' });
  });

  it('does not map unknown errors (they become a generic 500)', () => {
    expect(mapDbError(new Error('something else'))).toBeNull();
    expect(mapDbError('not even an error')).toBeNull();
  });
});

describe('unexpected errors never leak internals', () => {
  it('returns a generic 500 with no SQL, secrets or stack', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({
      prisma: new PrismaClient(),
      clock: () => Date.now(),
      authenticate: async () => {
        throw new Error('password=hunter2 SELECT * FROM "User"');
      },
    });
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|SELECT|stack/i);
    spy.mockRestore();
  });
});

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, commas inside fields, CRLF and a BOM', () => {
    const csv = '﻿a,"b,c",d\r\n"he said ""hi""",x,y\r\n\r\nlast,row,here';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b,c', 'd'],
      ['he said "hi"', 'x', 'y'],
      ['last', 'row', 'here'],
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n  \n')).toEqual([]);
  });
});

describe('holiday date formats', () => {
  it.each([
    ['2026-10-19', '2026-10-19'],
    ['19-10-2026', '2026-10-19'],
    ['19/10/2026', '2026-10-19'],
    ['19-Oct-2026', '2026-10-19'],
    ['19 Oct 2026', '2026-10-19'],
    ['5-Jan-2026', '2026-01-05'],
    ['  2026-1-5 ', '2026-01-05'],
  ])('accepts %s', (input, expected) => {
    expect(parseFlexibleDate(input)).toBe(expected);
  });

  it.each(['31-02-2026', '2026-13-01', 'garbage', '', '19-Foo-2026', '2026/10/19'])('rejects %s', (input) => {
    expect(parseFlexibleDate(input)).toBeNull();
  });
});

describe('holiday import analysis', () => {
  it('works without a header row (positional columns)', () => {
    const rows = analyseImport('2026-10-19,Diwali,COMPANY\n2026-12-25,Christmas,OPTIONAL', new Set());
    expect(rows.map((r) => [r.date, r.name, r.type, r.status])).toEqual([
      ['2026-10-19', 'Diwali', 'COMPANY', 'NEW'],
      ['2026-12-25', 'Christmas', 'OPTIONAL', 'NEW'],
    ]);
  });

  it('understands a header in any column order and a blank type', () => {
    const rows = analyseImport('name,date,type\nDiwali,2026-10-19,\nHoli,2026-03-04,optional', new Set());
    expect(rows.map((r) => [r.name, r.type])).toEqual([
      ['Diwali', 'COMPANY'],
      ['Holi', 'OPTIONAL'],
    ]);
  });

  it('marks duplicates, duplicates inside the file, and each kind of error', () => {
    const rows = analyseImport(
      ['date,name,type', '2026-10-19,Existing,COMPANY', '2026-11-01,A,COMPANY', '2026-11-01,B,COMPANY', 'bad,C,COMPANY', '2026-11-02,,COMPANY', '2026-11-03,D,NOPE'].join('\n'),
      new Set(['2026-10-19']),
    );
    expect(rows.map((r) => r.status)).toEqual(['DUPLICATE', 'NEW', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
    expect(rows.map((r) => r.error)).toEqual([undefined, undefined, 'Duplicate date in the file', 'Invalid date', 'Name is empty', 'Type must be COMPANY or OPTIONAL']);
    expect(rows[0]?.row).toBe(2); // spreadsheet-style row numbers, header is row 1
  });
});

describe('Google token verification wrapper', () => {
  it('verifies against our own client id and returns the identity', async () => {
    const { createGoogleVerifier } = await import('../src/google');
    verify.mockResolvedValue({ getPayload: () => ({ sub: 'abc', email: 'me@example.test', email_verified: true }) });
    const identity = await createGoogleVerifier('client-123.apps.googleusercontent.com')('token-xyz');
    expect(verify).toHaveBeenCalledWith({ idToken: 'token-xyz', audience: 'client-123.apps.googleusercontent.com' });
    expect(identity).toEqual({ sub: 'abc', email: 'me@example.test', emailVerified: true });
  });

  it('reports an unverified email as unverified', async () => {
    const { createGoogleVerifier } = await import('../src/google');
    verify.mockResolvedValue({ getPayload: () => ({ sub: 'abc', email: 'me@example.test', email_verified: false }) });
    expect((await createGoogleVerifier('c')('t')).emailVerified).toBe(false);
  });

  it('throws when Google returns no identity, and passes through verification failures', async () => {
    const { createGoogleVerifier } = await import('../src/google');
    verify.mockResolvedValue({ getPayload: () => ({ sub: 'abc' }) });
    await expect(createGoogleVerifier('c')('t')).rejects.toThrow(/no identity/);
    verify.mockResolvedValue({ getPayload: () => undefined });
    await expect(createGoogleVerifier('c')('t')).rejects.toThrow();
    verify.mockRejectedValue(new Error('Wrong recipient, payload audience != requiredAudience'));
    await expect(createGoogleVerifier('c')('t')).rejects.toThrow(/audience/);
  });
});

describe('prettyDate', () => {
  it('formats independent of the server locale', () => {
    expect(prettyDate('2026-09-01')).toBe('1 Sep 2026');
    expect(prettyDate('2026-12-25')).toBe('25 Dec 2026');
  });
});
