# Expenses

A private, offline expense tracker for the iPhone Home Screen. Plain HTML, CSS and JavaScript: no dependencies, no accounts, no server, no analytics, no advertising. Your expenses stay on your device and leave it only when you export a file yourself.

> **Status: release candidate for testing with dummy data. Do not enter real financial records yet.**
> It has been tested only by automated tests in desktop Chromium. It has never run on a real iPhone, so installing to the Home Screen, working offline in Safari, the keyboard and number pad, sharing files and how long iOS keeps the data are all unverified. See [Before you trust it with real records](#before-you-trust-it-with-real-records).

## What it does

- Add, edit, delete and duplicate expenses, with categories, payment methods, tags, notes and merchants. AED is the default currency. Other currencies are kept as entered and never converted.
- Budgets with in-app alerts and a straight-line projection, and repeating expenses.
- Reports for 15 ready-made periods or your own dates, a side-by-side comparison of two periods, search and filters.
- An optional passcode that locks the app and encrypts the stored records.
- Backups only when you ask (optionally with their own password), restored by replacing or adding.
- Export to CSV. **PDF reports are not available yet**; the Export sheet in Reports says so.
- Works offline after the first visit. A new version downloads quietly and starts the next time you open the app from scratch.

## Documents

- [PRIVACY_AND_SECURITY.md](PRIVACY_AND_SECURITY.md): what stays on the phone, what can leave it, how it is protected and where the protection stops.
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): what is verified, what is not, and what is missing.

Both match the Privacy and Known limitations pages inside the app (`docs/js/ui/screens/info_text.js`).

## Install on an iPhone

1. Open the app's address in **Safari**: `https://<account>.github.io/expenses-web/`.
2. Tap Share, then **Add to Home Screen**.
3. Open it from the new icon, not from a Safari tab. The Home Screen app usually keeps its own storage, so data entered in a Safari tab may not appear there.

## Publish with GitHub Pages

The site is the `docs/` folder. In the repository on GitHub: **Settings, Pages, Build and deployment, Source: Deploy from a branch**, then pick the branch (currently `wip-web-app`) and the folder **/docs**, and Save. The address appears at the top of that page after a minute or two.

All Pages sites of one account share one web address and one browser storage area, so keep `<account>.github.io` for this app alone (see [PRIVACY_AND_SECURITY.md](PRIVACY_AND_SECURITY.md)).

## Develop

Node 22 is the only requirement for the app and the unit tests. The browser tests also need Playwright and Chromium.

```
npm test                                   unit tests
node tools/serve.mjs                       try the app at http://localhost:8080/ (also served at /expenses-web/)
node tests/e2e/<name>.mjs [light|dark]     one browser test (SHOTS_DIR=... sets where screenshots go)
node tools/build_sw.mjs                    run after ANY change inside docs/ (rewrites the file list and version in docs/sw.js)
node tools/build_sw.mjs --check            fails if docs/sw.js is out of date (the unit tests run this too)
```

How updates work: the offline worker's cache is named after a fingerprint of every file in `docs/`. After a change, `tools/build_sw.mjs` gives it a new name, the phone downloads the new version in the background, and it takes over only when the app is next opened from scratch. If the download fails part-way, the old version keeps working.

## Before you trust it with real records

Use **dummy data only** and check each of these on a real iPhone, from the Home Screen icon:

1. Add, edit, delete and duplicate a few expenses.
2. Type amounts with the number pad and the keyboard. The sheet must stay visible above the keyboard.
3. Move around: the tabs, swiping back, the date fields.
4. Turn the passcode on. Lock, force-quit, reopen and unlock. Try a wrong passcode.
5. Make a backup (with a password). Delete an expense. Restore the backup. The expense must come back.
6. Switch on Airplane Mode, open the app, add an expense, force-quit and reopen. It must still be there.
7. Try light and dark mode, and a larger text size (Settings, Display & Brightness, Text Size).
8. Open Reports, compare two periods, and export a CSV file you can open.
9. Come back after a day or two. The data must still be there. Read About, "Protected from clearing".
10. Read Privacy and Known limitations in the app.

Anything that behaves differently from this list is a bug to fix before real records go in.

## Layout

```
docs/          the published site (index.html, css/, js/, icons/, manifest.webmanifest, sw.js)
docs/js/core   money, dates, budgets, reports, encryption and backup logic (no screens)
docs/js/data   where records are stored (IndexedDB) and unlocking
docs/js/ui     screens and components
tests/         unit tests (node --test) and browser tests (tests/e2e)
tools/         local server, offline-copy builder, icon script
```
