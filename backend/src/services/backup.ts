import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { rulesOverlap, validateSessions, type WorkRule } from '@oht/engine';
import { ApiError, mapDbError } from '../errors';
import { dateStr, fromDbDate, prettyDate, toDbDate } from '../http';

/**
 * Backup format (version 1). Portable: no user id, no email, no database ids
 * except the keys needed to link bereavement days to their event inside the file.
 * A SHA-256 checksum over `data` detects a truncated, damaged or hand-edited file.
 */
export const BACKUP_APP = 'office-hours-tracker';
export const BACKUP_VERSION = 1;

type Db = PrismaClient | Prisma.TransactionClient;

const iso = z.string().datetime({ offset: true });
const num = (min: number, max: number) => z.number().min(min).max(max);

const settingsSchema = z
  .object({
    trackingStartDate: dateStr,
    maxSessionMinutes: z.number().int().min(60).max(1440),
    theme: z.string().max(20),
    notificationPrefs: z.record(z.unknown()),
  })
  .strict();

const ruleSchema = z
  .object({
    dailyRequiredMinutes: z.number().int().min(1).max(1440),
    weeklyRequiredMinutes: z.number().int().min(1).max(10080),
    halfDayRequiredMinutes: z.number().int().min(0).max(1440),
    workingDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    weekStartsOn: z.number().int().min(1).max(7),
    effectiveFrom: dateStr,
    effectiveTo: dateStr.nullable(),
  })
  .strict();

const holidaySchema = z
  .object({
    date: dateStr,
    name: z.string().min(1).max(120),
    type: z.enum(['COMPANY', 'OPTIONAL']),
    description: z.string().max(500).nullable(),
  })
  .strict();

const policySchema = z
  .object({
    annualEntitlement: num(0, 366),
    accrualPerMonth: num(0, 366),
    carryForwardCap: num(0, 366),
    optionalQuota: num(0, 366),
    bereavementDaysPerEvent: z.number().int().min(0).max(60),
    effectiveFrom: dateStr,
    effectiveTo: dateStr.nullable(),
  })
  .strict();

const ledgerSchema = z
  .object({
    pool: z.enum(['ANNUAL', 'OPTIONAL', 'BEREAVEMENT']),
    type: z.enum(['OPENING', 'ACCRUAL', 'GRANT', 'LAPSE', 'ADJUSTMENT']),
    days: num(-366, 366),
    effectiveDate: dateStr,
    leaveYear: z.number().int().min(2000).max(2100),
    note: z.string().max(500).nullable(),
  })
  .strict();

const eventSchema = z
  .object({
    id: z.string().min(1).max(64),
    relation: z.string().min(1).max(80),
    startDate: dateStr,
    note: z.string().max(500).nullable(),
  })
  .strict();

const attendanceSchema = z
  .object({
    date: dateStr,
    status: z.enum(['WORKING', 'WFH', 'CASUAL_LEAVE', 'SICK_LEAVE', 'BEREAVEMENT_LEAVE', 'OPTIONAL_HOLIDAY']),
    dayFraction: z.union([z.literal(1), z.literal(0.5)]),
    notes: z.string().max(2000).nullable(),
    managerInformed: z.boolean(),
    bereavementEventId: z.string().max(64).nullable(),
    sessions: z.array(z.object({ inTime: iso, outTime: iso.nullable() }).strict()).max(50),
  })
  .strict();

const dataSchema = z
  .object({
    settings: settingsSchema,
    workRules: z.array(ruleSchema).max(200),
    holidays: z.array(holidaySchema).max(3000),
    leavePolicies: z.array(policySchema).max(50),
    ledger: z.array(ledgerSchema).max(5000),
    bereavementEvents: z.array(eventSchema).max(500),
    attendance: z.array(attendanceSchema).max(20000),
  })
  .strict();

const backupSchema = z
  .object({
    app: z.literal(BACKUP_APP),
    version: z.literal(BACKUP_VERSION),
    exportedAt: iso,
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    data: dataSchema,
  })
  .strict();

export type BackupData = z.infer<typeof dataSchema>;
export type Backup = z.infer<typeof backupSchema>;

const canonicalKey = (e: { effectiveDate: string; pool: string; type: string; days: number; note: string | null }): string =>
  `${e.effectiveDate}|${e.pool}|${e.type}|${String(e.days).padStart(10, '0')}|${e.note ?? ''}`;

export const checksumOf = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export interface BackupCounts {
  attendanceDays: number;
  sessions: number;
  holidays: number;
  workRules: number;
  leavePolicies: number;
  ledgerEntries: number;
  bereavementEvents: number;
}

