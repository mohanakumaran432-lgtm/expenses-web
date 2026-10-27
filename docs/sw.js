// The offline copy of the app. It keeps this app's own files and nothing else. It never asks another website for anything,
// never stores what a person types, and never sends anything anywhere.
//
// How updates work, on purpose (part of the app swapping to a different version in the middle of a session could break it):
//  - Every change to the app changes this file: VERSION below is a fingerprint of all the app's files, so the browser notices.
//  - A new version downloads in the background into its own cache and then WAITS. It takes over only when the app is opened
//    from scratch, after every window of the app has been closed. The old copy is deleted at that point.
//  - If any file fails to download, the new version is not installed at all and the old one keeps working.
//
// The part between BEGIN and END is written by `node tools/build_sw.mjs`. Do not edit it by hand.

// BEGIN GENERATED (node tools/build_sw.mjs)
const VERSION = 'b792f990a178';
const FILES = [
  'css/base.css',
  'css/components.css',
  'css/screens.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'index.html',
  'js/core/alerts.js',
  'js/core/amount_input.js',
  'js/core/app_lock.js',
  'js/core/backup.js',
  'js/core/budget_service.js',
  'js/core/budgets.js',
  'js/core/calendar.js',
  'js/core/catalog_service.js',
  'js/core/comparison.js',
  'js/core/crypto.js',
  'js/core/csv.js',
  'js/core/currency.js',
  'js/core/data_service.js',
  'js/core/dayrange.js',
  'js/core/encoding.js',
  'js/core/expense_service.js',
  'js/core/format.js',
  'js/core/localdate.js',
  'js/core/lock_settings.js',
  'js/core/models.js',
  'js/core/money.js',
  'js/core/periods.js',
  'js/core/query.js',
  'js/core/recurrence.js',
  'js/core/recurrence_service.js',
  'js/core/report_document.js',
  'js/core/reports.js',
  'js/core/snapshot.js',
  'js/core/text.js',
  'js/core/util.js',
  'js/core/validation.js',
  'js/core/vault.js',
  'js/data/backend_indexeddb.js',
  'js/data/backend_memory.js',
  'js/data/ledger_store.js',
  'js/data/lock_store.js',
  'js/data/passcode_authenticator.js',
  'js/data/stores.js',
  'js/data/unlock_flow.js',
  'js/ui/backup_memory.js',
  'js/ui/chart_math.js',
  'js/ui/charts.js',
  'js/ui/components.js',
  'js/ui/controller.js',
  'js/ui/dom.js',
  'js/ui/exports.js',
  'js/ui/files.js',
  'js/ui/icons.js',
  'js/ui/layers.js',
  'js/ui/main.js',
  'js/ui/screens/amount_pad.js',
  'js/ui/screens/backup_flow.js',
  'js/ui/screens/budget_editor.js',
  'js/ui/screens/budgets.js',
  'js/ui/screens/categories.js',
  'js/ui/screens/drilldown.js',
  'js/ui/screens/erase.js',
  'js/ui/screens/expense_form.js',
  'js/ui/screens/file_ready.js',
  'js/ui/screens/filters.js',
  'js/ui/screens/home.js',
  'js/ui/screens/info_text.js',
  'js/ui/screens/lock.js',
  'js/ui/screens/methods_tags.js',
  'js/ui/screens/passcode_fields.js',
  'js/ui/screens/pickers.js',
  'js/ui/screens/reauth.js',
  'js/ui/screens/recurring.js',
  'js/ui/screens/recurring_editor.js',
  'js/ui/screens/reorder.js',
  'js/ui/screens/report_compare.js',
  'js/ui/screens/report_detail.js',
  'js/ui/screens/report_parts.js',
  'js/ui/screens/reports.js',
  'js/ui/screens/rows.js',
  'js/ui/screens/settings.js',
  'js/ui/screens/settings_about.js',
  'js/ui/screens/settings_backup.js',
  'js/ui/screens/settings_delete.js',
  'js/ui/screens/settings_display.js',
  'js/ui/screens/settings_info.js',
  'js/ui/screens/settings_lock.js',
  'js/ui/screens/settings_notifications.js',
  'js/ui/screens/style_pickers.js',
  'js/ui/screens/tabs.js',
  'js/ui/screens/transaction_list.js',
  'js/ui/screens/transactions.js',
  'js/ui/screens/welcome.js',
  'js/ui/shell.js',
  'js/ui/typing.js',
  'js/ui/updates.js',
  'js/ui/version.js',
  'manifest.webmanifest',
];
// END GENERATED

const PREFIX = 'expenses-';
const CACHE = `${PREFIX}${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      for (const file of FILES) {
        // 'reload' asks the website itself, not the browser's own short-lived copy, so the new version is complete and consistent.
        const response = await fetch(new Request(file, { cache: 'reload' }));
        if (!response.ok) throw new Error(`Could not download ${file}`);
        await cache.put(file, response.clone());
        if (file === 'index.html') await cache.put('./', response);
      }
    } catch (error) {
      await caches.delete(CACHE); // never leave half a version behind; the working copy carries on
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    }
    // Lets the very first visit work offline straight away. (Updates never get here while the app is open.)
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return; // other addresses are none of this file's business
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // The app is one page: any page address gets that page, whatever comes after the ? in it.
    const hit = await cache.match(request.mode === 'navigate' ? 'index.html' : request, { ignoreSearch: true });
    return hit || fetch(request);
  })());
});
