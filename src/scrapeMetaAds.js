console.log("GRAPHQL_DEBUG_MARKER: scrapeMetaAds.js loaded");
console.log("[version] scrapeMetaAds.js stamp: 2026-02-24-finalUrl-v1");
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
  const baseOptions = {
    headless: !headful,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  };

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

function createContext(browser) {
  return browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });
}

async function waitForStableLoad(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);
}

async function tryAcceptCookies(page) {
  const buttonRegex = /allow all|accept all|accept|agree|allow cookies|only allow essential/i;
  const textCandidates = [
    'Allow all cookies',
    'Allow all',
    'Accept all',
    'Accept',
    'Agree',
    'Only allow essential cookies'
  ];

  const frames = page.frames();
  for (const frame of frames) {
    try {
      const roleBtn = frame.getByRole('button', { name: buttonRegex });
      if (await roleBtn.count()) {
        await roleBtn.first().click({ timeout: 1500 }).catch(() => {});
        console.log('[cookie] accepted: yes (role button)');
        return true;
      }
    } catch (err) {
      // ignore
    }

    for (const text of textCandidates) {
      try {
        const locator = frame.locator('button:has-text("' + text + '")');
        if (await locator.count()) {
          await locator.first().click({ timeout: 1500 }).catch(() => {});
          console.log('[cookie] accepted: yes (' + text + ')');
          return true;
        }
      } catch (err) {
        // ignore
      }
    }

    try {
      const clicked = await frame.evaluate((labels) => {
        const elements = Array.from(document.querySelectorAll('button, div, span'));
        for (const el of elements) {
          const text = (el.innerText || '').trim();
          if (!text) continue;
          if (labels.some((label) => text.toLowerCase().includes(label.toLowerCase()))) {
            el.click();
            return true;
          }
        }
        return false;
      }, textCandidates);
      if (clicked) {
        console.log('[cookie] accepted: yes (frame eval)');
        return true;
      }
    } catch (err) {
      // ignore
    }
  }

  console.log('[cookie] accepted: no');
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

function sanitizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  let url = value.trim();
  if (!url) return '';

  try {
    const parsed = new URL(url, 'https://www.facebook.com');
    url = parsed.toString();
  } catch (err) {
    return '';
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return '';
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith('facebook.com') && parsed.pathname.includes('/l.php')) {
      const target = parsed.searchParams.get('u');
      if (target) {
        return decodeURIComponent(target);
      }
    }
  } catch (err) {
    return url;
  }

  return url;
}

function pickFirstUrl(values) {
  for (const value of values) {
    const sanitized = sanitizeUrl(value);
    if (sanitized) return sanitized;
  }
  return '';
}

function extractLandingLink(node) {
  if (!node || typeof node !== 'object') return '';

  const direct = pickFirstUrl([
    node.link_url,
    node.website_url,
    node.destination_url,
    node.url,
    node.final_url,
    node.linkUrl,
    node.websiteUrl,
    node.destinationUrl,
    node.finalUrl
  ]);
  if (direct) return direct;

  const cta = node.call_to_action || node.callToAction || node.cta || null;
  if (cta) {
    const ctaLink = pickFirstUrl([
      cta.link,
      cta.url,
      cta.value && cta.value.link,
      cta.value && cta.value.url
    ]);
    if (ctaLink) return ctaLink;
  }

  if (Array.isArray(node.attachments)) {
    for (const attachment of node.attachments) {
      const attachmentLink = pickFirstUrl([
        attachment.url,
        attachment.link,
        attachment.card_link,
        attachment.cardLink
      ]);
      if (attachmentLink) return attachmentLink;
    }
  }

  const cardLink = pickFirstUrl([node.card_link, node.cardLink]);
  if (cardLink) return cardLink;

  return '';
}

function extractCreativePreview(node) {
  if (!node || typeof node !== 'object') return '';
  return (
    node.ad_snapshot_url ||
    node.adSnapshotUrl ||
    node.ad_creative_image_url ||
    node.image_url ||
    node.imageUrl ||
    node.thumbnail_url ||
    node.thumbnailUrl ||
    ''
  );
}

