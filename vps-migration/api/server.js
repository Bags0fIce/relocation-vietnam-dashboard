import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import nodemailer from 'nodemailer';
import { rateLimit } from 'express-rate-limit';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Keep unknown-account sign-ins on the same bcrypt path without shipping a reusable hash.
const dummyPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
const origin = process.env.APP_ORIGIN;
const sessionDays = Math.max(1, Math.min(14, Number(process.env.SESSION_DAYS || 7)));
const cookieName = 'rv_session';
const ttl = `${sessionDays} day${sessionDays === 1 ? '' : 's'}`;
const emailTransport = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
}) : null;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:', 'https://tile.openstreetmap.de'], connectSrc: ["'self'"],
  fontSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'none'"],
  baseUri: ["'self'"], formAction: ["'self'"],
} } }));
app.use(express.json({ limit: '256kb' }));

const jsonError = (res, status, message) => res.status(status).json({ data: null, error: { message } });
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const cookieValue = (req, name) => {
  const prefix = `${name}=`;
  const item = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
};
const cookieOptions = { secure: true, sameSite: 'strict', path: '/', httpOnly: true };
const setSessionCookies = (res, token, csrf) => {
  res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionDays * 86400_000 });
  res.cookie('rv_csrf', csrf, { secure: true, sameSite: 'strict', path: '/', httpOnly: false, maxAge: sessionDays * 86400_000 });
};
const clearSessionCookies = res => {
  res.clearCookie(cookieName, cookieOptions);
  res.clearCookie('rv_csrf', { secure: true, sameSite: 'strict', path: '/' });
};
const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { data: null, error: { message: 'Too many attempts. Wait 15 minutes and try again.' } } });

