import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { istInstant } from '@oht/engine';

/**
 * Integration tests: the DATABASE must reject invalid data even if the API has a bug.
 * Requires DATABASE_URL to point at a migrated PostgreSQL.
 */

const prisma = new PrismaClient();
const t = (date: string, hhmm: string): Date => new Date(istInstant(date, hhmm));
const d = (date: string): Date => new Date(`${date}T00:00:00Z`);

let userId: string;
let otherUserId: string;
let seq = 0;

/** A fresh Attendance for a unique far-future date so tests never collide. */
async function newAttendance(date: string, extra: Record<string, unknown> = {}, uid = userId) {
  return prisma.attendance.create({ data: { userId: uid, date: d(date), ...extra } });
}

function addSession(attendanceId: string, date: string, inn: string, out: string | null, uid = userId) {
  return prisma.attendanceSession.create({
    data: { attendanceId, userId: uid, inTime: t(date, inn), outTime: out ? t(date, out) : null },
  });
}

const createdUsers: string[] = [];

async function freshUser(tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `it-${tag}-${Date.now()}-${process.pid}-${++seq}@example.test` },
  });
  createdUsers.push(user.id);
  return user.id;
}

// Every test gets its own users, so leftovers (an open session, an earlier rule)
// can never leak into another test.
beforeEach(async () => {
  userId = await freshUser('a');
  otherUserId = await freshUser('b');
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
  await prisma.$disconnect();
});

