console.log("GRAPHQL_DEBUG_MARKER: scrapeMetaAds.js loaded");

// Use playwright-extra with stealth plugin to bypass Facebook bot detection
let chromium;
try {
  const { chromium: chromiumExtra } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromiumExtra.use(StealthPlugin());
  chromium = chromiumExtra;
  console.log('[stealth] playwright-extra + stealth plugin loaded');
} catch (e) {
  console.log('[stealth] playwright-extra not available, falling back to plain playwright: ' + e.message);
  chromium = require('playwright').chromium;
}

// ─── Browser ──────────────────────────────────────────────────────────────────

async function launchBrowser(headful) {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled'
  ];
  try {
    const browser = await chromium.launch({ headless: !headful, channel: 'chrome', args });
    console.log('[playwright] Launched system Chrome');
    return browser;
  } catch (e) {
    console.log('[playwright] Falling back to bundled Chromium');
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
    Object.defineProperty(navigator, 'plugins', { get: function() { return [1, 2, 3, 4, 5]; } });
    Object.defineProperty(navigator, 'languages', { get: function() { return ['en-US', 'en']; } });
    window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {} };
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
        var btns = Array.from(document.querySelectorAll('button'));
        for (var i = 0; i < btns.length; i++) {
          var t = (btns[i].innerText || '').trim().toLowerCase();
          for (var j = 0; j < labelList.length; j++) {
            if (t.includes(labelList[j].toLowerCase())) { btns[i].click(); return true; }
          }
        }
        return false;
      }, labels);
      if (clicked) {
        console.log('[cookie] accepted: yes (eval)');
        await page.waitForTimeout(3000);
        return true;
      }
    } catch (e) {}
  }
  console.log('[cookie] accepted: no');
  return false;
}

// ─── GraphQL parsing ──────────────────────────────────────────────────────────

function stripPrefix(raw) {
  var s = String(raw || '').trim();
  if (s.startsWith('for (;;);')) s = s.slice(9).trim();
  if (s.startsWith(")]}',")) s = s.slice(5).trim();
  return s;
}

function parseJson(raw, logFail) {
  var s = stripPrefix(raw);
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
  try { return JSON.parse(s); }
  catch (e) {
    if (logFail) console.log('GRAPHQL_DEBUG_MARKER: parse_failed first80=' + s.slice(0, 80));
    return null;
  }
}

// ─── Ad extraction ────────────────────────────────────────────────────────────

function sanitizeUrl(v) {
  if (!v || typeof v !== 'string' || !v.trim().startsWith('http')) return '';
  try {
    var p = new URL(v.trim());
    if (p.hostname.endsWith('facebook.com') && p.pathname.includes('/l.php')) {
      var u = p.searchParams.get('u');
      return u ? decodeURIComponent(u) : v.trim();
    }
    return v.trim();
  } catch (e) { return ''; }
}

function firstUrl(arr) {
  for (var i = 0; i < arr.length; i++) { var s = sanitizeUrl(arr[i]); if (s) return s; }
  return '';
}

function getLanding(node) {
  if (!node || typeof node !== 'object') return '';
  var d = firstUrl([node.link_url, node.website_url, node.destination_url, node.url, node.final_url, node.linkUrl, node.websiteUrl, node.finalUrl]);
  if (d) return d;
  var cta = node.call_to_action || node.callToAction || node.cta;
  if (cta) { var c = firstUrl([cta.link, cta.url, cta.value && cta.value.link, cta.value && cta.value.url]); if (c) return c; }
  if (Array.isArray(node.attachments)) {
    for (var i = 0; i < node.attachments.length; i++) { var a = node.attachments[i]; var al = firstUrl([a.url, a.link, a.card_link]); if (al) return al; }
  }
  return firstUrl([node.card_link, node.cardLink]);
}

function getCreative(node) {
  if (!node || typeof node !== 'object') return '';
  return node.ad_snapshot_url || node.adSnapshotUrl || node.ad_creative_image_url || node.image_url || node.imageUrl || node.thumbnail_url || '';
}

