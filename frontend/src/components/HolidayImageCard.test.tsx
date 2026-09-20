import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { ImageError } from '@/lib/image';
import { HolidayImageCard } from './HolidayImageCard';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn(), putBinary: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));
const shrink = vi.hoisted(() => vi.fn());
vi.mock('@/lib/image', async (orig) => ({ ...(await orig<typeof import('@/lib/image')>()), shrinkImage: shrink }));

const META = { exists: true, mimeType: 'image/jpeg', width: 1200, height: 800, fileName: 'company-holidays.jpg', updatedAt: '2026-09-20T08:00:00.000Z' };

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return { ...render(<QueryClientProvider client={client}><HolidayImageCard /></QueryClientProvider>), invalidate };
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  shrink.mockReset();
});

const chooseFile = (name = 'calendar.png', type = 'image/png') =>
  fireEvent.change(screen.getByLabelText('Choose a picture'), { target: { files: [new File(['x'], name, { type })] } });

describe('holiday calendar picture', () => {
  it('invites an upload when there is none, and explains what it is for', async () => {
    api.get.mockResolvedValue({ exists: false });
    mount();
    expect(await screen.findByRole('button', { name: 'Upload a picture' })).toBeInTheDocument();
    expect(screen.getByText(/Any photo or screenshot works/)).toBeInTheDocument();
    expect(screen.getByText(/only for viewing/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('accepts any kind of picture in the file chooser', async () => {
    api.get.mockResolvedValue({ exists: false });
    mount();
    expect(await screen.findByLabelText('Choose a picture')).toHaveAttribute('accept', 'image/*');
  });

  it('shrinks the chosen file, uploads it with its size and name, and refreshes', async () => {
    api.get.mockResolvedValue({ exists: false });
    const blob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
    shrink.mockResolvedValue({ blob, width: 1600, height: 900, name: 'calendar.jpg' });
    api.putBinary.mockResolvedValue(META);
    const { invalidate } = mount();
    await screen.findByRole('button', { name: 'Upload a picture' });
    chooseFile('calendar.png');
    await waitFor(() => expect(api.putBinary).toHaveBeenCalledWith('/holidays/image', blob, 'image/jpeg', { width: 1600, height: 900, name: 'calendar.jpg' }));
    expect(shrink).toHaveBeenCalledTimes(1);
    expect((shrink.mock.calls[0]![0] as File).name).toBe('calendar.png');
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['holiday-image'] }));
  });

  it('shows the picture with a cache-busting address, its date, and opens it full size', async () => {
    api.get.mockResolvedValue(META);
    mount();
    const img = await screen.findByAltText('Your holiday calendar');
    expect(img).toHaveAttribute('src', `/api/holidays/image/file?v=${encodeURIComponent(META.updatedAt)}`);
    expect(screen.getByText('Updated Sun, 20 Sep 2026')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'View full size' }));
    const full = await screen.findByAltText('Your holiday calendar, full size');
    expect(full).toHaveAttribute('width', '1200');
    expect(full).toHaveAttribute('height', '800');
    expect(screen.getByText('company-holidays.jpg')).toBeInTheDocument();
  });

  it('replaces the picture through the same chooser', async () => {
    api.get.mockResolvedValue(META);
    shrink.mockResolvedValue({ blob: new Blob(['n'], { type: 'image/jpeg' }), width: 10, height: 10, name: 'new.jpg' });
    api.putBinary.mockResolvedValue({ ...META, fileName: 'new.jpg' });
    mount();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Replace' }));
    chooseFile('new.png');
    await waitFor(() => expect(api.putBinary).toHaveBeenCalled());
  });

  it('asks before removing, and can be cancelled', async () => {
    api.get.mockResolvedValue(META);
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Yes, remove it' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(api.del).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('removes it once confirmed, and shows the empty state again', async () => {
    api.get.mockResolvedValueOnce(META).mockResolvedValue({ exists: false });
    api.del.mockResolvedValue(undefined);
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    await user.click(screen.getByRole('button', { name: 'Yes, remove it' }));
    expect(api.del).toHaveBeenCalledWith('/holidays/image');
    expect(await screen.findByRole('button', { name: 'Upload a picture' })).toBeInTheDocument();
  });

  it('explains a picture the browser cannot open, without uploading anything', async () => {
    api.get.mockResolvedValue({ exists: false });
    shrink.mockRejectedValue(new ImageError("This browser can't open that kind of picture. Try a JPG or PNG."));
    mount();
    await screen.findByRole('button', { name: 'Upload a picture' });
    chooseFile('photo.heic', 'image/heic');
    expect(await screen.findByRole('alert')).toHaveTextContent("This browser can't open that kind of picture. Try a JPG or PNG.");
    expect(api.putBinary).not.toHaveBeenCalled();
  });

  it('shows the server message when an upload is refused, and keeps any existing picture', async () => {
    api.get.mockResolvedValue(META);
    shrink.mockResolvedValue({ blob: new Blob(['n'], { type: 'image/jpeg' }), width: 10, height: 10, name: 'n.jpg' });
    api.putBinary.mockRejectedValue(new ApiError('IMAGE_TOO_LARGE', 'The picture is too large. Use one under 1 MB.', 413));
    mount();
    await screen.findByAltText('Your holiday calendar');
    chooseFile();
    expect(await screen.findByRole('alert')).toHaveTextContent('The picture is too large. Use one under 1 MB.');
    expect(screen.getByAltText('Your holiday calendar')).toBeInTheDocument();
  });

  it('explains a failed load', async () => {
    api.get.mockRejectedValue(new ApiError('NETWORK_ERROR', "Can't reach the server. Check your connection and try again.", 0));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Can't reach the server/);
  });
});
