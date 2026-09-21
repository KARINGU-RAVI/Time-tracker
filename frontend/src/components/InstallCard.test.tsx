import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initInstall, resetInstallForTests } from '@/lib/install';
import { InstallCard } from './InstallCard';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

function setup({ ua, standalone = false }: { ua: string; standalone?: boolean }) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(ua === DESKTOP ? 'Win32' : 'iPhone');
  window.matchMedia = vi.fn().mockReturnValue({ matches: standalone }) as unknown as typeof window.matchMedia;
  initInstall();
}

/** The browser saying "this app can be installed". */
function browserOffers(outcome: 'accepted' | 'dismissed') {
  const prompt = vi.fn(async () => undefined);
  const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome }) });
  act(() => void window.dispatchEvent(e));
  return { prompt, event: e };
}

beforeEach(() => resetInstallForTests());
afterEach(() => vi.restoreAllMocks());

describe('InstallCard', () => {
  it('offers an Install button when the browser allows it, and uses the browser prompt once', async () => {
    setup({ ua: ANDROID });
    render(<InstallCard />);
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
    const { prompt, event } = browserOffers('accepted');
    expect(event.defaultPrevented).toBe(true); // our button replaces the browser's own bar
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Install app' }));
    expect(prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull()); // an offer works only once
  });

  it('is friendly when the person says no', async () => {
    setup({ ua: ANDROID });
    render(<InstallCard />);
    browserOffers('dismissed');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Install app' }));
    expect(await screen.findByText(/No problem/)).toBeInTheDocument();
  });

  it('tells iPhone users the Safari steps, because iPhones have no install button', () => {
    setup({ ua: IPHONE });
    render(<InstallCard />);
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull();
  });

  it('gives Android browsers without the offer the menu steps', () => {
    setup({ ua: ANDROID });
    render(<InstallCard />);
    expect(screen.getByText(/browser menu/)).toBeInTheDocument();
  });

  it('shows nothing once the app is already installed', () => {
    setup({ ua: IPHONE, standalone: true });
    const { container } = render(<InstallCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing on a computer where the browser does not offer to install it', () => {
    setup({ ua: DESKTOP });
    const { container } = render(<InstallCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('disappears after the app gets installed', async () => {
    setup({ ua: ANDROID });
    render(<InstallCard />);
    browserOffers('accepted');
    expect(await screen.findByRole('button', { name: 'Install app' })).toBeInTheDocument();
    act(() => void window.dispatchEvent(new Event('appinstalled')));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install app' })).toBeNull());
    expect(screen.queryByText(/browser menu/)).toBeNull();
  });
});
