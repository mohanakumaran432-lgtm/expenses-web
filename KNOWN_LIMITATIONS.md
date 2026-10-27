# Known limitations

The same words are in the app (Settings, About, Known limitations).

## Where this release stands

- **Checked, in desktop Chromium only (automated tests):** the unit tests, and browser tests of expenses, transactions, budgets, repeating expenses, lists, passcode lock, backup and restore, delete, going back, and the offline copy with updates.
- **Not checked:** anything that depends on Safari or iOS. That covers installing to the Home Screen, working offline there, the keyboard and number pad, safe areas, the share sheet for backups and CSV files, the cover in the app switcher, larger text, and how long iOS keeps the stored data. The checklist for that is in the [README](README.md#before-you-trust-it-with-real-records).
- **Not in this release:** PDF reports, swipe to delete, Face ID or Touch ID, notifications, cloud sync and CSV import.

Until the iPhone checks pass, treat the app as a test version and use dummy data.

## Tested here, not yet on your iPhone

This version was built and tested in a desktop browser engine (Chromium) on a computer, never in Safari on an iPhone. If something looks or behaves differently on your phone, treat it as a bug, not as how it is meant to be. Things most likely to differ:

- Adding the app to the Home Screen, working offline and getting new versions.
- Sharing and saving files (backups and CSV files).
- The keyboard, the number pad and how the screen resizes when the keyboard opens.
- The cover shown in the app switcher.
- Spacing around the notch and Home bar, swiping back, and larger text sizes.
- How long iOS keeps the stored data.

## What a web app on iPhone cannot do

- No Face ID or Touch ID. The passcode is always asked for.
- No notifications on the lock screen or while the app is closed. Budget alerts and reminders appear when you open the app.
- Repeating expenses are added when you open the app, not at the moment they are due. A bill due on the 1st that you open the app on the 3rd is recorded on the 3rd, dated the 1st.
- A new version never replaces the one you are using. It is downloaded quietly and starts the next time you open the app from scratch: swipe it away in the app switcher, then open it again.
- iOS decides when stored website data may be removed. Making backups is what keeps your records safe.
- The app cannot control whether iOS includes its stored data in iPhone backups.
- PDF reports are not available yet. The Export button in Reports offers a CSV file of the expenses in the report instead.
- The date box shows dates in your iPhone's own format, whatever format you choose for the rest of the app.
- Swiping a row to delete is not offered. Delete from the edit screen, or use Select in Transactions.

## Left out on purpose

- Currency conversion and exchange rates. Expenses keep the currency they were saved in, and totals count one currency at a time.
- Accounts, sign-in, cloud sync, analytics, advertising and any outside service.
- Importing CSV files, receipt photos, bank connections, widgets, Apple Watch, shared ledgers and languages other than English.

## Money, dates and limits

- An amount can have up to 10 digits before the decimal point. Dates run from 1 January 2000 to one year ahead.
- Periods, weeks, months and years follow the Gregorian calendar, whatever calendar the phone shows.
- "Today" is the phone's current day. Each expense keeps the day you chose, so travelling does not move old expenses.
- Average per day counts the days that have passed, including days with nothing spent, and not the days still to come.
- A budget projection is a straight-line estimate from your spending so far. It says so on screen, and early in a period it is marked early.
- Search finds expenses containing every word you type, ignoring capitals and accents. It does not correct spelling.

## Colour

- You can choose your own category colours, and some may be hard to tell apart, especially with colour-vision differences. Charts always show names, amounts and percentages as well, and never rely on colour alone.

## Restoring and merging

- Replace all swaps everything for the backup. Add to this keeps what is here and adds what the backup has, matching records by their own identity and categories by name. Nothing is deleted by adding.
- The lock passcode is not part of a backup. After restoring on another phone, turn the passcode on again.

## Hosting

- All GitHub Pages sites of one account share one web address and one browser storage area. Keep the address this app is served from for this app alone, and use a passcode.
- The stored data belongs to the address the app was opened from, so the same app opened from another address starts empty. On iPhone the Home Screen app usually also keeps its own storage, apart from a Safari tab. Move data between them with a backup.