export function countsOf(data: BackupData): BackupCounts {
  return {
    attendanceDays: data.attendance.length,
    sessions: data.attendance.reduce((n, a) => n + a.sessions.length, 0),
    holidays: data.holidays.length,
    workRules: data.workRules.length,
    leavePolicies: data.leavePolicies.length,
    ledgerEntries: data.ledger.length,
    bereavementEvents: data.bereavementEvents.length,
  };
}

/** Everything the user owns, as a portable backup. */
export async function exportBackup(db: Db, userId: string, now: number): Promise<Backup> {
  const [settings, rules, holidays, policies, ledger, events, attendance] = await Promise.all([
    db.userSettings.findUnique({ where: { userId } }),
    db.workRule.findMany({ where: { userId }, orderBy: { effectiveFrom: 'asc' } }),
    db.holiday.findMany({ where: { userId }, orderBy: { date: 'asc' } }),
    db.leavePolicy.findMany({ where: { userId }, orderBy: { effectiveFrom: 'asc' } }),
    db.leaveLedgerEntry.findMany({ where: { userId }, orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }] }),
    db.bereavementEvent.findMany({ where: { userId }, orderBy: { startDate: 'asc' } }),
    db.attendance.findMany({
      where: { userId },
      orderBy: { date: 'asc' },
      include: { sessions: { orderBy: { inTime: 'asc' } } },
    }),
  ]);
  if (!settings) throw new ApiError(409, 'NOT_CONFIGURED', 'Settings are missing. Nothing to back up yet.');

  const data: BackupData = {
    settings: {
      trackingStartDate: fromDbDate(settings.trackingStartDate),
      maxSessionMinutes: settings.maxSessionMinutes,
      theme: settings.theme,
      notificationPrefs: (settings.notificationPrefs ?? {}) as Record<string, unknown>,
    },
    workRules: rules.map((r) => ({
      dailyRequiredMinutes: r.dailyRequiredMinutes,
      weeklyRequiredMinutes: r.weeklyRequiredMinutes,
      halfDayRequiredMinutes: r.halfDayRequiredMinutes,
      workingDays: r.workingDays,
      weekStartsOn: r.weekStartsOn,
      effectiveFrom: fromDbDate(r.effectiveFrom),
      effectiveTo: r.effectiveTo ? fromDbDate(r.effectiveTo) : null,
    })),
    holidays: holidays.map((h) => ({ date: fromDbDate(h.date), name: h.name, type: h.type, description: h.description })),
    leavePolicies: policies.map((p) => ({
      annualEntitlement: Number(p.annualEntitlement),
      accrualPerMonth: Number(p.accrualPerMonth),
      carryForwardCap: Number(p.carryForwardCap),
      optionalQuota: Number(p.optionalQuota),
      bereavementDaysPerEvent: p.bereavementDaysPerEvent,
      effectiveFrom: fromDbDate(p.effectiveFrom),
      effectiveTo: p.effectiveTo ? fromDbDate(p.effectiveTo) : null,
    })),
    // The database gives no order between rows that share a date, so sort fully. Identical data must
    // always produce an identical file (and checksum), whatever order the rows were inserted in.
    ledger: ledger
      .map((e) => ({
        pool: e.pool,
        type: e.type,
        days: Number(e.days),
        effectiveDate: fromDbDate(e.effectiveDate),
        leaveYear: e.leaveYear,
        note: e.note,
      }))
      .sort((a, b) => canonicalKey(a).localeCompare(canonicalKey(b))),
    bereavementEvents: events
      .map((e) => ({ id: e.id, relation: e.relation, startDate: fromDbDate(e.startDate), note: e.note }))
      .sort((a, b) => `${a.startDate}|${a.relation}|${a.note ?? ''}|${a.id}`.localeCompare(`${b.startDate}|${b.relation}|${b.note ?? ''}|${b.id}`)),
    attendance: attendance.map((a) => ({
      date: fromDbDate(a.date),
      status: a.status,
      dayFraction: Number(a.dayFraction) === 0.5 ? 0.5 : 1,
      notes: a.notes,
      managerInformed: a.managerInformed,
      bereavementEventId: a.bereavementEventId,
      sessions: a.sessions.map((s) => ({ inTime: s.inTime.toISOString(), outTime: s.outTime ? s.outTime.toISOString() : null })),
    })),
  };
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), checksum: checksumOf(data), data };
}

const invalid = (message: string, details?: unknown) => new ApiError(400, 'INVALID_BACKUP', message, details);

