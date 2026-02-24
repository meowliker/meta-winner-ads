const { chromium } = require('playwright');
const { launchBrowser } = require('./scrapeMetaAds');

function isHttpUrl(value) {
  return value && (value.startsWith('http://') || value.startsWith('https://'));
}

function unwrapFacebookRedirect(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('facebook.com') && parsed.pathname.includes('/l.php')) {
      const target = parsed.searchParams.get('u');
      if (target) return decodeURIComponent(target);
    }
  } catch (err) {
    return url;
  }
  return url;
}

function isExternalLink(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith('facebook.com')) return false;
    if (host.endsWith('messenger.com')) return false;
    if (host.endsWith('instagram.com')) return false;
    return true;
  } catch (err) {
    return false;
  }
}

function pickBestExternalLink(links) {
  const cleaned = links
    .filter((link) => isHttpUrl(link))
    .map((link) => unwrapFacebookRedirect(link))
    .filter((link) => isHttpUrl(link))
    .filter((link) => !link.startsWith('javascript:'))
    .filter((link) => !link.startsWith('#'))
    .filter((link) => isExternalLink(link));

  if (cleaned.length === 0) return '';

  const preferred = cleaned.find((link) => link.includes('.') && !link.includes('facebook.com'));
  return preferred || cleaned[0];
}

async function extractLandingFromSnapshot(browser, snapshotUrl) {
  if (!snapshotUrl) return '';
  const page = await browser.newPage();

  try {
    await page.goto(snapshotUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);

    const hrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).map((a) => a.href || '');
    });

    return pickBestExternalLink(hrefs);
  } catch (err) {
    return '';
  } finally {
    await page.close().catch(() => {});
  }
}

async function getSnapshotBrowser() {
  const launchInfo = await launchBrowser(false);
  return launchInfo.browser;
}

module.exports = { extractLandingFromSnapshot, getSnapshotBrowser };
