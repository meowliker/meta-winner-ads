console.log("GRAPHQL_DEBUG_MARKER: scrapeMetaAds.js loaded");

const { chromium } = require('playwright');

// ─── Browser launch ───────────────────────────────────────────────────────────

async function launchBrowser(headful) {
  const args = [
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process'
  ];
  try {
    const browser = await chromium.launch({ headless: !headful, channel: 'chrome', args });
    console.log('[playwright] Launched system Chrome');
    return browser;
  } catch (e) {
    console.log('[playwright] System Chrome failed, using bundled Chromium');
    return chromium.launch({ headless: !headful, args });
  }
}

async function createContext(browser) {
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    }
  });

  await context.addInitScript(function() {
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });
    Object.defineProperty(navigator, 'plugins', { get: function() { return [1, 2, 3]; } });
    Object.defineProperty(navigator, 'languages', { get: function() { return ['en-US', 'en']; } });
    window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {} };
    var originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = function(parameters) {
      return parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
    };
  });

  return context;
}

// ─── Cookie consent ───────────────────────────────────────────────────────────

async function tryAcceptCookies(page) {
  const labels = ['Allow all cookies', 'Allow all', 'Accept all', 'Accept', 'Agree', 'Only allow essential cookies'];

  for (const frame of page.frames()) {
    try {
      const btn = frame.getByRole('button', { name: /allow all|accept all|accept|agree/i });
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: 2000 });
        console.log('[cookie] accepted: yes (role button)');
        await page.waitForTimeout(3000);
        return true;
      }
    } catch (e) {}

    for (const label of labels) {
      try {
        const loc = frame.locator('button:has-text("' + label + '")');
        if (await loc.count() > 0) {
          await loc.first().click({ timeout: 2000 });
          console.log('[cookie] accepted: yes (' + label + ')');
          await page.waitForTimeout(3000);
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
        await page.waitForTimeout(3000);
        return true;
      }
    } catch (e) {}
  }

  console.log('[cookie] accepted: no');
  return false;
}

// ─── Token extraction ─────────────────────────────────────────────────────────

