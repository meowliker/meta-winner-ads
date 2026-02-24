const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function isRetryableError(err) {
  const msg = String(err && err.message ? err.message : err).toLowerCase();
  return (
    msg.includes('execution context was destroyed') ||
    msg.includes('navigation') ||
    msg.includes('target closed')
  );
}

async function withRetries(fn, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === retries) {
        throw err;
      }
    }
  }
  throw lastErr;
}

async function launchBrowser(headful) {
  const baseOptions = { headless: !headful };

  try {
    const browser = await chromium.launch({ ...baseOptions, channel: 'chrome' });
    console.log('[playwright] Launching system Chrome (channel: chrome)');
    return { browser, launchType: 'chrome' };
  } catch (err) {
    console.log(`[playwright] System Chrome launch failed: ${err.message}`);
  }

  try {
    const browser = await chromium.launch(baseOptions);
    console.log('[playwright] Launching bundled Chromium');
    return { browser, launchType: 'bundled' };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.includes('EPERM')) {
      console.log('[playwright] Bundled Chromium failed with EPERM. Retrying system Chrome.');
      const browser = await chromium.launch({ ...baseOptions, channel: 'chrome' });
      console.log('[playwright] Launching system Chrome (channel: chrome)');
      return { browser, launchType: 'chrome' };
    }
    throw err;
  }
}

