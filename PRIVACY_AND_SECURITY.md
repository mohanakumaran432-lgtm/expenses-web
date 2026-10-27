# Privacy and security

What the app does with your data, and where its protection stops. The same words are in the app (Settings, About, Privacy). They promise only what the app can keep.

**This app is not completely secure, because no software is, and it has not had an independent security review. It has also never run on a real iPhone, so do not put real financial records in it until the checks in the [README](README.md#before-you-trust-it-with-real-records) have passed.**

## Your data stays on this iPhone

- Everything you enter is stored in this browser's storage on your iPhone. There is no account, no server and no cloud copy.
- The app has no analytics, no advertising, no trackers, no crash reporter and no third-party code.
- The app contains no code that sends your data anywhere, and its security policy tells the browser to block the page from making network requests at all.
- Your financial records are never given to an AI service or any outside program.

## What does leave your iPhone

- Only what you export yourself: a CSV file or a backup file. They go through the iPhone's share sheet to the place you pick. The app never uploads anything on its own.
- To open the app, your iPhone downloads its program files from the website that hosts it. That website can see that a device asked for the files, and when, with the usual details such as the internet address and browser type. It never sees your expenses. Once the app is on your Home Screen it opens from the copy on your iPhone and only checks for a newer version when it is online.

## How it is protected

- Passcode (optional but recommended): it locks the app and encrypts what is stored. A key is made from the passcode (PBKDF2 with 600,000 rounds) and every record is encrypted with AES-256-GCM. The passcode itself is never stored, and there is no way to recover a forgotten one.
- Without a passcode, the app does not encrypt what it stores. Your iPhone's own passcode and data protection still apply.
- While the app is locked, none of your data is drawn on the screen, not even hidden.
- Leaving the app covers the screen so the picture iOS keeps for the app switcher shows no amounts. This is done by the web page, is best effort, and has not been verified on every iPhone.
- Alerts stay inside the app. Nothing is ever shown on your lock screen. Alert text leaves out amounts and budget names unless you switch that on.
- Nothing about your spending is written to logs or crash reports, and the diagnostics on the About page are counts only.
- Backups happen only when you ask. A backup can be protected with its own password (AES-256-GCM); without one the file is readable by anyone who gets it.

## What it cannot do

- It cannot use Face ID or Touch ID. A web app has no safe way to, so the passcode is always asked for.
- It cannot stop screenshots, screen recording or someone looking at your screen.
- It cannot protect you when your iPhone is unlocked in someone else's hands, or when the phone itself is compromised.
- A short number passcode is quick to type but can be found by someone who copies your stored data and tries every combination on a fast computer. Longer, with letters and numbers, is far stronger. The waiting time after wrong tries only slows down someone using the app itself.
- Someone who can copy this app's stored data could delete or roll back records without the app noticing.
- Changing the passcode protects what is stored from then on. It does not affect copies of the data made earlier.
- Erasing deletes the data the way a browser deletes website data. Traces can remain in the phone's storage until it is overwritten.
- Whoever controls the website that serves this app can change the program your iPhone runs the next time it updates. If you host it yourself, protect that account with two-factor authentication.
- Websites on the same address share one browser storage area. On a shared address such as yourname.github.io, any other page you publish there could read what this app stores. Keep that address for this app alone, and use a passcode so the stored records are encrypted.

## What you should do

- Choose a passcode that is long, ideally with letters and numbers.
- Make a backup now and then, protect it with a password if you keep it in the cloud, and keep a copy somewhere other than this iPhone.
- Open the app from its Home Screen icon, not from a Safari tab, so it uses the saved copy and its own storage.
- Delete exported files you no longer need.

## Notes for whoever hosts it

- This repository is public. It holds the program, never anyone's expenses.
- The app is served over HTTPS by GitHub Pages. As any web host does, it sees which files a device downloads and when. It cannot see what you enter.
- Every GitHub Pages site of one account shares one web address (`yourname.github.io`), and so one browser storage area. See "What it cannot do" above: keep that address for this app alone, or use a custom domain or a separate account for it.
- The page's security policy (in `docs/index.html`) allows only the app's own scripts and styles and blocks every network request the page could make (`connect-src 'none'`). The offline worker (`docs/sw.js`) only touches GET requests to the app's own address: it answers them from its saved copy and asks the same website only for a file it does not have.
- The unit tests fail if a page script uses `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `EventSource`, builds markup from text, or if the page or the worker names an outside address.
- Nothing about spending is written to the browser console. The summary on the About page holds counts only.