describe('Attendance', () => {
  it('allows only one record per user per date, but the same date for another user', async () => {
    await newAttendance('2031-01-06');
    await expect(newAttendance('2031-01-06')).rejects.toThrow(/Unique constraint/);
    await expect(newAttendance('2031-01-06', {}, otherUserId)).resolves.toBeTruthy();
  });

  it('never lets the date or owner change', async () => {
    const a = await newAttendance('2031-01-07');
    await expect(
      prisma.attendance.update({ where: { id: a.id }, data: { date: d('2031-01-08') } }),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('allows a half day only for casual and sick leave', async () => {
    await expect(newAttendance('2031-01-08', { dayFraction: 0.5 })).rejects.toThrow(
      /attendance_half_day_only_casual_sick/,
    );
    await expect(
      newAttendance('2031-01-09', { status: 'CASUAL_LEAVE', dayFraction: 0.5 }),
    ).resolves.toBeTruthy();
    await expect(
      newAttendance('2031-01-10', { status: 'SICK_LEAVE', dayFraction: 0.5 }),
    ).resolves.toBeTruthy();
  });

  it('rejects any fraction other than 1 or 0.5', async () => {
    await expect(
      newAttendance('2031-01-13', { status: 'CASUAL_LEAVE', dayFraction: 0.7 }),
    ).rejects.toThrow(/attendance_fraction_valid/);
  });

  it('requires bereavement days to be linked to an event, and only those', async () => {
    await expect(newAttendance('2031-01-14', { status: 'BEREAVEMENT_LEAVE' })).rejects.toThrow(
      /attendance_bereavement_link/,
    );
    const ev = await prisma.bereavementEvent.create({
      data: { userId, relation: 'Test relation', startDate: d('2031-01-14') },
    });
    await expect(
      newAttendance('2031-01-15', { status: 'WORKING', bereavementEventId: ev.id }),
    ).rejects.toThrow(/attendance_bereavement_link/);
    await expect(
      newAttendance('2031-01-14', { status: 'BEREAVEMENT_LEAVE', bereavementEventId: ev.id }),
    ).resolves.toBeTruthy();
  });

  it('blocks deleting a bereavement event that still has days linked', async () => {
    const ev = await prisma.bereavementEvent.create({
      data: { userId, relation: 'Test relation 2', startDate: d('2031-02-03') },
    });
    await newAttendance('2031-02-03', { status: 'BEREAVEMENT_LEAVE', bereavementEventId: ev.id });
    await expect(prisma.bereavementEvent.delete({ where: { id: ev.id } })).rejects.toThrow();
  });
});

describe('AttendanceSession', () => {
  it('rejects OUT before or equal to IN', async () => {
    const a = await newAttendance('2031-03-03');
    await expect(addSession(a.id, '2031-03-03', '10:00', '09:00')).rejects.toThrow(/session_out_after_in/);
    await expect(addSession(a.id, '2031-03-03', '10:00', '10:00')).rejects.toThrow(/session_out_after_in/);
  });

  it('allows several sequential sessions, including touching ones', async () => {
    const a = await newAttendance('2031-03-04');
    await addSession(a.id, '2031-03-04', '08:00', '10:00');
    await addSession(a.id, '2031-03-04', '10:00', '12:00'); // touching
    await addSession(a.id, '2031-03-04', '13:00', '17:30');
    expect(await prisma.attendanceSession.count({ where: { attendanceId: a.id } })).toBe(3);
  });

  it('rejects overlapping closed sessions', async () => {
    const a = await newAttendance('2031-03-05');
    await addSession(a.id, '2031-03-05', '08:00', '12:00');
    await expect(addSession(a.id, '2031-03-05', '11:00', '13:00')).rejects.toThrow(/session_no_overlap/);
    await expect(addSession(a.id, '2031-03-05', '08:30', '09:00')).rejects.toThrow(/session_no_overlap/);
  });

  it('rejects overlap across different attendance days of the same user', async () => {
    // A session that crosses midnight owns the early hours of the next day.
    const a1 = await newAttendance('2031-03-06');
    await prisma.attendanceSession.create({
      data: { attendanceId: a1.id, userId, inTime: t('2031-03-06', '22:00'), outTime: t('2031-03-07', '02:00') },
    });
    const a2 = await newAttendance('2031-03-07');
    await expect(addSession(a2.id, '2031-03-07', '01:00', '03:00')).rejects.toThrow(/session_no_overlap/);
    await expect(addSession(a2.id, '2031-03-07', '03:00', '05:00')).resolves.toBeTruthy();
  });

  it('allows only one open session per user (duplicate IN)', async () => {
    const a = await newAttendance('2031-03-10');
    await addSession(a.id, '2031-03-10', '08:00', null);
    const b = await newAttendance('2031-03-11');
    await expect(addSession(b.id, '2031-03-11', '09:00', null)).rejects.toThrow();
    // Closing it frees the slot.
    await prisma.attendanceSession.updateMany({
      where: { attendanceId: a.id },
      data: { outTime: t('2031-03-10', '17:00') },
    });
    await expect(addSession(b.id, '2031-03-11', '09:00', null)).resolves.toBeTruthy();
  });

  it('treats an open session as running forever for overlap', async () => {
    const a = await newAttendance('2031-03-12');
    await addSession(a.id, '2031-03-12', '10:00', null);
    await expect(addSession(a.id, '2031-03-12', '12:00', '13:00')).rejects.toThrow(/session_no_overlap/);
    await expect(addSession(a.id, '2031-03-12', '08:00', '09:00')).resolves.toBeTruthy();
  });

  it('lets different users have sessions at the same time', async () => {
    const a = await newAttendance('2031-03-13');
    const b = await newAttendance('2031-03-13', {}, otherUserId);
    await addSession(a.id, '2031-03-13', '09:00', '17:00');
    await expect(addSession(b.id, '2031-03-13', '09:00', '17:00', otherUserId)).resolves.toBeTruthy();
  });

  it('rejects a session whose IN is not on the attendance date (IST)', async () => {
    const a = await newAttendance('2031-03-14');
    await expect(addSession(a.id, '2031-03-15', '09:00', '10:00')).rejects.toThrow(
      /not on the attendance date/,
    );
    // 00:30 IST on the 14th is still the 14th, although it is the 13th in UTC.
    await expect(addSession(a.id, '2031-03-14', '00:30', '01:00')).resolves.toBeTruthy();
  });

  it("rejects a session whose user differs from the attendance owner", async () => {
    const a = await newAttendance('2031-03-17');
    await expect(addSession(a.id, '2031-03-17', '09:00', '10:00', otherUserId)).rejects.toThrow(
      /does not match the attendance user/,
    );
  });

  it('lets exactly one of two simultaneous check-ins win', async () => {
    const a = await newAttendance('2031-03-18');
    const results = await Promise.allSettled([
      addSession(a.id, '2031-03-18', '09:00', null),
      addSession(a.id, '2031-03-18', '09:00', null),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('WorkRule', () => {
  const rule = (from: string, to: string | null, extra: Record<string, unknown> = {}, uid = userId) => ({
    userId: uid,
    dailyRequiredMinutes: 480,
    weeklyRequiredMinutes: 2400,
    halfDayRequiredMinutes: 240,
    workingDays: [1, 2, 3, 4, 5],
    effectiveFrom: d(from),
    effectiveTo: to ? d(to) : null,
    ...extra,
  });

  it('allows adjacent versions and rejects overlapping ones', async () => {
    await prisma.workRule.create({ data: rule('2040-01-01', '2040-06-30') });
    await expect(prisma.workRule.create({ data: rule('2040-07-01', null) })).resolves.toBeTruthy();
    await expect(prisma.workRule.create({ data: rule('2040-03-01', '2040-03-31') })).rejects.toThrow(
      /work_rule_no_overlap/,
    );
    await expect(prisma.workRule.create({ data: rule('2039-12-01', '2040-01-01') })).rejects.toThrow(
      /work_rule_no_overlap/,
    );
  });

  it('rejects an open-ended rule that overlaps a later one', async () => {
    await prisma.workRule.create({ data: rule('2050-01-01', null) });
    await expect(prisma.workRule.create({ data: rule('2051-01-01', null) })).rejects.toThrow(
      /work_rule_no_overlap/,
    );
  });

  it('allows the same dates for a different user', async () => {
    await prisma.workRule.create({ data: rule('2040-01-01', '2040-06-30') });
    await expect(
      prisma.workRule.create({ data: rule('2040-01-01', '2040-06-30', {}, otherUserId) }),
    ).resolves.toBeTruthy();
  });

  it('rejects invalid values', async () => {
    await expect(prisma.workRule.create({ data: rule('2060-02-01', '2060-01-01') })).rejects.toThrow(
      /work_rule_dates_valid/,
    );
    await expect(
      prisma.workRule.create({ data: rule('2061-01-01', null, { workingDays: [1, 8] }) }),
    ).rejects.toThrow(/work_rule_working_days_valid/);
    await expect(
      prisma.workRule.create({ data: rule('2062-01-01', null, { workingDays: [] }) }),
    ).rejects.toThrow(/work_rule_working_days_valid/);
    await expect(
      prisma.workRule.create({ data: rule('2063-01-01', null, { halfDayRequiredMinutes: 999 }) }),
    ).rejects.toThrow(/work_rule_minutes_valid/);
    await expect(
      prisma.workRule.create({ data: rule('2064-01-01', null, { weekStartsOn: 9 }) }),
    ).rejects.toThrow(/work_rule_week_start_valid/);
  });
});

describe('Holiday and ledger', () => {
  it('allows one holiday per user per date', async () => {
    const h = { userId, date: d('2031-10-20'), name: 'Test holiday', type: 'COMPANY' as const };
    await prisma.holiday.create({ data: h });
    await expect(prisma.holiday.create({ data: h })).rejects.toThrow(/Unique constraint/);
  });

  const entry = (extra: Record<string, unknown>) => ({
    userId,
    pool: 'ANNUAL' as const,
    type: 'ACCRUAL' as const,
    days: 1.75,
    effectiveDate: d('2031-05-01'),
    leaveYear: 2031,
    ...extra,
  });

  it('creates each accrual only once (idempotent materialisation)', async () => {
    await prisma.leaveLedgerEntry.create({ data: entry({}) });
    await expect(prisma.leaveLedgerEntry.create({ data: entry({}) })).rejects.toThrow();
  });

  it('allows repeated manual adjustments on the same date', async () => {
    const adj = entry({ type: 'ADJUSTMENT', days: -1, effectiveDate: d('2031-05-02') });
    await prisma.leaveLedgerEntry.create({ data: adj });
    await expect(prisma.leaveLedgerEntry.create({ data: adj })).resolves.toBeTruthy();
  });

  it('keeps leaveYear consistent with the entry date', async () => {
    await expect(
      prisma.leaveLedgerEntry.create({ data: entry({ effectiveDate: d('2031-06-01'), leaveYear: 2030 }) }),
    ).rejects.toThrow(/ledger_leave_year_matches_date/);
  });

  it('rejects a nonsensical session cap', async () => {
    await expect(
      prisma.userSettings.create({
        data: { userId: otherUserId, trackingStartDate: d('2031-01-01'), maxSessionMinutes: 5 },
      }),
    ).rejects.toThrow(/settings_max_session_valid/);
  });
});

describe('account and abuse-protection tables', () => {
  it('refuses an email that is not lower case (so one address can never be two accounts)', async () => {
    const email = `Upper-${Date.now()}-${process.pid}@example.test`;
    await expect(prisma.user.create({ data: { email } })).rejects.toThrow(/User_email_lowercase/);
    const ok = await prisma.user.create({ data: { email: email.toLowerCase() } });
    createdUsers.push(ok.id);
    await expect(prisma.user.create({ data: { email: email.toLowerCase() } })).rejects.toThrow(/Unique constraint/);
  });

  it('refuses a negative failed-login counter', async () => {
    await expect(prisma.user.update({ where: { id: userId }, data: { failedLogins: -1 } })).rejects.toThrow(/failedLogins_nonneg/);
  });

  it('stores only one row per token hash, and refuses a token used before it was created', async () => {
    const hash = `h-${Date.now()}-${process.pid}`;
    await prisma.authToken.create({ data: { userId, kind: 'VERIFY_EMAIL', tokenHash: hash, expiresAt: new Date(Date.now() + 1000) } });
    await expect(
      prisma.authToken.create({ data: { userId, kind: 'RESET_PASSWORD', tokenHash: hash, expiresAt: new Date(Date.now() + 1000) } }),
    ).rejects.toThrow(/Unique constraint/);
    await expect(
      prisma.authToken.create({
        data: { userId, kind: 'VERIFY_EMAIL', tokenHash: `${hash}-b`, expiresAt: new Date(Date.now() + 1000), usedAt: new Date(0) },
      }),
    ).rejects.toThrow(/usedAt_after_created/);
  });

  it('removes tokens together with their user', async () => {
    const uid = await freshUser('tok');
    const tokenHash = `gone-${Date.now()}-${process.pid}`;
    await prisma.authToken.create({ data: { userId: uid, kind: 'VERIFY_EMAIL', tokenHash, expiresAt: new Date(Date.now() + 1000) } });
    await prisma.user.delete({ where: { id: uid } });
    expect(await prisma.authToken.findUnique({ where: { tokenHash } })).toBeNull();
  });

  it('refuses a negative rate-limit counter', async () => {
    await expect(
      prisma.rateLimit.create({ data: { key: `neg-${Date.now()}-${process.pid}`, windowStart: new Date(), count: -1 } }),
    ).rejects.toThrow(/RateLimit_count_nonneg/);
  });
});

void seq;