async function waitForStableLoad(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function tryAcceptCookies(page) {
  const labels = [
    'Allow all cookies',
    'Accept all',
    'Accept',
    'Only allow essential cookies'
  ];
  for (const label of labels) {
    try {
      const btn = page.getByRole('button', { name: label, exact: false });
      if (await btn.count()) {
        await btn.first().click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    } catch (err) {
      // ignore
    }
  }
  return false;
}

async function detectLoginWall(page) {
  const text = await withRetries(() => page.evaluate(() => {
    return (document.body && document.body.innerText ? document.body.innerText : '');
  })).catch(() => '');
  const lower = String(text).toLowerCase();
  return lower.includes('log in') && lower.includes('facebook');
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function handleLoginWall(page, options) {
  const { pauseOnLoginWall, isLocal, headful } = options;
  if (!pauseOnLoginWall || (!isLocal && !headful)) {
    return true;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log('LOGIN REQUIRED: Please log in to Facebook in the opened browser. Press ENTER in terminal to continue.');
    await waitForEnter('');
    await waitForStableLoad(page);
    const still = await detectLoginWall(page);
    if (!still) {
      return false;
    }
  }

  return true;
}

function extractPageId(url) {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('view_all_page_id') || parsed.searchParams.get('id') || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

function pushAd(adMap, ad) {
  if (!ad || !ad.ad_archive_id) return;
  if (!adMap.has(ad.ad_archive_id)) {
    adMap.set(ad.ad_archive_id, ad);
  }
}

function extractAdsFromNode(node, adMap) {
  if (!node || typeof node !== 'object') return;

  if (node.ad_archive_id || node.adArchiveID) {
    const adId = node.ad_archive_id || node.adArchiveID;
    const ad = {
      ad_archive_id: String(adId),
      started_running_on: node.started_running_on || node.startedRunningOn || node.start_time || null,
      primary_text: node.ad_creative_body || node.ad_creative_body_text || node.adCreativeBody || node.body || node.text || '',
      creative_preview: node.ad_creative_image_url || node.image_url || node.imageUrl || node.thumbnail_url || node.thumbnailUrl || '',
      landing_link: node.snapshot_url || node.snapshotUrl || node.link_url || node.linkUrl || node.website_url || ''
    };
    pushAd(adMap, ad);
  }

  if (Array.isArray(node.ad_archive_ids)) {
    for (const id of node.ad_archive_ids) {
      pushAd(adMap, { ad_archive_id: String(id) });
    }
  }

  if (Array.isArray(node.ads)) {
    for (const ad of node.ads) {
      extractAdsFromNode(ad, adMap);
    }
  }

  if (Array.isArray(node.edges)) {
    for (const edge of node.edges) {
      if (edge && edge.node) {
        extractAdsFromNode(edge.node, adMap);
      }
    }
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') {
      extractAdsFromNode(value, adMap);
    }
  }
}

function normalizeAds(adMap) {
  const results = [];
  for (const ad of adMap.values()) {
    results.push({
      adLibraryLink: ad.ad_archive_id
        ? `https://www.facebook.com/ads/library/?id=${ad.ad_archive_id}`
        : '',
      startedRunningOn: ad.started_running_on || null,
      primaryText: ad.primary_text || '',
      creativePreview: ad.creative_preview || '',
      landingLink: ad.landing_link || ''
    });
  }
  return results;
}

async function runFallbackScroll(page) {
  for (let i = 0; i < 5; i += 1) {
    await withRetries(() => page.evaluate(() => {
      window.scrollBy(0, 1200);
    }));
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(2000);
}

async function scrapeMetaAds(url, options) {
  const { headful, maxAds = 30, isLocal, pauseOnLoginWall } = options;
  const launchInfo = await launchBrowser(headful);
  const browser = launchInfo.browser;
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });

  try {
    let finalUrl = url;
    const graphqlPayloads = [];
    const adMap = new Map();

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        finalUrl = frame.url();
      }
    });

    page.on('response', async (res) => {
      try {
        const resUrl = res.url();
        if (!resUrl.includes('/api/graphql/')) return;
        const json = await res.json().catch(() => null);
        if (!json) return;

        if (graphqlPayloads.length < 20) {
          graphqlPayloads.push(json);
        }

        const tempMap = new Map();
        extractAdsFromNode(json, tempMap);
        for (const [id, ad] of tempMap.entries()) {
          if (!adMap.has(id)) {
            adMap.set(id, ad);
          }
        }
      } catch (err) {
        // ignore
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForStableLoad(page);

    const cookieAccepted = await tryAcceptCookies(page);
    await waitForStableLoad(page);

    let loginWall = await detectLoginWall(page);
    if (loginWall) {
      const stillBlocked = await handleLoginWall(page, { pauseOnLoginWall, isLocal, headful });
      loginWall = stillBlocked;
      if (loginWall) {
        console.log(`[scrape] Login wall detected. Skipping ${url}`);
        return {
          ads: [],
          finalUrl,
          cookieAccepted,
          loginWall,
          adLinksFound: 0,
          graphqlAdsCollected: 0
        };
      }
    }

    for (let i = 0; i < 12; i += 1) {
      await withRetries(() => page.evaluate(() => {
        window.scrollBy(0, document.body.scrollHeight);
      }));
      await page.waitForTimeout(1200);
    }

    if (adMap.size === 0) {
      console.log('[scrape] GraphQL ads collected is 0. Running fallback scroll.');
      await runFallbackScroll(page);
    }

    if (adMap.size === 0) {
      console.log('[scrape] Still 0 ads. Reloading once and retrying fallback.');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForStableLoad(page);
      await runFallbackScroll(page);
    }

    const graphqlAdsCollected = adMap.size;
    console.log(`[scrape] GraphQL ads collected: ${graphqlAdsCollected}`);

    if (graphqlAdsCollected === 0 && isLocal) {
      const debugDir = path.join(process.cwd(), 'debug');
      fs.mkdirSync(debugDir, { recursive: true });
      const pageId = extractPageId(finalUrl || url);
      const networkPath = path.join(debugDir, `${pageId}-network.json`);
      const screenshotPath = path.join(debugDir, `${pageId}.png`);

      const payloadSlice = graphqlPayloads.slice(0, 3);
      if (payloadSlice.length > 0) {
        fs.writeFileSync(networkPath, JSON.stringify(payloadSlice, null, 2));
      }
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }

    const normalized = normalizeAds(adMap).slice(0, maxAds);

    return {
      ads: normalized,
      finalUrl: finalUrl || page.url(),
      cookieAccepted,
      loginWall: false,
      adLinksFound: graphqlAdsCollected,
      graphqlAdsCollected
    };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeMetaAds, withRetries, launchBrowser };
