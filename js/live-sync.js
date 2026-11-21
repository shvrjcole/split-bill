/* ChipIn — live sync (OPTIONAL, Firebase).
 *
 * A separate module so the offline app never depends on it. It is
 * loaded from index.html after js/app.js, but it does NOTHING unless
 * js/firebase-config.js holds a real Firebase project config.
 * Without a config, or with no network, the app works exactly as
 * before (localStorage, join code, export/import) and the Activity
 * tab shows "Offline mode — live sync not set up yet".
 *
 * How it works, when configured:
 *   - Anonymous sign-in (no account, no name/email collected).
 *   - One Firestore document per live group:
 *       collection "chipin-groups", document id = the 6-character
 *       group code, e.g. chipin-groups/K7Q2XA.
 *   - The document is { code, rev, updatedAt, updatedBy,
 *     updatedByName, group } where `group` is the whole ChipIn
 *     group object (members, expenses, payments, activity).
 *   - "Go live" uploads the current local group and shows the code.
 *     Other members open ChipIn, enter the code, and join — no
 *     account. An onSnapshot listener then pushes every change
 *     (expense added, payment marked/confirmed, member added) to
 *     all open clients, so dashboards/balances update immediately.
 *   - Every local save of a live group is pushed (debounced 600 ms).
 *   - Conflict rule: LAST WRITE WINS, whole-group document.
 *     Two people saving the same group at the exact same moment can
 *     overwrite each other; the later save wins. There is no
 *     per-field merge. For hostel/trip groups this is fine; it is
 *     NOT a design for hundreds of simultaneous editors.
 *   - Echo guard: our own writes are ignored on the way back
 *     (matching updatedBy uid, and rev <= last seen rev).
 *
 * Security — read the README before enabling this. The 6-character
 * code IS the only gate: anyone who knows a group's code can read
 * and change that group, like an unlisted link. The Firestore rules
 * stop anyone listing groups or touching other collections, but
 * they cannot check "knows the code" beyond the doc id itself.
 * Treat the code like a password: share it only with the group.
 *
 * Firebase JS SDK v10 (modular), loaded from Google's CDN only when
 * live sync is actually used, via dynamic import(). Nothing is
 * downloaded for offline users. */

