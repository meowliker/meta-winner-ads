console.log("GRAPHQL_DEBUG_MARKER: scrapeMetaAds.js loaded");

const { chromium } = require('playwright');

// ─── Browser launch ───────────────────────────────────────────────────────────

async function launchBrowser(headful) {
  const args = ['--disable-dev-shm-usage', '--no-sandbox', '--disable-blink-features=AutomationControlled'];
  try {
    const browser = await chromium.launch({ headless: !headful, channel: 'chrome', args });
    console.log('[playwright] Launched system Chrome');
    return browser;
  } catch (e) {
    console.log('[playwright] System Chrome failed, using bundled Chromium');
    return chromium.launch({ headless: !headful, args });
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

// ─── Cookie consent ───────────────────────────────────────────────────────────

async function tryAcceptCookies(page) {
  const labels = ['Allow all cookies', 'Allow all', 'Accept all', 'Accept', 'Agree', 'Only allow essential cookies'];
  const selectors = ['[data-cookiebanner]', 'button[title*="Allow"]', '[aria-label*="cookie"]'];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      try {
        const loc = frame.locator(selector);
        if (await loc.count() > 0) {
          await loc.first().click({ timeout: 2000 });
          console.log('[cookie] accepted: yes (' + selector + ')');
          await page.waitForTimeout(2500);
          return true;
        }
      } catch (e) {}
    }

    try {
      const btn = frame.getByRole('button', { name: /allow all|accept all|accept|agree/i });
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: 2000 });
        console.log('[cookie] accepted: yes (role button)');
        await page.waitForTimeout(2500);
        return true;
      }
    } catch (e) {}

    for (const label of labels) {
      try {
        const loc = frame.locator('button:has-text("' + label + '")');
        if (await loc.count() > 0) {
          await loc.first().click({ timeout: 2000 });
          console.log('[cookie] accepted: yes (' + label + ')');
          await page.waitForTimeout(2500);
          return true;
        }
      } catch (e) {}
    }

    try {
      const clicked = await frame.evaluate(function(labelList) {
        var buttons = Array.from(document.querySelectorAll('button'));
        for (var i = 0; i < buttons.length; i++) {
          var text = (buttons[i].innerText || '').trim().toLowerCase();
          for (var j = 0; j < labelList.length; j++) {
            if (text.includes(labelList[j].toLowerCase())) {
              buttons[i].click();
              return true;
            }
          }
        }
        return false;
      }, labels);
      if (clicked) {
        console.log('[cookie] accepted: yes (frame eval)');
        await page.waitForTimeout(2500);
        return true;
      }
    } catch (e) {}
  }

  console.log('[cookie] accepted: no');
  return false;
}

// ─── Login wall ───────────────────────────────────────────────────────────────

async function detectLoginWall(page) {
  try {
    var text = await page.evaluate(function() {
      return document.body ? document.body.innerText : '';
    });
    var lower = String(text).toLowerCase();
    return lower.includes('log in') && lower.includes('facebook');
  } catch (e) {
    return false;
  }
}

// ─── GraphQL parsing ──────────────────────────────────────────────────────────

function stripPrefix(raw) {
  var cleaned = String(raw || '').trim();
  if (cleaned.startsWith('for (;;);')) cleaned = cleaned.slice(9).trim();
  if (cleaned.startsWith(")]}',")) cleaned = cleaned.slice(5).trim();
  return cleaned;
}

function parseGraphqlText(raw, logFail) {
  var cleaned = stripPrefix(raw);
  if (cleaned[0] !== '{' && cleaned[0] !== '[') return null;
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    if (logFail) console.log('GRAPHQL_DEBUG_MARKER: json_parse_failed err=' + e.message + ' first80=' + cleaned.slice(0, 80));
    return null;
  }
}

// ─── Ad extraction ────────────────────────────────────────────────────────────

function sanitizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  var url = value.trim();
  if (!url.startsWith('http')) return '';
  try {
    var parsed = new URL(url);
    if (parsed.hostname.endsWith('facebook.com') && parsed.pathname.includes('/l.php')) {
      var target = parsed.searchParams.get('u');
      if (target) return decodeURIComponent(target);
    }
    return url;
  } catch (e) { return ''; }
}

function pickFirstUrl(values) {
  for (var i = 0; i < values.length; i++) {
    var s = sanitizeUrl(values[i]);
    if (s) return s;
  }
  return '';
}

function extractLandingLink(node) {
  if (!node || typeof node !== 'object') return '';
  var direct = pickFirstUrl([node.link_url, node.website_url, node.destination_url, node.url, node.final_url, node.linkUrl, node.websiteUrl, node.destinationUrl, node.finalUrl]);
  if (direct) return direct;
  var cta = node.call_to_action || node.callToAction || node.cta || null;
  if (cta) {
    var ctaLink = pickFirstUrl([cta.link, cta.url, cta.value && cta.value.link, cta.value && cta.value.url]);
    if (ctaLink) return ctaLink;
  }
  if (Array.isArray(node.attachments)) {
    for (var i = 0; i < node.attachments.length; i++) {
      var a = node.attachments[i];
      var al = pickFirstUrl([a.url, a.link, a.card_link, a.cardLink]);
      if (al) return al;
    }
  }
  return pickFirstUrl([node.card_link, node.cardLink]);
}

