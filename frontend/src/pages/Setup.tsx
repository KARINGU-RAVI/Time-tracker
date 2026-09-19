import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { Field, TextInput } from '@/components/ui/form';
import { Banner, Card, ErrorState, Skeleton } from '@/components/ui/primitives';
import { ApiError, get, post } from '@/lib/api';
import { cn } from '@/lib/cn';
import { prettyDate } from '@/lib/dates';
import { readFileText, saveFile } from '@/lib/files';
import { HOLIDAY_TEMPLATE, parseHolidayCsv, type HolidayRow } from '@/lib/holidayCsv';

interface Defaults {
  alreadyComplete: boolean;
  today: string;
  profile: { name: string };
  work: { dailyMinutes: number; weeklyMinutes: number; workingDays: number[]; weekStartsOn: 1 | 7; trackingStartDate: string };
  leave: {
    annualEntitlement: number;
    accrualPerMonth: number;
    carryForwardCap: number;
    optionalQuota: number;
    bereavementDaysPerEvent: number;
    carriedForward: number;
    annualUsedSoFar: number;
    optionalUsedSoFar: number;
    birthdayQuota: number;
    birthdayTaken: boolean;
    creditsFromMonth: number;
  };
  holidays: { companyCount: number };
}

interface Preview {
  preview: {
    annual: { carriedIn: number; credited: number; used: number; balance: number };
    optional: { quota: number; used: number; remaining: number };
    birthday: { quota: number; used: number; remaining: number };
    trackingStartDate: string;
  };
  holidayCount: number;
}

/** Everything typed as text so half-typed numbers ("1.") never fight the user; converted on the way out. */
interface Form {
  name: string;
  employeeId: string;
  designation: string;
  businessUnit: string;
  dailyH: string;
  dailyM: string;
  weeklyH: string;
  weeklyM: string;
  workingDays: number[];
  weekStartsOn: 1 | 7;
  trackingStartDate: string;
  annualEntitlement: string;
  accrualPerMonth: string;
  carryForwardCap: string;
  optionalQuota: string;
  bereavementDaysPerEvent: string;
  carriedForward: string;
  annualUsedSoFar: string;
  optionalUsedSoFar: string;
  birthdayQuota: string;
  birthdayTaken: boolean;
  creditsFromMonth: string;
  holidaySource: 'company' | 'list' | 'none';
  holidayList: HolidayRow[];
}

const DAYS = [
  [1, 'M', 'Monday'],
  [2, 'T', 'Tuesday'],
  [3, 'W', 'Wednesday'],
  [4, 'T', 'Thursday'],
  [5, 'F', 'Friday'],
  [6, 'S', 'Saturday'],
  [7, 'S', 'Sunday'],
] as const;
const DAY_NAMES: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
const STEPS = ['Profile', 'Work hours', 'Leave', 'Holidays', 'Review'] as const;

