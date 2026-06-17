/**
 * Full historical index — parallel by module, optional detail fetch.
 * Safe to re-run (UPSERT on record_number, resumable cursor per module).
 *
 * Usage:
 *   START_DATE=2010-01-01 node scripts/index.js
 *   START_DATE=2020-01-01 MODULE=Building node scripts/index.js
 *   SKIP_DETAIL=1 node scripts/index.js        # fast list-only pass
 *   CONCURRENCY=4 node scripts/index.js        # modules in parallel (default: all)
 */

import { makeBrowser, searchWindow, extractDetail, MODULES, monthWindows } from '../src/scraper.js';
import { upsertPermit, linkPermitToAddress, applySchema, query } from '../src/db.js';

// Parse as local date to avoid UTC timezone shifting the month
const [sy, sm, sd] = (process.env.START_DATE || '2010-01-01').split('-').map(Number);
const START_DATE  = new Date(sy, sm - 1, sd);
const END_DATE    = new Date();
const ONLY_MODULE = process.env.MODULE   || null;
const SKIP_DETAIL = process.env.SKIP_DETAIL === '1';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);

const modules = ONLY_MODULE
  ? MODULES.filter(m => m.name === ONLY_MODULE)
  : MODULES;

async function indexModule(mod) {
  const browser = await makeBrowser();
  const page    = await browser.newPage();
  page.setDefaultTimeout(30000);

  // Resume from cursor
  const cursorRes = await query(
    `SELECT last_end FROM scrape_cursor WHERE module = $mod LIMIT 1`,
    { mod: mod.name }
  ).catch(() => null);
  const lastEnd  = cursorRes?.[0]?.result?.[0]?.last_end;
  const fromDate = lastEnd ? new Date(lastEnd) : START_DATE;

  if (lastEnd) console.log(`[${mod.name}] Resuming from ${lastEnd}`);

  let total = 0;

  for (const win of monthWindows(fromDate, END_DATE)) {
    let count = 0;
    try {
      for await (const row of searchWindow(page, mod, win.start, win.end)) {
        const record = buildRecord(row, mod.name);
        if (!record.record_number) continue;

        if (!SKIP_DETAIL && row._detail_url) {
          try {
            const detail = await extractDetail(page, row._detail_url);
            mergeDetail(record, detail);
          } catch {}
        }

        await upsertPermit(record);
        if (record.address) {
          await linkPermitToAddress(record.record_number, record.address).catch(() => {});
        }
        count++;
      }
    } catch (err) {
      console.error(`[${mod.name}] !! ${win.start}: ${err.message}`);
    }

    await query(
      `UPSERT scrape_cursor:⟨${mod.name}⟩ SET module=$mod, last_end=$end, updated_at=time::now()`,
      { mod: mod.name, end: win.end }
    ).catch(() => {});

    if (count) console.log(`[${mod.name}] ${win.start}→${win.end}: ${count} records`);
    total += count;
  }

  await browser.close();
  return total;
}

function buildRecord(row, moduleName) {
  return {
    module:        moduleName,
    record_number: row['record_number'] || row['permit_number'] || row['application_#'] || null,
    status:        row['status'] || row['record_status'] || null,
    permit_type:   row['record_type'] || row['type'] || null,
    applied_date:  row['date'] || row['opened'] || row['filed_date'] || null,
    address:       row['address'] || null,
    description:   row['description'] || null,
    project_name:  row['project_name'] || null,
    expiration_date: row['expiration_date'] || null,
    short_notes:   row['short_notes'] || null,
    _raw_list:     row,
    scraped_at:    new Date().toISOString(),
  };
}

function mergeDetail(record, detail) {
  Object.assign(record, {
    issued_date:     detail['issued_date']    || detail['issue_date']    || null,
    expiration_date: detail['expiration_date']|| detail['expire_date']   || null,
    project_name:    detail['project_name']   || detail['description']   || record.project_name,
    parcel_number:   detail['parcel_number']  || detail['parcel_#']      || null,
    license_number:  detail['license_number'] || detail['contractor_license'] || null,
    _detail:         detail,
  });
}

async function main() {
  console.log(`Applying schema...`);
  await applySchema();

  const mode = SKIP_DETAIL ? 'list-only (fast)' : 'with detail pages';
  console.log(`\nIndexing ${modules.map(m => m.name).join(', ')} | ${mode} | concurrency ${Math.min(CONCURRENCY, modules.length)}`);
  console.log(`Range: ${START_DATE.toDateString()} → ${END_DATE.toDateString()}\n`);

  // Run modules in parallel, up to CONCURRENCY at a time
  const results = [];
  for (let i = 0; i < modules.length; i += CONCURRENCY) {
    const batch = modules.slice(i, i + CONCURRENCY);
    const counts = await Promise.all(batch.map(indexModule));
    batch.forEach((m, j) => results.push({ module: m.name, total: counts[j] }));
  }

  console.log('\n══ Complete ══');
  results.forEach(r => console.log(`  ${r.module}: ${r.total} records`));
  console.log(`  Total: ${results.reduce((s, r) => s + r.total, 0)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