(function () {
  'use strict';

  var root = typeof globalThis !== 'undefined' ? globalThis : this;
  var COLLECTION = 'chipin-groups';
  var SDK_VERSION = '10.14.1';
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/';
  var CODE_LENGTH = 6;
  /* No 0/O/1/I/L — codes are read out loud / typed by hand. */
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var PUSH_DEBOUNCE_MS = 600;

  /* Firebase SDK functions, filled in by loadFirebase(). */
  var fb = null; /* { initializeApp, getAuth, signInAnonymously, getFirestore, doc, setDoc, getDoc, onSnapshot } */
  var app = null, db = null, auth = null, uid = null;

  var initialised = false;   /* init() has run (UI wired) */
  var sdkReady = false;      /* SDK loaded + anonymous sign-in done */
  var sdkPromise = null;
  var liveCode = null;       /* code of the group currently synced, or null */
  var liveGroupId = null;
  var lastSeenRev = 0;
  var lastPushedJson = null;
  var pushTimer = null;
  var unsubscribe = null;

  function config() {
    return (typeof root !== 'undefined' && root.CHIPIN_FIREBASE_CONFIG) || null;
  }

  /* True only when every config value is filled in with a real value. */
  function configured() {
    var cfg = config();
    if (!cfg) return false;
    var keys = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
    for (var i = 0; i < keys.length; i++) {
      var v = cfg[keys[i]];
      if (typeof v !== 'string' || !v || v.indexOf('YOUR_') === 0) return false;
    }
    return true;
  }

  function chipInApp() {
    return (typeof root !== 'undefined' && root.ChipInApp) || null;
  }

  function toast(msg) {
    var a = chipInApp();
    if (a && typeof a.toast === 'function') a.toast(msg);
  }

  /* 6-character code, crypto-random when available. Pure + testable. */
  function generateCode() {
    var code = '';
    var cryptoObj = (typeof root !== 'undefined' && root.crypto && root.crypto.getRandomValues) ? root.crypto : null;
    for (var i = 0; i < CODE_LENGTH; i++) {
      var n;
      if (cryptoObj) {
        var arr = new Uint32Array(1);
        cryptoObj.getRandomValues(arr);
        n = arr[0] % CODE_ALPHABET.length;
      } else {
        n = Math.floor(Math.random() * CODE_ALPHABET.length);
      }
      code += CODE_ALPHABET[n];
    }
    return code;
  }

  /* The Firestore document for one live group. Pure + testable. */
  function buildPayload(code, group, rev, byUid, byName) {
    return {
      code: code,
      rev: rev,
      updatedAt: new Date().toISOString(),
      updatedBy: byUid || null,
      updatedByName: byName || 'Someone',
      group: group
    };
  }

  function actorName(group) {
    if (!group) return 'Someone';
    var a = chipInApp();
    if (a && group.currentUserId && typeof group.members !== 'undefined') {
      var m = (group.members || []).find(function (x) { return x.id === group.currentUserId; });
      if (m) return m.name;
    }
    return 'Someone';
  }

  function loadFirebase() {
    if (sdkReady) return Promise.resolve(true);
    if (sdkPromise) return sdkPromise;
    if (!configured()) return Promise.reject(new Error('Firebase is not configured — fill in js/firebase-config.js first.'));
    sdkPromise = Promise.all([
      import(SDK_BASE + 'firebase-app.js'),
      import(SDK_BASE + 'firebase-auth.js'),
      import(SDK_BASE + 'firebase-firestore.js')
    ]).then(function (mods) {
      var appMod = mods[0], authMod = mods[1], fsMod = mods[2];
      fb = {
        initializeApp: appMod.initializeApp,
        getAuth: authMod.getAuth,
        signInAnonymously: authMod.signInAnonymously,
        getFirestore: fsMod.getFirestore,
        doc: fsMod.doc,
        setDoc: fsMod.setDoc,
        getDoc: fsMod.getDoc,
        onSnapshot: fsMod.onSnapshot
      };
      app = fb.initializeApp(config());
      auth = fb.getAuth(app);
      db = fb.getFirestore(app);
      return fb.signInAnonymously(auth);
    }).then(function (cred) {
      uid = cred.user.uid;
      sdkReady = true;
      return true;
    }).catch(function (err) {
      sdkPromise = null;
      throw err;
    });
    return sdkPromise;
  }

  function docRef(code) {
    return fb.doc(db, COLLECTION, code);
  }

  function subscribe(code) {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    unsubscribe = fb.onSnapshot(docRef(code), function (snap) {
      if (!snap.exists()) return;
      var data = snap.data();
      if (!data || !data.group) return;
      /* Ignore our own echo and anything older than what we have. */
      if (data.updatedBy === uid) return;
      if (typeof data.rev === 'number' && data.rev <= lastSeenRev) return;
      lastSeenRev = typeof data.rev === 'number' ? data.rev : lastSeenRev;
      lastPushedJson = JSON.stringify(data.group);
      var a = chipInApp();
      if (a && typeof a.applyRemoteGroup === 'function') {
        a.applyRemoteGroup(data.group);
        toast('Group updated by ' + (data.updatedByName || 'another member') + ' — balances refreshed.');
      }
    }, function (err) {
      setStatus('error', 'Live sync error: ' + (err && err.message ? err.message : err) + '. Offline mode still works.');
    });
  }

  /* Push the active group to Firestore (debounced, deduped). No-op
     unless this client currently has a live group open. */
  function pushIfLive() {
    var a = chipInApp();
    if (!a || !sdkReady || !liveCode) return;
    var group = a.activeGroup();
    if (!group || group.id !== liveGroupId) return;
    var json = JSON.stringify(group);
    if (json === lastPushedJson) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushNow(); }, PUSH_DEBOUNCE_MS);
  }

  function pushNow() {
    var a = chipInApp();
    if (!a || !sdkReady || !liveCode) return;
    var group = a.activeGroup();
    if (!group || group.id !== liveGroupId) return;
    var rev = Date.now();
    var payload = buildPayload(liveCode, group, rev, uid, actorName(group));
    fb.setDoc(docRef(liveCode), payload).then(function () {
      lastSeenRev = rev;
      lastPushedJson = JSON.stringify(group);
    }).catch(function (err) {
      setStatus('error', 'Could not save live update: ' + (err && err.message ? err.message : err));
    });
  }

  /* Upload the current local group as a new live group and show its code. */
  function goLive() {
    var a = chipInApp();
    if (!a) return Promise.reject(new Error('ChipIn app is not ready yet.'));
    var group = a.activeGroup();
    if (!group) return Promise.reject(new Error('Create a group first, then go live.'));
    return loadFirebase().then(function () {
      var code = generateCode();
      group.liveCode = code;
      var rev = Date.now();
      var payload = buildPayload(code, group, rev, uid, actorName(group));
      return fb.setDoc(docRef(code), payload).then(function () {
        liveCode = code;
        liveGroupId = group.id;
        lastSeenRev = rev;
        lastPushedJson = JSON.stringify(group);
        a.saveState();
        subscribe(code);
        setStatus('live', code);
        return code;
      });
    }).catch(function (err) {
      setStatus('error', 'Could not go live: ' + (err && err.message ? err.message : err) + '. Check your connection — offline mode still works.');
      throw err;
    });
  }

  /* Join a live group by its 6-character code. No account needed. */
  function joinLive(rawCode) {
    var code = String(rawCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return Promise.reject(new Error('Enter the 6-character live code, e.g. K7Q2XA.'));
    }
    return loadFirebase().then(function () {
      return fb.getDoc(docRef(code));
    }).then(function (snap) {
      if (!snap.exists()) throw new Error('No live group with code ' + code + '. Check the code and try again.');
      var data = snap.data();
      if (!data || !data.group || typeof data.group.name !== 'string') {
        throw new Error('That live group looks damaged — ask the group owner to go live again.');
      }
      var a = chipInApp();
      var group = data.group;
      group.liveCode = code;
      if (a && typeof a.applyRemoteGroup === 'function') a.applyRemoteGroup(group);
      liveCode = code;
      liveGroupId = group.id;
      lastSeenRev = typeof data.rev === 'number' ? data.rev : 0;
      lastPushedJson = JSON.stringify(group);
      subscribe(code);
      setStatus('live', code);
      toast('Joined live group "' + group.name + '" — updates from other members will appear here.');
      return group;
    }).catch(function (err) {
      setStatus('error', err && err.message ? err.message : String(err));
      throw err;
    });
  }

  function stopLive() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    var a = chipInApp();
    var group = a ? a.activeGroup() : null;
    if (group && group.liveCode) group.liveCode = null;
    liveCode = null;
    liveGroupId = null;
    lastSeenRev = 0;
    lastPushedJson = null;
    if (a) a.saveState();
    setStatus(configured() ? 'ready' : 'offline');
  }

  function status() {
    if (liveCode) return 'live';
    if (!configured()) return 'offline';
    return 'ready';
  }

  /* ---- Live sync card UI (Activity tab) — all lookups guarded so
     the module is harmless if the card markup is missing. ---- */
  function $(id) {
    return (typeof document !== 'undefined') ? document.getElementById(id) : null;
  }

  function setStatus(state, extra) {
    var statusEl = $('liveSyncStatus');
    var controls = $('liveSyncControls');
    var codeRow = $('liveCodeRow');
    var codeEl = $('liveCodeDisplay');
    var goBtn = $('goLiveBtn');
    var stopBtn = $('stopLiveBtn');
    var hint = $('liveSyncSetupHint');
    if (!statusEl) return;
    if (state === 'live') {
      statusEl.textContent = '● Live — this group is syncing. Changes from other members appear here automatically.';
      statusEl.classList.add('live-status-live');
      if (controls) controls.hidden = false;
      if (codeRow) codeRow.hidden = false;
      if (codeEl) codeEl.textContent = extra || liveCode || '';
      if (goBtn) goBtn.hidden = true;
      if (stopBtn) stopBtn.hidden = false;
      if (hint) hint.hidden = true;
    } else if (state === 'ready') {
      statusEl.textContent = 'Live sync is set up. Tap “Go live with this group” to sync it, or join a group with its 6-letter code.';
      statusEl.classList.remove('live-status-live');
      if (controls) controls.hidden = false;
      if (codeRow) codeRow.hidden = true;
      if (goBtn) goBtn.hidden = false;
      if (stopBtn) stopBtn.hidden = true;
      if (hint) hint.hidden = true;
    } else if (state === 'error') {
      statusEl.textContent = extra || 'Live sync hit a problem. Offline mode still works.';
      statusEl.classList.remove('live-status-live');
      if (controls) controls.hidden = false;
      if (goBtn) goBtn.hidden = false;
      if (stopBtn) stopBtn.hidden = true;
    } else { /* offline — not configured */
      statusEl.textContent = 'Offline mode — live sync not set up yet. The app works exactly as before: data stays on this device, and you share updates with Export group data or the Activity share buttons.';
      statusEl.classList.remove('live-status-live');
      if (controls) controls.hidden = true;
      if (hint) hint.hidden = false;
    }
  }

  function init() {
    if (initialised) return;
    initialised = true;
    setStatus(configured() ? 'ready' : 'offline');
    var goBtn = $('goLiveBtn');
    if (goBtn) goBtn.addEventListener('click', function () {
      goLive().then(function (code) {
        toast('Live! Share code ' + code + ' with the group — they join from the landing page or here.');
      }).catch(function (err) { toast(err && err.message ? err.message : 'Could not go live.'); });
    });
    var stopBtn = $('stopLiveBtn');
    if (stopBtn) stopBtn.addEventListener('click', function () {
      stopLive();
      toast('Live sync stopped for this group. It stays saved on this device.');
    });
    var joinBtn = $('joinLiveBtn');
    if (joinBtn) joinBtn.addEventListener('click', function () {
      var input = $('joinLiveCodeInput');
      joinLive(input ? input.value : '').catch(function (err) {
        toast(err && err.message ? err.message : 'Could not join.');
      });
    });
    var joinInput = $('joinLiveCodeInput');
    if (joinInput) joinInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); joinBtn.click(); }
    });
    var copyBtn = $('copyLiveCodeBtn');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var code = liveCode || '';
      if (!code) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { toast('Live code copied: ' + code); });
      } else { toast('Live code: ' + code); }
    });
  }

  root.ChipInLiveSync = {
    COLLECTION: COLLECTION,
    configured: configured,
    generateCode: generateCode,
    buildPayload: buildPayload,
    goLive: goLive,
    joinLive: joinLive,
    stopLive: stopLive,
    pushIfLive: pushIfLive,
    status: status,
    init: init
  };
})();
