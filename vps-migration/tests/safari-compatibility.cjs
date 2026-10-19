const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../site/app.js'), 'utf8');

function boot({ storageDenied = false, nativeDialog = false } = {}) {
  const elements = new Map(), handlers = {}, saved = new Map();
  const document = { activeElement: null, visibilityState: 'visible' };
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      const el = { innerHTML: '', textContent: '', dataset: {}, open: false, hidden: true,
        isConnected: true, classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
        setAttribute(name) { if (name === 'open') this.open = true; },
        removeAttribute(name) { if (name === 'open') this.open = false; },
        focus() { document.activeElement = this; }, getClientRects: () => [{}],
        querySelector: () => element('first-control'), querySelectorAll: () => [],
        contains(node) { return this.querySelectorAll().includes(node); },
        addEventListener(name, fn) { this[name + 'Handler'] = fn; }
      };
      elements.set(selector, el);
    }
    return elements.get(selector);
  };
  const addEventListener = (name, fn) => (handlers[name] ||= []).push(fn);
  Object.assign(document, { body: element('body'), querySelector: element, querySelectorAll: () => [], addEventListener });
  const dialog = element('#detail');
  if (nativeDialog) {
    dialog.showModal = function () { this.open = true; };
    dialog.close = function () { this.open = false; this.closeHandler?.(); };
  }
  const access = fn => (...args) => { if (storageDenied) throw new Error('Storage denied'); return fn(...args); };
  // Deliberately return US-style en-CA output, as locale data must not define storage dates.
  function DateTimeFormat(locale, options) {
    const formatter = new Intl.DateTimeFormat(locale, options);
    if (locale === 'en-CA') return { format: () => '10/09/2026' };
    return formatter;
  }
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-08T18:30:00Z'])); } }
  const context = vm.createContext({ document, window: { addEventListener }, location: { hash: '' },
    localStorage: { getItem: access(k => saved.get(k) || null), setItem: access((k,v) => saved.set(k,v)), removeItem: access(k => saved.delete(k)) },
    Intl: { DateTimeFormat, NumberFormat: Intl.NumberFormat }, Date: FixedDate, URLSearchParams,
    crypto: {}, console, setTimeout: () => 0, clearTimeout() {}, queueMicrotask, Map, Set, FormData: class {},
  });
  vm.runInContext(source, context);
  return { context, document, dialog, element, saved, run: code => vm.runInContext(code, context),
    fire: (name, event) => handlers[name].forEach(fn => fn(event)) };
}

const restricted = boot({ storageDenied: true });
for (const route of ['overview','sales','customers','messages','tasks','schedule','logistics','followups','financials','marketing','recruitment','improvements','access']) {
  restricted.context.location.hash = '#' + route;
  restricted.fire('hashchange', {});
  assert.ok(restricted.element('#main').innerHTML.length > 100, route + ' renders with storage denied');
}
restricted.run('loginDialog()');
restricted.element('#profile-select').value = 'Stephanie';
restricted.fire('click', { target: { closest: () => ({ dataset: { action: 'select-profile' } }) } });
assert.equal(restricted.run('currentUser'), 'Stephanie');
assert.equal(restricted.dialog.open, false);
assert.match(restricted.element('#toast').textContent, /Saving failed/);

const app = boot();
assert.equal(app.run('today()'), '2026-10-09', 'Vietnam date crosses midnight independently of locale order');
assert.equal(app.run('dateState("2026-10-08")'), 'Overdue');
assert.equal(app.run('dateState("2026-10-09")'), 'Due today');
assert.equal(app.run('dateState("2026-10-10")'), 'Upcoming');
assert.match(app.run('schedule()'), /October 2026/);
const trigger = app.element('trigger'), first = app.element('first-control'), last = app.element('last-control');
app.dialog.querySelectorAll = () => [first, last];
trigger.focus(); app.run('loginDialog()');
assert.equal(app.dialog.open, true);
assert.equal(app.element('#detail-backdrop').hidden, false);
assert.equal(app.document.body.classList.contains('dialog-open'), true);
last.focus(); let prevented = false;
app.fire('keydown', { key: 'Tab', preventDefault() { prevented = true; } });
assert.equal(app.document.activeElement, first); assert.equal(prevented, true);
app.fire('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
assert.equal(app.document.activeElement, last);
app.fire('keydown', { key: 'Escape', preventDefault() {} });
assert.equal(app.dialog.open, false); assert.equal(app.document.activeElement, trigger);
assert.equal(app.document.body.classList.contains('dialog-open'), false);

const native = boot({ nativeDialog: true });
const nativeTrigger = native.element('trigger'); nativeTrigger.focus();
native.run('loginDialog()'); assert.equal(native.document.body.classList.contains('dialog-open'), true);
native.dialog.close(); assert.equal(native.document.body.classList.contains('dialog-open'), false);
assert.equal(native.document.activeElement, nativeTrigger);
console.log('Passed Safari compatibility regressions: all 13 screens with denied storage; profile selection; locale-independent Vietnam dates and calendar; legacy modal focus trap/Escape/return focus; native modal scroll cleanup.');
