import { chromium } from 'playwright-core';

const BASE = 'https://aca-prod.accela.com/DALLASTX';
const GRID  = 'ctl00_PlaceHolderMain_dgvPermitList_gdvPermitList';

export const MODULES = [
  { name: 'Building',    tab: 'Building' },
  { name: 'Planning',    tab: 'Planning' },
  { name: 'Enforcement', tab: 'Enforcement' },
  { name: 'PublicWorks', tab: 'PublicWorks' },
];

export function makeBrowser() {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

// Fill a date input that has an ASP.NET watermark extender
async function fillDate(page, selector, value) {
  await page.click(selector);
  await page.evaluate(s => { document.querySelector(s).value = ''; }, selector);
  await page.type(selector, value, { delay: 40 });
  await page.press(selector, 'Tab');
  await page.waitForTimeout(200);
}

// Click an element by dispatching a native MouseEvent (bypasses Playwright strict-mode eval)
async function nativeClick(page, selector) {
  await page.evaluate(sel => {
    document.querySelector(sel)
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }, selector);
}

// ── Search one module for one date window ──────────────────────────────────
// Yields parsed CSV rows for each page of results.
export async function* searchWindow(page, module, startDate, endDate) {
  const url = `${BASE}/Cap/CapHome.aspx?module=${module.tab}&TabName=${module.tab}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

  await fillDate(page, '#ctl00_PlaceHolderMain_generalSearchForm_txtGSStartDate', startDate);
  await fillDate(page, '#ctl00_PlaceHolderMain_generalSearchForm_txtGSEndDate',   endDate);

  // Submit search — locator click with force bypasses visibility check;
  // wait for grid to appear in DOM (UpdatePanel AJAX, no page navigation)
  await Promise.all([
    page.waitForSelector(`#${GRID}`, { timeout: 25000 }).catch(() => {}),
    page.locator('#ctl00_PlaceHolderMain_btnNewSearch').click({ force: true }),
  ]);

  // Check we have a grid (no results = empty search window)
  const gridExists = await page.$(`#${GRID}`).then(Boolean).catch(() => false);
  if (!gridExists) return;

  let pageNum = 1;
  while (true) {
    // Export current page as CSV (faster and cleaner than HTML scraping)
    const rows = await exportPageAsCSV(page);
    if (rows.length === 0) break;

    // Also grab the detail URLs from the HTML grid (not in CSV)
    const detailUrls = await extractDetailUrls(page);

    // Merge CSV data with detail URLs by position
    for (let i = 0; i < rows.length; i++) {
      yield { ...rows[i], _detail_url: detailUrls[i] || null };
    }

    console.log(`  [${module.name}] ${startDate}→${endDate} page ${pageNum}: ${rows.length} rows`);

    // Navigate to next page
    const hasNext = await goToNextPage(page);
    if (!hasNext) break;
    pageNum++;
  }
}

async function exportPageAsCSV(page) {
  const exportId = `${GRID}_gdvPermitListtop4btnExport`;
  const exportBtn = await page.$(`#${exportId}`);
  if (!exportBtn) return [];

  // dispatchEvent is required here — CDP-based click doesn't trigger __doPostBack downloads
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.evaluate(id => {
      document.getElementById(id)
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, exportId),
  ]);

  if (!download) return [];

  const path = await download.path();
  if (!path) return [];

  const { readFileSync } = await import('fs');
  const csv = readFileSync(path, 'utf8');
  return parseCSV(csv);
}

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = parseCSVRow(lines[0]).map(h =>
    h.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  );

  return lines.slice(1)
    .map(line => {
      const vals = parseCSVRow(line);
      const row = {};
      headers.forEach((h, i) => { if (h) row[h] = (vals[i] || '').trim(); });
      return row;
    })
    .filter(row => row.record_number);
}

function parseCSVRow(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
    else cur += c;
  }
  cols.push(cur);
  return cols;
}

async function extractDetailUrls(page) {
  return page.evaluate(GRID => {
    const t = document.getElementById(GRID);
    if (!t) return [];
    return [...t.querySelectorAll('a[id*="_hlPermitNumber"]')].map(a => a.href);
  }, GRID);
}

async function goToNextPage(page) {
  // Next > is in the last row of the grid (pager row)
  const nextExists = await page.evaluate(GRID => {
    const t = document.getElementById(GRID);
    if (!t) return false;
    const rows = t.querySelectorAll('tbody tr');
    const lastRow = rows[rows.length - 1];
    const nextLink = [...(lastRow?.querySelectorAll('a') || [])].find(a =>
      a.innerText.trim().includes('Next')
    );
    if (!nextLink) return false;
    nextLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }, GRID);

  if (!nextExists) return false;
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  return true;
}

// ── Fetch a record detail page and extract all structured fields ───────────
export async function extractDetail(page, detailUrl) {
  await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });

  return page.evaluate(() => {
    const out = {};

    // Key/value table rows
    document.querySelectorAll('table tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length >= 2) {
        const raw   = cells[0].innerText.trim().replace(/[:\s]+$/, '');
        const key   = raw.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const value = cells[1].innerText.trim();
        if (key && value && key.length < 50 && !key.match(/^col\d+$/)) {
          out[key] = value.substring(0, 300);
        }
      }
    });

    // Section headers
    out.__sections = [...document.querySelectorAll('h2, h3, .ACA_Title_Label, .ACA_TabRow_Title')]
      .map(h => h.innerText.trim()).filter(Boolean);

    // Contacts block
    const contacts = [];
    document.querySelectorAll('table[id*="Contact"] tr, .contact-table tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length >= 2) contacts.push(cells.map(td => td.innerText.trim()));
    });
    if (contacts.length) out.__contacts = contacts;

    // Inspections block
    const inspections = [];
    document.querySelectorAll('table[id*="Inspection"] tr, table[id*="inspection"] tr').forEach(tr => {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length >= 2) inspections.push(cells.map(td => td.innerText.trim()));
    });
    if (inspections.length) out.__inspections = inspections;

    out.__url        = window.location.href;
    out.__scraped_at = new Date().toISOString();
    return out;
  });
}

// ── Date utilities ─────────────────────────────────────────────────────────

export function fmtDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

export function* monthWindows(from, to) {
  let cur = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cur <= to) {
    const end = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    yield { start: fmtDate(cur), end: fmtDate(end < to ? end : to) };
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
}
