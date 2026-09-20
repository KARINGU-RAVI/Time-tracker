import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import type { Holiday } from '@/lib/types';
import { renderAt } from '@/test/utils';
import Holidays from './Holidays';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

const H = (id: string, date: string, name: string, type: Holiday['type'] = 'COMPANY'): Holiday => ({ id, date, name, type, description: null });
const list = [H('1', '2026-03-04', 'Holi', 'OPTIONAL'), H('2', '2026-09-07', 'Company holiday'), H('3', '2026-10-19', 'Diwali')];

const CSV = 'date,name,type\n2026-10-19,Diwali,COMPANY\n2026-12-25,Christmas,OPTIONAL\n31-02-2026,Bad,COMPANY\n';
const preview = {
  rows: [
    { row: 2, date: '2026-10-19', name: 'Diwali', type: 'COMPANY', status: 'DUPLICATE' },
    { row: 3, date: '2026-12-25', name: 'Christmas', type: 'OPTIONAL', status: 'NEW' },
    { row: 4, date: null, name: 'Bad', type: 'COMPANY', status: 'ERROR', error: 'Invalid date' },
  ],
  summary: { new: 1, duplicates: 1, errors: 1 },
};

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
  api.get.mockImplementation(async (url: string) => (url === '/holidays/image' ? { exists: false } : { holidays: list, summary: { company: 2, optional: 1 } }));
});
afterEach(() => vi.useRealTimers());

const open = () => renderAt('/holidays', '/holidays', <Holidays />);

describe('Holidays list', () => {
  it('shows the year, the counts and each holiday with its type', async () => {
    open();
    expect(await screen.findByText('Diwali')).toBeInTheDocument();
    expect(screen.getByText('2026')).toBeInTheDocument();
    expect(screen.getByText(/2 company holidays · 1 optional/)).toBeInTheDocument();
    expect(screen.getByText('Mon 19 Oct')).toBeInTheDocument();
    expect(screen.getAllByText('Company')).toHaveLength(2);
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/holidays', { year: 2026 });
  });

  it('changes year', async () => {
    open();
    await screen.findByText('Diwali');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next year' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/holidays', { year: 2027 }));
  });

  it('shows the empty state with both ways to add holidays', async () => {
    api.get.mockResolvedValue({ holidays: [], summary: { company: 0, optional: 0 } });
    open();
    expect(await screen.findByText('Upload your company holiday calendar')).toBeInTheDocument();
    expect(screen.getByText(/No holidays added for 2026 yet/)).toBeInTheDocument();
  });

  it('deletes a holiday', async () => {
    api.del.mockResolvedValue(undefined);
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Delete Diwali' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/holidays/3'));
  });

  it('explains a failed load and retries', async () => {
    api.get.mockReset();
    let failed = false;
    api.get.mockImplementation(async (url: string) => {
      if (url === '/holidays/image') return { exists: false };
      if (!failed) {
        failed = true; // only the holiday list fails, once
        throw new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0);
      }
      return { holidays: list, summary: { company: 2, optional: 1 } };
    });
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Diwali')).toBeInTheDocument();
  });
});

describe('Add holiday', () => {
  it('saves a holiday and shows a server refusal', async () => {
    api.post.mockRejectedValueOnce(new ApiError('DUPLICATE', 'This record already exists.', 409));
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Add holiday$/ }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('Date'));
    await user.type(within(dialog).getByLabelText('Date'), '2026-12-25');
    await user.type(within(dialog).getByLabelText('Name'), 'Christmas');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'OPTIONAL');
    await user.click(within(dialog).getByRole('button', { name: 'Save holiday' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/holidays', { date: '2026-12-25', name: 'Christmas', type: 'OPTIONAL' }));
    expect(await within(dialog).findByText('This record already exists.')).toBeInTheDocument();
  });

  it('cannot save without a name', async () => {
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Add holiday$/ }));
    expect(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save holiday' })).toBeDisabled();
  });
});

describe('Import from a file', () => {
  async function chooseFile(csv = CSV) {
    open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Import from file' }));
    const dialog = await screen.findByRole('dialog');
    await user.upload(within(dialog).getByLabelText('Choose CSV file'), new File([csv], 'holidays_2026.csv', { type: 'text/csv' }));
    return { user, dialog };
  }

  it('previews before saving: counts, each row, and errors that will never be imported', async () => {
    api.post.mockResolvedValue(preview);
    const { dialog } = await chooseFile();
    expect(await within(dialog).findByText('1 new')).toBeInTheDocument();
    expect(within(dialog).getByText('1 duplicates')).toBeInTheDocument();
    expect(within(dialog).getByText('1 error')).toBeInTheDocument();
    expect(within(dialog).getByText('Error: Invalid date')).toBeInTheDocument();
    expect(within(dialog).getByText('Duplicate')).toBeInTheDocument();
    expect(within(dialog).getByText(/Rows with errors are never imported/)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/holidays/import/preview', { csv: CSV });
    expect(api.post).toHaveBeenCalledTimes(1); // nothing committed yet
  });

  it('skips duplicates by default and imports only the new rows', async () => {
    api.post.mockImplementation(async (url: string) => (url.endsWith('/preview') ? preview : { imported: 1, overwritten: 0, skippedDuplicates: 1, errors: 1 }));
    const { user, dialog } = await chooseFile();
    await user.click(await within(dialog).findByRole('button', { name: 'Import 1 holidays' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/holidays/import/commit', { csv: CSV, duplicates: 'skip' }));
    expect(await within(dialog).findByText(/1 holidays imported/)).toBeInTheDocument();
  });

  it('can overwrite existing holidays instead', async () => {
    api.post.mockImplementation(async (url: string) => (url.endsWith('/preview') ? preview : { imported: 1, overwritten: 1, skippedDuplicates: 0, errors: 1 }));
    const { user, dialog } = await chooseFile();
    await user.click(await within(dialog).findByLabelText('Overwrite existing'));
    await user.click(within(dialog).getByRole('button', { name: 'Import 2 holidays' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/holidays/import/commit', { csv: CSV, duplicates: 'overwrite' }));
    expect(await within(dialog).findByText(/1 overwritten/)).toBeInTheDocument();
  });

  it('cannot import when nothing would change', async () => {
    api.post.mockResolvedValue({ rows: [{ row: 2, date: null, name: 'Bad', type: 'COMPANY', status: 'ERROR', error: 'Invalid date' }], summary: { new: 0, duplicates: 0, errors: 1 } });
    const { dialog } = await chooseFile('date,name\nx,Bad');
    expect(await within(dialog).findByRole('button', { name: 'Import 0 holidays' })).toBeDisabled();
  });

  it('shows a refusal from the server', async () => {
    api.post.mockRejectedValue(new ApiError('VALIDATION_ERROR', 'The file is empty.', 400));
    const { dialog } = await chooseFile('x');
    expect(await within(dialog).findByText('The file is empty.')).toBeInTheDocument();
  });

  it('offers a downloadable template with the right columns', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:template'; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    open();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Download template' }));
    expect(click).toHaveBeenCalledTimes(1);
    const text = await blobs[0]!.text();
    expect(text.split('\n')[0]).toBe('date,name,type,description');
    click.mockRestore();
  });
});
