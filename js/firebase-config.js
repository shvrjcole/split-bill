/* ChipIn — Firebase web config (OPTIONAL, live sync only).
 *
 * This file holds ONLY the public Firebase web config. These values
 * are NOT secrets: they identify the Firebase project in the browser
 * and are safe to ship in the app (Firebase's own docs say the web
 * config is public). Real security comes from the Firestore rules
 * in the README — never from hiding these values.
 *
 * To switch live sync on:
 *   1. console.firebase.google.com → create a project (Spark plan — free, no card).
 *   2. Build → Authentication → Sign-in method → enable Anonymous.
 *   3. Build → Firestore Database → create database (production mode).
 *   4. Paste the Firestore rules from the README into Rules → Publish.
 *   5. Project Settings → Your apps → Web app (</>) → copy the config
 *      below, replacing the YOUR_* placeholders.
 *   6. Deploy this folder to a static host (e.g. GitHub Pages) and open it
 *      over https — Firebase Auth does not work on file://.
 *
 * Until every value below is filled in with a real project, ChipIn
 * runs exactly as before: offline, localStorage only, and the
 * Activity tab shows "Offline mode — live sync not set up yet".
 * Do NOT put any other keys here — no service-account keys, no
 * Admin SDK credentials, no passwords. Those must never be in
 * client-side code. */

window.CHIPIN_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDqMciFrqICUj_j0g4wHg8UtZ_XuIBVXh4',
  authDomain: 'chipin-99cad.firebaseapp.com',
  projectId: 'chipin-99cad',
  storageBucket: 'chipin-99cad.firebasestorage.app',
  messagingSenderId: '796553803466',
  appId: '1:796553803466:web:b2df626bb7189b63ffa633'
};
