/**
 * Full historical index.
 * Scrapes every module month-by-month from START_DATE to today.
 * Safe to re-run — UPSERT on record_number means no duplicates.
 *
 * Usage:
 *   START_DATE=2010-01-01 node scripts/index.js
 *   START_DATE=2020-01-01 MODULE=Building node scripts/index.js
 */

import { makeBrowser, searchWindow, extractDetail, MODULES, monthWindows } from '../src/scraper.js';
import { upsertPermit, linkPermitToAddress, applySchema, query } from '../src/db.js';

const START_DATE  = new Date(process.env.START_DATE || '2010-01-01');
const END_DATE    = new Date();
const ONLY_MODULE = process.env.MODULE || null;
const DETAIL      = process.env.SKIP_DETAIL !== '1'; // set SKIP_DETAIL=1 for list-only fast pass

async function main() {
  console.log('Applying schema...');
  await applySchema();

  const browser = await makeBrowser();
  const page    = await browser.newPage();
  page.setDefaultTimeout(30000);

  const modules = ONLY_MODULE
    ? MODULES.filter(m => m.name === ONLY_MODULE)
    : MODULES;

  for (const mod of modules) {
    console.log(`\n══ Module: ${mod.name} ══`);

    // Resume from last cursor if available
    const cursorRes = await query(
      `SELECT last_end FROM scrape_cursor WHERE module = $mod LIMIT 1;`,
      { mod: mod.name }
    ).catch(() => null);
    const lastEnd = cursorRes?.[0]?.result?.[0]?.last_end;
    const fromDate = lastEnd ? new Date(lastEnd) : START_DATE;

    if (lastEnd) {
      console.log(`  Resuming from ${lastEnd}`);
    }

    for (const window of monthWindows(fromDate, END_DATE)) {
      console.log(`\n  Window: ${window.start} → ${window.end}`);
      let count = 0;

      try {
        for await (const row of searchWindow(page, mod, window.start, window.end)) {
          const permitId = await ingestRow(page, row, mod.name, DETAIL);
          if (permitId) count++;
        }
      } catch (err) {
        console.error(`  !! Error in window ${window.start}: ${err.message}`);
        // Continue to next window rather than aborting
      }

      // Update cursor after each successful window
      await query(
        `UPSERT scrape_cursor:⟨${mod.name}⟩ SET module = $mod, last_end = $end, updated_at = time::now();`,
        { mod: mod.name, end: window.end }
      ).catch(() => {});

      console.log(`  ✓ ${count} records upserted`);
    }
  }

  await browser.close();
  console.log('\nIndex complete.');
}

async function ingestRow(page, row, moduleName, fetchDetail) {
  // Build base record from list view
  const record = {
    module:       moduleName,
    record_number: row['record_number'] || row['permit_number'] || row['application_#'] || null,
    status:        row['status'] || row['record_status'] || null,
    permit_type:   row['record_type'] || row['type'] || null,
    applied_date:  row['opened'] || row['filed_date'] || row['application_date'] || null,
    address:       row['address'] || null,
    description:   row['description'] || row['project_name'] || null,
    _raw_list:     row,
    scraped_at:    new Date().toISOString(),
  };

  if (!record.record_number) return null;

  // Fetch detail page for full data
  if (fetchDetail && row._detail_url) {
    try {
      const detail = await extractDetail(page, row._detail_url);
      Object.assign(record, {
        issued_date:     detail['issued_date'] || detail['issue_date'] || null,
        expiration_date: detail['expiration_date'] || detail['expire_date'] || null,
        project_name:    detail['project_name'] || detail['description'] || null,
        parcel_number:   detail['parcel_number'] || detail['parcel_#'] || null,
        license_number:  detail['license_number'] || detail['contractor_license'] || null,
        _detail:         detail,
      });
    } catch (err) {
      console.warn(`    ⚠ detail fetch failed for ${record.record_number}: ${err.message}`);
    }
  }

  await upsertPermit(record);

  // Create address relation if we have one
  if (record.address) {
    const id = (record.record_number || '').replace(/[^a-zA-Z0-9]/g, '_');
    await linkPermitToAddress(id, record.address).catch(() => {});
  }

  return record.record_number;
}

main().catch(err => { console.error(err); process.exit(1); });
