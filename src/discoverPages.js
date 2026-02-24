const { chromium } = require('playwright');
const { withRetries, launchBrowser } = require('./scrapeMetaAds');

function buildSearchUrl(keyword, country) {
  const params = new URLSearchParams({
    active_status: 'active',
    ad_type: 'all',
    country: country || 'ALL',
    q: keyword,
    search_type: 'keyword_unordered'
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

async function discoverPages(keyword, country, options) {
  const { headful, maxScrolls = 6 } = options || {};
  const launchInfo = await launchBrowser(headful);
  const browser = launchInfo.browser;
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });

  try {
    const url = buildSearchUrl(keyword, country);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    for (let i = 0; i < maxScrolls; i += 1) {
      await withRetries(() => page.evaluate(() => {
        window.scrollBy(0, Math.floor(window.innerHeight * 0.9));
      }));
      await page.waitForTimeout(1200);
    }

    const pages = await withRetries(() => page.evaluate(() => {
      function extractId(href) {
        try {
          const url = new URL(href, window.location.origin);
          return url.searchParams.get('view_all_page_id');
        } catch (err) {
          return null;
        }
      }

      function pickName(link) {
        const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
        const aria = (link.getAttribute('aria-label') || '').trim();
        if (aria) return aria;
        const container = link.closest('div');
        if (!container) return '';
        const containerText = (container.textContent || '').replace(/\s+/g, ' ').trim();
        return containerText.split(' ? ')[0] || '';
      }

      const linkNodes = Array.from(document.querySelectorAll('a[href*="view_all_page_id="]'));
      const byId = new Map();

      for (const link of linkNodes) {
        const href = link.getAttribute('href') || '';
        const id = extractId(href);
        if (!id) continue;

        const entry = byId.get(id) || { id, name: '', count: 0 };
        entry.count += 1;
        if (!entry.name) {
          entry.name = pickName(link);
        }
        byId.set(id, entry);
      }

      return Array.from(byId.values());
    }));

    return pages;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { discoverPages, buildSearchUrl };
