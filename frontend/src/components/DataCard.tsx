import { useRef, useState } from 'react';
import { Download, FileSpreadsheet, RotateCcw, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Banner, Card, CardTitle, Field, inputClass } from '@/components/ui/primitives';
import { ApiError, get, post } from '@/lib/api';
import { firstDayOfMonth, todayIst } from '@/lib/dates';
import { daysSince, lastBackupDate, readFileText, rememberBackup, saveFile } from '@/lib/files';
import { useQueryClient } from '@tanstack/react-query';

interface Counts {
  attendanceDays: number;
  sessions: number;
  holidays: number;
  workRules: number;
  leavePolicies: number;
  ledgerEntries: number;
  bereavementEvents: number;
}
interface Validation {
  valid: true;
  exportedAt: string;
  backup: Counts;
  current: Counts;
  daysThatWouldBeLost: number;
}

const ROWS: Array<[keyof Counts, string]> = [
  ['attendanceDays', 'Days recorded'],
  ['sessions', 'Sessions'],
  ['holidays', 'Holidays'],
  ['workRules', 'Work rules'],
  ['ledgerEntries', 'Leave entries'],
  ['bereavementEvents', 'Bereavement events'],
];

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** Backup, restore and report export. The restore is guarded: validate first, then type REPLACE. */
export function DataCard() {
  const today = todayIst();
  const [busy, setBusy] = useState<'backup' | 'csv' | 'validate' | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [last, setLast] = useState<string | null>(lastBackupDate);

  const [from, setFrom] = useState(() => firstDayOfMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7))));
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<'daily' | 'sessions'>('daily');

  const picker = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ backup: unknown; check: Validation } | null>(null);

  async function exportBackup() {
    setBusy('backup');
    setMessage(null);
    try {
      const backup = await get<unknown>('/backup');
      saveFile(JSON.stringify(backup, null, 2), `office-hours-backup-${today}.json`, 'application/json');
      rememberBackup(today);
      setLast(today);
      setMessage({ tone: 'ok', text: 'Backup downloaded. Keep the file somewhere safe (not only on this device).' });
    } catch (e) {
      setMessage({ tone: 'bad', text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function exportCsv() {
    setBusy('csv');
    setMessage(null);
    try {
      const text = await get<string>('/export/csv', { startDate: from, endDate: to, type: kind });
      saveFile(text, `office-hours-${kind}-${from}_to_${to}.csv`, 'text/csv');
    } catch (e) {
      setMessage({ tone: 'bad', text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  }

  async function chooseRestoreFile(file: File | undefined) {
    if (!file) return;
    setBusy('validate');
    setMessage(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFileText(file));
      } catch {
        throw new ApiError('INVALID_BACKUP', 'That file is not a readable backup (it is not valid JSON).', 400);
      }
      // The server checks everything first and saves nothing.
      const check = await post<Validation>('/backup/validate', parsed);
      setUpload({ backup: parsed, check });
    } catch (e) {
      setMessage({ tone: 'bad', text: errMsg(e) });
    } finally {
      setBusy(null);
      if (picker.current) picker.current.value = '';
    }
  }

  const stale = last === null ? true : daysSince(last, today) > 30;

  return (
    <Card>
      <CardTitle>Data</CardTitle>

      {stale && (
        <Banner tone="warn" className="mb-3">
          {last === null ? 'No backup has been downloaded on this device yet.' : `Your last backup from this device was ${daysSince(last, today)} days ago.`} Export one regularly:
          it is your safety net.
        </Banner>
      )}
      {!stale && last && <p className="mb-3 text-xs text-ink-soft">Last backup from this device: {last}.</p>}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={exportBackup}>
          <Download size={16} aria-hidden /> {busy === 'backup' ? 'Preparing…' : 'Export backup (JSON)'}
        </Button>
        <input ref={picker} type="file" accept=".json,application/json" className="sr-only" aria-label="Choose backup file" onChange={(e) => chooseRestoreFile(e.target.files?.[0])} />
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => picker.current?.click()}>
          <Upload size={16} aria-hidden /> {busy === 'validate' ? 'Checking…' : 'Restore from backup'}
        </Button>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-2 flex items-center gap-2 text-sm font-medium">
          <FileSpreadsheet size={16} aria-hidden /> Export a report (CSV)
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="From" htmlFor="csv-from">
            <input id="csv-from" type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" htmlFor="csv-to">
            <input id="csv-to" type="date" className={inputClass} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Report" htmlFor="csv-kind">
            <select id="csv-kind" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as 'daily' | 'sessions')}>
              <option value="daily">Daily (one row per day)</option>
              <option value="sessions">Sessions (one row per IN/OUT)</option>
            </select>
          </Field>
        </div>
        <Button className="mt-3" variant="outline" size="sm" disabled={busy !== null || !from || !to || to < from} onClick={exportCsv}>
          <Download size={16} aria-hidden /> {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
        </Button>
      </div>

      {message && (
        <Banner tone={message.tone === 'ok' ? 'ok' : 'bad'} className="mt-4">
          {message.text}
        </Banner>
      )}

      {upload && <RestoreDialog upload={upload} onClose={() => setUpload(null)} onExportFirst={exportBackup} />}
    </Card>
  );
}

function RestoreDialog({ upload, onClose, onExportFirst }: { upload: { backup: unknown; check: Validation }; onClose: () => void; onExportFirst: () => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const { check } = upload;

  async function restore() {
    setState('working');
    setError(null);
    try {
      await post('/backup/restore', { confirm: 'REPLACE', backup: upload.backup });
      await qc.invalidateQueries();
      setState('done');
    } catch (e) {
      setError(errMsg(e));
      setState('idle');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && state !== 'working') onClose(); }} title="Restore from backup" description={`Backup made ${check.exportedAt.slice(0, 10)}`}>
      {state === 'done' ? (
        <div className="flex flex-col gap-3">
          <Banner tone="ok">Restored. All your data now matches the backup.</Banner>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-soft">
                <th className="py-1 font-medium">Item</th>
                <th className="py-1 text-right font-medium">In the file</th>
                <th className="py-1 text-right font-medium">Now</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([key, label]) => (
                <tr key={key} className="border-t border-line">
                  <td className="py-1.5">{label}</td>
                  <td className="num py-1.5 text-right font-medium">{check.backup[key]}</td>
                  <td className="num py-1.5 text-right text-ink-soft">{check.current[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <Banner tone="bad">
            <strong>This replaces ALL your current data with the file.</strong>
            {check.daysThatWouldBeLost > 0 && (
              <span className="mt-1 block">
                {check.daysThatWouldBeLost} day{check.daysThatWouldBeLost > 1 ? 's' : ''} recorded now {check.daysThatWouldBeLost > 1 ? 'are' : 'is'} not in the backup and will be deleted.
              </span>
            )}
          </Banner>

          <Button variant="outline" size="sm" onClick={onExportFirst} className="self-start">
            <RotateCcw size={16} aria-hidden /> Download a backup of the current data first
          </Button>

          <Field label='Type REPLACE to confirm' htmlFor="confirm-text">
            <input id="confirm-text" autoComplete="off" className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          {error && <Banner tone="bad">{error}</Banner>}

          <Button variant="danger" size="lg" disabled={typed !== 'REPLACE' || state === 'working'} onClick={restore}>
            {state === 'working' ? 'Restoring…' : 'Restore and replace everything'}
          </Button>
          <Button variant="ghost" disabled={state === 'working'} onClick={onClose}>
            Cancel
          </Button>
        </div>
      )}
    </Dialog>
  );
}
