import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { renderAt } from '@/test/utils';
import { DataCard } from './DataCard';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const BACKUP = { app: 'office-hours-tracker', version: 1, exportedAt: '2026-09-18T10:00:00.000Z', checksum: 'a'.repeat(64), data: { attendance: [] } };
const counts = (n: number) => ({ attendanceDays: n, sessions: n * 2, holidays: 3, workRules: 2, leavePolicies: 1, ledgerEntries: 13, bereavementEvents: 0 });
const check = (over: object = {}) => ({ valid: true, exportedAt: '2026-09-10T10:00:00.000Z', backup: counts(10), current: counts(12), daysThatWouldBeLost: 2, ...over });

let saved: Array<{ name: string; text: Promise<string> }> = [];

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  localStorage.clear();
  saved = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
    saved.push({ name: '', text: (b as Blob).text() });
    return 'blob:x';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved[saved.length - 1]!.name = this.download;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const open = () => renderAt('/settings', '/settings', <DataCard />);
const file = (text: string, name = 'backup.json') => new File([text], name, { type: 'application/json' });

describe('Export backup', () => {
  it('downloads the backup as a dated JSON file and remembers when', async () => {
    api.get.mockResolvedValue(BACKUP);
    open();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export backup (JSON)' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(api.get).toHaveBeenCalledWith('/backup');
    expect(saved[0]!.name).toBe('office-hours-backup-2026-09-18.json');
    expect(JSON.parse(await saved[0]!.text)).toEqual(BACKUP);
    expect(await screen.findByText(/Backup downloaded/)).toBeInTheDocument();
    expect(localStorage.getItem('oht-last-backup')).toBe('2026-09-18');
    expect(screen.getByText(/Last backup from this device: 2026-09-18/)).toBeInTheDocument();
  });

  it('reminds you when there is no backup, or the last one is old, and not when it is recent', () => {
    const first = open();
    expect(screen.getByText(/No backup has been downloaded on this device yet/)).toBeInTheDocument();
    first.unmount();

    localStorage.setItem('oht-last-backup', '2026-08-01');
    const second = open();
    expect(screen.getByText(/last backup from this device was 48 days ago/)).toBeInTheDocument();
    second.unmount();

    localStorage.setItem('oht-last-backup', '2026-09-10');
    open();
    expect(screen.queryByText(/days ago/)).not.toBeInTheDocument();
    expect(screen.getByText(/Last backup from this device: 2026-09-10/)).toBeInTheDocument();
  });

  it('shows a refusal and does not claim success', async () => {
    api.get.mockRejectedValue(new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0));
    open();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Export backup (JSON)' }));
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    expect(saved).toHaveLength(0);
    expect(localStorage.getItem('oht-last-backup')).toBeNull();
  });
});

describe('Export a CSV report', () => {
  it('defaults to this month, and downloads with the chosen range and type', async () => {
    api.get.mockResolvedValue('Date,Weekday\r\n');
    open();
    expect(screen.getByLabelText('From')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('To')).toHaveValue('2026-09-18');
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Report'), 'sessions');
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/export/csv', { startDate: '2026-09-01', endDate: '2026-09-18', type: 'sessions' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]!.name).toBe('office-hours-sessions-2026-09-01_to_2026-09-18.csv');
    expect(await saved[0]!.text).toBe('Date,Weekday\r\n');
  });

  it('cannot download when the end is before the start', async () => {
    open();
    const user = userEvent.setup();
    const to = screen.getByLabelText('To');
    await user.clear(to);
    await user.type(to, '2026-08-01');
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
  });

  it('shows the server message for a bad range', async () => {
    api.get.mockRejectedValue(new ApiError('RANGE_TOO_LARGE', 'Choose a range of at most one year.', 400));
    open();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(await screen.findByText('Choose a range of at most one year.')).toBeInTheDocument();
  });
});

describe('Restore from backup', () => {
  async function chooseFile(text = JSON.stringify(BACKUP)) {
    open();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Choose backup file'), file(text));
    return user;
  }

  it('checks the file first, shows what changes, and saves nothing yet', async () => {
    api.post.mockResolvedValue(check());
    await chooseFile();
    const dialog = await screen.findByRole('dialog');
    expect(api.post).toHaveBeenCalledWith('/backup/validate', BACKUP);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByText('Backup made 2026-09-10')).toBeInTheDocument();
    const days = within(dialog).getByText('Days recorded').closest('tr')!;
    expect(days).toHaveTextContent('10');
    expect(days).toHaveTextContent('12');
    expect(within(dialog).getByText(/replaces ALL your current data/)).toBeInTheDocument();
    expect(within(dialog).getByText(/2 days recorded now are not in the backup and will be deleted/)).toBeInTheDocument();
  });

  it('will not restore until REPLACE is typed exactly', async () => {
    api.post.mockResolvedValue(check());
    const user = await chooseFile();
    const dialog = await screen.findByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'Restore and replace everything' });
    const box = within(dialog).getByLabelText('Type REPLACE to confirm');
    expect(go).toBeDisabled();
    for (const wrong of ['replace', 'REPLAC', 'yes', 'REPLACE ']) {
      await user.clear(box);
      await user.type(box, wrong);
      expect(go).toBeDisabled();
    }
    await user.clear(box);
    await user.type(box, 'REPLACE');
    expect(go).toBeEnabled();
    expect(api.post).toHaveBeenCalledTimes(1); // still only the validation
  });

  it('restores with the explicit confirmation and reports success', async () => {
    api.post.mockImplementation(async (url: string) => (url === '/backup/validate' ? check() : { restored: counts(10), exportedAt: BACKUP.exportedAt }));
    const user = await chooseFile();
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Type REPLACE to confirm'), 'REPLACE');
    await user.click(within(dialog).getByRole('button', { name: 'Restore and replace everything' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/backup/restore', { confirm: 'REPLACE', backup: BACKUP }));
    expect(await within(dialog).findByText(/All your data now matches the backup/)).toBeInTheDocument();
  });

  it('offers to download the current data before replacing it', async () => {
    api.post.mockResolvedValue(check());
    api.get.mockResolvedValue(BACKUP);
    const user = await chooseFile();
    await user.click(await screen.findByRole('button', { name: /Download a backup of the current data first/ }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/backup'));
    await waitFor(() => expect(saved).toHaveLength(1));
  });

  it('shows the reason when the server refuses the file, and never opens the restore dialog', async () => {
    api.post.mockRejectedValue(new ApiError('INVALID_BACKUP', 'The backup file has been changed or damaged (its checksum does not match). Nothing was restored.', 400));
    await chooseFile();
    expect(await screen.findByText(/checksum does not match/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rejects a file that is not JSON without calling the server', async () => {
    await chooseFile('this is not json {');
    expect(await screen.findByText(/not a readable backup/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows a server refusal during the restore and keeps the dialog open', async () => {
    api.post.mockImplementation(async (url: string) => {
      if (url === '/backup/validate') return check();
      throw new ApiError('INVALID_BACKUP', 'The backup has sessions that overlap each other across days. Nothing was restored.', 400);
    });
    const user = await chooseFile();
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Type REPLACE to confirm'), 'REPLACE');
    await user.click(within(dialog).getByRole('button', { name: 'Restore and replace everything' }));
    expect(await within(dialog).findByText(/overlap each other across days/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/All your data now matches/)).not.toBeInTheDocument();
  });

  it('cancelling leaves everything untouched', async () => {
    api.post.mockResolvedValue(check());
    const user = await chooseFile();
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});
