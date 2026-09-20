import { useRef, useState } from 'react';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { HolidayImageCard } from '@/components/HolidayImageCard';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Banner, Card, Chip, ErrorState, Field, Skeleton, inputClass } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { dayLabel, todayIst } from '@/lib/dates';
import { useAddHoliday, useDeleteHoliday, useHolidays, useImportCommit, useImportPreview } from '@/lib/queries';

const TEMPLATE = 'date,name,type,description\n2026-10-19,Diwali,COMPANY,\n2026-12-25,Christmas,OPTIONAL,Optional holiday\n';

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'holidays-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function Holidays() {
  const [year, setYear] = useState(Number(todayIst().slice(0, 4)));
  const q = useHolidays(year);
  const del = useDeleteHoliday();
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const list = q.data?.holidays ?? [];
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Holidays</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" aria-label="Previous year" onClick={() => setYear((y) => y - 1)}>‹</Button>
          <span className="num text-base font-semibold">{year}</span>
          <Button variant="outline" size="sm" aria-label="Next year" onClick={() => setYear((y) => y + 1)}>›</Button>
        </div>
      </header>

      {q.data && (
        <p className="num text-sm text-ink-soft">
          {q.data.summary.company} company holidays · {q.data.summary.optional} optional
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus size={16} aria-hidden /> Add holiday
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload size={16} aria-hidden /> Import from file
        </Button>
        <Button size="sm" variant="ghost" onClick={downloadTemplate}>
          <Download size={16} aria-hidden /> Download a sample file
        </Button>
      </div>

      <HolidayImageCard />

      {q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <Skeleton className="h-48" />
      ) : list.length === 0 ? (
        <Card className="py-10 text-center">
          <p className="font-medium">Upload your company holiday calendar</p>
          <p className="mt-1 text-sm text-ink-soft">No holidays added for {year} yet.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Button size="sm" onClick={() => setAddOpen(true)}>Add holiday</Button>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>Import from file</Button>
          </div>
        </Card>
      ) : (
        <Card className="p-0">
          <ul>
            {list.map((h) => (
              <li key={h.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                <span className="num w-24 text-sm font-medium">{dayLabel(h.date)}</span>
                <span className="flex-1 text-sm">{h.name}</span>
                <Chip className={h.type === 'COMPANY' ? 'bg-holiday/10 text-holiday' : 'bg-holiday/5 text-holiday'}>{h.type === 'COMPANY' ? 'Company' : 'Optional'}</Chip>
                <Button variant="destructiveText" size="icon" aria-label={`Delete ${h.name}`} disabled={del.isPending} onClick={() => del.mutate(h.id)}>
                  <Trash2 size={16} />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {del.error && <Banner tone="bad">{del.error.message}</Banner>}

      <AddHolidayDialog open={addOpen} onOpenChange={setAddOpen} />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

function AddHolidayDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const add = useAddHoliday();
  const [date, setDate] = useState(todayIst());
  const [name, setName] = useState('');
  const [type, setType] = useState<'COMPANY' | 'OPTIONAL'>('COMPANY');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add holiday">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ date, name, type }, { onSuccess: () => { setName(''); onOpenChange(false); } });
        }}
      >
        <Field label="Date" htmlFor="h-date"><input id="h-date" type="date" required className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Name" htmlFor="h-name"><input id="h-name" required maxLength={120} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Type" htmlFor="h-type">
          <select id="h-type" className={inputClass} value={type} onChange={(e) => setType(e.target.value as 'COMPANY' | 'OPTIONAL')}>
            <option value="COMPANY">Company holiday</option>
            <option value="OPTIONAL">Optional holiday</option>
          </select>
        </Field>
        {add.error && <p role="alert" className="text-sm text-bad">{add.error.message}</p>}
        <Button type="submit" size="lg" disabled={add.isPending || !name.trim()}>Save holiday</Button>
      </form>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const preview = useImportPreview();
  const commit = useImportCommit();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [dupes, setDupes] = useState<'skip' | 'overwrite'>('skip');
  const input = useRef<HTMLInputElement>(null);

  function reset() {
    setCsv('');
    setFileName('');
    setDupes('skip');
    preview.reset();
    commit.reset();
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    preview.mutate(text);
  }

  const s = preview.data?.summary;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}
      title="Import holidays"
      description="CSV file with columns: date, name, type, description. Nothing is saved until you confirm."
    >
      {!preview.data && (
        <div className="flex flex-col gap-3">
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Choose CSV file" onChange={(e) => pick(e.target.files?.[0])} />
          <Button variant="outline" size="lg" onClick={() => input.current?.click()} disabled={preview.isPending}>
            <Upload size={18} aria-hidden /> {preview.isPending ? 'Reading…' : 'Choose a CSV file'}
          </Button>
          <p className="text-xs text-ink-soft">Excel files: save as CSV first.</p>
          {preview.error && <Banner tone="bad">{preview.error.message}</Banner>}
        </div>
      )}

      {preview.data && s && !commit.isSuccess && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-soft">{fileName}</p>
          <div className="flex flex-wrap gap-2">
            <Chip className="bg-ok/10 text-ok">{s.new} new</Chip>
            <Chip className="bg-warn/15 text-[#8a6300]">{s.duplicates} duplicates</Chip>
            <Chip className="bg-bad/10 text-bad">{s.errors} error{s.errors === 1 ? '' : 's'}</Chip>
          </div>
          <ul className="max-h-56 overflow-y-auto rounded-lg border border-line text-sm">
            {preview.data.rows.map((r) => (
              <li key={r.row} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-0">
                <span className="num w-24 shrink-0">{r.date ?? 'Invalid'}</span>
                <span className="flex-1 truncate">{r.name || '(no name)'}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', r.status === 'NEW' && 'bg-ok/10 text-ok', r.status === 'DUPLICATE' && 'bg-warn/15 text-[#8a6300]', r.status === 'ERROR' && 'bg-bad/10 text-bad')}>
                  {r.status === 'ERROR' ? `Error: ${r.error}` : r.status === 'NEW' ? 'New' : 'Duplicate'}
                </span>
              </li>
            ))}
          </ul>
          <fieldset className="text-sm">
            <legend className="mb-1 font-medium">Duplicates</legend>
            <label className="mr-4 inline-flex items-center gap-2"><input type="radio" name="dupes" checked={dupes === 'skip'} onChange={() => setDupes('skip')} /> Skip existing</label>
            <label className="inline-flex items-center gap-2"><input type="radio" name="dupes" checked={dupes === 'overwrite'} onChange={() => setDupes('overwrite')} /> Overwrite existing</label>
          </fieldset>
          <p className="text-xs text-ink-soft">Rows with errors are never imported. Nothing is saved until you confirm.</p>
          {commit.error && <Banner tone="bad">{commit.error.message}</Banner>}
          <Button size="lg" disabled={commit.isPending || s.new + (dupes === 'overwrite' ? s.duplicates : 0) === 0} onClick={() => commit.mutate({ csv, duplicates: dupes })}>
            {commit.isPending ? 'Importing…' : `Import ${s.new + (dupes === 'overwrite' ? s.duplicates : 0)} holidays`}
          </Button>
          <Button variant="ghost" onClick={reset}>Back</Button>
        </div>
      )}

      {commit.isSuccess && (
        <div className="flex flex-col gap-3">
          <Banner tone="ok">
            {commit.data.imported} holidays imported{commit.data.overwritten ? `, ${commit.data.overwritten} overwritten` : ''}.
          </Banner>
          <Button onClick={() => { reset(); onOpenChange(false); }}>Done</Button>
        </div>
      )}
    </Dialog>
  );
}