function extractAds(node, adMap) {
  if (!node || typeof node !== 'object') return;
  var id = node.ad_archive_id || node.adArchiveID || node.archive_id;
  if (id) {
    var sid = String(id);
    if (!adMap.has(sid)) {
      adMap.set(sid, {
        id: sid,
        start: node.started_running_on || node.startedRunningOn || node.start_time || node.startDate || null,
        creative: getCreative(node),
        landing: getLanding(node),
        snapshot: node.ad_snapshot_url || node.adSnapshotUrl || ''
      });
    }
    return;
  }
  if (Array.isArray(node.edges)) { for (var i = 0; i < node.edges.length; i++) { if (node.edges[i] && node.edges[i].node) extractAds(node.edges[i].node, adMap); } }
  if (Array.isArray(node.ads)) { for (var i = 0; i < node.ads.length; i++) extractAds(node.ads[i], adMap); }
  if (Array.isArray(node.results)) { for (var i = 0; i < node.results.length; i++) extractAds(node.results[i], adMap); }
  var keys = Object.keys(node);
  for (var k = 0; k < keys.length; k++) {
    var val = node[keys[k]];
    if (val && typeof val === 'object' && !Array.isArray(val)) extractAds(val, adMap);
    if (Array.isArray(val)) { for (var i = 0; i < val.length; i++) extractAds(val[i], adMap); }
    if (typeof val === 'string' && val.includes('ad_archive_id=')) {
      var m = val.match(/ad_archive_id=(\d+)/);
      if (m && !adMap.has(m[1])) adMap.set(m[1], { id: m[1], start: null, creative: '', landing: '', snapshot: '' });
    }
  }
}

function normalize(adMap) {
  var out = [];
  adMap.forEach(function(ad) {
    var days = 0;
    if (ad.start) {
      var ts = typeof ad.start === 'number' ? ad.start * 1000 : new Date(ad.start).getTime();
      if (!isNaN(ts)) days = Math.floor((Date.now() - ts) / 86400000);
    }
    out.push({
      adArchiveId: ad.id,
      adLibraryLink: 'https://www.facebook.com/ads/library/?id=' + ad.id,
      adSnapshotUrl: ad.snapshot || 'https://www.facebook.com/ads/library/?id=' + ad.id,
      creativePreview: ad.creative || '',
      landingLink: ad.landing || '',
      runtimeDays: days,
      duplicates: 1,
      startDate: ad.start ? new Date(typeof ad.start === 'number' ? ad.start * 1000 : ad.start).toISOString() : ''
    });
  });
  return out;
}

// ─── DOM fallback ─────────────────────────────────────────────────────────────

async function domFallback(page, adMap) {
  try {
    var hrefs = await page.evaluate(function() {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(function(a) { return a.getAttribute('href') || ''; })
        .filter(function(h) { return h.includes('ad_archive_id') || (h.includes('/ads/library/') && h.includes('id=')); });
    });
    var seen = new Set(Array.from(adMap.keys()));
    hrefs.forEach(function(h) {
      var m = h.match(/ad_archive_id=(\d+)/) || h.match(/\/ads\/library\/\?id=(\d+)/);
      if (m && !seen.has(m[1])) {
        adMap.set(m[1], { id: m[1], start: null, creative: '', landing: '', snapshot: 'https://www.facebook.com/ads/library/?id=' + m[1] });
        seen.add(m[1]);
      }
    });
    console.log('[dom] ad links found: ' + hrefs.length);
    return hrefs.length;
  } catch (e) { return 0; }
}

// ─── Login wall ───────────────────────────────────────────────────────────────

