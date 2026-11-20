'use strict';
// Balance + settlement + UPI checks. Run: node test/test.js
// Loads js/app.js in a vm without a DOM — pure logic is exposed as globalThis.SplitBill.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const ctx = { console, globalThis: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const SB = ctx.SplitBill;
if (!SB) throw new Error('SplitBill not exposed by js/app.js');

function assert(cond, msg) { if (!cond) throw new Error('FAIL: ' + msg); console.log('ok -', msg); }
function eq(a, b, msg) { assert(a === b, msg + ' (got ' + a + ', want ' + b + ')'); }

// Test group from README: 3 people, ₹900 mess (Aarav) + ₹600 Wi-Fi (Meera), split 3 ways.
const group = {
  members: [
    { id: 'a', name: 'Aarav', upi: 'aarav@okhdfcbank' },
    { id: 'b', name: 'Meera', upi: 'meera@okaxis' },
    { id: 'c', name: 'Rohan', upi: '' },
  ],
  expenses: [
    { id: 'e1', desc: 'Mess bill', amount: 900, category: 'Mess', paidBy: 'a', date: '2026-11-21', splitWith: ['a', 'b', 'c'] },
    { id: 'e2', desc: 'Wi-Fi bill', amount: 600, category: 'Wi-Fi', paidBy: 'b', date: '2026-11-21', splitWith: ['a', 'b', 'c'] },
  ],
};

const balances = SB.computeBalances(group);
const byName = Object.fromEntries(balances.map(b => [b.name, b]));
eq(byName.Aarav.paid, 900, 'Aarav paid 900');
eq(byName.Aarav.share, 500, 'Aarav share 500');
eq(byName.Aarav.balance, 400, 'Aarav balance +400');
eq(byName.Meera.balance, 100, 'Meera balance +100');
eq(byName.Rohan.balance, -500, 'Rohan balance -500');
eq(balances.reduce((s, b) => s + b.balance, 0), 0, 'Balances sum to 0');

const settlements = SB.simplifySettlements(balances);
eq(settlements.length, 2, '2 settlement transactions (minimum)');
eq(settlements.reduce((s, x) => s + x.amount, 0), 500, 'Settlements total ₹500');
assert(settlements.some(s => s.fromName === 'Rohan' && s.toName === 'Aarav' && s.amount === 400), 'Rohan -> Aarav ₹400');
assert(settlements.some(s => s.fromName === 'Rohan' && s.toName === 'Meera' && s.amount === 100), 'Rohan -> Meera ₹100');

// Partial split: ₹300 paid by Aarav, split only between Aarav + Meera.
const g2 = {
  members: group.members,
  expenses: [{ id: 'e3', desc: 'Groceries', amount: 300, category: 'Groceries', paidBy: 'a', date: '2026-11-21', splitWith: ['a', 'b'] }],
};
const b2 = SB.computeBalances(g2);
eq(b2.find(x => x.name === 'Rohan').share, 0, 'Rohan share 0 when not in split');
eq(b2.find(x => x.name === 'Meera').share, 150, 'Meera share 150 on partial split');

// UPI link
const link = SB.buildUpiLink('aarav@okhdfcbank', 'Aarav', 400, 'Split-Bill: Hostel');
assert(link === 'upi://pay?pa=aarav%40okhdfcbank&pn=Aarav&am=400.00&cu=INR&tn=Split-Bill%3A%20Hostel', 'UPI link exact: ' + link);
assert(SB.buildUpiLink('', 'Rohan', 100) === null, 'Missing UPI ID returns null, no broken link');
assert(SB.buildUpiLink(null, 'Rohan', 100) === null, 'Null UPI ID returns null');

// Activity logging: adding an expense creates an entry with actor + amount.
const g3 = {
  id: 'g3', name: 'Hostel — Room 4', members: group.members,
  expenses: [], activity: [], payments: [], currentUserId: 'a',
};
const entry = SB.logActivity(g3, 'Aarav', 'Added expense "Mess bill" — ₹900, Mess, paid by Aarav', '2026-11-21T10:00:00.000Z');
eq(g3.activity.length, 1, 'Activity log has 1 entry after logging');
eq(entry.actor, 'Aarav', 'Activity entry actor is Aarav');
assert(entry.text.includes('₹900') && entry.text.includes('Mess'), 'Activity entry text has amount + category');
eq(entry.at, '2026-11-21T10:00:00.000Z', 'Activity entry keeps its timestamp');
const entry2 = SB.logActivity(g3, 'Meera', 'Added member Rohan');
eq(g3.activity[0].actor, 'Meera', 'Newest activity entry is first (newest first)');
assert(SB.activitySummaryText(g3).includes('Aarav') && SB.activitySummaryText(g3).includes('Mess bill'), 'Activity summary includes actor + action');

// Category breakdown: Mess ₹900 paid by Aarav, split 3 ways.
const bd = SB.categoryBreakdown(group, 'Mess');
eq(bd.total, 900, 'Mess category total ₹900');
eq(bd.count, 1, 'Mess category has 1 expense');
eq(bd.members.find(x => x.name === 'Aarav').paid, 900, 'Mess: Aarav paid ₹900');
eq(bd.members.find(x => x.name === 'Meera').share, 300, 'Mess: Meera share ₹300');
eq(bd.members.find(x => x.name === 'Rohan').share, 300, 'Mess: Rohan share ₹300');
const bdEmpty = SB.categoryBreakdown(group, 'Trip');
eq(bdEmpty.total, 0, 'Trip category total ₹0 when empty');
eq(bdEmpty.members.length, 0, 'Trip category has no members when empty');

// Settlement marked as paid: Rohan pays Aarav ₹400, balances update and it is logged.
const g4 = {
  id: 'g4', name: 'Hostel — Room 4', members: group.members,
  expenses: group.expenses, activity: [], payments: [], currentUserId: 'c',
};
const pay = SB.recordPayment(g4, 'c', 'a', 400, 'Rohan', '2026-11-21T11:00:00.000Z');
eq(g4.payments.length, 1, '1 payment recorded');
eq(pay.amount, 400, 'Payment amount ₹400');
const b4 = SB.computeBalances(g4);
eq(b4.find(x => x.name === 'Rohan').balance, -100, 'Rohan balance -500 -> -100 after paying ₹400');
eq(b4.find(x => x.name === 'Aarav').balance, 0, 'Aarav balance 400 -> 0 after receiving ₹400');
eq(b4.find(x => x.name === 'Meera').balance, 100, 'Meera balance unchanged at +100');
assert(g4.activity.some(a => a.actor === 'Rohan' && a.text.includes('₹400') && a.text.includes('Rohan → Aarav')), 'Settlement paid is logged with actor + amount + names');
const remaining = SB.simplifySettlements(b4);
eq(remaining.length, 1, 'Only 1 settlement remains after marking ₹400 paid');
assert(remaining[0].fromName === 'Rohan' && remaining[0].toName === 'Meera' && remaining[0].amount === 100, 'Remaining settlement is Rohan -> Meera ₹100');

console.log('All tests passed.');
