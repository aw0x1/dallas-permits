/**
 * Smoke test — confirms the scraper can reach the site, click Search,
 * and extract at least one row. Does not write to SurrealDB.
 *
 * Usage: node scripts/verify.js
 */

import { makeBrowser, searchWindow, MODULES, fmtDate, monthWindows } from '../src/scraper.js';

async function main() {
  const browser = await makeBrowser();
  const page    = await browser.newPage();

  // Use a single-month window from 60 days ago to avoid cross-month boundary issue
  const end   = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1); // first of current month

  const [window] = [...monthWindows(start, end)];
  console.log(`Verifying: ${window.start} → ${window.end}`);

  let found = false;
  for await (const row of searchWindow(page, MODULES[0], window.start, window.end)) {
    console.log('Sample row:', JSON.stringify(row, null, 2));
    found = true;
    break;
  }

  await browser.close();

  if (!found) {
    console.error('No rows found — scraper may be broken or month has no records yet.');
    process.exit(1);
  }
  console.log('\n✓ Scraper OK');
}

main().catch(err => { console.error(err); process.exit(1); });
