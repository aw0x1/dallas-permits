// SurrealDB HTTP client.
// Supports two auth modes:
//   SURREALDB_TOKEN  — Bearer JWT (Surreal Cloud)
//   SURREALDB_USER + SURREALDB_PASS — Basic auth (self-hosted)

const URL_  = process.env.SURREALDB_URL  || 'http://localhost:8000';
const NS    = process.env.SURREALDB_NS   || 'dallas';
const DB    = process.env.SURREALDB_DB   || 'permits';

function authHeader() {
  if (process.env.SURREALDB_TOKEN) {
    return `Bearer ${process.env.SURREALDB_TOKEN}`;
  }
  const user = process.env.SURREALDB_USER || 'root';
  const pass = process.env.SURREALDB_PASS || 'root';
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

const HEADERS = () => ({
  'Content-Type':  'application/json',
  'Accept':        'application/json',
  'surreal-ns':    NS,
  'surreal-db':    DB,
  'Authorization': authHeader(),
});

export async function query(sql, vars = {}) {
  // SurrealDB HTTP API: raw SQL in body, variables as URL query params (JSON-encoded for objects)
  let endpoint = `${URL_}/sql`;
  const keys = vars ? Object.keys(vars) : [];
  if (keys.length) {
    const params = new URLSearchParams();
    for (const k of keys) {
      const v = vars[k];
      params.set(k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
    }
    endpoint += '?' + params.toString();
  }

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: HEADERS(),
    body:    sql,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SurrealDB ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

export async function upsertPermit(data) {
  const id = safeId(data.record_number || data._url || Math.random().toString(36).slice(2));
  return query(`UPSERT permit:⟨${id}⟩ MERGE $data`, { data });
}

export async function linkPermitToAddress(permitRecordNumber, address) {
  const pid = safeId(permitRecordNumber);
  const aid = safeId(address);
  await query(`UPSERT address:⟨${aid}⟩ SET text = $addr`, { addr: address });
  return query(
    `RELATE permit:⟨${pid}⟩->located_at->address:⟨${aid}⟩ SET at = time::now()`,
  );
}

export async function getLastScrapeDate(module) {
  try {
    const res = await query(
      `SELECT scraped_at FROM permit WHERE module = $mod ORDER BY scraped_at DESC LIMIT 1`,
      { mod: module }
    );
    return res[0]?.result?.[0]?.scraped_at || null;
  } catch {
    return null;
  }
}

export async function applySchema() {
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.surql');
  const schema = readFileSync(schemaPath, 'utf8');

  // Split on semicolons and run each statement (SurrealDB REST needs one statement at a time
  // or the full batch — sending the full file works fine)
  return query(schema);
}

function safeId(str) {
  return String(str)
    .replace(/[^a-zA-Z0-9\-_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 80) || 'unknown';
}
