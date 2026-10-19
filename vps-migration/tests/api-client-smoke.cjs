const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const requests = [];
const handlers = new Map();
let next = { data: { session: null }, error: null };
const context = vm.createContext({
  window: {},
  document: { cookie: 'rv_csrf=test-csrf-token' },
  location: { href: 'https://dashboard.example.test/', origin: 'https://dashboard.example.test', pathname: '/', hash: '' },
  history: { replaceState(_state, _title, url) { context.location.href = new URL(url, context.location.origin).href; } },
  URL, URLSearchParams, console, queueMicrotask,
  fetch: async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => next };
  },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'site', 'rv-client.js'), 'utf8'), context);
const client = context.window.RVDashboardAPI.createClient('https://ignored.invalid', 'not-used-in-browser');

(async () => {
  const { data: sessionData } = await client.auth.getSession();
  assert.equal(sessionData.session, null);
  assert.equal(requests.at(-1).url, '/api/auth/session');
  assert.equal(requests.at(-1).options.credentials, 'same-origin');

  await client.from('team_members').select('user_id,display_name,role').eq('user_id', 'member-1').maybeSingle();
  assert.match(requests.at(-1).url, /\/api\/data\/team_members\?/);
  assert.match(requests.at(-1).url, /eq_user_id=member-1/);
  assert.match(requests.at(-1).url, /single=maybe/);

  await client.from('workspace_records').upsert({ record_type: 'task', record_key: 'task-1' });
  assert.equal(requests.at(-1).options.method, 'POST');
  assert.equal(requests.at(-1).options.headers['X-RV-CSRF'], 'test-csrf-token');

  await client.from('workspace_records').delete().eq('record_type', 'task').eq('record_key', 'task-1');
  assert.match(requests.at(-1).url, /record_type=task/);
  assert.equal(requests.at(-1).options.method, 'DELETE');

  await client.team.update('member-1', { role: 'intern', finance_access: false });
  assert.equal(requests.at(-1).url, '/api/team-members/member-1');
  assert.equal(requests.at(-1).options.method, 'PATCH');
  assert.equal(requests.at(-1).options.headers['X-RV-CSRF'], 'test-csrf-token');

  await client.functions.invoke('invite-team-member', { body: { display_name: 'Test User' } });
  assert.equal(requests.at(-1).url, '/api/auth/invitations');
  assert.equal(requests.at(-1).options.headers['X-RV-CSRF'], 'test-csrf-token');

  next = { data: { session: { user: { id: 'member-1', email: 'test@example.test' } } }, error: null };
  await client.auth.signInWithPassword({ email: 'test@example.test', password: 'test' });
  let signedIn = false;
  client.auth.onAuthStateChange((event, session) => { if (event === 'INITIAL_SESSION' && session?.user?.id === 'member-1') signedIn = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signedIn, true);

  console.log('Passed API client smoke checks: same-origin session, safe record query, CSRF on writes, invitation route, and auth-state notification.');
})().catch(error => { console.error(error); process.exitCode = 1; });
