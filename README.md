# ChipIn — Shared Expense Tracker

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

**By default there is no live sync.** ChipIn stores data only on
the device in `localStorage`. A change made on one phone does not
appear automatically on another person's phone.

That is why the Activity tab exists: it is the record other people
can follow. To share updates:

1. In Activity, use **Export group data (JSON)** — send that file
   to the others (WhatsApp, email, etc.).
2. They open ChipIn, go to Activity → **Import group data**,
   and load the file. They then see the same expenses, balances,
   payments and the full activity log, newest first.
3. For a quick update without the file, use **Copy activity
   summary** or **Share on WhatsApp** in Activity, or
   **Export activity CSV**.

Live sync across phones is available as an opt-in — see
“Live sync (optional — Firebase)” below. It is off by default and
the app says so in the Activity tab, so no one expects updates to
appear by themselves until the group owner switches it on.

## Live sync (optional — Firebase, free tier)

Live sync is prepared in the code (`js/live-sync.js`, config in
`js/firebase-config.js`) but **off until a Firebase project is
set up**. With no config, the app behaves exactly as before.

### How it works

- Anonymous sign-in — no account, no name or email collected.
- One Firestore document per live group: collection
  `chipin-groups`, document id = the 6-character group code
  (e.g. `chipin-groups/K7Q2XA`). The document is
  `{ code, rev, updatedAt, updatedBy, updatedByName, group }`,
  where `group` is the whole ChipIn group object.
- In Activity → **Live sync**, tap **Go live with this group**.
  The current group is uploaded and the code is shown. Other
  members open ChipIn, enter the code, and join — no account.
- A live `onSnapshot` listener then pushes every change (expense
  added, payment marked as paid, member added) to all open
  clients, so dashboards and balances update immediately.
- Every local save of a live group is pushed to Firestore
  (debounced 600 ms). **Conflict rule: last write wins, on the
  whole group document.** Two people saving the same group at
  the exact same moment can overwrite each other; the later save
  wins. There is no per-field merge.
- A Firestore document is at most 1 MiB — a ChipIn group (activity
  capped at 200 entries) fits easily.

### Setup (owner only, once)

1. Go to console.firebase.google.com and create a project.
   Choose the **Spark plan — free, no card required**.
2. Build → Authentication → Sign-in method → enable **Anonymous**.
3. Build → Firestore Database → Create database → **production
   mode**, pick the nearest region (e.g. `asia-south1` for India).
4. In Firestore → Rules, paste the rules below and Publish.
5. Project Settings → Your apps → Web app (`</>`) → register the
   app and copy the config values into `js/firebase-config.js`,
   replacing the `YOUR_*` placeholders. These values are the
   **public** web config — they are not secrets.
6. Deploy this folder to a static host (e.g. GitHub Pages) and
   open it over `https://` — Firebase Auth does not work on
   `file://`.
7. In the app, open a group → Activity → Live sync → **Go live
   with this group**, and share the 6-letter code with the group.

### Config values still needed from the Firebase project

All six, from Project Settings → Your apps → Web app:

- `apiKey`, `authDomain`, `projectId`, `storageBucket`,
  `messagingSenderId`, `appId`

### Firestore rules — paste exactly, then Publish

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // ChipIn live groups. The 6-character group code IS the doc id.
    // Anyone who knows the code can read/write that one group —
    // like an unlisted link. No listing, no other collections.
    match /chipin-groups/{code} {
      allow get: if request.auth != null && code.size() == 6;
      allow create, update: if request.auth != null
        && code.size() == 6
        && request.resource.data.code == code
        && request.resource.data.keys().hasAll(
             ['code', 'rev', 'updatedAt', 'updatedBy', 'group'])
        && request.resource.data.group is map
        && request.resource.data.group.name is string
        && request.resource.data.group.members is list
        && request.resource.data.group.expenses is list;
      allow delete: if false;
      allow list: if false;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### Security — read this before enabling

- **The code is the only gate.** These rules cannot check
  "knows the code" as a password — the doc id *is* the code, so
  anyone who knows (or guesses) a group's 6-letter code can read
  and change that group. The rules stop anyone *listing* groups
  or touching any other collection, and they check the document
  shape, but they do not make the code a secret. Share it only
  with people in the group, like a password.
- To rotate a code: in Activity → Live sync, tap **Stop live
  sync**, then **Go live** again — a new code is generated and
  the old document is left orphaned (it holds the old snapshot;
  delete it from the Firebase console if that bothers you).
- Do not put sensitive personal data in a group (bank details,
  passwords, full addresses). Names, UPI IDs and expenses are
  all the app needs.
- Never add service-account keys or Admin SDK credentials to
  this repo — they must never be in client-side code.

### Cost

Spark (free) tier, no card: Firestore gives 50,000 document
reads, 20,000 writes and 20,000 deletes per day, plus 1 GiB of
stored data — far more than a few hostel/trip groups use.
(Quotas are Google's published Spark limits; check them in the
Firebase console — they can change.) Nothing is charged unless
you deliberately upgrade to the Blaze pay-as-you-go plan. If the
free daily quota is ever hit, sync pauses until the next day —
it does not start charging.

### When live sync is NOT set up

Everything still works offline: localStorage groups, join code,
export/import, UPI links. The Activity tab shows
“Offline mode — live sync not set up yet” and the Firebase SDK
is never even downloaded.

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
upi://pay?pa=<upi-id>&pn=<payee-name>&am=<amount>&cu=INR&tn=ChipIn%3A+<group>
```

Tapping it opens the user's UPI app (GPay / PhonePe / Paytm, etc.)
with the payee and amount filled in. ChipIn never moves money
itself and never sees bank details.

## Project structure

```
index.html            Entry point, mobile-first layout
css/styles.css        All styling, print styles included
js/app.js             All logic: groups, balances, settlements, UPI, export
js/firebase-config.js Firebase web config — placeholders until the
                      owner fills in a real project (see README)
js/live-sync.js       Optional live sync (Firebase/Firestore);
                      inert unless a real config is present
manifest.webmanifest  PWA manifest (installable)
sw.js                 Offline cache (best-effort)
icons/                192/512 PNG + SVG app icons
test/test.js          Balance + settlement + UPI checks (node)
```

## Privacy

By default all data stays on the device in `localStorage`. There
is no server, no analytics and no account. Clearing browser data
deletes groups.

If the owner switches on live sync (see above), live groups are
also stored in the owner's own Firebase project (Firestore),
under the group's 6-letter code, with anonymous sign-in only —
ChipIn itself collects no names, emails or passwords. Anyone who
knows a group's code can read that group, so share codes only
inside the group.
