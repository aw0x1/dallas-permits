/**
 * Daily incremental scrape.
 * Searches the last LOOKBACK_DAYS (default 8) across all modules.
 * Overlap catches edits to recently-filed records.
 *
 * Usage:
 *   node scripts/incremental.js
 *   LOOKBACK_DAYS=14 node scripts/incremental.js
 */

import { makeBrowser, searchWindow, extractDetail, MODULES, fmtDate, monthWindows } from '../src/scraper.js';
import { upsertPermit, linkPermitToAddress } from '../src/db.js';

const LOOKBACK  = parseInt(process.env.LOOKBACK_DAYS || '8', 10);

async function main() {
  const end   = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - LOOKBACK);

  // Split into monthly windows — Accela returns no results for cross-month date ranges
  const windows = [...monthWindows(start, end)];
  console.log(`Incremental scrape: ${fmtDate(start)} → ${fmtDate(end)} (${LOOKBACK} day lookback, ${windows.length} window(s))`);

  const browser = await makeBrowser();
  const page    = await browser.newPage();
  page.setDefaultTimeout(30000);

  let total = 0;

  for (const mod of MODULES) {
    console.log(`\n── ${mod.name}`);
    let count = 0;

    for (const win of windows) {
    try {
      for await (const row of searchWindow(page, mod, win.start, win.end)) {
        const record = {
          module:        mod.name,
          record_number: row['record_number'] || row['permit_number'] || row['application_#'] || null,
          status:        row['status'] || row['record_status'] || null,
          permit_type:   row['record_type'] || row['type'] || null,
          applied_date:  row['opened'] || row['filed_date'] || row['application_date'] || null,
          address:       row['address'] || null,
          description:   row['description'] || row['project_name'] || null,
          _raw_list:     row,
          scraped_at:    new Date().toISOString(),
        };

        if (!record.record_number) continue;

        if (row._detail_url) {
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
          } catch {}
        }

        await upsertPermit(record);
        if (record.address) {
          const id = record.record_number.replace(/[^a-zA-Z0-9]/g, '_');
          await linkPermitToAddress(id, record.address).catch(() => {});
        }

        count++;
      }
    } catch (err) {
      console.error(`  !! ${mod.name}/${win.start} error: ${err.message}`);
    }
    } // end windows loop

    console.log(`  ${count} records upserted`);
    total += count;
  }

  await browser.close();
  console.log(`\nIncremental complete: ${total} total records upserted.`);
}

main().catch(err => { console.error(err); process.exit(1); });
