// The offline copy of the app (a service worker) and finding out whether a newer version has been downloaded.
//
// A new version is downloaded in the background but only takes over the next time the app is opened from scratch, never
// in the middle of a session: part of the app swapping to a different version while you use it could break it.

export function offlineSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** { supported, registered, controlled, waiting } for the About page. */
export async function updateStatus() {
  if (!offlineSupported()) return { supported: false, registered: false, controlled: false, waiting: false };
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      supported: true,
      registered: Boolean(registration),
      controlled: Boolean(navigator.serviceWorker.controller),
      waiting: Boolean(registration && registration.waiting),
    };
  } catch {
    return { supported: true, registered: false, controlled: false, waiting: false };
  }
}

function settled(worker) {
  return new Promise((resolve) => {
    const done = () => {
      if (worker.state === 'installed' || worker.state === 'activated' || worker.state === 'redundant') resolve(worker.state);
    };
    if (['installed', 'activated', 'redundant'].includes(worker.state)) {
      resolve(worker.state);
      return;
    }
    worker.addEventListener('statechange', done);
  });
}

/**
 * Looks for a newer version. Resolves 'new' (downloaded, starts next time the app is opened), 'current', 'offline' or 'unavailable'.
 * Nothing about the person or their data is sent: it only asks the website for the app's own files.
 */
export async function checkForUpdate() {
  if (!offlineSupported()) return 'unavailable';
  let registration;
  try {
    registration = await navigator.serviceWorker.getRegistration();
  } catch {
    return 'unavailable';
  }
  if (!registration) return 'unavailable';
  if (registration.waiting) return 'new';
  try {
    await registration.update();
  } catch {
    return 'offline';
  }
  if (registration.waiting) return 'new';
  if (registration.installing) {
    const state = await settled(registration.installing);
    return state === 'installed' || registration.waiting ? 'new' : 'current';
  }
  return 'current';
}
