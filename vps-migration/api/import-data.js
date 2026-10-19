import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const dir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node import-data.js <private-export-directory>');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured.');
const maxFileBytes = 100 * 1024 * 1024;
const validTypes = new Set(['customer','service_track','task','message_thread','message','followup','campaign','improvement','activity']);
const validKinds = new Set(['quote','invoice','payment','expense','commission','other']);
async function readArray(filename) {
  const file = path.join(dir, filename);
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > maxFileBytes) throw new Error(`${filename} must be a regular file smaller than 100 MB.`);
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(value) || value.length > 50_000) throw new Error(`${filename} must contain a JSON array with at most 50,000 records.`);
  return value;
}
function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new Error(`Invalid ${field} in export.`);
  return value;
}
function requiredPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Record payloads must be JSON objects.');
  return JSON.stringify(value);
}
const operational = await readArray('workspace_records.json');
const finance = await readArray('finance_records.json');
for (const row of operational) {
  if (!validTypes.has(row.record_type)) throw new Error('Unsupported operational record type in export.');
  requiredString(row.record_key, 'record key');
  requiredPayload(row.payload);
}
for (const row of finance) {
  requiredString(row.record_key, 'finance record key');
  if (!validKinds.has(row.record_kind)) throw new Error('Unsupported finance record kind in export.');
  requiredPayload(row.payload);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query(`SELECT
    (SELECT count(*)::int FROM workspace_records) AS operational,
    (SELECT count(*)::int FROM finance_records) AS finance`);
  if (existing.rows[0].operational || existing.rows[0].finance) throw new Error('Target tables are not empty; refusing to overwrite or merge during first import.');
  for (const row of operational) {
    await client.query(`INSERT INTO workspace_records(record_type,record_key,customer_key,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,coalesce($5::timestamptz,now()),coalesce($6::timestamptz,now()))`,
    [row.record_type,row.record_key,row.customer_key || null,requiredPayload(row.payload),row.created_at || null,row.updated_at || null]);
  }
  for (const row of finance) {
    await client.query(`INSERT INTO finance_records(record_key,customer_key,record_kind,payload,created_at,updated_at)
      VALUES($1,$2,$3,$4,coalesce($5::timestamptz,now()),coalesce($6::timestamptz,now()))`,
    [row.record_key,row.customer_key || null,row.record_kind,requiredPayload(row.payload),row.created_at || null,row.updated_at || null]);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ imported: { operational: operational.length, finance: finance.length }, mode: 'first import into empty target' }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`Import stopped safely: ${error.message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