/**
 * Checks a file completely BEFORE anything is written: format, checksum, then the rules the
 * database and the engine enforce (unique days, valid and non-overlapping sessions, rule dates).
 */
export function parseBackup(raw: unknown): Backup {
  if (typeof raw !== 'object' || raw === null || (raw as { app?: unknown }).app !== BACKUP_APP) {
    throw invalid('This is not an Office Hours backup file.');
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== BACKUP_VERSION) {
    throw invalid(`This backup is version ${String(version)}, but this app reads version ${BACKUP_VERSION}.`);
  }

  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw invalid(`The backup file is damaged or incomplete (${first?.path.join('.') || 'file'}: ${first?.message ?? 'invalid'}).`);
  }
  const backup = parsed.data;

  // The checksum is over the ORIGINAL data, not the re-serialised parse result.
  if (checksumOf((raw as { data: unknown }).data) !== backup.checksum) {
    throw invalid('The backup file has been changed or damaged (its checksum does not match). Nothing was restored.');
  }

  const { data } = backup;
  const dupDay = firstDuplicate(data.attendance.map((a) => a.date));
  if (dupDay) throw invalid(`The backup lists ${prettyDate(dupDay)} more than once.`);
  const dupHoliday = firstDuplicate(data.holidays.map((h) => h.date));
  if (dupHoliday) throw invalid(`The backup lists a holiday on ${prettyDate(dupHoliday)} more than once.`);

  const eventIds = new Set(data.bereavementEvents.map((e) => e.id));
  if (eventIds.size !== data.bereavementEvents.length) throw invalid('The backup repeats a bereavement event.');

  for (const a of data.attendance) {
    const isBereavement = a.status === 'BEREAVEMENT_LEAVE';
    if (isBereavement !== (a.bereavementEventId !== null)) {
      throw invalid(`${prettyDate(a.date)}: bereavement days must be linked to an event, and only those.`);
    }
    if (a.bereavementEventId !== null && !eventIds.has(a.bereavementEventId)) {
      throw invalid(`${prettyDate(a.date)}: it refers to a bereavement event that is not in the file.`);
    }
    if (a.dayFraction === 0.5 && a.status !== 'CASUAL_LEAVE' && a.status !== 'SICK_LEAVE') {
      throw invalid(`${prettyDate(a.date)}: only casual or sick leave can be a half day.`);
    }
    const issues = validateSessions(
      a.sessions.map((s) => ({ inTime: Date.parse(s.inTime), outTime: s.outTime ? Date.parse(s.outTime) : null })),
      { date: a.date, maxSessionMinutes: data.settings.maxSessionMinutes },
    );
    if (issues[0]) throw invalid(`${prettyDate(a.date)}: ${issues[0].message}`);
  }
  if (data.attendance.filter((a) => a.sessions.some((s) => s.outTime === null)).length > 1) {
    throw invalid('The backup has more than one unclosed session.');
  }

  for (const l of data.ledger) {
    if (Number(l.effectiveDate.slice(0, 4)) !== l.leaveYear) {
      throw invalid(`Leave entry on ${prettyDate(l.effectiveDate)} has the wrong leave year.`);
    }
  }

  checkNoOverlap(
    data.workRules.map((r) => ({ ...r, dailyRequiredMinutes: r.dailyRequiredMinutes }) as unknown as WorkRule),
    'work rules',
  );
  for (const r of data.workRules) if (r.effectiveTo !== null && r.effectiveTo < r.effectiveFrom) throw invalid('A work rule ends before it starts.');
  for (const r of data.workRules) if (r.halfDayRequiredMinutes > r.dailyRequiredMinutes) throw invalid('A work rule has a half day longer than a full day.');
  return backup;
}

function firstDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return v;
    seen.add(v);
  }
  return null;
}

function checkNoOverlap(rules: WorkRule[], label: string) {
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (rulesOverlap(rules[i]!, rules[j]!)) throw invalid(`Two ${label} in the backup cover the same dates.`);
    }
  }
}

export async function currentCounts(db: Db, userId: string): Promise<BackupCounts> {
  const [attendanceDays, sessions, holidays, workRules, leavePolicies, ledgerEntries, bereavementEvents] = await Promise.all([
    db.attendance.count({ where: { userId } }),
    db.attendanceSession.count({ where: { userId } }),
    db.holiday.count({ where: { userId } }),
    db.workRule.count({ where: { userId } }),
    db.leavePolicy.count({ where: { userId } }),
    db.leaveLedgerEntry.count({ where: { userId } }),
    db.bereavementEvent.count({ where: { userId } }),
  ]);
  return { attendanceDays, sessions, holidays, workRules, leavePolicies, ledgerEntries, bereavementEvents };
}

