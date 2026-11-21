/* ChipIn — Firebase web config EXAMPLE.
 *
 * Copy this file to firebase-config.js and fill in your own project's
 * values from Firebase Console > Project Settings > Your apps.
 * firebase-config.js is gitignored — never commit your real key.
 * The key is a public web config value, but keep it restricted in
 * Google Cloud Console (API restrictions: Identity Toolkit + Firestore
 * only; Application restrictions: your site's referrers only). */

window.CHIPIN_FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'YOUR_MESSAGING_SENDER_ID',
  appId: 'YOUR_APP_ID'
};
