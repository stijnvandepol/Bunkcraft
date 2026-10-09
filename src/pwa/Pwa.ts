import { button, h } from '../ui/dom';
import './pwa.css';

/** Chrome/Edge/Android install prompt event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** True when the browser offers to install the game right now (not yet installed). */
export function installAvailable(): boolean {
  return deferredPrompt !== null;
}

/** Subscribe to install availability changes; returns an unsubscribe function. */
export function onInstallChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Shows the browser's install dialog. Resolves true when the player accepted. */
export async function promptInstall(): Promise<boolean> {
  const ev = deferredPrompt;
  if (!ev) return false;
  deferredPrompt = null;
  notify();
  await ev.prompt();
  return (await ev.userChoice).outcome === 'accepted';
}

/**
 * An "Install App" button that is only visible while the browser offers installation.
 * `cls` lets the caller style it for its place (options grid, title screen).
 */
export function installButton(cls = ''): HTMLButtonElement {
  const btn = button('Install App', () => void promptInstall(), { cls });
  const sync = () => btn.classList.toggle('hidden', !installAvailable());
  sync();
  onInstallChange(sync);
  return btn;
}

function showUpdateToast(worker: ServiceWorker): void {
  if (document.querySelector('.pwa-toast')) return;
  const toast = h('div', { class: 'pwa-toast bc', role: 'status' },
    h('span', { text: 'A new version of BunkCraft is available.' }),
    button('Reload', () => worker.postMessage({ type: 'SKIP_WAITING' })),
    button('Later', () => toast.remove()),
  );
  document.body.append(toast);
}

/** Registers the service worker (production builds only) and wires the update and install flows. */
export function initPwa(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });

  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install claims the page too; only reload when an older version was replaced.
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then((reg) => {
      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast(worker);
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg.waiting);
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      // Long-lived tabs (and installed apps) check for a new version now and then.
      const check = () => void reg.update().catch(() => undefined);
      window.setInterval(check, 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    }, (e) => console.warn('Service worker registration failed', e));
  });
}