const num = (s: string): number => (s.trim() === '' ? 0 : Number(s));
const validNumber = (s: string) => s.trim() === '' || (/^\d*\.?\d{0,2}$/.test(s.trim()) && Number.isFinite(Number(s)));
const minutes = (h: string, m: string) => Math.round(num(h) * 60 + num(m));
const hm = (total: number): [string, string] => [String(Math.floor(total / 60)), String(total % 60)];
const dur = (total: number) => `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
const days = (n: number) => `${n.toFixed(2)} day${n === 1 ? '' : 's'}`;

function fromDefaults(d: Defaults): Form {
  const [dh, dm] = hm(d.work.dailyMinutes);
  const [wh, wm] = hm(d.work.weeklyMinutes);
  const s = (n: number) => String(n);
  return {
    name: d.profile.name,
    employeeId: '',
    designation: '',
    businessUnit: '',
    dailyH: dh,
    dailyM: dm,
    weeklyH: wh,
    weeklyM: wm,
    workingDays: d.work.workingDays,
    weekStartsOn: d.work.weekStartsOn,
    trackingStartDate: d.work.trackingStartDate,
    annualEntitlement: s(d.leave.annualEntitlement),
    accrualPerMonth: s(d.leave.accrualPerMonth),
    carryForwardCap: s(d.leave.carryForwardCap),
    optionalQuota: s(d.leave.optionalQuota),
    bereavementDaysPerEvent: s(d.leave.bereavementDaysPerEvent),
    carriedForward: s(d.leave.carriedForward),
    annualUsedSoFar: s(d.leave.annualUsedSoFar),
    optionalUsedSoFar: s(d.leave.optionalUsedSoFar),
    birthdayQuota: s(d.leave.birthdayQuota),
    birthdayTaken: d.leave.birthdayTaken,
    creditsFromMonth: s(d.leave.creditsFromMonth),
    holidaySource: d.holidays.companyCount > 0 ? 'company' : 'none',
    holidayList: [],
  };
}

const leaveKeys = ['annualEntitlement', 'accrualPerMonth', 'carryForwardCap', 'carriedForward', 'annualUsedSoFar', 'birthdayQuota'] as const;

/** The request body the server expects (the same shape for the preview and the final save). */
export function toRequest(f: Form) {
  return {
    profile: { name: f.name.trim(), employeeId: f.employeeId.trim() || undefined, designation: f.designation.trim() || undefined, businessUnit: f.businessUnit.trim() || undefined },
    work: {
      dailyMinutes: minutes(f.dailyH, f.dailyM),
      weeklyMinutes: minutes(f.weeklyH, f.weeklyM),
      workingDays: f.workingDays,
      weekStartsOn: f.weekStartsOn,
      trackingStartDate: f.trackingStartDate,
    },
    leave: {
      annualEntitlement: num(f.annualEntitlement),
      accrualPerMonth: num(f.accrualPerMonth),
      carryForwardCap: num(f.carryForwardCap),
      optionalQuota: Math.round(num(f.optionalQuota)),
      bereavementDaysPerEvent: Math.round(num(f.bereavementDaysPerEvent)),
      carriedForward: num(f.carriedForward),
      annualUsedSoFar: num(f.annualUsedSoFar),
      optionalUsedSoFar: Math.round(num(f.optionalUsedSoFar)),
      birthdayQuota: num(f.birthdayQuota),
      birthdayTaken: f.birthdayTaken && num(f.birthdayQuota) > 0,
      creditsFromMonth: Math.round(num(f.creditsFromMonth)) || 1,
    },
    holidays: { source: f.holidaySource, list: f.holidaySource === 'list' ? f.holidayList : undefined },
  };
}

function NumberField({ label, value, onChange, hint, suffix }: { label: string; value: string; onChange: (v: string) => void; hint?: string; suffix?: string }) {
  const bad = !validNumber(value);
  return (
    <Field label={label} hint={hint} error={bad ? 'Enter a number, for example 1.75.' : null}>
      {(a11y) => (
        <div className="relative">
          <TextInput {...a11y} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} className={suffix ? 'pr-16' : ''} />
          {suffix && <span className="pointer-events-none absolute right-3 top-3 text-sm text-ink-soft">{suffix}</span>}
        </div>
      )}
    </Field>
  );
}

function DurationField({ label, h, m, onChange, hint }: { label: string; h: string; m: string; onChange: (h: string, m: string) => void; hint?: string }) {
  const total = minutes(h, m);
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex items-center gap-2">
        <TextInput aria-label={`${label}: hours`} inputMode="numeric" value={h} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 2), m)} className="w-20 text-center" />
        <span className="text-sm text-ink-soft">h</span>
        <TextInput aria-label={`${label}: minutes`} inputMode="numeric" value={m} onChange={(e) => onChange(h, e.target.value.replace(/\D/g, '').slice(0, 2))} className="w-20 text-center" />
        <span className="text-sm text-ink-soft">m</span>
        <span className="ml-auto text-sm font-medium tabular-nums">{dur(total)}</span>
      </div>
      {hint && <p className="text-xs text-ink-soft">{hint}</p>}
    </fieldset>
  );
}

export default function Setup() {
  const qc = useQueryClient();
  const defaults = useQuery({ queryKey: ['setup-defaults'], queryFn: () => get<Defaults>('/setup/defaults'), staleTime: Infinity });
  const [form, setForm] = useState<Form | null>(null);
  const [step, setStep] = useState(0);
  const [ack, setAck] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (defaults.data && !form) setForm(fromDefaults(defaults.data));
  }, [defaults.data, form]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  // The balance preview comes from the server, so it can never disagree with what is saved.
  const previewKey = useMemo(() => (form ? JSON.stringify({ ...toRequest(form), profile: undefined, holidays: { source: 'none' } }) : ''), [form]);
  useEffect(() => {
    if (!form || step < 1) return;
    const numbersOk = [...leaveKeys, 'optionalQuota', 'bereavementDaysPerEvent', 'optionalUsedSoFar', 'creditsFromMonth'].every((k) => validNumber(form[k as keyof Form] as string));
    if (!numbersOk || form.workingDays.length === 0) return;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const { profile: _p, ...body } = toRequest(form);
        const r = await post<Preview>('/setup/preview', { ...body, holidays: { source: form.holidaySource === 'list' ? 'list' : 'none', list: form.holidaySource === 'list' ? form.holidayList : undefined } });
        if (!stale) {
          setPreview(r);
          setPreviewError(null);
        }
      } catch (e) {
        if (!stale) {
          setPreview(null);
          setPreviewError(e instanceof ApiError ? e.message : 'Could not check these numbers.');
        }
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // previewKey changes exactly when a number the server cares about changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, step]);

  if (defaults.isError) return <ErrorState message={defaults.error.message} onRetry={() => defaults.refetch()} />;
  if (!form || !defaults.data) {
    return (
      <div className="p-6" aria-busy="true">
        <Skeleton className="h-10 w-1/2" />
      </div>
    );
  }
  const d = defaults.data;

  const workOk = form.workingDays.length > 0 && minutes(form.dailyH, form.dailyM) >= 60 && minutes(form.weeklyH, form.weeklyM) >= 60 && /^\d{4}-\d{2}-\d{2}$/.test(form.trackingStartDate);
  const leaveOk = [...leaveKeys, 'optionalQuota', 'bereavementDaysPerEvent', 'optionalUsedSoFar', 'creditsFromMonth'].every((k) => validNumber(form[k as keyof Form] as string)) && !previewError && preview !== null;
  const stepOk = [form.name.trim().length > 0, workOk, leaveOk, form.holidaySource !== 'list' || form.holidayList.length > 0, ack][step]!;

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const { rows, errors } = parseHolidayCsv(await readFileText(file));
    setCsvErrors(errors);
    set('holidayList', errors.length ? [] : rows);
  }

  async function finish() {
    setSaving(true);
    setSaveError(null);
    try {
      await post('/setup/complete', { ...toRequest(form!), acknowledged: true });
      await qc.invalidateQueries();
    } catch (e) {
      setSaveError(e instanceof ApiError && e.status !== 0 && e.status < 500 ? e.message : 'Could not save your setup. Nothing was changed. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const p = preview?.preview;
  const startNote = form.trackingStartDate ? `From ${prettyDate(form.trackingStartDate)}` : '';

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center gap-3 pt-2">
        <Logo size={44} />
        <div>
          <h1 className="text-xl font-semibold">Set up your account</h1>
          <p className="text-sm text-ink-soft" aria-live="polite">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </p>
        </div>
      </header>
      <div className="flex gap-1" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-label="Setup progress">
        {STEPS.map((s, i) => (
          <span key={s} className={cn('h-1.5 flex-1 rounded-full', i <= step ? 'bg-primary' : 'bg-muted')} />
        ))}
      </div>
      {step < 4 && <p className="text-sm text-ink-soft">We filled in common defaults. Change anything that is different for you.</p>}

      <Card className="flex flex-col gap-4">
        {step === 0 && (
          <>
            <Field label="Full name" hint="Shown in your messages and exports.">
              {(a) => <TextInput {...a} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" maxLength={80} />}
            </Field>
            <Field label="Employee ID (optional)">{(a) => <TextInput {...a} value={form.employeeId} onChange={(e) => set('employeeId', e.target.value)} maxLength={40} />}</Field>
            <Field label="Designation (optional)">{(a) => <TextInput {...a} value={form.designation} onChange={(e) => set('designation', e.target.value)} maxLength={80} />}</Field>
            <Field label="Business unit (optional)">{(a) => <TextInput {...a} value={form.businessUnit} onChange={(e) => set('businessUnit', e.target.value)} maxLength={80} />}</Field>
          </>
        )}

        {step === 1 && (
          <>
            <DurationField label="Daily hours" h={form.dailyH} m={form.dailyM} onChange={(h, m) => { set('dailyH', h); set('dailyM', m); }} hint="Half a day counts as half of this." />
            <DurationField label="Weekly hours" h={form.weeklyH} m={form.weeklyM} onChange={(h, m) => { set('weeklyH', h); set('weeklyM', m); }} />
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Working days</legend>
              <div className="flex gap-2">
                {DAYS.map(([n, letter, name]) => {
                  const on = form.workingDays.includes(n);
                  return (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={on}
                      aria-label={name}
                      onClick={() => set('workingDays', on ? form.workingDays.filter((x) => x !== n) : [...form.workingDays, n].sort())}
                      className={cn('grid h-11 w-11 place-items-center rounded-full border text-sm font-semibold', on ? 'border-primary bg-primary text-on-primary' : 'border-line text-ink-soft')}
                    >
                      {letter}
                    </button>
                  );
                })}
              </div>
              {form.workingDays.length === 0 && <p role="alert" className="mt-1 text-sm text-bad">Choose at least one working day.</p>}
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Week starts on</legend>
              <div className="grid grid-cols-2 rounded-full bg-muted p-1" role="radiogroup" aria-label="Week starts on">
                {([1, 7] as const).map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={form.weekStartsOn === n} onClick={() => set('weekStartsOn', n)} className={cn('h-10 rounded-full text-sm font-medium', form.weekStartsOn === n ? 'bg-card text-primary shadow-sm' : 'text-ink-soft')}>
                    {n === 1 ? 'Monday' : 'Sunday'}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="flex items-center justify-between rounded-xl bg-muted px-3 py-2 text-sm">
              <span>Time zone</span>
              <span className="flex items-center gap-2 text-ink-soft"><Lock size={14} aria-hidden />India Standard Time (UTC+05:30)</span>
            </div>
            <p className="-mt-2 text-xs text-ink-soft">Other time zones are not supported yet.</p>
            <Field label="Start tracking from" hint="Leave and hours before this date come from your opening balances in the next step.">
              {(a) => <TextInput {...a} type="date" value={form.trackingStartDate} min={`${d.today.slice(0, 4)}-01-01`} max={`${d.today.slice(0, 4)}-12-31`} onChange={(e) => set('trackingStartDate', e.target.value)} />}
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <h2 className="text-sm font-semibold">Yearly leave</h2>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="Annual leave per year" value={form.annualEntitlement} onChange={(v) => set('annualEntitlement', v)} suffix="days" />
              <NumberField label="Credited each month" value={form.accrualPerMonth} onChange={(v) => set('accrualPerMonth', v)} suffix="days" />
              <NumberField label="Maximum carried to next year" value={form.carryForwardCap} onChange={(v) => set('carryForwardCap', v)} suffix="days" />
              <NumberField label="Optional holidays per year" value={form.optionalQuota} onChange={(v) => set('optionalQuota', v)} />
            </div>
            <NumberField label="Bereavement leave per event (days)" value={form.bereavementDaysPerEvent} onChange={(v) => set('bereavementDaysPerEvent', v)} />
            <h2 className="mt-2 text-sm font-semibold">Your balance today</h2>
            <NumberField label="Carried forward from last year" value={form.carriedForward} onChange={(v) => set('carriedForward', v)} suffix="days" />
            <NumberField label="Annual leave taken this year so far" value={form.annualUsedSoFar} onChange={(v) => set('annualUsedSoFar', v)} suffix="days" hint="Sick and casual leave taken before your tracking start date." />
            <NumberField label="Optional leave taken this year so far" value={form.optionalUsedSoFar} onChange={(v) => set('optionalUsedSoFar', v)} />
            <NumberField label="Birthday half-day allowance per year" value={form.birthdayQuota} onChange={(v) => set('birthdayQuota', v)} suffix="days" hint="Half a day is usual. It is separate from annual leave and does not carry over." />
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" checked={form.birthdayTaken && num(form.birthdayQuota) > 0} disabled={num(form.birthdayQuota) <= 0} onChange={(e) => set('birthdayTaken', e.target.checked)} className="mt-1" />
              <span>I have already taken my birthday half-day this year</span>
            </label>
            <NumberField label="First month you earned leave this year" value={form.creditsFromMonth} onChange={(v) => set('creditsFromMonth', v)} hint="1 for January. Use a later month if you joined this year." />
            {previewError && <Banner tone="bad">{previewError}</Banner>}
            <div className="rounded-2xl border border-primary/30 bg-primary-soft/40 p-4" aria-live="polite">
              <p className="text-sm font-semibold">Your balance after setup</p>
              {p ? (
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-ink-soft">Annual leave</dt>
                  <dd className="text-right text-lg font-semibold tabular-nums">{days(p.annual.balance)}</dd>
                  <dt className="text-ink-soft">Optional leave</dt>
                  <dd className="text-right text-lg font-semibold tabular-nums">{p.optional.remaining} left</dd>
                  <dt className="text-ink-soft">Birthday half-day</dt>
                  <dd className="text-right text-lg font-semibold tabular-nums">{p.birthday.remaining} left</dd>
                </dl>
              ) : (
                <p className="mt-2 text-sm text-ink-soft">Checking…</p>
              )}
              <p className="mt-2 text-xs text-ink-soft">Updates as you type. Bereavement, birthday and other separate leave do not count here.</p>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            {([
              ['company', 'Use the company calendar', d.holidays.companyCount > 0 ? `${d.holidays.companyCount} holidays listed` : 'No company calendar has been published yet.'],
              ['list', 'Upload my own list', 'A CSV file with the date, name and type.'],
              ['none', 'Start empty and add later', 'You can add holidays any time.'],
            ] as const).map(([value, title, sub]) => (
              <label key={value} className={cn('flex cursor-pointer items-start gap-3 rounded-2xl border p-3', form.holidaySource === value ? 'border-primary bg-primary-soft/40' : 'border-line')}>
                <input type="radio" name="holidays" checked={form.holidaySource === value} onChange={() => set('holidaySource', value)} className="mt-1" />
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs text-ink-soft">{sub}</span>
                </span>
              </label>
            ))}
            {form.holidaySource === 'list' && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex h-11 cursor-pointer items-center rounded-full border border-line bg-card px-5 text-sm font-semibold hover:bg-muted">
                    Choose CSV file
                    <input type="file" accept=".csv,text/csv" className="sr-only" aria-label="Choose CSV file" onChange={(e) => void chooseFile(e.target.files?.[0])} />
                  </label>
                  <button type="button" className="text-sm font-medium text-primary" onClick={() => saveFile(HOLIDAY_TEMPLATE, 'holidays-template.csv', 'text/csv')}>
                    Download the template
                  </button>
                </div>
                {csvErrors.length > 0 && (
                  <Banner tone="bad">
                    <p className="font-medium">Fix these lines and choose the file again:</p>
                    <ul className="mt-1 list-disc pl-4">{csvErrors.slice(0, 6).map((e) => <li key={e}>{e}</li>)}</ul>
                    {csvErrors.length > 6 && <p className="mt-1">…and {csvErrors.length - 6} more.</p>}
                  </Banner>
                )}
                {form.holidayList.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-soft">Preview ({form.holidayList.length} holidays)</p>
                    <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                      {form.holidayList.slice(0, 5).map((h) => (
                        <li key={h.date} className="flex items-center justify-between gap-2 px-3 py-2">
                          <span className="tabular-nums text-ink-soft">{prettyDate(h.date)}</span>
                          <span className="min-w-0 flex-1 truncate">{h.name}</span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{h.type === 'OPTIONAL' ? 'Optional' : 'Public'}</span>
                        </li>
                      ))}
                    </ul>
                    {form.holidayList.length > 5 && <p className="mt-1 text-xs text-ink-soft">…and {form.holidayList.length - 5} more.</p>}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {step === 4 && (
          <>
            {[
              [0, 'Profile', [form.name.trim(), [form.employeeId, form.designation, form.businessUnit].filter(Boolean).join(' · ')].filter(Boolean)],
              [1, 'Work hours', [`${dur(minutes(form.dailyH, form.dailyM))} a day, ${dur(minutes(form.weeklyH, form.weeklyM))} a week`, `${form.workingDays.map((n) => DAY_NAMES[n]).join(', ')}. Week starts ${form.weekStartsOn === 1 ? 'Monday' : 'Sunday'}. ${startNote}`]],
              [2, 'Leave', [p ? `Annual leave ${days(p.annual.balance)}, optional ${p.optional.remaining} left` : '', `${form.accrualPerMonth} days credited each month, up to ${form.carryForwardCap} carried forward`]],
              [3, 'Holidays', [form.holidaySource === 'company' ? `Company calendar (${d.holidays.companyCount})` : form.holidaySource === 'list' ? `${form.holidayList.length} holidays from your file` : 'None yet']],
            ].map(([i, title, lines]) => (
              <div key={title as string} className="flex items-start justify-between gap-3 border-b border-line pb-3 last:border-0">
                <div>
                  <h2 className="text-sm font-semibold">{title as string}</h2>
                  {(lines as string[]).filter(Boolean).map((l) => <p key={l} className="text-sm text-ink-soft">{l}</p>)}
                </div>
                <button type="button" className="text-sm font-medium text-primary" onClick={() => setStep(i as number)} aria-label={`Edit ${title as string}`}>Edit</button>
              </div>
            ))}
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" />
              <span>I understand my data is stored in this app and I can delete it any time.</span>
            </label>
            {saveError && <Banner tone="bad">{saveError}</Banner>}
          </>
        )}
      </Card>

      <div className="mt-auto flex items-center justify-between gap-3 pb-4">
        <Button variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0 || saving}>
          Back
        </Button>
        {step < 4 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!stepOk}>
            Continue
          </Button>
        ) : (
          <Button onClick={finish} disabled={!stepOk || saving}>
            {saving ? 'Saving your setup…' : 'Finish setup'}
          </Button>
        )}
      </div>
    </div>
  );
}
