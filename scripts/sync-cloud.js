/**
 * Sync the last SYNC_DAYS of permits from local Optiplex SurrealDB
 * to Surreal Cloud (free tier). Keeps the cloud instance as a
 * public-facing recent window well within the 1GB free limit.
 *
 * ~15K records × ~2KB = ~30MB — easily fits forever.
 *
 * Usage:
 *   SURREALDB_URL=http://localhost:8000 \
 *   SURREALDB_USER=root SURREALDB_PASS=root \
 *   CLOUD_URL=https://shiny-ember-....surreal.cloud \
 *   CLOUD_TOKEN=eyJ... \
 *   node scripts/sync-cloud.js
 */

const LOCAL_URL  = process.env.SURREALDB_URL  || 'http://localhost:8000';
const LOCAL_USER = process.env.SURREALDB_USER || 'root';
const LOCAL_PASS = process.env.SURREALDB_PASS || 'root';
const CLOUD_URL  = process.env.CLOUD_URL  || '';
const CLOUD_TOKEN = process.env.CLOUD_TOKEN || '';
const SYNC_DAYS  = parseInt(process.env.SYNC_DAYS || '90', 10);
const NS = 'dallas';
const DB = 'permits';

if (!CLOUD_URL || !CLOUD_TOKEN) {
  console.error('CLOUD_URL and CLOUD_TOKEN are required.');
  process.exit(1);
}

function localHeaders() {
  return {
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'surreal-ns':    NS,
    'surreal-db':    DB,
    'Authorization': 'Basic ' + Buffer.from(`${LOCAL_USER}:${LOCAL_PASS}`).toString('base64'),
  };
}

function cloudHeaders() {
  return {
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'surreal-ns':    NS,
    'surreal-db':    DB,
    'Authorization': `Bearer ${CLOUD_TOKEN}`,
  };
}

async function localQuery(sql, vars = {}) {
  const res = await fetch(`${LOCAL_URL}/sql`, {
    method: 'POST', headers: localHeaders(),
    body: vars && Object.keys(vars).length ? JSON.stringify({ query: sql, vars }) : sql,
  });
  if (!res.ok) throw new Error(`Local DB ${res.status}: ${await res.text()}`);
  return res.json();
}

async function cloudQuery(sql, vars = {}) {
  const res = await fetch(`${CLOUD_URL}/sql`, {
    method: 'POST', headers: cloudHeaders(),
    body: vars && Object.keys(vars).length ? JSON.stringify({ query: sql, vars }) : sql,
  });
  if (!res.ok) throw new Error(`Cloud DB ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - SYNC_DAYS);
  const cutoffStr = cutoff.toISOString();

  console.log(`Syncing permits newer than ${cutoffStr} to Surreal Cloud...`);

  // Pull recent records from local
  const result = await localQuery(
    `SELECT * FROM permit WHERE scraped_at >= $cutoff ORDER BY scraped_at ASC`,
    { cutoff: cutoffStr }
  );

  const records = result[0]?.result || [];
  console.log(`Found ${records.length} records to sync.`);

  if (records.length === 0) {
    console.log('Nothing to sync.');
    return;
  }

  // Apply schema on cloud first (idempotent)
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.surql');
  const schema = readFileSync(schemaPath, 'utf8');
  await cloudQuery(schema);
  console.log('Schema applied.');

  // First prune cloud records older than SYNC_DAYS
  await cloudQuery(
    `DELETE permit WHERE scraped_at < $cutoff`,
    { cutoff: cutoffStr }
  );
  console.log(`Pruned cloud records older than ${SYNC_DAYS} days.`);

  // Upsert in batches of 200
  const BATCH = 200;
  let synced = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const sql = batch.map(r => {
      const id = String(r.id).replace(/^permit:/, '');
      // Strip surreal internal id before merge
      const { id: _, ...data } = r;
      return `UPSERT permit:⟨${id}⟩ MERGE ${JSON.stringify(data)};`;
    }).join('\n');
    await cloudQuery(sql);
    synced += batch.length;
    process.stdout.write(`\r  Synced ${synced}/${records.length}...`);
  }

  console.log(`\nDone. ${synced} permits synced to Surreal Cloud.`);
}

main().catch(err => { console.error(err); process.exit(1); });