/**
 * Replaces ALL of the user's data with the backup, in one transaction: either everything is
 * restored or nothing changes. Rows get new ids; the file's event keys are remapped.
 */
export async function restoreBackup(prisma: PrismaClient, userId: string, backup: Backup): Promise<BackupCounts> {
  const { data } = backup;
  try {
    await prisma.$transaction(
      async (tx) => {
        // Children first: sessions cascade with their day; events are restricted while days point at them.
        await tx.attendance.deleteMany({ where: { userId } });
        await tx.bereavementEvent.deleteMany({ where: { userId } });
        await tx.holiday.deleteMany({ where: { userId } });
        await tx.workRule.deleteMany({ where: { userId } });
        await tx.leavePolicy.deleteMany({ where: { userId } });
        await tx.leaveLedgerEntry.deleteMany({ where: { userId } });

        await tx.userSettings.upsert({
          where: { userId },
          update: {
            trackingStartDate: toDbDate(data.settings.trackingStartDate),
            maxSessionMinutes: data.settings.maxSessionMinutes,
            theme: data.settings.theme,
            notificationPrefs: data.settings.notificationPrefs as Prisma.InputJsonValue,
          },
          create: {
            userId,
            trackingStartDate: toDbDate(data.settings.trackingStartDate),
            maxSessionMinutes: data.settings.maxSessionMinutes,
            theme: data.settings.theme,
            notificationPrefs: data.settings.notificationPrefs as Prisma.InputJsonValue,
          },
        });

        // Rules must not overlap while inserting, so insert in date order (the DB checks each row).
        for (const r of [...data.workRules].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))) {
          await tx.workRule.create({
            data: { userId, ...r, effectiveFrom: toDbDate(r.effectiveFrom), effectiveTo: r.effectiveTo ? toDbDate(r.effectiveTo) : null },
          });
        }
        await tx.leavePolicy.createMany({
          data: data.leavePolicies.map((p) => ({ userId, ...p, effectiveFrom: toDbDate(p.effectiveFrom), effectiveTo: p.effectiveTo ? toDbDate(p.effectiveTo) : null })),
        });
        await tx.holiday.createMany({ data: data.holidays.map((h) => ({ userId, ...h, date: toDbDate(h.date) })) });
        await tx.leaveLedgerEntry.createMany({
          data: data.ledger.map((l) => ({ userId, ...l, effectiveDate: toDbDate(l.effectiveDate) })),
        });

        const eventIdMap = new Map<string, string>();
        for (const e of data.bereavementEvents) {
          const id = randomUUID();
          eventIdMap.set(e.id, id);
          await tx.bereavementEvent.create({ data: { id, userId, relation: e.relation, startDate: toDbDate(e.startDate), note: e.note } });
        }

        const days = data.attendance.map((a) => ({ ...a, id: randomUUID() }));
        await tx.attendance.createMany({
          data: days.map((a) => ({
            id: a.id,
            userId,
            date: toDbDate(a.date),
            status: a.status,
            dayFraction: a.dayFraction,
            notes: a.notes,
            managerInformed: a.managerInformed,
            bereavementEventId: a.bereavementEventId ? (eventIdMap.get(a.bereavementEventId) ?? null) : null,
          })),
        });

        // Sessions oldest-first so the overlap constraint sees them in a natural order.
        const sessions = days
          .flatMap((a) => a.sessions.map((s) => ({ attendanceId: a.id, userId, inTime: new Date(s.inTime), outTime: s.outTime ? new Date(s.outTime) : null })))
          .sort((x, y) => x.inTime.getTime() - y.inTime.getTime());
        if (sessions.length) await tx.attendanceSession.createMany({ data: sessions });

        await tx.auditLog.create({
          data: { userId, entity: 'Backup', entityId: randomUUID(), action: 'RESTORE', after: { exportedAt: backup.exportedAt, ...countsOf(data) } },
        });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const mapped = mapDbError(e);
    if (mapped?.code === 'OVERLAP' || mapped?.code === 'ALREADY_CHECKED_IN') {
      throw invalid('The backup has sessions that overlap each other across days. Nothing was restored.');
    }
    if (mapped?.code === 'RULE_OVERLAP') throw invalid('Two work rules in the backup cover the same dates. Nothing was restored.');
    if (mapped) throw invalid(`${mapped.message} Nothing was restored.`);
    throw e;
  }
  return countsOf(data);
}