async function session(req, _res, next) {
  try {
    const token = cookieValue(req, cookieName);
    if (!token) { req.auth = null; return next(); }
    const result = await pool.query(`SELECT s.id AS session_id, s.user_id, s.auth_mode, s.flow_id, s.csrf_hash, s.expires_at,
      m.email, m.display_name, m.role, m.active, m.finance_access
      FROM dashboard_sessions s JOIN team_members m ON m.user_id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(token)]);
    req.auth = result.rows[0] || null;
    next();
  } catch (error) { next(error); }
}
app.use('/api', session);

function requireActive(req, res, next) {
  if (!req.auth || req.auth.auth_mode !== 'normal' || !req.auth.active) return jsonError(res, 401, 'Sign in with an active team account.');
  next();
}
function requireCsrf(req, res, next) {
  const cookie = cookieValue(req, 'rv_csrf');
  const header = req.get('x-rv-csrf') || '';
  if (!req.auth || !cookie || !header || header !== cookie || hash(cookie) !== req.auth.csrf_hash) return jsonError(res, 403, 'Security token expired. Reload the page and try again.');
  next();
}
function requireManager(req, res, next) {
  if (!['owner', 'general_manager'].includes(req.auth?.role)) return jsonError(res, 403, 'Only an owner or general manager can manage team access.');
  next();
}
function requireFinance(req, res, next) {
  if (!req.auth?.active || !req.auth.finance_access || !['owner', 'general_manager', 'project_contributor'].includes(req.auth.role)) return jsonError(res, 403, 'You do not have financial record access.');
  next();
}
function passwordPolicy(password, email = '') {
  if (typeof password !== 'string' || password.length < 14 || password.length > 200) return 'Use a unique password with at least 14 characters.';
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())) return 'Do not include your email name in the password.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) return 'Use a strong passphrase with upper- and lowercase letters and at least one number.';
  return '';
}
async function writeAudit(client, type, key, operation, actor) {
  await client.query('INSERT INTO audit_events(entity_type,entity_key,operation,actor_id) VALUES($1,$2,$3,$4)', [type, String(key), operation, actor || null]);
}
async function createSession(res, memberId, mode = 'normal', flowId = null) {
  const token = randomToken();
  const csrf = randomToken();
  await pool.query('INSERT INTO dashboard_sessions(user_id,token_hash,csrf_hash,auth_mode,flow_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6::interval)', [memberId, hash(token), hash(csrf), mode, flowId, ttl]);
  setSessionCookies(res, token, csrf);
  return csrf;
}
async function sendMail(to, subject, text) {
  if (!emailTransport || !process.env.MAIL_FROM || !origin) throw new Error('Email delivery is not configured. Ask the administrator to set the approved SMTP sender before inviting users.');
  await emailTransport.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
}
const memberShape = row => ({ user_id: row.user_id, display_name: row.display_name, role: row.role, active: row.active, finance_access: row.finance_access });

app.get('/api/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { jsonError(res, 503, 'Database unavailable.'); }
});

app.post('/api/auth/bootstrap', authLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const expected = String(process.env.BOOTSTRAP_TOKEN || '');
    const supplied = String(req.body?.token || '');
    if (expected.length < 32 || !crypto.timingSafeEqual(Buffer.from(hash(expected)), Buffer.from(hash(supplied)))) return jsonError(res, 403, 'Initial setup is unavailable or the setup token is incorrect.');
    const displayName = String(req.body?.display_name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!displayName || displayName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(res, 400, 'Enter a name and valid email address.');
    const issue = passwordPolicy(password, email);
    if (issue) return jsonError(res, 400, issue);
    const digest = await bcrypt.hash(password, 12);
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('rv-dashboard-bootstrap'))");
    const complete = await client.query("SELECT setting_value FROM system_settings WHERE setting_key='bootstrap_complete' FOR UPDATE");
    const count = await client.query('SELECT count(*)::int AS count FROM team_members');
    if (complete.rowCount || count.rows[0].count > 0) { await client.query('ROLLBACK'); return jsonError(res, 409, 'Initial setup has already been completed.'); }
    const result = await client.query(`INSERT INTO team_members(email,display_name,password_hash,role,active,finance_access)
      VALUES($1,$2,$3,'owner',true,true) RETURNING user_id`, [email, displayName, digest]);
    await client.query("INSERT INTO system_settings(setting_key,setting_value) VALUES('bootstrap_complete','true')");
    await writeAudit(client, 'team_members', result.rows[0].user_id, 'INSERT', result.rows[0].user_id);
    await client.query('COMMIT');
    res.status(201).json({ data: { message: 'Owner account created. Remove BOOTSTRAP_TOKEN from the VPS environment and sign in.' }, error: null });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.get('/api/auth/session', async (req, res) => {
  if (!req.auth) return res.json({ data: { session: null }, error: null });
  res.json({ data: { session: { user: { id: req.auth.user_id, email: req.auth.email }, authMode: req.auth.auth_mode } }, error: null });
});
app.post('/api/auth/sign-in', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const result = await pool.query('SELECT user_id,email,password_hash,active FROM team_members WHERE lower(email)=lower($1)', [email]);
    const member = result.rows[0];
    const ok = await bcrypt.compare(password, member?.password_hash || dummyPasswordHash);
    if (!member || !ok || !member.active) return jsonError(res, 401, 'Email or password is incorrect, or the account is not active.');
    const csrf = await createSession(res, member.user_id);
    await writeAudit(pool, 'team_members', member.user_id, 'LOGIN', member.user_id);
    res.json({ data: { session: { user: { id: member.user_id, email: member.email } }, csrf }, error: null });
  } catch (error) { next(error); }
});
app.post('/api/auth/sign-out', requireCsrf, async (req, res, next) => {
  try { await writeAudit(pool, 'team_members', req.auth.user_id, 'LOGOUT', req.auth.user_id); await pool.query('DELETE FROM dashboard_sessions WHERE id=$1', [req.auth.session_id]); clearSessionCookies(res); res.json({ data: { session: null }, error: null }); }
  catch (error) { next(error); }
});

app.post('/api/auth/invitations', requireActive, requireCsrf, requireManager, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!emailTransport || !process.env.MAIL_FROM || !origin) return jsonError(res, 503, 'Email delivery is not configured. Ask the administrator to set the approved SMTP sender before inviting users.');
    const displayName = String(req.body?.display_name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = String(req.body?.role || 'intern');
    const financeAccess = req.body?.finance_access === true;
    if (!displayName || displayName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError(res, 400, 'Enter a name and valid work email.');
    if (!['owner','general_manager','intern','project_contributor','member'].includes(role)) return jsonError(res, 400, 'Invalid team role.');
    if (financeAccess && !['owner','general_manager','project_contributor'].includes(role)) return jsonError(res, 400, 'This role cannot be given finance access.');
    const token = randomToken();
    await client.query('BEGIN');
    const existing = await client.query('SELECT user_id FROM team_members WHERE lower(email)=lower($1)', [email]);
    if (existing.rowCount) { await client.query('ROLLBACK'); return jsonError(res, 409, 'An account already exists for this email. Ask an owner to update its access.'); }
    const member = await client.query(`INSERT INTO team_members(email,display_name,role,active,finance_access)
      VALUES($1,$2,$3,false,$4) RETURNING user_id`, [email, displayName, role, financeAccess]);
    await client.query('INSERT INTO team_invitations(user_id,token_hash,expires_at,created_by) VALUES($1,$2,now()+interval \'72 hours\',$3)', [member.rows[0].user_id, hash(token), req.auth.user_id]);
    await client.query('COMMIT');
    const inviteUrl = `${origin}/?invite=${encodeURIComponent(token)}#type=invite`;
    try { await sendMail(email, 'Relocation Vietnam dashboard invitation', `Hello ${displayName},\n\nYou have been invited to the Relocation Vietnam dashboard. This link expires in 72 hours:\n${inviteUrl}\n\nIf you were not expecting this, ignore this email.`); }
    catch (error) { await pool.query('DELETE FROM team_members WHERE user_id=$1 AND active=false', [member.rows[0].user_id]); return jsonError(res, 503, error.message); }
    await writeAudit(pool, 'team_members', member.rows[0].user_id, 'INVITE', req.auth.user_id);
    res.json({ data: { message: 'Invitation sent.' }, error: null });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/auth/invitations/consume', authLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const token = String(req.body?.token || '');
    await client.query('BEGIN');
    const result = await client.query(`SELECT i.id,m.user_id,m.email FROM team_invitations i JOIN team_members m USING(user_id)
      WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.expires_at>now() AND m.active=false FOR UPDATE OF i`, [hash(token)]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return jsonError(res, 400, 'This invitation link is invalid or expired. Ask a manager to send a new one.'); }
    const invite = result.rows[0];
    await client.query('UPDATE team_invitations SET consumed_at=now() WHERE id=$1', [invite.id]);
    await client.query('COMMIT');
    const csrf = await createSession(res, invite.user_id, 'invite', invite.id);
    res.json({ data: { session: { user: { id: invite.user_id, email: invite.email }, authMode: 'invite' }, csrf }, error: null });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/auth/password-reset', authLimiter, async (req, res, next) => {
  try {
    if (!emailTransport || !process.env.MAIL_FROM || !origin) return jsonError(res, 503, 'Password reset email is not available yet. Contact the dashboard administrator.');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const result = await pool.query('SELECT user_id,email FROM team_members WHERE lower(email)=lower($1) AND active=true', [email]);
    if (result.rowCount) {
      const token = randomToken();
      await pool.query('INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval \'30 minutes\')', [result.rows[0].user_id, hash(token)]);
      const url = `${origin}/?recover=${encodeURIComponent(token)}#type=recovery`;
      try { await sendMail(email, 'Relocation Vietnam dashboard password reset', `A password reset was requested. This link expires in 30 minutes:\n${url}\n\nIf you did not request it, ignore this email.`); }
      catch (error) { await pool.query('DELETE FROM password_resets WHERE token_hash=$1', [hash(token)]); return jsonError(res, 503, 'Password reset email could not be sent. Contact the dashboard administrator.'); }
    }
    res.json({ data: { message: 'If an active account exists for that email, a reset email has been requested.' }, error: null });
  } catch (error) { next(error); }
});
app.post('/api/auth/password-reset/consume', authLimiter, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const token = String(req.body?.token || '');
    await client.query('BEGIN');
    const result = await client.query('SELECT id,user_id FROM password_resets WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [hash(token)]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return jsonError(res, 400, 'This reset link is invalid or expired. Request another one.'); }
    const row = result.rows[0];
    await client.query('UPDATE password_resets SET consumed_at=now() WHERE id=$1', [row.id]);
    await client.query('COMMIT');
    const csrf = await createSession(res, row.user_id, 'recovery', row.id);
    res.json({ data: { session: { user: { id: row.user_id }, authMode: 'recovery' }, csrf }, error: null });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});
app.post('/api/auth/password', requireCsrf, async (req, res, next) => {
  try {
    if (!req.auth || !['normal','invite','recovery'].includes(req.auth.auth_mode)) return jsonError(res, 401, 'Your password flow expired. Sign in or request a new link.');
    const password = String(req.body?.password || '');
    const issue = passwordPolicy(password, req.auth.email || '');
    if (issue) return jsonError(res, 400, issue);
    const digest = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE team_members SET password_hash=$1,active=true,updated_at=now() WHERE user_id=$2', [digest, req.auth.user_id]);
      if (req.auth.auth_mode === 'invite') await client.query('UPDATE team_invitations SET consumed_at=coalesce(consumed_at,now()) WHERE id=$1', [req.auth.flow_id]);
      if (req.auth.auth_mode === 'recovery') await client.query('UPDATE password_resets SET consumed_at=coalesce(consumed_at,now()) WHERE id=$1', [req.auth.flow_id]);
      await client.query('UPDATE dashboard_sessions SET auth_mode=\'normal\',flow_id=NULL,expires_at=now()+$2::interval WHERE id=$1', [req.auth.session_id, ttl]);
      const auditOperation = req.auth.auth_mode === 'invite' ? 'INVITE' : req.auth.auth_mode === 'recovery' ? 'PASSWORD_RESET' : 'PASSWORD_CHANGE';
      await writeAudit(client, 'team_members', req.auth.user_id, auditOperation, req.auth.user_id);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    res.json({ data: { user: { id: req.auth.user_id, email: req.auth.email } }, error: null });
  } catch (error) { next(error); }
});

app.patch('/api/team-members/:userId', requireActive, requireCsrf, requireManager, async (req, res, next) => {
  const userId = String(req.params.userId || '');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return jsonError(res, 400, 'Invalid team member id.');
  const role = String(req.body?.role || '');
  const financeAccess = req.body?.finance_access === true;
  if (!['owner','general_manager','intern','project_contributor','member'].includes(role)) return jsonError(res, 400, 'Invalid team role.');
  if (financeAccess && !['owner','general_manager','project_contributor'].includes(role)) return jsonError(res, 400, 'This role cannot be given finance access.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT user_id,role,active FROM team_members WHERE user_id=$1 FOR UPDATE', [userId]);
    if (!target.rowCount) { await client.query('ROLLBACK'); return jsonError(res, 404, 'Team member not found.'); }
    if (target.rows[0].active && target.rows[0].role === 'owner' && role !== 'owner') {
      const owners = await client.query("SELECT count(*)::int AS count FROM team_members WHERE active=true AND role='owner'");
      if (owners.rows[0].count <= 1) { await client.query('ROLLBACK'); return jsonError(res, 409, 'The last active owner cannot be demoted. Promote another owner first.'); }
    }
    const result = await client.query('UPDATE team_members SET role=$1,finance_access=$2,updated_at=now(),updated_by=$3 WHERE user_id=$4 RETURNING user_id,display_name,role,active,finance_access', [role, financeAccess, req.auth.user_id, userId]);
    await writeAudit(client, 'team_members', userId, 'UPDATE', req.auth.user_id);
    await client.query('COMMIT');
    res.json({ data: { member: memberShape(result.rows[0]) }, error: null });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

const tables = {
  team_members: { columns: ['user_id','display_name','role','active','finance_access'], key: 'user_id' },
  workspace_records: { columns: ['record_type','record_key','customer_key','payload','updated_at'], key: 'record_key' },
  finance_records: { columns: ['record_key','customer_key','record_kind','payload','updated_at'], key: 'record_key' },
};
app.get('/api/data/:table', requireActive, async (req, res, next) => {
  try {
    const table = req.params.table;
    if (!tables[table]) return jsonError(res, 404, 'Unknown data collection.');
    if (table === 'finance_records' && (!req.auth.finance_access || !['owner','general_manager','project_contributor'].includes(req.auth.role))) return jsonError(res, 403, 'You do not have financial record access.');
    const definition = tables[table];
    const requested = String(req.query.select || '*').split(',').map(s => s.trim()).filter(Boolean);
    const cols = requested.includes('*') ? definition.columns : requested.filter(c => definition.columns.includes(c));
    if (!cols.length) return jsonError(res, 400, 'No allowed fields requested.');
    const params = [];
    const where = [];
    const filters = { user_id: 'user_id', active: 'active', record_type: 'record_type', record_key: 'record_key' };
    for (const [queryName, column] of Object.entries(filters)) {
      const value = req.query[`eq_${queryName}`];
      if (value !== undefined) { params.push(value); where.push(`${column}=$${params.length}`); }
    }
    if (table === 'team_members') {
      params.push(req.auth.user_id);
      where.push(`(active=true OR user_id=$${params.length})`);
    }
    const orderBy = String(req.query.order_by || 'updated_at');
    const allowedOrder = definition.columns.includes(orderBy) ? orderBy : (table === 'team_members' ? 'display_name' : 'updated_at');
    const direction = req.query.order_ascending === 'true' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 1000)));
    const sql = `SELECT ${cols.join(',')} FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${allowedOrder} ${direction} LIMIT ${limit}`;
    const result = await pool.query(sql, params);
    const maybeSingle = req.query.single === 'maybe';
    res.json({ data: maybeSingle ? (result.rows[0] || null) : result.rows, error: null });
  } catch (error) { next(error); }
});
app.post('/api/data/:table', requireActive, requireCsrf, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const table = req.params.table;
    const row = req.body?.row;
    if (!['workspace_records','finance_records'].includes(table) || !row || typeof row !== 'object' || Array.isArray(row)) return jsonError(res, 400, 'Invalid record.');
    if (table === 'finance_records' && (!req.auth.finance_access || !['owner','general_manager','project_contributor'].includes(req.auth.role))) return jsonError(res, 403, 'You do not have financial record access.');
    await client.query('BEGIN');
    let result;
    if (table === 'workspace_records') {
      const allowedTypes = ['customer','service_track','task','message_thread','message','followup','campaign','improvement','activity'];
      if (!allowedTypes.includes(row.record_type) || !row.record_key || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) { await client.query('ROLLBACK'); return jsonError(res, 400, 'Invalid operational record.'); }
      result = await client.query(`INSERT INTO workspace_records(record_type,record_key,customer_key,payload,updated_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(record_type,record_key) DO UPDATE SET customer_key=EXCLUDED.customer_key,payload=EXCLUDED.payload,updated_at=now(),updated_by=EXCLUDED.updated_by
        RETURNING record_type,record_key,customer_key,payload,updated_at`, [row.record_type,row.record_key,row.customer_key || null,row.payload,req.auth.user_id]);
      await writeAudit(client, table, row.record_key, 'UPSERT', req.auth.user_id);
    } else {
      const allowedKinds = ['quote','invoice','payment','expense','commission','other'];
      if (!row.record_key || !allowedKinds.includes(row.record_kind) || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) { await client.query('ROLLBACK'); return jsonError(res, 400, 'Invalid finance record.'); }
      result = await client.query(`INSERT INTO finance_records(record_key,customer_key,record_kind,payload,updated_by)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(record_key) DO UPDATE SET customer_key=EXCLUDED.customer_key,record_kind=EXCLUDED.record_kind,payload=EXCLUDED.payload,updated_at=now(),updated_by=EXCLUDED.updated_by
        RETURNING record_key,customer_key,record_kind,payload,updated_at`, [row.record_key,row.customer_key || null,row.record_kind,row.payload,req.auth.user_id]);
      await writeAudit(client, table, row.record_key, 'UPSERT', req.auth.user_id);
    }
    await client.query('COMMIT');
    res.json({ data: result.rows[0], error: null });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});
