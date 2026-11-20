# Split-Bill — Shared Expense Tracker

A lightweight, mobile-friendly web app for hostel and trip groups.
Track shared mess bills, Wi-Fi, groceries and trip expenses, see who owes
whom, and settle with a one-click UPI payment link.

Core features are free. No account, no paywall on the core tracker.

## Features

- **Groups** — create and switch groups (e.g. “Hostel — Room 4”, “Goa Trip”)
- **Members** — name + optional UPI ID, edit and delete
- **Expenses** — description, amount in ₹, category
  (Mess, Wi-Fi, Groceries, Trip, Other), paid by, date,
  split equally among selected members
- **Dashboard** — total spent, per-person paid / share / balance,
  spending by category. Tap any category card and a popup shows
  the names: who paid and what each person's share was in that
  category. In Expenses, filtering by a category also lists the
  involved member names under the filter.
- **Activity** — a new Activity tab logs every change, newest
  first, with date/time, the person's name and the action:
  expense added / edited / deleted (with amount, category and
  paid by), member added / edited / deleted, group created,
  and settlement marked as paid. Choose your name in “You are”
  at the top of the app so updates are attributed to you;
  without it, updates say “Someone”. The log is stored with
  the group in localStorage, so it survives reload. Copy the
  activity summary, share it on WhatsApp, or export it as CSV.
- **Settlements** — simplified who-pays-whom, with the fewest
  transactions needed. Tap **Mark as paid** after paying — the
  payment is recorded, balances update, and it is logged in
  Activity (with Undo if it was a mistake).
- **Settle via UPI** — one-tap `upi://pay?pa=<upi>&pn=<name>&am=<amount>&cu=INR`
  link, plus a Copy link button. If a member has no UPI ID, the app
  asks you to add it instead of making a broken link.
- **Export** — Export CSV (free) and Print / Save as PDF (free, via the
  browser print dialog). Export the whole group as JSON and import
  it on another device — see “Sharing updates with others” below.
- **Pro (coming soon)** — one-time ₹99 upgrade for formatted PDF
  reports and receipt scanning. This is a placeholder in the UI;
  it does not lock any core feature.
- **Offline-first** — data is stored on the device in `localStorage`
  (`splitbill_v1`). Works as an installable PWA.

## How to run locally

```bash
# from this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

Or use any static file server. Do not open `index.html` with
`file://` for the service worker — the app itself works, but
service-worker registration is skipped there by design.

## How to test the balances

1. Load the demo group (button on the empty state), or create a group
   with 3 members.
2. Demo: Aarav pays ₹900 Mess, Meera pays ₹600 Wi-Fi, split 3 ways.
   - Total: ₹1,500. Each person's share: ₹500.
   - Aarav paid ₹900 → balance +₹400 (is owed ₹400)
   - Meera paid ₹600 → balance +₹100 (is owed ₹100)
   - Rohan paid ₹0 → balance −₹500 (owes ₹500)
   - Settlements: Rohan → Aarav ₹400, Rohan → Meera ₹100. Total paid
     in settlements: ₹500, which matches Rohan's debt.
3. The automated check for this is in `test/test.js`:
   `node test/test.js`

## Sharing updates with others — and the honest limit

**There is no live sync in this version.** Split-Bill stores data
only on the device in `localStorage`. A change made on one phone
does not appear automatically on another person's phone.

That is why the Activity tab exists: it is the record other people
can follow. To share updates:

1. In Activity, use **Export group data (JSON)** — send that file
   to the others (WhatsApp, email, etc.).
2. They open Split-Bill, go to Activity → **Import group data**,
   and load the file. They then see the same expenses, balances,
   payments and the full activity log, newest first.
3. For a quick update without the file, use **Copy activity
   summary** or **Share on WhatsApp** in Activity, or
   **Export activity CSV**.

Live sync across phones would need a server / account system and
is not in this version — the app says this in the Activity tab too,
so no one expects updates to appear by themselves.

## How to build an APK (Android)

This repo is a PWA — the recommended no-Play-Store route is:

1. Deploy this folder to any static host (GitHub Pages, Netlify, etc.).
2. Open the hosted URL in Chrome on Android → ⋮ → **Add to Home screen**
   (or **Install app**). That installs it like an app, offline-capable.
3. For a real APK, wrap the same hosted URL / files with a trusted
   PWA-to-APK tool (e.g. Bubblewrap / PWABuilder) and sign it with
   your own keystore. Do not ship a debug-signed wrapper as a
   commercial release.

## UPI setup

No setup is needed in the app. Each member's UPI ID is entered in
Members (e.g. `name@okhdfcbank`). The settle link is built as:

```
upi://pay?pa=<upi-id>&pn=<payee-name>&am=<amount>&cu=INR&tn=Split-Bill%3A+<group>
```

Tapping it opens the user's UPI app (GPay / PhonePe / Paytm, etc.)
with the payee and amount filled in. Split-Bill never moves money
itself and never sees bank details.

## Project structure

```
index.html            Entry point, mobile-first layout
css/styles.css        All styling, print styles included
js/app.js             All logic: groups, balances, settlements, UPI, export
manifest.webmanifest  PWA manifest (installable)
sw.js                 Offline cache (best-effort)
icons/                192/512 PNG + SVG app icons
test/test.js          Balance + settlement + UPI checks (node)
```

## Privacy

All data stays on the device in `localStorage`. There is no server,
no analytics and no account. Clearing browser data deletes groups.
