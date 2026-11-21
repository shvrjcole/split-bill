'use strict';

/* ChipIn — shared expense tracker.
   Data is stored only on this device, in localStorage under STORAGE_KEY.
   No account, no server, no demo data loaded by default.
   Honest limit: there is NO live sync across phones in this version.
   Other people track updates by receiving an exported group file
   (JSON) or an activity summary / CSV from this app and importing it. */

var STORAGE_KEY = 'splitbill_v1';
var CATEGORIES = ['Mess', 'Wi-Fi', 'Groceries', 'Trip', 'Other'];

function uid() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function formatINR(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function memberNameById(group, id) {
  var m = (group.members || []).find(function (x) { return x.id === id; });
  return m ? m.name : 'Unknown';
}

/* ---- Pure logic (testable without the DOM) ---- */

function computeBalances(group) {
  // Returns [{ memberId, name, paid, share, balance }] where balance = paid - share
  // + settlement payments out - settlement payments in.
  var byId = {};
  group.members.forEach(function (m) {
    byId[m.id] = { memberId: m.id, name: m.name, paid: 0, share: 0, balance: 0, paidOut: 0, received: 0 };
  });
  group.expenses.forEach(function (e) {
    var amount = Number(e.amount) || 0;
    var split = (e.splitWith && e.splitWith.length ? e.splitWith : group.members.map(function (m) { return m.id; }))
      .filter(function (id) { return byId[id]; });
    if (!split.length) return;
    var perPerson = amount / split.length;
    if (byId[e.paidBy]) byId[e.paidBy].paid = round2(byId[e.paidBy].paid + amount);
    split.forEach(function (id) { byId[id].share = round2(byId[id].share + perPerson); });
  });
  (group.payments || []).forEach(function (p) {
    var amt = Number(p.amount) || 0;
    if (byId[p.fromId]) byId[p.fromId].paidOut = round2(byId[p.fromId].paidOut + amt);
    if (byId[p.toId]) byId[p.toId].received = round2(byId[p.toId].received + amt);
  });
  return group.members.map(function (m) {
    var b = byId[m.id];
    b.balance = round2(b.paid - b.share + b.paidOut - b.received);
    return b;
  });
}

function simplifySettlements(balances) {
  // Greedy minimum-transaction settlement: debtors pay creditors, largest first.
  var creditors = balances.filter(function (b) { return b.balance > 0.009; })
    .map(function (b) { return { id: b.memberId, name: b.name, amount: b.balance }; })
    .sort(function (a, b) { return b.amount - a.amount; });
  var debtors = balances.filter(function (b) { return b.balance < -0.009; })
    .map(function (b) { return { id: b.memberId, name: b.name, amount: -b.balance }; })
    .sort(function (a, b) { return b.amount - a.amount; });
  var out = [];
  var i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    var pay = round2(Math.min(debtors[i].amount, creditors[j].amount));
    if (pay > 0.009) {
      out.push({ fromId: debtors[i].id, fromName: debtors[i].name, toId: creditors[j].id, toName: creditors[j].name, amount: pay });
    }
    debtors[i].amount = round2(debtors[i].amount - pay);
    creditors[j].amount = round2(creditors[j].amount - pay);
    if (debtors[i].amount <= 0.009) i++;
    if (creditors[j].amount <= 0.009) j++;
  }
  return out;
}

function categoryBreakdown(group, category) {
  // For one category: total spent, and per member paid + share in that category.
  var total = 0;
  var byId = {};
  group.members.forEach(function (m) {
    byId[m.id] = { memberId: m.id, name: m.name, paid: 0, share: 0 };
  });
  (group.expenses || []).filter(function (e) { return e.category === category; }).forEach(function (e) {
    var amount = Number(e.amount) || 0;
    total = round2(total + amount);
    var split = (e.splitWith && e.splitWith.length ? e.splitWith : group.members.map(function (m) { return m.id; }))
      .filter(function (id) { return byId[id]; });
    if (!split.length) return;
    var perPerson = amount / split.length;
    if (byId[e.paidBy]) byId[e.paidBy].paid = round2(byId[e.paidBy].paid + amount);
    split.forEach(function (id) { byId[id].share = round2(byId[id].share + perPerson); });
  });
  var members = group.members.map(function (m) { return byId[m.id]; })
    .filter(function (b) { return b.paid > 0 || b.share > 0; });
  return { category: category, total: round2(total), count: (group.expenses || []).filter(function (e) { return e.category === category; }).length, members: members };
}