function extractCreativePreview(node) {
  if (!node || typeof node !== 'object') return '';
  return node.ad_snapshot_url || node.adSnapshotUrl || node.ad_creative_image_url || node.image_url || node.imageUrl || node.thumbnail_url || node.thumbnailUrl || '';
}

function extractAdsFromNode(node, adMap) {
  if (!node || typeof node !== 'object') return;

  var adId = node.ad_archive_id || node.adArchiveID || node.archive_id;
  if (adId) {
    var id = String(adId);
    if (!adMap.has(id)) {
      adMap.set(id, {
        ad_archive_id: id,
        started_running_on: node.started_running_on || node.startedRunningOn || node.start_time || node.startDate || null,
        creative_preview: extractCreativePreview(node),
        landing_link: extractLandingLink(node),
        ad_snapshot_url: node.ad_snapshot_url || node.adSnapshotUrl || ''
      });
    }
    return;
  }

  if (Array.isArray(node.edges)) {
    for (var i = 0; i < node.edges.length; i++) {
      if (node.edges[i] && node.edges[i].node) extractAdsFromNode(node.edges[i].node, adMap);
    }
  }

  if (Array.isArray(node.ads)) {
    for (var i = 0; i < node.ads.length; i++) extractAdsFromNode(node.ads[i], adMap);
  }

  if (Array.isArray(node.results)) {
    for (var i = 0; i < node.results.length; i++) extractAdsFromNode(node.results[i], adMap);
  }

  var keys = Object.keys(node);
  for (var k = 0; k < keys.length; k++) {
    var val = node[keys[k]];
    if (val && typeof val === 'object' && !Array.isArray(val)) extractAdsFromNode(val, adMap);
    if (Array.isArray(val)) {
      for (var i = 0; i < val.length; i++) extractAdsFromNode(val[i], adMap);
    }
    if (typeof val === 'string' && val.includes('ad_archive_id=')) {
      var m = val.match(/ad_archive_id=(\d+)/);
      if (m && !adMap.has(m[1])) {
        adMap.set(m[1], { ad_archive_id: m[1], started_running_on: null, creative_preview: '', landing_link: '', ad_snapshot_url: '' });
      }
    }
  }
}

function normalizeAds(adMap) {
  var results = [];
  adMap.forEach(function(ad) {
    var startTs = ad.started_running_on;
    var runtimeDays = 0;
    if (startTs) {
      var ts = typeof startTs === 'number' ? startTs : Math.floor(new Date(startTs).getTime() / 1000);
      if (!isNaN(ts)) runtimeDays = Math.floor((Date.now() / 1000 - ts) / 86400);
    }
    results.push({
      adArchiveId: ad.ad_archive_id,
      adLibraryLink: 'https://www.facebook.com/ads/library/?id=' + ad.ad_archive_id,
      adSnapshotUrl: ad.ad_snapshot_url || 'https://www.facebook.com/ads/library/?id=' + ad.ad_archive_id,
      creativePreview: ad.creative_preview || '',
      landingLink: ad.landing_link || '',
      runtimeDays: runtimeDays,
      duplicates: 1,
      startDate: startTs ? new Date(typeof startTs === 'number' ? startTs * 1000 : startTs).toISOString() : ''
    });
  });
  return results;
}

// ─── DOM ad extraction ────────────────────────────────────────────────────────

async function extractAdLinksFromDom(page) {
  try {
    var hrefs = await page.evaluate(function() {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(function(a) { return a.getAttribute('href') || ''; })
        .filter(function(h) { return h.includes('ad_archive_id') || (h.includes('/ads/library/') && h.includes('id=')); });
    });
    var unique = Array.from(new Set(hrefs.map(function(h) {
      if (h.startsWith('http')) return h;
      return 'https://www.facebook.com' + h;
    })));
    console.log('[dom] ad links found: ' + unique.length);
    return unique;
  } catch (e) { return []; }
}

// Wait until real ad edges appear in GraphQL OR timeout
async function waitForAdEdges(adMap, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (adMap.size > 0) return true;
    await new Promise(function(r) { setTimeout(r, 500); });
  }
  return false;
}

// ─── Main scrape function ─────────────────────────────────────────────────────

