// The words of the Privacy and Known limitations pages. Plain language, no promises the app cannot keep.
// Each section: { title, lead?: one paragraph, items?: [text] }.
//
// Keep these in step with docs/PRIVACY_AND_SECURITY.md and docs/KNOWN_LIMITATIONS.md in the project.

export const PRIVACY_SECTIONS = Object.freeze([
  {
    title: 'Your data stays on this iPhone',
    items: [
      'Everything you enter is stored in this browser\'s storage on your iPhone. There is no account, no server and no cloud copy.',
      'The app has no analytics, no advertising, no trackers, no crash reporter and no third-party code.',
      'The app contains no code that sends your data anywhere, and its security policy tells the browser to block the page from making network requests at all.',
      'Your financial records are never given to an AI service or any outside program.',
    ],
  },
  {
    title: 'What does leave your iPhone',
    items: [
      'Only what you export yourself: a CSV file, a PDF report or a backup file. They go through the iPhone\'s share sheet to the place you pick. The app never uploads anything on its own.',
      'To open the app, your iPhone downloads its program files from the website that hosts it. That website can see that a device asked for the files, and when, with the usual details such as the internet address and browser type. It never sees your expenses. Once the app is on your Home Screen it opens from the copy on your iPhone and only checks for a newer version when it is online.',
    ],
  },
  {
    title: 'How it is protected',
    items: [
      'Passcode (optional but recommended): it locks the app and encrypts what is stored. A key is made from the passcode (PBKDF2 with 600,000 rounds) and every record is encrypted with AES-256-GCM. The passcode itself is never stored, and there is no way to recover a forgotten one.',
      'Without a passcode, the app does not encrypt what it stores. Your iPhone\'s own passcode and data protection still apply.',
      'While the app is locked, none of your data is drawn on the screen, not even hidden.',
      'Leaving the app covers the screen so the picture iOS keeps for the app switcher shows no amounts. This is done by the web page, is best effort, and has not been verified on every iPhone.',
      'Alerts stay inside the app. Nothing is ever shown on your lock screen. Alert text leaves out amounts and budget names unless you switch that on.',
      'Nothing about your spending is written to logs or crash reports, and the diagnostics on the About page are counts only.',
      'Backups happen only when you ask. A backup can be protected with its own password (AES-256-GCM); without one the file is readable by anyone who gets it.',
    ],
  },
  {
    title: 'What it cannot do',
    items: [
      'It cannot use Face ID or Touch ID. A web app has no safe way to, so the passcode is always asked for.',
      'It cannot stop screenshots, screen recording or someone looking at your screen.',
      'It cannot protect you when your iPhone is unlocked in someone else\'s hands, or when the phone itself is compromised.',
      'A short number passcode is quick to type but can be found by someone who copies your stored data and tries every combination on a fast computer. Longer, with letters and numbers, is far stronger. The waiting time after wrong tries only slows down someone using the app itself.',
      'Someone who can copy this app\'s stored data could delete or roll back records without the app noticing.',
      'Changing the passcode protects what is stored from then on. It does not affect copies of the data made earlier.',
      'Erasing deletes the data the way a browser deletes website data. Traces can remain in the phone\'s storage until it is overwritten.',
      'Whoever controls the website that serves this app can change the program your iPhone runs the next time it updates. If you host it yourself, protect that account with two-factor authentication.',
    ],
  },
  {
    title: 'What you should do',
    items: [
      'Choose a passcode that is long, ideally with letters and numbers.',
      'Make a backup now and then, protect it with a password if you keep it in the cloud, and keep a copy somewhere other than this iPhone.',
      'Open the app from its Home Screen icon, not from a Safari tab, so it uses the saved copy and its own storage.',
      'Delete exported files you no longer need.',
    ],
  },
]);

export const LIMITATION_SECTIONS = Object.freeze([
  {
    title: 'Tested here, not yet on your iPhone',
    lead: 'This version was built and tested in a desktop browser engine (Chromium) on a computer, never in Safari on an iPhone. If something looks or behaves differently on your phone, treat it as a bug, not as how it is meant to be. Things most likely to differ:',
    items: [
      'Sharing and saving files (backups, CSV, PDF reports).',
      'The keyboard, the number pad and how the screen resizes when the keyboard opens.',
      'The cover shown in the app switcher.',
      'Spacing around the notch and Home bar, swiping back, and larger text sizes.',
      'How long iOS keeps the stored data.',
    ],
  },
  {
    title: 'What a web app on iPhone cannot do',
    items: [
      'No Face ID or Touch ID. The passcode is always asked for.',
      'No notifications on the lock screen or while the app is closed. Budget alerts and reminders appear when you open the app.',
      'Repeating expenses are added when you open the app, not at the moment they are due. A bill due on the 1st that you open the app on the 3rd is recorded on the 3rd, dated the 1st.',
      'iOS decides when stored website data may be removed. Making backups is what keeps your records safe.',
      'The app cannot control whether iOS includes its stored data in iPhone backups.',
      'PDF reports are made of page pictures, so their text cannot be selected or searched. Use the CSV file for that.',
      'The date box shows dates in your iPhone\'s own format, whatever format you choose for the rest of the app.',
      'Swiping a row to delete is not offered. Delete from the edit screen, or use Select in Transactions.',
    ],
  },
  {
    title: 'Left out on purpose',
    items: [
      'Currency conversion and exchange rates. Expenses keep the currency they were saved in, and totals count one currency at a time.',
      'Accounts, sign-in, cloud sync, analytics, advertising and any outside service.',
      'Importing CSV files, receipt photos, bank connections, widgets, Apple Watch, shared ledgers and languages other than English.',
    ],
  },
  {
    title: 'Money, dates and limits',
    items: [
      'An amount can have up to 10 digits before the decimal point. Dates run from 1 January 2000 to one year ahead.',
      'Periods, weeks, months and years follow the Gregorian calendar, whatever calendar the phone shows.',
      '"Today" is the phone\'s current day. Each expense keeps the day you chose, so travelling does not move old expenses.',
      'Average per day counts the days that have passed, including days with nothing spent, and not the days still to come.',
      'A budget projection is a straight-line estimate from your spending so far. It says so on screen, and early in a period it is marked early.',
      'Search finds expenses containing every word you type, ignoring capitals and accents. It does not correct spelling.',
    ],
  },
  {
    title: 'Colour',
    items: [
      'You can choose your own category colours, and some may be hard to tell apart, especially with colour-vision differences. Charts always show names, amounts and percentages as well, and never rely on colour alone.',
    ],
  },
  {
    title: 'Restoring and merging',
    items: [
      'Replace all swaps everything for the backup. Add to this keeps what is here and adds what the backup has, matching records by their own identity and categories by name. Nothing is deleted by adding.',
      'The lock passcode is not part of a backup. After restoring on another phone, turn the passcode on again.',
    ],
  },
]);