function extractSnapshotUrl(node) {
  if (!node || typeof node !== 'object') return '';
  return node.ad_snapshot_url || node.adSnapshotUrl || '';
}

function extractAdIdFromString(value, adMap) {
  if (!value || typeof value !== 'string') return;
  const matchId = value.match(/ad_archive_id=(\d+)/);
  if (matchId && matchId[1]) {
    pushAd(adMap, { ad_archive_id: String(matchId[1]) });
  }
}

function extractAdsFromNode(node, adMap) {
  if (!node || typeof node !== 'object') return;

  if (node.ad_archive_id || node.adArchiveID || node.archive_id) {
    const adId = node.ad_archive_id || node.adArchiveID || node.archive_id;
    const ad = {
      ad_archive_id: String(adId),
      started_running_on: node.started_running_on || node.startedRunningOn || node.start_time || null,
      primary_text: node.ad_creative_body || node.ad_creative_body_text || node.adCreativeBody || node.body || node.text || '',
      creative_preview: extractCreativePreview(node),
      landing_link: extractLandingLink(node),
      ad_snapshot_url: extractSnapshotUrl(node)
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
    if (typeof value === 'string') {
      extractAdIdFromString(value, adMap);
    }
    if (value && typeof value === 'object') {
      extractAdsFromNode(value, adMap);
    }
  }
}

function normalizeAds(adMap) {
  const results = [];
  for (const ad of adMap.values()) {
    results.push({
      adArchiveId: ad.ad_archive_id,
      adLibraryLink: ad.ad_archive_id
        ? `https://www.facebook.com/ads/library/?id=${ad.ad_archive_id}`
        : '',
      adSnapshotUrl: ad.ad_snapshot_url || '',
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

function shouldSkipCompetitorUrl(url) {
  return !url.includes('view_all_page_id=') && !url.includes('search_term=');
}

async function extractAdLinksFromDom(page) {
  const data = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const hrefs = anchors.map((a) => a.getAttribute('href') || '');
    return { total: anchors.length, hrefs };
  });

  const candidates = data.hrefs.filter((href) =>
    href.includes('/ads/library/') && (href.includes('ad_archive_id=') || href.includes('id='))
      || href.includes('ad_archive_id')
  );

  const normalized = candidates.map((href) => {
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) return `https://www.facebook.com${href}`;
    return `https://www.facebook.com/${href}`;
  });

  const unique = Array.from(new Set(normalized));
  console.log(`[dom] anchors scanned: ${data.total}, ad links found: ${unique.length}`);
  return unique;
}

async function waitForAdSignals(page) {
  try {
    await page.waitForFunction(() => {
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      return anchors.some((a) => {
        const href = a.getAttribute('href') || '';
        return href.includes('ad_archive_id') || href.includes('/ads/library/?id=');
      });
    }, { timeout: 15000 });
    return true;
  } catch (err) {
    return false;
  }
}

async function scrapeMetaAds(competitor, options) {
  console.log("GRAPHQL_DEBUG_MARKER: competitor start");
  const { headful, maxAds = 30, isLocal, pauseOnLoginWall, competitorIndex } = options;
  const finalUrlInput = competitor && competitor.finalUrl ? competitor.finalUrl : '';
  const rawInput = competitor && competitor.raw ? competitor.raw : '';
  const pageId = competitor && competitor.pageId ? competitor.pageId : '';

  console.log('[competitor] raw: ' + (rawInput || 'n/a'));
  console.log('[competitor] finalUrl: ' + (finalUrlInput || 'n/a'));
  console.log('[competitor] pageId: ' + (pageId || 'n/a'));

  if (!finalUrlInput || shouldSkipCompetitorUrl(finalUrlInput)) {
    console.error('[competitor] BAD URL: ' + (rawInput || finalUrlInput) + ' (missing view_all_page_id or search_term)');
    return {
      ads: [],
      finalUrl: finalUrlInput,
      cookieAccepted: false,
      loginWall: false,
      adLinksFound: 0,
      graphqlAdsCollected: 0,
      graphqlResponsesSeen: 0,
      graphqlParsed: 0,
      graphqlAdIds: 0,
      domAdLinksFound: 0
    };
  }

  const launchInfo = await launchBrowser(headful);
  const browser = launchInfo.browser;
  const context = await createContext(browser);
  const page = await context.newPage();

  try {
    let finalUrl = finalUrlInput;
    const graphqlPayloads = [];
    const adMap = new Map();
    let graphqlResponsesSeen = 0;
    let graphqlParsed = 0;
    let graphqlAdIds = 0;
    let graphqlDebugPrinted = false;
    let graphqlParseFailedLogged = false;

    async function printGraphqlDebugOnce(tag, response) {
      if (graphqlDebugPrinted) return;
      graphqlDebugPrinted = true;
      try {
        const headers = response && response.headers ? response.headers() : {};
        const ct = headers['content-type'] || headers['Content-Type'] || '';
        let sample = '';
        if (response && response.text) {
          const raw = await response.text();
          sample = String(raw || '').slice(0, 200);
        } else {
          sample = '(no response object)';
        }
        console.log(`GRAPHQL_DEBUG_MARKER: ${tag} content-type=${ct}`);
        console.log(`GRAPHQL_DEBUG_MARKER: ${tag} first200=${sample}`);
      } catch (e) {
        console.log(`GRAPHQL_DEBUG_MARKER: ${tag} failed_to_read=${String(e && e.message ? e.message : e)}`);
      }
    }


    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        finalUrl = frame.url();
      }
    });

        async function handleGraphqlJson(json) {
      if (!json) return;
      const tempMap = new Map();
      extractAdsFromNode(json, tempMap);
      for (const [id, ad] of tempMap.entries()) {
        if (!adMap.has(id)) {
          adMap.set(id, ad);
        }
      }
      graphqlAdIds = adMap.size;
    }

    function parseGraphqlText(raw) {
      if (!raw) return null;
      let cleaned = String(raw).trim();
      if (cleaned.startsWith('for (;;);')) {
        cleaned = cleaned.slice('for (;;);'.length).trim();
      }
      if (cleaned.startsWith(")]}',")) {
        cleaned = cleaned.slice(5).trim();
      }
      const firstChar = cleaned[0] || '';
      if (firstChar !== '{' && firstChar !== '[') {
        return null;
      }
      try {
        return JSON.parse(cleaned);
      } catch (err) {
        if (!graphqlParseFailedLogged) {
          console.log('GRAPHQL_DEBUG_MARKER: json_parse_failed err=' + (err && err.message ? err.message : String(err)) + ' first80=' + cleaned.slice(0, 80));
          graphqlParseFailedLogged = true;
        }
        return null;
      }
    }

    page.on('response', async (res) => {
      try {
        const resUrl = res.url();
        if (!resUrl.includes('graphql')) return;
        graphqlResponsesSeen += 1;
        const raw = await res.text().catch(() => '');
        await printGraphqlDebugOnce("graphql-response", {
          headers: () => (res && res.headers ? res.headers() : {}),
          text: async () => raw
        });
        const json = parseGraphqlText(raw);
        if (!json) return;
        graphqlParsed += 1;

        if (graphqlPayloads.length < 20) {
          graphqlPayloads.push(json);
        }

        await handleGraphqlJson(json);
      } catch (err) {
        // ignore
      }
    });

    page.on('requestfinished', async (req) => {
      try {
        const res = await req.response();
        if (!res) return;
        const resUrl = res.url();
        if (!resUrl.includes('graphql')) return;
        // no-op: response body may be consumed in response handler
      } catch (err) {
        // ignore
      }
    });

    console.log('[nav] using competitor.finalUrl: ' + finalUrlInput);
    console.log('[nav] competitor.raw: ' + (rawInput || ''));
    console.log('[nav] competitor.pageId: ' + (pageId || ''));
    if ((finalUrlInput.includes('sort_data') || (!finalUrlInput.includes('view_all_page_id=') && !finalUrlInput.includes('search_term=')))) {
      console.error('[nav] BAD FINAL URL (generic or missing view_all_page_id). Refusing to scrape.');
      console.error('[nav] url=' + finalUrlInput);
      return {
        ads: [],
        finalUrl: finalUrlInput,
        cookieAccepted: false,
        loginWall: false,
        adLinksFound: 0,
        graphqlAdsCollected: 0,
        graphqlResponsesSeen: 0,
        graphqlParsed: 0,
        graphqlAdIds: 0,
        domAdLinksFound: 0,
        reason: 'bad_final_url'
      };
    }

    await page.goto(finalUrlInput, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForStableLoad(page);

    const cookieAccepted = await tryAcceptCookies(page);
    await page.waitForTimeout(1500);
    for (let i = 0; i < 3; i += 1) {
      await withRetries(() => page.evaluate(() => {
        window.scrollBy(0, 800);
      }));
      await page.waitForTimeout(800);
    }
    const earlyDomLinks = await extractAdLinksFromDom(page);
    console.log(`GRAPHQL_DEBUG_MARKER: post-consent dom scan links=${earlyDomLinks.length}`);
    await waitForStableLoad(page);

    let loginWall = await detectLoginWall(page);
    if (loginWall) {
      const stillBlocked = await handleLoginWall(page, { pauseOnLoginWall, isLocal, headful });
      loginWall = stillBlocked;
      if (loginWall) {
        console.log(`[scrape] Login wall detected. Skipping ${finalUrlInput}`);
        return {
          ads: [],
          finalUrl,
          cookieAccepted,
          loginWall,
          adLinksFound: 0,
          graphqlAdsCollected: 0,
          graphqlResponsesSeen,
          graphqlParsed,
          graphqlAdIds,
          domAdLinksFound: 0
        };
      }
    }

    const adSignalFound = await waitForAdSignals(page);
    if (!adSignalFound) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForStableLoad(page);
      await waitForAdSignals(page);
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

    const domLinks = await extractAdLinksFromDom(page);
    const domAdLinksFound = domLinks.length;

    const graphqlAdsCollected = adMap.size;
    console.log(`[scrape] GraphQL ads collected: ${graphqlAdsCollected}`);
    console.log(`[scrape] GraphQL responses seen: ${graphqlResponsesSeen}, parsed: ${graphqlParsed}, ad ids: ${graphqlAdIds}`);
    console.log(`GRAPHQL_DEBUG_MARKER: summary responsesSeen=${graphqlResponsesSeen} parsed=${graphqlParsed} ids=${graphqlAdIds} domLinks=${domAdLinksFound} cookieAccepted=${cookieAccepted ? 'yes' : 'no'}`);

    if (graphqlAdsCollected === 0 && isLocal) {
      const debugDir = path.join(process.cwd(), 'debug');
      fs.mkdirSync(debugDir, { recursive: true });
      const pageId = extractPageId(finalUrl || finalUrlInput);
      const networkPath = path.join(debugDir, `${pageId}-network.json`);
      const screenshotPath = path.join(debugDir, `${pageId}.png`);

      const payloadSlice = graphqlPayloads.slice(0, 3);
      if (payloadSlice.length > 0) {
        fs.writeFileSync(networkPath, JSON.stringify(payloadSlice, null, 2));
      }
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }

    const normalized = normalizeAds(adMap).slice(0, maxAds);

    if (domAdLinksFound === 0 && graphqlAdsCollected === 0) {
      const artifactsDir = path.join(process.cwd(), 'artifacts');
      fs.mkdirSync(artifactsDir, { recursive: true });
      const idx = typeof competitorIndex === 'number' ? competitorIndex : 0;
      const screenshotPath = path.join(artifactsDir, `${idx}-no-ads.png`);
      const htmlPath = path.join(artifactsDir, `${idx}-page.html`);
      const logPath = path.join(artifactsDir, `${idx}-log.txt`);

      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      if (html) {
        fs.writeFileSync(htmlPath, html.slice(0, 200 * 1024));
      }
      fs.writeFileSync(logPath, `finalUrl=${finalUrl}\ncookieAccepted=${cookieAccepted}\nloginWall=${loginWall}\n`);
    }

    return {
      ads: normalized,
      finalUrl: finalUrl || page.url(),
      cookieAccepted,
      loginWall: false,
      adLinksFound: graphqlAdsCollected,
      graphqlAdsCollected,
      graphqlResponsesSeen,
      graphqlParsed,
      graphqlAdIds,
      domAdLinksFound
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeMetaAds, withRetries, launchBrowser, createContext };