async function extractTokens(page) {
  try {
    var tokens = await page.evaluate(function() {
      var html = document.documentElement.innerHTML;
      var dtsg = '';
      var lsd = '';

      var dtsgMatch = html.match(/"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/);
      if (!dtsgMatch) dtsgMatch = html.match(/fb_dtsg["\s:]+value["\s:]+([A-Za-z0-9_\-:]+)/);
      if (!dtsgMatch) dtsgMatch = html.match(/"DTSGInitialData[^"]*",\[\],\{"token":"([^"]+)"/);
      if (dtsgMatch) dtsg = dtsgMatch[1];

      var lsdMatch = html.match(/"LSD[^"]*",\[\],\{"token":"([^"]+)"/);
      if (!lsdMatch) lsdMatch = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/);
      if (lsdMatch) lsd = lsdMatch[1];

      return { dtsg: dtsg, lsd: lsd };
    });
    console.log('[tokens] dtsg=' + (tokens.dtsg ? tokens.dtsg.slice(0, 10) + '...' : 'NOT FOUND') + ' lsd=' + (tokens.lsd ? tokens.lsd.slice(0, 10) + '...' : 'NOT FOUND'));
    return tokens;
  } catch (e) {
    console.log('[tokens] extraction failed: ' + e.message);
    return { dtsg: '', lsd: '' };
  }
}

// ─── Direct GraphQL fetch from inside the page ───────────────────────────────

async function fetchAdsViaPageContext(page, pageId, tokens) {
  if (!tokens.dtsg || !tokens.lsd) {
    console.log('[fetch] Skipping direct fetch — tokens missing');
    return [];
  }

  console.log('[fetch] Attempting direct GraphQL fetch for pageId=' + pageId);

  try {
    var result = await page.evaluate(async function(params) {
      var variables = JSON.stringify({
        activeStatus: 'ALL',
        adType: 'ALL',
        bylines: [],
        collationToken: params.pageId + '_' + Date.now(),
        contentLanguages: [],
        countries: ['ALL'],
        cursor: null,
        excludedIDs: null,
        first: 30,
        location: null,
        mediaType: 'ALL',
        pageIDs: [],
        potentialReachInput: null,
        publisherPlatforms: [],
        queryString: '',
        regions: null,
        searchType: 'PAGE',
        sessionID: params.pageId,
        sortData: { mode: 'TOTAL_IMPRESSIONS', direction: 'DESC' },
        source: null,
        startDate: null,
        v: '2e9c42',
        viewAllPageID: params.pageId
      });

      var body = new URLSearchParams();
      body.append('av', '0');
      body.append('__user', '0');
      body.append('__a', '1');
      body.append('__req', 'a');
      body.append('dpr', '1');
      body.append('__ccg', 'EXCELLENT');
      body.append('fb_dtsg', params.dtsg);
      body.append('lsd', params.lsd);
      body.append('variables', variables);
      body.append('doc_id', '9496122687101087');

      var response = await fetch('https://www.facebook.com/api/graphql/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-FB-LSD': params.lsd,
          'X-ASBD-ID': '198387',
          'Origin': 'https://www.facebook.com',
          'Referer': 'https://www.facebook.com/ads/library/'
        },
        body: body.toString(),
        credentials: 'include'
      });

      var text = await response.text();
      return { status: response.status, body: text.slice(0, 5000) };
    }, { pageId: pageId, dtsg: tokens.dtsg, lsd: tokens.lsd });

    console.log('[fetch] status=' + result.status);
    console.log('[fetch] body preview=' + result.body.slice(0, 300));
    return result;
  } catch (e) {
    console.log('[fetch] failed: ' + e.message);
    return null;
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
  if (!cleaned || (cleaned[0] !== '{' && cleaned[0] !== '[')) return null;
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

// ─── DOM fallback ─────────────────────────────────────────────────────────────

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

// ─── Intercept and capture real GraphQL ad request ───────────────────────────

async function captureAndReplayAdRequest(page, pageId) {
  console.log('[intercept] Setting up request capture for pageId=' + pageId);

  var capturedRequest = null;

  // Intercept POST requests to graphql
  await page.route('**/api/graphql/**', async function(route) {
    var request = route.request();
    if (request.method() === 'POST') {
      var postData = request.postData() || '';
      // Look for requests that contain our pageId or ad library search terms
      if (postData.includes(pageId) || postData.includes('viewAllPageID') || postData.includes('AdLibrary')) {
        if (!capturedRequest) {
          capturedRequest = {
            url: request.url(),
            headers: request.headers(),
            postData: postData
          };
          console.log('[intercept] Captured ad request! postData preview=' + postData.slice(0, 200));
        }
      }
    }
    await route.continue();
  });

  return {
    getCapture: function() { return capturedRequest; }
  };
}

// ─── Login wall detection ─────────────────────────────────────────────────────

async function detectLoginWall(page) {
  try {
    var text = await page.evaluate(function() {
      return document.body ? document.body.innerText : '';
    });
    var lower = String(text).toLowerCase();
    return lower.includes('log in') && lower.includes('facebook');
  } catch (e) { return false; }
}

// ─── Main scrape function ─────────────────────────────────────────────────────

async function scrapeMetaAds(competitor, options) {
  console.log("GRAPHQL_DEBUG_MARKER: competitor start");
  var headful = options.headful || false;
  var maxAds = options.maxAds || 30;
  var finalUrlInput = competitor.finalUrl || '';
  var pageId = competitor.pageId || '';
  var competitorIndex = options.competitorIndex || 1;

  console.log('[competitor] finalUrl: ' + finalUrlInput);
  console.log('[competitor] pageId: ' + pageId);

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
  var uniqueShapes = new Set();

  // ✅ Intercept requests to capture ad GraphQL calls
  var interceptor = await captureAndReplayAdRequest(page, pageId);

  // ✅ Intercept responses
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

      if (json.data && json.data.ad_library_main) {
        var keyStr = Object.keys(json.data.ad_library_main).sort().join(',');
        if (!uniqueShapes.has(keyStr)) {
          uniqueShapes.add(keyStr);
          console.log('GRAPHQL_DEBUG_MARKER: new ad_library_main shape keys=' + keyStr);
        }
      }

      extractAdsFromNode(json, adMap);
    } catch (e) {}
  });

  page.on('framenavigated', function(frame) {
    if (frame === page.mainFrame()) finalUrl = frame.url();
  });

  // Step 1: Navigate
  try {
    await page.goto(finalUrlInput, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.error('[nav] goto failed: ' + e.message);
  }

  await page.waitForTimeout(3000);

  // Step 2: Accept cookies
  var cookieAccepted = await tryAcceptCookies(page);
  if (cookieAccepted) await page.waitForTimeout(4000);

  // Step 3: Wait for redirect to settle
  await page.waitForTimeout(5000);
  console.log('[nav] Current URL after settle: ' + page.url().slice(0, 100));

  // Step 4: Extract tokens for direct fetch
  var tokens = await extractTokens(page);

  // Step 5: Try direct GraphQL fetch using page context + cookies
  if (pageId && tokens.dtsg) {
    var fetchResult = await fetchAdsViaPageContext(page, pageId, tokens);
    if (fetchResult && fetchResult.body) {
      var json = parseGraphqlText(fetchResult.body, true);
      if (json) {
        extractAdsFromNode(json, adMap);
        console.log('[fetch] After direct fetch: ids=' + adMap.size);
      }
    }
  }

  // Step 6: Scroll to trigger any remaining GraphQL requests
  console.log('[scrape] Scrolling to trigger ad edge requests...');
  for (var i = 0; i < 8; i++) {
    try { await page.evaluate(function() { window.scrollBy(0, 600); }); } catch (e) {}
    await page.waitForTimeout(2000);
    if (adMap.size > 0 && i > 2) {
      console.log('[scrape] Got ' + adMap.size + ' ads — stopping scroll');
      break;
    }
  }

  // Step 7: Detect login wall
  var loginWall = await detectLoginWall(page);
  if (loginWall) {
    try { await page.screenshot({ path: '/tmp/debug.png', fullPage: true }); } catch (e) {}
    console.log('[scrape] Login wall detected');
  }

  // Step 8: DOM fallback
  var domLinks = await extractAdLinksFromDom(page);
  domLinks.forEach(function(href) {
    var m = href.match(/ad_archive_id=(\d+)/) || href.match(/\/ads\/library\/\?id=(\d+)/);
    if (m && !adMap.has(m[1])) {
      adMap.set(m[1], { ad_archive_id: m[1], started_running_on: null, creative_preview: '', landing_link: '', ad_snapshot_url: 'https://www.facebook.com/ads/library/?id=' + m[1] });
    }
  });

  // Log captured request for debugging
  var captured = interceptor.getCapture();
  if (captured) {
    console.log('[intercept] Captured request postData keys: ' + captured.postData.slice(0, 300));
  } else {
    console.log('[intercept] No ad GraphQL request was captured');
  }

  console.log('GRAPHQL_DEBUG_MARKER: summary responsesSeen=' + graphqlResponsesSeen + ' parsed=' + graphqlParsed + ' ids=' + adMap.size + ' domLinks=' + domLinks.length + ' cookieAccepted=' + (cookieAccepted ? 'yes' : 'no'));

  await browser.close();

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