app.delete('/api/data/:table/:key', requireActive, requireCsrf, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const table = req.params.table;
    if (!['workspace_records','finance_records'].includes(table)) return jsonError(res, 404, 'Unknown data collection.');
    if (table === 'finance_records' && (!req.auth.finance_access || !['owner','general_manager','project_contributor'].includes(req.auth.role))) return jsonError(res, 403, 'You do not have financial record access.');
    await client.query('BEGIN');
    const params = [req.params.key];
    let sql = table === 'finance_records' ? 'DELETE FROM finance_records WHERE record_key=$1' : 'DELETE FROM workspace_records WHERE record_key=$1';
    if (table === 'workspace_records' && req.query.record_type) { params.push(req.query.record_type); sql += ' AND record_type=$2'; }
    const result = await client.query(`${sql} RETURNING record_key`, params);
    if (result.rowCount) await writeAudit(client, table, result.rows[0].record_key, 'DELETE', req.auth.user_id);
    await client.query('COMMIT');
    res.json({ data: result.rows[0] || null, error: null });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.use('/api', (_req, res) => jsonError(res, 404, 'API route not found.'));
app.use((error, _req, res, _next) => {
  console.error('API error:', error?.message || 'unknown');
  jsonError(res, 500, 'The request could not be completed. Try again or contact the dashboard administrator.');
});

const publicDir = path.resolve(__dirname, '../site');
try { await fs.access(publicDir); app.use(express.static(publicDir, { index: 'index.html', etag: true, maxAge: '1h' })); } catch { /* App API can run before the website source is staged. */ }
app.get('*', async (_req, res) => {
  try { res.sendFile(path.join(publicDir, 'index.html')); }
  catch { jsonError(res, 404, 'Dashboard site files are not staged yet.'); }
});

async function start() {
  if (!process.env.DATABASE_URL || !origin || !origin.startsWith('https://')) throw new Error('DATABASE_URL and an HTTPS APP_ORIGIN are required.');
  const schema = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`Relocation Vietnam dashboard API listening on ${port}`));
}
start().catch(error => { console.error('Startup failed:', error.message); process.exit(1); });
