import { useSyncExternalStore } from 'react';

/** The browser's "install this app" offer (Chrome, Edge, Samsung Internet). It fires once, early, so it is kept here. */
interface InstallOffer extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let offer: InstallOffer | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Call once at start-up, before the page is drawn. */
export function initInstall(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // we show our own button instead of the browser's mini-bar
    offer = e as InstallOffer;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    offer = null;
    installedNow = true;
    notify();
  });
}

/** Opened from the home screen icon (no browser bars)? */
export function isInstalled(): boolean {
  if (installedNow) return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

export function isIos(): boolean {
  const nav = navigator;
  return /iphone|ipad|ipod/i.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

export function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!offer) return 'unavailable';
  const current = offer;
  offer = null; // an offer can be used only once
  notify();
  await current.prompt();
  return (await current.userChoice).outcome;
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

/** True while the browser is offering to install the app. */
export const useCanInstall = (): boolean => useSyncExternalStore(subscribe, () => offer !== null);

/** For tests. */
export function resetInstallForTests(): void {
  offer = null;
  installedNow = false;
  listeners.clear();
}