function buildUpiLink(upiId, payeeName, amount, note) {
  if (!upiId || !String(upiId).trim()) return null;
  var enc = encodeURIComponent;
  return 'upi://pay?pa=' + enc(String(upiId).trim()) +
    '&pn=' + enc(payeeName || '') +
    '&am=' + enc(Number(amount).toFixed(2)) +
    '&cu=INR&tn=' + enc(note || 'ChipIn settlement');
}

function logActivity(group, actor, text, atISO) {
  // Pure: appends an activity entry (newest first) and returns it.
  // actor is a person's name, e.g. 'Aarav'; use 'Someone' when no one is chosen.
  if (!group) return null;
  if (!Array.isArray(group.activity)) group.activity = [];
  var entry = { id: uid(), at: atISO || new Date().toISOString(), actor: actor || 'Someone', text: text };
  group.activity.unshift(entry);
  if (group.activity.length > 200) group.activity.length = 200;
  return entry;
}

function recordPayment(group, fromId, toId, amount, actor, atISO) {
  // Pure: records a settlement payment, adjusts future balances via
  // computeBalances, and logs it in the activity log. Returns the payment.
  if (!group) return null;
  if (!Array.isArray(group.payments)) group.payments = [];
  var payment = { id: uid(), fromId: fromId, toId: toId, amount: round2(Number(amount) || 0), date: todayISO(), at: atISO || new Date().toISOString() };
  group.payments.push(payment);
  logActivity(group, actor || 'Someone',
    'Marked ' + formatINR(payment.amount) + ' paid: ' + memberNameById(group, fromId) + ' → ' + memberNameById(group, toId),
    payment.at);
  return payment;
}

function activitySummaryText(group) {
  var lines = ['ChipIn — ' + group.name + ' — Activity'];
  lines.push('Updated: ' + new Date().toLocaleString('en-IN'));
  lines.push('');
  var items = (group.activity || []).slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  if (!items.length) lines.push('No activity yet.');
  items.forEach(function (a) {
    lines.push(new Date(a.at).toLocaleString('en-IN') + ' — ' + a.actor + ': ' + a.text);
  });
  return lines.join('\n');
}

// Expose pure logic for automated tests (harmless in the browser).
if (typeof globalThis !== 'undefined') {
  globalThis.SplitBill = {
    computeBalances: computeBalances, simplifySettlements: simplifySettlements,
    buildUpiLink: buildUpiLink, formatINR: formatINR, round2: round2,
    categoryBreakdown: categoryBreakdown, logActivity: logActivity,
    recordPayment: recordPayment, activitySummaryText: activitySummaryText
  };
}

/* ---- Storage ---- */

function ensureGroupShape(g) {
  if (!Array.isArray(g.activity)) g.activity = [];
  if (!Array.isArray(g.payments)) g.payments = [];
  if (!Array.isArray(g.members)) g.members = [];
  if (!Array.isArray(g.expenses)) g.expenses = [];
  if (typeof g.currentUserId === 'undefined') g.currentUserId = null;
  if (typeof g.liveCode === 'undefined') g.liveCode = null; /* null = offline group; a 6-letter code = live group (see js/live-sync.js) */
  return g;
}
function loadState() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { groups: [], activeGroupId: null };
    var parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.groups)) return { groups: [], activeGroupId: null };
    parsed.groups.forEach(ensureGroupShape);
    return parsed;
  } catch (e) { return { groups: [], activeGroupId: null }; }
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage full / private mode */ }
  /* Optional live sync (js/live-sync.js): push the active group to
     Firestore if this group is live. Guarded and best-effort — the
     local save above has already happened, and with no Firebase
     config this is a complete no-op. Suppressed while a remote
     update is being applied, so we never echo it straight back. */
  try {
    if (typeof window !== 'undefined' && window.ChipInLiveSync && !window.__chipinApplyingRemote) {
      window.ChipInLiveSync.pushIfLive();
    }
  } catch (e) { /* live sync must never break the offline app */ }
}
var state = (typeof localStorage !== 'undefined') ? loadState() : { groups: [], activeGroupId: null };
function activeGroup() {
  return state.groups.find(function (g) { return g.id === state.activeGroupId; }) || null;
}

