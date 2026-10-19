/* Minimal same-origin compatibility layer for the dashboard's current data calls. */
(function () {
  const listeners = new Set();
  let currentSession = null;
  let bootPromise;
  const csrf = () => decodeURIComponent(document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('rv_csrf='))?.slice(8) || '');
  const emit = (event, session) => { currentSession = session; for (const listener of listeners) queueMicrotask(() => listener(event, session)); };
  async function request(path, options = {}) {
    const headers = { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.mutate ? { 'X-RV-CSRF': csrf() } : {}), ...(options.headers || {}) };
    const response = await fetch(path, { method: options.method || 'GET', credentials: 'same-origin', headers, body: options.body ? JSON.stringify(options.body) : undefined });
    let value;
    try { value = await response.json(); } catch { value = { data: null, error: { message: `Server returned ${response.status}.` } }; }
    if (!response.ok && !value.error) value.error = { message: `Request failed (${response.status}).` };
    return value;
  }
  async function initializeFlow() {
    const url = new URL(location.href);
    const invite = url.searchParams.get('invite');
    const recover = url.searchParams.get('recover');
    if (invite || recover) {
      const response = await request(invite ? '/api/auth/invitations/consume' : '/api/auth/password-reset/consume', { method: 'POST', body: { token: invite || recover } });
      if (response.error) { history.replaceState({}, '', location.pathname + location.hash); throw new Error(response.error.message); }
      currentSession = response.data?.session || null;
      url.searchParams.delete(invite ? 'invite' : 'recover');
      history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
      emit('SIGNED_IN', currentSession);
      return;
    }
    const response = await request('/api/auth/session');
    if (response.error) throw new Error(response.error.message);
    currentSession = response.data?.session || null;
    return currentSession;
  }
  function ensureBoot() { return bootPromise ||= initializeFlow(); }

  class Query {
    constructor(table) { this.table = table; this.columns = '*'; this.filters = []; this.ordering = null; this.take = null; this.action = 'select'; this.row = null; this.single = false; }
    select(columns = '*') { this.columns = columns; return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    order(field, options = {}) { this.ordering = [field, options.ascending === true]; return this; }
    limit(value) { this.take = value; return this; }
    maybeSingle() { this.single = true; return this; }
    upsert(row) { this.action = 'upsert'; this.row = row; return this; }
    delete() { this.action = 'delete'; return this; }
    async execute() {
      await ensureBoot();
      if (this.action === 'upsert') return request(`/api/data/${encodeURIComponent(this.table)}`, { method: 'POST', mutate: true, body: { row: this.row } });
      if (this.action === 'delete') {
        const key = this.filters.find(([field]) => field === 'record_key')?.[1];
        if (key == null) return { data: null, error: { message: 'A record key is required to delete a row.' } };
        const type = this.filters.find(([field]) => field === 'record_type')?.[1];
        const url = new URL(`/api/data/${encodeURIComponent(this.table)}/${encodeURIComponent(key)}`, location.origin);
        if (type) url.searchParams.set('record_type', type);
        return request(url.pathname + url.search, { method: 'DELETE', mutate: true });
      }
      const url = new URL(`/api/data/${encodeURIComponent(this.table)}`, location.origin);
      url.searchParams.set('select', this.columns);
      for (const [field, value] of this.filters) url.searchParams.set(`eq_${field}`, value);
      if (this.ordering) { url.searchParams.set('order_by', this.ordering[0]); url.searchParams.set('order_ascending', String(this.ordering[1])); }
      if (this.take != null) url.searchParams.set('limit', String(this.take));
      if (this.single) url.searchParams.set('single', 'maybe');
      return request(url.pathname + url.search);
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }

  window.RVDashboardAPI = {
    createClient() {
      const auth = {
        async getSession() {
          try { await ensureBoot(); return { data: { session: currentSession }, error: null }; }
          catch (error) { return { data: { session: null }, error: { message: error.message } }; }
        },
        onAuthStateChange(callback) {
          listeners.add(callback);
          ensureBoot().then(() => callback('INITIAL_SESSION', currentSession)).catch(error => console.error('Account setup failed:', error.message));
          return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
        },
        async signInWithPassword({ email, password }) {
          const result = await request('/api/auth/sign-in', { method: 'POST', body: { email, password } });
          if (!result.error) emit('SIGNED_IN', result.data?.session || null);
          return result;
        },
        async signOut() {
          const result = await request('/api/auth/sign-out', { method: 'POST', mutate: true });
          if (!result.error) emit('SIGNED_OUT', null);
          return result;
        },
        async updateUser({ password }) {
          const result = await request('/api/auth/password', { method: 'POST', mutate: true, body: { password } });
          if (!result.error && currentSession) { currentSession.authMode = 'normal'; emit('USER_UPDATED', currentSession); }
          return result;
        },
        async resetPasswordForEmail(email) {
          return request('/api/auth/password-reset', { method: 'POST', body: { email } });
        },
      };
      return {
        auth,
        from: table => new Query(table),
        team: { update: (userId, body) => request('/api/team-members/' + encodeURIComponent(userId), { method: 'PATCH', mutate: true, body }) },
        functions: { invoke: async (name, options = {}) => {
          if (name !== 'invite-team-member') return { data: null, error: { message: 'Unknown dashboard function.' } };
          const response = await request('/api/auth/invitations', { method: 'POST', mutate: true, body: options.body || {} });
          return { data: response.data, error: response.error ? { message: response.error.message } : null };
        } },
      };
    },
  };
})();