async function isLoginWall(page) {
  try {
    var t = await page.evaluate(function() { return document.body ? document.body.innerText : ''; });
    var l = String(t).toLowerCase();
    return l.includes('log in') && l.includes('facebook');
  } catch (e) { return false; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapeMetaAds(competitor, options) {
  console.log("GRAPHQL_DEBUG_MARKER: competitor start");
  var headful = options.headful || false;
  var maxAds = options.maxAds || 30;
  var finalUrlInput = competitor.finalUrl || '';

  console.log('[competitor] finalUrl: ' + finalUrlInput);

  if (!finalUrlInput || (!finalUrlInput.includes('view_all_page_id=') && !finalUrlInput.includes('search_term='))) {
    console.error('[competitor] BAD URL');
    return { ads: [], finalUrl: finalUrlInput, cookieAccepted: false, loginWall: false, adLinksFound: 0 };
  }

  var browser = await launchBrowser(headful);
  var context = await createContext(browser);
  var page = await context.newPage();

  var finalUrl = finalUrlInput;
  var adMap = new Map();
  var seen = 0, parsed = 0, failLogged = false, firstLogged = false;
  var shapes = new Set();

  // ✅ Response handler BEFORE navigation
  page.on('response', async function(res) {
    try {
      if (!res.url().includes('graphql')) return;
      seen++;
      var raw = await res.text().catch(function() { return ''; });
      if (!firstLogged) {
        firstLogged = true;
        console.log('GRAPHQL_DEBUG_MARKER: graphql-response content-type=' + (res.headers()['content-type'] || ''));
        console.log('GRAPHQL_DEBUG_MARKER: graphql-response first200=' + raw.slice(0, 200));
      }
      var json = parseJson(raw, !failLogged);
      if (!json) { failLogged = true; return; }
      parsed++;
      if (json.data && json.data.ad_library_main) {
        var shape = Object.keys(json.data.ad_library_main).sort().join(',');
        if (!shapes.has(shape)) { shapes.add(shape); console.log('GRAPHQL_DEBUG_MARKER: ad_library_main shape=' + shape); }
      }
      extractAds(json, adMap);
    } catch (e) {}
  });

  page.on('framenavigated', function(f) { if (f === page.mainFrame()) finalUrl = f.url(); });

  // Navigate
  try { await page.goto(finalUrlInput, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.error('[nav] failed: ' + e.message); }

  // Accept cookies right away
  await page.waitForTimeout(2000);
  var cookieAccepted = await tryAcceptCookies(page);

  // Wait for redirect to settle
  await page.waitForTimeout(6000);
  console.log('[nav] settled url: ' + page.url().slice(0, 100));

  // Try cookies again after redirect
  if (!cookieAccepted) {
    cookieAccepted = await tryAcceptCookies(page);
    if (cookieAccepted) await page.waitForTimeout(5000);
  }

  // Poll for ads while scrolling — up to 60 seconds
  console.log('[scrape] Polling for ad edges...');
  var elapsed = 0;
  var scrollStep = 0;
  while (elapsed < 60000) {
    await page.waitForTimeout(2000);
    elapsed += 2000;
    scrollStep++;
    try { await page.evaluate(function() { window.scrollBy(0, 500); }); } catch (e) {}
    if (adMap.size > 0 && elapsed > 6000) {
      console.log('[scrape] Got ' + adMap.size + ' ads at ' + elapsed + 'ms');
      break;
    }
  }

  // If still nothing after 60s, try a page reload once
  if (adMap.size === 0) {
    console.log('[scrape] 0 ads — reloading once');
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      if (!cookieAccepted) { cookieAccepted = await tryAcceptCookies(page); await page.waitForTimeout(4000); }
      for (var i = 0; i < 8; i++) {
        try { await page.evaluate(function() { window.scrollBy(0, 600); }); } catch (e) {}
        await page.waitForTimeout(2000);
        if (adMap.size > 0) break;
      }
    } catch (e) {}
  }

  var loginWall = await isLoginWall(page);
  if (loginWall) {
    try { await page.screenshot({ path: '/tmp/debug.png', fullPage: true }); } catch (e) {}
  }

  var domLinks = await domFallback(page, adMap);

  console.log('GRAPHQL_DEBUG_MARKER: summary responsesSeen=' + seen + ' parsed=' + parsed + ' ids=' + adMap.size + ' domLinks=' + domLinks + ' cookieAccepted=' + (cookieAccepted ? 'yes' : 'no'));

  await browser.close();

  var all = normalize(adMap);
  var withDates = all.filter(function(a) { return a.runtimeDays > 0; });
  var ads = withDates.length > 0 ? withDates.filter(function(a) { return a.runtimeDays >= 30; }) : all;
  ads = ads.slice(0, maxAds);

  return { ads: ads, finalUrl: finalUrl || finalUrlInput, cookieAccepted: cookieAccepted, loginWall: loginWall, adLinksFound: adMap.size };
}

module.exports = { scrapeMetaAds };