async function scrapeMetaAds(competitor, options) {
  console.log("GRAPHQL_DEBUG_MARKER: competitor start");
  var headful = options.headful || false;
  var maxAds = options.maxAds || 30;
  var finalUrlInput = competitor.finalUrl || '';
  var competitorIndex = options.competitorIndex || 1;

  console.log('[competitor] finalUrl: ' + finalUrlInput);

  if (!finalUrlInput || (!finalUrlInput.includes('view_all_page_id=') && !finalUrlInput.includes('search_term='))) {
    console.error('[competitor] BAD URL: missing view_all_page_id or search_term');
    return { ads: [], finalUrl: finalUrlInput, cookieAccepted: false, loginWall: false, adLinksFound: 0 };
  }

  var browser = await launchBrowser(headful);
  var context = await createContext(browser);
  var page = await context.newPage();

  var finalUrl = finalUrlInput;
  var adMap = new Map();
  var graphqlResponsesSeen = 0;
  var graphqlParsed = 0;
  var parseFailLogged = false;
  var firstResponseLogged = false;

  // ✅ Attach BEFORE navigation
  page.on('response', async function(res) {
    try {
      var url = res.url();
      if (!url.includes('graphql')) return;
      graphqlResponsesSeen++;

      var raw = await res.text().catch(function() { return ''; });

      if (!firstResponseLogged) {
        firstResponseLogged = true;
        var ct = (res.headers()['content-type'] || '');
        console.log('GRAPHQL_DEBUG_MARKER: graphql-response content-type=' + ct);
        console.log('GRAPHQL_DEBUG_MARKER: graphql-response first200=' + raw.slice(0, 200));
      }

      var json = parseGraphqlText(raw, !parseFailLogged);
      if (!json) { parseFailLogged = true; return; }
      graphqlParsed++;

      // Log structure of first parsed response to help debug paths
      if (graphqlParsed === 1) {
        var topKeys = Object.keys(json).join(',');
        var dataKeys = json.data ? Object.keys(json.data).join(',') : 'none';
        console.log('GRAPHQL_DEBUG_MARKER: first-parsed topKeys=' + topKeys + ' dataKeys=' + dataKeys);
        if (json.data && json.data.ad_library_main) {
          var mainKeys = Object.keys(json.data.ad_library_main).join(',');
          console.log('GRAPHQL_DEBUG_MARKER: ad_library_main keys=' + mainKeys);
        }
      }

      extractAdsFromNode(json, adMap);
    } catch (e) {}
  });

  page.on('framenavigated', function(frame) {
    if (frame === page.mainFrame()) finalUrl = frame.url();
  });

  // Navigate
  try {
    await page.goto(finalUrlInput, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error('[nav] goto failed: ' + e.message);
  }

  // Wait for page to settle including redirect
  await page.waitForTimeout(4000);

  // Accept cookies
  var cookieAccepted = await tryAcceptCookies(page);

  // After cookie acceptance wait for Facebook to load the actual ads
  console.log('[scrape] Waiting 12s for ad edges to load after cookie acceptance...');
  await page.waitForTimeout(12000);

  // Slow scroll to trigger ad edge GraphQL requests
  console.log('[scrape] Starting scroll phase...');
  for (var i = 0; i < 12; i++) {
    try { await page.evaluate(function() { window.scrollBy(0, 600); }); } catch (e) {}
    await page.waitForTimeout(2000);
    // Stop scrolling early if we already have ads
    if (adMap.size > 0 && i > 3) {
      console.log('[scrape] Got ' + adMap.size + ' ads — stopping scroll early');
      break;
    }
  }

  // Detect login wall
  var loginWall = await detectLoginWall(page);
  if (loginWall) {
    try { await page.screenshot({ path: '/tmp/debug.png', fullPage: true }); } catch (e) {}
    console.log('[scrape] Login wall detected');
  }

  // If still no ads, reload once and retry
  if (adMap.size === 0 && !loginWall) {
    console.log('[scrape] 0 ads after scroll — reloading and retrying');
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(8000);
      var cookieAccepted2 = await tryAcceptCookies(page);
      if (cookieAccepted2) cookieAccepted = true;
      await page.waitForTimeout(8000);
      for (var i = 0; i < 8; i++) {
        try { await page.evaluate(function() { window.scrollBy(0, 800); }); } catch (e) {}
        await page.waitForTimeout(2000);
        if (adMap.size > 0) break;
      }
    } catch (e) {}
  }

  // DOM fallback — grab any visible ad links
  var domLinks = await extractAdLinksFromDom(page);
  domLinks.forEach(function(href) {
    var m = href.match(/ad_archive_id=(\d+)/) || href.match(/\/ads\/library\/\?id=(\d+)/);
    if (m && !adMap.has(m[1])) {
      adMap.set(m[1], { ad_archive_id: m[1], started_running_on: null, creative_preview: '', landing_link: '', ad_snapshot_url: 'https://www.facebook.com/ads/library/?id=' + m[1] });
    }
  });

  console.log('GRAPHQL_DEBUG_MARKER: summary responsesSeen=' + graphqlResponsesSeen + ' parsed=' + graphqlParsed + ' ids=' + adMap.size + ' domLinks=' + domLinks.length + ' cookieAccepted=' + (cookieAccepted ? 'yes' : 'no'));

  await browser.close();

  // Normalize
  var allAds = normalizeAds(adMap);
  var adsWithDates = allAds.filter(function(a) { return a.runtimeDays > 0; });
  var ads = adsWithDates.length > 0
    ? adsWithDates.filter(function(a) { return a.runtimeDays >= 30; })
    : allAds;

  ads = ads.slice(0, maxAds);

  return {
    ads: ads,
    finalUrl: finalUrl || finalUrlInput,
    cookieAccepted: cookieAccepted,
    loginWall: loginWall,
    adLinksFound: adMap.size
  };
}

module.exports = { scrapeMetaAds };