/* ---- Browser UI (only runs in a browser) ---- */

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  var $ = function (id) { return document.getElementById(id); };
  var currentExpenseFilter = 'All';

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function actorName(group) {
    if (!group) return 'Someone';
    if (group.currentUserId) return memberNameById(group, group.currentUserId);
    return 'Someone';
  }
  function log(group, text) { logActivity(group, actorName(group), text); }
  function memberName(group, id) { return memberNameById(group, id); }
  function memberUpi(group, id) {
    var m = group.members.find(function (x) { return x.id === id; });
    return m && m.upi ? m.upi : '';
  }
  function downloadFile(filename, content, type) {
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function safeFilename(name) { return String(name || 'chipin').replace(/[^a-z0-9]+/gi, '-').toLowerCase(); }

  function openCategoryModal(category) {
    var g = activeGroup(); if (!g) return;
    var b = categoryBreakdown(g, category);
    $('categoryModalTitle').textContent = category;
    if (!b.count) {
      $('categoryModalBody').innerHTML = '<p class="muted">No expenses in this category yet.</p>';
    } else {
      var rows = b.members.map(function (m) {
        return '<li><span><strong>' + escapeHtml(m.name) + '</strong><br><span class="muted small">Paid ' + formatINR(m.paid) + ' · Share ' + formatINR(m.share) + '</span></span>' +
          '<span>' + formatINR(m.share) + ' share</span></li>';
      }).join('');
      $('categoryModalBody').innerHTML =
        '<p><strong>Total in ' + escapeHtml(category) + ': ' + formatINR(b.total) + '</strong> · ' + b.count + ' expense' + (b.count === 1 ? '' : 's') + '</p>' +
        '<ul class="balance-list">' + rows + '</ul>' +
        '<p class="muted small">Names shown are the people who paid or shared in this category.</p>';
    }
    $('categoryModal').hidden = false;
    $('categoryModalClose').focus();
  }
  function closeCategoryModal() { $('categoryModal').hidden = true; }

  function render() {
    var group = activeGroup();
    var select = $('groupSelect');
    // No groups yet → the dropdown is empty, so disable it instead of
    // showing a broken-looking empty select.
    select.disabled = state.groups.length === 0;
    select.innerHTML = '';
    state.groups.forEach(function (g) {
      var opt = document.createElement('option');
      opt.value = g.id; opt.textContent = g.name;
      if (g.id === state.activeGroupId) opt.selected = true;
      select.appendChild(opt);
    });
    $('emptyState').hidden = !!group;
    $('appMain').hidden = !group;
    $('groupActions').style.display = group ? '' : 'none';
    if (!group) {
      $('groupMeta').textContent = '';
      return;
    }
    $('groupMeta').textContent = group.members.length + ' member' + (group.members.length === 1 ? '' : 's') +
      ' · ' + group.expenses.length + ' expense' + (group.expenses.length === 1 ? '' : 's') +
      ' · ' + (group.activity || []).length + ' activity update' + ((group.activity || []).length === 1 ? '' : 's') +
      (group.liveCode ? ' · Live: ' + group.liveCode : '');

    // "You are:" selector — stored per group, so activity is attributed.
    var who = $('currentUserSelect');
    who.innerHTML = '<option value="">Not set — updates will say “Someone”</option>' +
      group.members.map(function (m) {
        return '<option value="' + m.id + '"' + (group.currentUserId === m.id ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>';
      }).join('');

    var balances = computeBalances(group);
    var total = round2(group.expenses.reduce(function (s, e) { return s + (Number(e.amount) || 0); }, 0));
    $('totalSpent').textContent = formatINR(total);
    $('expenseCount').textContent = String(group.expenses.length);
    $('memberCount').textContent = String(group.members.length);

    $('balanceList').innerHTML = balances.length ? balances.map(function (b) {
      var cls = b.balance > 0.009 ? 'positive' : (b.balance < -0.009 ? 'negative' : '');
      var label = b.balance > 0.009 ? 'is owed ' : (b.balance < -0.009 ? 'owes ' : 'settled');
      return '<li><span>' + escapeHtml(b.name) + '<br><span class="muted small">Paid ' + formatINR(b.paid) + ' · Share ' + formatINR(b.share) + '</span></span>' +
        '<span class="' + cls + '">' + (b.balance === 0 ? 'Settled' : label + formatINR(Math.abs(b.balance))) + '</span></li>';
    }).join('') : '<li class="muted">Add members and an expense to see balances.</li>';

    // Spending by category — each card is tappable and opens a popup with names.
    var byCat = {};
    group.expenses.forEach(function (e) { byCat[e.category] = round2((byCat[e.category] || 0) + (Number(e.amount) || 0)); });
    $('categoryList').innerHTML = Object.keys(byCat).length ? Object.keys(byCat).map(function (c) {
      var count = group.expenses.filter(function (e) { return e.category === c; }).length;
      return '<li><button class="category-card" data-category="' + escapeHtml(c) + '" type="button" aria-label="See who paid and shared in ' + escapeHtml(c) + '">' +
        '<span>' + escapeHtml(c) + '<br><span class="muted small">Tap to see names · ' + count + ' expense' + (count === 1 ? '' : 's') + '</span></span>' +
        '<strong>' + formatINR(byCat[c]) + '</strong></button></li>';
    }).join('') : '<li class="muted">No expenses yet.</li>';

    // Expense form options — preserve the in-progress choices across
    // renders. render() used to rebuild the Paid-by select and the split
    // checkboxes from scratch, silently wiping the selected payer and
    // re-ticking members the user had unticked (e.g. changing "You are"
    // re-renders and would have saved the wrong split).
    var paidBy = $('expensePaidBy');
    var prevPaidBy = paidBy.value;
    var prevSplit = {};
    var hadSplitBoxes = false;
    document.querySelectorAll('#splitWithList input').forEach(function (c) {
      prevSplit[c.value] = c.checked;
      hadSplitBoxes = true;
    });
    paidBy.innerHTML = group.members.map(function (m) {
      return '<option value="' + m.id + '"' + (m.id === prevPaidBy ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>';
    }).join('');
    $('splitWithList').innerHTML = group.members.map(function (m) {
      // A member the user unticked stays unticked; a brand-new member
      // defaults to ticked; with no previous boxes (first render) all ticked.
      var checked = !hadSplitBoxes || prevSplit[m.id] !== false;
      return '<label><input type="checkbox" value="' + m.id + '"' + (checked ? ' checked' : '') + '> ' + escapeHtml(m.name) + '</label>';
    }).join('') || '<span class="muted">Add members first.</span>';

    // Expense filter + involved names
    var filter = $('expenseFilter');
    if (filter.options.length !== CATEGORIES.length + 1) {
      filter.innerHTML = '<option>All</option>' + CATEGORIES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
      filter.value = currentExpenseFilter;
    }
    var filtered = currentExpenseFilter === 'All'
      ? group.expenses.slice()
      : group.expenses.filter(function (e) { return e.category === currentExpenseFilter; });
    if (currentExpenseFilter === 'All') {
      $('expenseFilterInfo').textContent = '';
    } else {
      var bd = categoryBreakdown(group, currentExpenseFilter);
      if (!bd.count) {
        $('expenseFilterInfo').textContent = 'No expenses in ' + currentExpenseFilter + ' yet.';
      } else {
        $('expenseFilterInfo').textContent = 'In ' + currentExpenseFilter + ': ' +
          bd.members.map(function (m) { return m.name + ' (paid ' + formatINR(m.paid) + ', share ' + formatINR(m.share) + ')'; }).join(' · ') +
          ' — total ' + formatINR(bd.total) + '.';
      }
    }

    // Expense list, newest first
    var sorted = filtered.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    $('expenseList').innerHTML = sorted.length ? sorted.map(function (e) {
      var splitNames = (e.splitWith || []).map(function (id) { return memberName(group, id); }).join(', ');
      return '<li><div><strong>' + escapeHtml(e.desc) + '</strong> · ' + escapeHtml(e.category) +
        '<div class="expense-meta">' + escapeHtml(e.date) + ' · Paid by ' + escapeHtml(memberName(group, e.paidBy)) +
        ' · Split: ' + escapeHtml(splitNames || '—') + '</div></div>' +
        '<div style="text-align:right"><div class="expense-amount">' + formatINR(e.amount) + '</div>' +
        '<button class="btn btn-ghost" data-edit-expense="' + e.id + '" type="button">Edit</button> ' +
        '<button class="btn btn-ghost danger" data-del-expense="' + e.id + '" type="button">Delete</button></div></li>';
    }).join('') : '<li class="muted">No expenses yet — add your first one above.</li>';

    // Settlements
    var settlements = simplifySettlements(balances);
    $('settlementList').innerHTML = settlements.length ? settlements.map(function (s, idx) {
      var upi = memberUpi(group, s.toId);
      var link = buildUpiLink(upi, s.toName, s.amount, 'ChipIn: ' + group.name);
      var payHtml;
      if (link) {
        payHtml = '<a class="btn btn-primary" href="' + escapeHtml(link) + '">Pay via UPI — ' + formatINR(s.amount) + '</a> ' +
          '<button class="btn btn-secondary" data-copy-upi="' + escapeHtml(link) + '" type="button">Copy link</button>';
      } else {
        payHtml = '<span class="muted small">No UPI ID for ' + escapeHtml(s.toName) + ' yet.</span> ' +
          '<button class="btn btn-secondary" data-add-upi="' + s.toId + '" type="button">Add UPI ID</button>';
      }
      payHtml += ' <button class="btn btn-ghost" data-mark-paid="' + idx + '" type="button">Mark as paid</button>';
      return '<li><strong>' + escapeHtml(s.fromName) + ' → ' + escapeHtml(s.toName) + '</strong> — ' + formatINR(s.amount) +
        '<div class="row" style="margin-top:8px">' + payHtml + '</div></li>';
    }).join('') : '<li class="muted">Everyone is settled up. 🎉</li>';

    // Paid settlements
    var paid = group.payments || [];
    $('paidList').innerHTML = paid.length ? paid.slice().reverse().map(function (p) {
      return '<li><span>' + escapeHtml(memberName(group, p.fromId)) + ' → ' + escapeHtml(memberName(group, p.toId)) +
        '<br><span class="muted small">' + escapeHtml(p.date) + ' · Paid</span></span>' +
        '<span><strong>' + formatINR(p.amount) + '</strong> <button class="btn btn-ghost danger" data-undo-payment="' + p.id + '" type="button">Undo</button></span></li>';
    }).join('') : '<li class="muted">No payments marked as paid yet.</li>';

    // Members
    $('memberList').innerHTML = group.members.length ? group.members.map(function (m) {
      return '<li><span><strong>' + escapeHtml(m.name) + '</strong><br><span class="muted small">' +
        (m.upi ? 'UPI: ' + escapeHtml(m.upi) : 'No UPI ID — tap Edit to add one') + '</span></span>' +
        '<span><button class="btn btn-ghost" data-edit-member="' + m.id + '" type="button">Edit</button> ' +
        '<button class="btn btn-ghost danger" data-del-member="' + m.id + '" type="button">Delete</button></span></li>';
    }).join('') : '<li class="muted">No members yet.</li>';

    // Activity — newest first
    var acts = (group.activity || []).slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    $('activityList').innerHTML = acts.length ? acts.map(function (a) {
      var when = new Date(a.at);
      var whenText = isNaN(when.getTime()) ? escapeHtml(a.at) : when.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return '<li><span><strong>' + escapeHtml(a.actor) + '</strong> — ' + escapeHtml(a.text) +
        '<br><span class="muted small">' + whenText + '</span></span></li>';
    }).join('') : '<li class="muted">No activity yet. Add an expense or a member and it will appear here, with your name.</li>';
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
  }

  /* Apply a group received over live sync: replace the local copy
     (or add it, if this device has never seen the group), keep this
     device's own "You are" choice, save locally without echoing the
     update back to Firestore, and re-render. Called only by
     js/live-sync.js, only when a Firebase config is present. */
  function applyRemoteGroup(remoteGroup) {
    if (!remoteGroup || typeof remoteGroup.id !== 'string') return false;
    ensureGroupShape(remoteGroup);
    var local = state.groups.find(function (x) { return x.id === remoteGroup.id; });
    var keepUser = local ? local.currentUserId : remoteGroup.currentUserId;
    var keepLive = local ? local.liveCode : remoteGroup.liveCode;
    if (local) {
      state.groups[state.groups.indexOf(local)] = remoteGroup;
    } else {
      state.groups.push(remoteGroup);
      state.activeGroupId = remoteGroup.id;
    }
    var g = state.groups.find(function (x) { return x.id === remoteGroup.id; });
    if (keepUser) g.currentUserId = keepUser;
    if (keepLive) g.liveCode = keepLive;
    window.__chipinApplyingRemote = true;
    try { saveState(); } finally { window.__chipinApplyingRemote = false; }
    render();
    return true;
  }

  /* Bridge for the optional live-sync module (js/live-sync.js).
     It only uses these hooks when a Firebase config is present;
     with no config, nothing here is ever called. */
  window.ChipInApp = {
    activeGroup: activeGroup,
    saveState: saveState,
    render: render,
    toast: toast,
    ensureGroupShape: ensureGroupShape,
    applyRemoteGroup: applyRemoteGroup
  };

  function createGroup(name) {
    var g = { id: uid(), name: name, createdAt: todayISO(), members: [], expenses: [], activity: [], payments: [], currentUserId: null };
    state.groups.push(g);
    state.activeGroupId = g.id;
    logActivity(g, 'Someone', 'Created group "' + name + '"');
    saveState(); render();
    return g;
  }

  function promptNewGroup() {
    var name = (window.prompt('Group name — e.g. Hostel — Room 4 or Goa Trip', '') || '').trim();
    if (name) { createGroup(name); toast('Group created: ' + name); }
  }

  function loadDemo() {
    var g = createGroup('Hostel — Room 4 (Demo)');
    var a = { id: uid(), name: 'Aarav', upi: 'aarav@okhdfcbank' };
    var b = { id: uid(), name: 'Meera', upi: 'meera@okaxis' };
    var c = { id: uid(), name: 'Rohan', upi: '' };
    g.members = [a, b, c];
    g.currentUserId = a.id;
    g.expenses = [
      { id: uid(), desc: 'Mess bill', amount: 900, category: 'Mess', paidBy: a.id, date: todayISO(), splitWith: [a.id, b.id, c.id] },
      { id: uid(), desc: 'Wi-Fi bill', amount: 600, category: 'Wi-Fi', paidBy: b.id, date: todayISO(), splitWith: [a.id, b.id, c.id] }
    ];
    logActivity(g, 'Aarav', 'Added expense "Mess bill" — ₹900, Mess, paid by Aarav');
    logActivity(g, 'Meera', 'Added expense "Wi-Fi bill" — ₹600, Wi-Fi, paid by Meera');
    saveState(); render();
    toast('Demo group loaded — delete it any time from the group bar.');
    switchTab('settle');
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('expenseDate').value = todayISO();

    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
    $('groupSelect').addEventListener('change', function (e) { state.activeGroupId = e.target.value; saveState(); render(); });
    $('currentUserSelect').addEventListener('change', function (e) {
      var g = activeGroup(); if (!g) return;
      g.currentUserId = e.target.value || null;
      saveState(); render();
      toast(g.currentUserId ? 'You are now: ' + memberName(g, g.currentUserId) + '. Your updates will show your name.' : '“You are” cleared — updates will say “Someone”.');
    });
    $('newGroupBtn').addEventListener('click', promptNewGroup);
    $('emptyNewGroupBtn').addEventListener('click', promptNewGroup);
    $('loadDemoBtn').addEventListener('click', loadDemo);
    $('renameGroupBtn').addEventListener('click', function () {
      var g = activeGroup(); if (!g) return;
      var oldName = g.name;
      var name = (window.prompt('Rename group', g.name) || '').trim();
      if (name && name !== oldName) { g.name = name; log(g, 'Renamed group from "' + oldName + '" to "' + name + '"'); saveState(); render(); toast('Group renamed.'); }
    });
    $('deleteGroupBtn').addEventListener('click', function () {
      var g = activeGroup(); if (!g) return;
      if (!window.confirm('Delete group "' + g.name + '" and all its expenses? This cannot be undone.')) return;
      state.groups = state.groups.filter(function (x) { return x.id !== g.id; });
      state.activeGroupId = state.groups.length ? state.groups[0].id : null;
      saveState(); render(); toast('Group deleted.');
    });

    $('expenseFilter').addEventListener('change', function (e) { currentExpenseFilter = e.target.value; render(); });

    $('memberForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var g = activeGroup(); if (!g) return;
      var name = $('memberName').value.trim();
      var upi = $('memberUpi').value.trim();
      if (!name) return;
      if (g.members.some(function (m) { return m.name.toLowerCase() === name.toLowerCase(); })) { toast('That member is already in this group.'); return; }
      g.members.push({ id: uid(), name: name, upi: upi });
      log(g, 'Added member ' + name + (upi ? ' (UPI: ' + upi + ')' : ''));
      $('memberName').value = ''; $('memberUpi').value = '';
      saveState(); render(); toast('Member added: ' + name);
    });

    $('expenseForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var g = activeGroup(); if (!g) return;
      if (!g.members.length) { toast('Add a member first.'); return; }
      var splitWith = Array.from(document.querySelectorAll('#splitWithList input:checked')).map(function (c) { return c.value; });
      if (!splitWith.length) { toast('Choose at least one person to split with.'); return; }
      var amount = round2(parseFloat($('expenseAmount').value));
      if (!amount || amount <= 0) { toast('Enter a valid amount.'); return; }
      var id = $('expenseId').value;
      var data = {
        desc: $('expenseDesc').value.trim(),
        amount: amount,
        category: $('expenseCategory').value,
        paidBy: $('expensePaidBy').value,
        date: $('expenseDate').value || todayISO(),
        splitWith: splitWith
      };
      if (id) {
        var ex = g.expenses.find(function (x) { return x.id === id; });
        if (ex) {
          var old = ex.desc + ' — ' + formatINR(ex.amount) + ', ' + ex.category;
          Object.assign(ex, data);
          log(g, 'Edited expense "' + data.desc + '" — ' + formatINR(amount) + ', ' + data.category + ', paid by ' + memberName(g, data.paidBy) + ' (was: ' + old + ')');
        }
        toast('Expense updated.');
      } else {
        g.expenses.push(Object.assign({ id: uid() }, data));
        log(g, 'Added expense "' + data.desc + '" — ' + formatINR(amount) + ', ' + data.category + ', paid by ' + memberName(g, data.paidBy));
        toast('Expense added.');
      }
      $('expenseForm').reset();
      $('expenseId').value = '';
      $('expenseDate').value = todayISO();
      $('expenseFormTitle').textContent = 'Add expense';
      $('cancelEditExpenseBtn').hidden = true;
      saveState(); render();
    });
    $('cancelEditExpenseBtn').addEventListener('click', function () {
      $('expenseForm').reset();
      $('expenseId').value = '';
      $('expenseDate').value = todayISO();
      $('expenseFormTitle').textContent = 'Add expense';
      this.hidden = true;
    });

    // Category modal: close button, backdrop click, Escape.
    $('categoryModalClose').addEventListener('click', closeCategoryModal);
    $('categoryModal').addEventListener('click', function (e) { if (e.target === $('categoryModal')) closeCategoryModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('categoryModal').hidden) closeCategoryModal(); });

    document.addEventListener('click', function (e) {
      var catBtn = e.target.closest('[data-category]');
      if (catBtn) { openCategoryModal(catBtn.dataset.category); return; }
      var t = e.target.closest('[data-edit-expense],[data-del-expense],[data-edit-member],[data-del-member],[data-copy-upi],[data-add-upi],[data-mark-paid],[data-undo-payment]');
      if (!t) return;
      var g = activeGroup(); if (!g) return;
      if (t.dataset.editExpense) {
        var ex = g.expenses.find(function (x) { return x.id === t.dataset.editExpense; });
        if (!ex) return;
        $('expenseId').value = ex.id;
        $('expenseDesc').value = ex.desc;
        $('expenseAmount').value = ex.amount;
        $('expenseCategory').value = ex.category;
        $('expensePaidBy').value = ex.paidBy;
        $('expenseDate').value = ex.date;
        document.querySelectorAll('#splitWithList input').forEach(function (c) { c.checked = ex.splitWith.indexOf(c.value) !== -1; });
        $('expenseFormTitle').textContent = 'Edit expense';
        $('cancelEditExpenseBtn').hidden = false;
        switchTab('expenses');
        $('expenseDesc').focus();
      }
      if (t.dataset.delExpense) {
        var del = g.expenses.find(function (x) { return x.id === t.dataset.delExpense; });
        if (!del) return;
        if (!window.confirm('Delete this expense?')) return;
        g.expenses = g.expenses.filter(function (x) { return x.id !== del.id; });
        log(g, 'Deleted expense "' + del.desc + '" — ' + formatINR(del.amount) + ', ' + del.category + ', paid by ' + memberName(g, del.paidBy));
        saveState(); render(); toast('Expense deleted.');
      }
      if (t.dataset.editMember) {
        var m = g.members.find(function (x) { return x.id === t.dataset.editMember; });
        if (!m) return;
        var oldName = m.name; var oldUpi = m.upi;
        var name = (window.prompt('Member name', m.name) || '').trim();
        if (!name) return;
        if (g.members.some(function (x) { return x.id !== m.id && x.name.toLowerCase() === name.toLowerCase(); })) {
          toast('That name is already used by another member in this group.');
          return;
        }
        var upi = (window.prompt('UPI ID for ' + name + ' (optional — leave blank to remove)', m.upi || '') || '').trim();
        m.name = name; m.upi = upi;
        log(g, 'Edited member ' + oldName + ' → ' + name + (upi !== oldUpi ? ' (UPI updated)' : ''));
        saveState(); render(); toast('Member updated.');
      }
      if (t.dataset.delMember) {
        var used = g.expenses.some(function (x) { return x.paidBy === t.dataset.delMember || (x.splitWith || []).indexOf(t.dataset.delMember) !== -1; }) ||
          (g.payments || []).some(function (p) { return p.fromId === t.dataset.delMember || p.toId === t.dataset.delMember; });
        if (used) { toast('Cannot delete — this member is in one or more expenses or recorded payments.'); return; }
        if (!window.confirm('Delete this member?')) return;
        var dm = g.members.find(function (x) { return x.id === t.dataset.delMember; });
        g.members = g.members.filter(function (x) { return x.id !== t.dataset.delMember; });
        if (g.currentUserId === t.dataset.delMember) g.currentUserId = null;
        if (dm) log(g, 'Deleted member ' + dm.name);
        saveState(); render(); toast('Member deleted.');
      }
      if (t.dataset.copyUpi) {
        var link = t.dataset.copyUpi;
        var done = function () { toast('UPI link copied.'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, function () { toast('Copy failed — long-press the Pay link instead.'); });
        } else { toast('Copy not supported in this browser.'); }
      }
      if (t.dataset.addUpi) {
        switchTab('members');
        toast('Add a UPI ID for that member, then come back to Settle up.');
      }
      if (t.dataset.markPaid !== undefined && t.dataset.markPaid !== null && t.dataset.markPaid !== '') {
        var balances = computeBalances(g);
        var settlements = simplifySettlements(balances);
        var s = settlements[Number(t.dataset.markPaid)];
        if (!s) return;
        recordPayment(g, s.fromId, s.toId, s.amount, actorName(g));
        saveState(); render(); toast('Marked ' + formatINR(s.amount) + ' paid: ' + s.fromName + ' → ' + s.toName);
      }
      if (t.dataset.undoPayment) {
        var p = (g.payments || []).find(function (x) { return x.id === t.dataset.undoPayment; });
        if (!p) return;
        g.payments = (g.payments || []).filter(function (x) { return x.id !== p.id; });
        log(g, 'Undid a payment of ' + formatINR(p.amount) + ': ' + memberName(g, p.fromId) + ' → ' + memberName(g, p.toId));
        saveState(); render(); toast('Payment undone.');
      }
    });

    $('exportCsvBtn').addEventListener('click', function () {
      var g = activeGroup(); if (!g) return;
      var rows = [['Date', 'Description', 'Category', 'Paid by', 'Amount (INR)', 'Split among']];
      g.expenses.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).forEach(function (e) {
        rows.push([e.date, e.desc, e.category, memberName(g, e.paidBy), Number(e.amount).toFixed(2),
          (e.splitWith || []).map(function (id) { return memberName(g, id); }).join('; ')]);
      });
      var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
      downloadFile(safeFilename(g.name) + '-expenses.csv', csv, 'text/csv');
      toast('CSV exported.');
    });
    $('printBtn').addEventListener('click', function () { window.print(); });
    $('proBtn').addEventListener('click', function () {
      toast('Pro is coming soon — PDF reports and receipt scanning will be a one-time ₹99 upgrade. Core stays free.');
    });

    // Activity sharing
    $('copyActivityBtn').addEventListener('click', function () {
      var g = activeGroup(); if (!g) return;
      var text = activitySummaryText(g);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Activity summary copied.'); }, function () { toast('Copy failed.'); });
      } else { toast('Copy not supported in this browser.'); }
    });
    $('whatsappActivityBtn').addEventListener('click', function () {
      var g = activeGroup(); if (!g) return;
      window.open('https://wa.me/?text=' + encodeURIComponent(activitySummaryText(g)), '_blank');
    });
    $('exportActivityCsvBtn').addEventListener('click', function () {
      var g = activeGroup(); if (!g) return;
      var rows = [['Date/Time', 'Actor', 'Action']];
      (g.activity || []).slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).forEach(function (a) {
        rows.push([new Date(a.at).toLocaleString('en-IN'), a.actor, a.text]);
      });
      var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
      downloadFile(safeFilename(g.name) + '-activity.csv', csv, 'text/csv');
      toast('Activity CSV exported.');
    });

    // Share group data with other parties (JSON export / import)
    $('exportGroupBtn').addEventListener('click', function () {
      var g = activeGroup(); if (!g) return;
      downloadFile(safeFilename(g.name) + '-chipin.json', JSON.stringify(g, null, 2), 'application/json');
      toast('Group file exported — send it to others and they can import it to see the same activity.');
    });
    $('importGroupBtn').addEventListener('click', function () { $('importGroupFile').click(); });
    $('importGroupFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var imported = JSON.parse(String(reader.result));
          if (!imported || typeof imported.name !== 'string' || !Array.isArray(imported.members) || !Array.isArray(imported.expenses)) {
            throw new Error('Not a ChipIn group file');
          }
          ensureGroupShape(imported);
          var existing = state.groups.find(function (x) { return x.id === imported.id; });
          if (existing) {
            var idx = state.groups.indexOf(existing);
            state.groups[idx] = imported;
            state.activeGroupId = imported.id;
          } else {
            state.groups.push(imported);
            state.activeGroupId = imported.id;
          }
          logActivity(imported, actorName(imported), 'Imported updated group data for "' + imported.name + '"');
          saveState(); render();
          toast('Group imported: ' + imported.name);
        } catch (err) {
          toast('Could not import that file — it is not a ChipIn group file.');
        }
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    // PWA service worker (best-effort; app works fully without it)
    if ('serviceWorker' in navigator && window.location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
    }

    // Optional live sync (js/live-sync.js): wires the Live sync card
    // in the Activity tab. No-op when Firebase is not configured —
    // the app then runs exactly as before, offline.
    if (window.ChipInLiveSync && typeof window.ChipInLiveSync.init === 'function') {
      window.ChipInLiveSync.init();
    }

    render();
  });
}
