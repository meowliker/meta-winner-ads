// scrapeMetaAds.js
console.log("GRAPHQL_DEBUG_MARKER: scrapeMetaAds.js loaded");

const { chromium } = require("playwright");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip common Facebook JSON security prefixes */
function stripPrefix(text) {
  return text
    .replace(/^for\s*\(;;\s*\);?\s*/, "")   // for(;;);
    .replace(/^\)\]\}',?\s*/, "")             // )]}',
    .replace(/^while\s*\(1\)\s*;?\s*/, "")   // while(1);
    .trim();
}

/** Recursively walk an object collecting ad nodes */
function collectAdNodes(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;

  // An ad node has adArchiveID or ad_archive_id
  if (obj.adArchiveID || obj.ad_archive_id) {
    results.push(obj);
    return results; // don't recurse deeper into this node
  }

  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) collectAdNodes(item, results);
    } else if (val && typeof val === "object") {
      collectAdNodes(val, results);
    }
  }
  return results;
}

/** Extract ad_archive_id values from raw text as fallback */
function extractIdsFromText(text) {
  const ids = new Set();
  const re = /ad_archive_id[="\s:]+(\d{10,20})/g;
  let m;
  while ((m = re.exec(text)) !== null) ids.add(m[1]);
  // also match /ads/library/?id=XXXXXXX
  const re2 = /\/ads\/library\/\?id=(\d{10,20})/g;
  while ((m = re2.exec(text)) !== null) ids.add(m[1]);
  return ids;
}

/** Parse an ad node from GraphQL into the shape run.js expects */
function parseAdNode(node) {
  const archiveId = String(node.adArchiveID || node.ad_archive_id || "");

  // Runtime
  const startTs = node.startDate || node.start_date || 0;
  const runtimeDays = startTs
    ? Math.floor((Date.now() / 1000 - startTs) / 86400)
    : 0;

  // Duplicates / collation count
  const duplicates =
    node.collationCount ||
    node.collation_count ||
    node.duplicateCount ||
    node.duplicate_count ||
    1;

  // Snapshot
  const snapshot = node.snapshot || node.ad_snapshot || {};
  const snapshotUrl =
    node.adSnapshotURL ||
    node.ad_snapshot_url ||
    (archiveId ? `https://www.facebook.com/ads/library/?id=${archiveId}` : "");

  // Creative preview — image or video
  let creativePreview = "";
  const cards = snapshot.cards || [];
  const images = snapshot.images || [];
  const videos = snapshot.videos || [];

  if (cards.length > 0) {
    creativePreview =
      cards[0].resizedImageUrl ||
      cards[0].original_image_url ||
      cards[0].videoHdUrl ||
      cards[0].video_hd_url ||
      "";
  } else if (images.length > 0) {
    creativePreview =
      images[0].resizedImageUrl || images[0].original_image_url || "";
  } else if (videos.length > 0) {
    creativePreview =
      videos[0].videoHdUrl || videos[0].video_hd_url || "";
  }

  // Landing URL — try multiple paths
  let landingLink =
    snapshot.linkUrl ||
    snapshot.link_url ||
    (cards[0] && (cards[0].linkUrl || cards[0].link_url)) ||
    "";

  if (!landingLink) {
    const cta =
      snapshot.callToActionLink ||
      snapshot.call_to_action_link ||
      (snapshot.callToAction && snapshot.callToAction.value) ||
      "";
    if (cta && cta.startsWith("http")) landingLink = cta;
  }

  const adLibraryLink = archiveId
    ? `https://www.facebook.com/ads/library/?id=${archiveId}`
    : "";

  return {
    adArchiveId: archiveId,
    adSnapshotUrl: snapshotUrl,
    creativePreview,
    landingLink,
    adLibraryLink,
    runtimeDays,
    duplicates,
    startDate: startTs ? new Date(startTs * 1000).toISOString() : "",
  };
}

// ─── Cookie acceptance ────────────────────────────────────────────────────────

async function acceptCookies(page) {
  const buttonTexts = [
    "Allow all cookies",
    "Accept all",
    "Allow essential and optional cookies",
    "Allow all",
    "Agree",
    "OK",
    "Accept",
  ];

  // Main frame
  for (const text of buttonTexts) {
    try {
      const btn = page.getByRole("button", { name: text, exact: false });
      if (await btn.isVisible({ timeout: 2500 })) {
        await btn.click();
        console.log(`GRAPHQL_DEBUG_MARKER: cookie clicked (main) text="${text}"`);
        await page.waitForTimeout(2500);
        return true;
      }
    } catch {}
  }

  // iframes
  for (const frame of page.frames()) {
    for (const text of buttonTexts) {
      try {
        const btn = frame.getByRole("button", { name: text, exact: false });
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log(`GRAPHQL_DEBUG_MARKER: cookie clicked (iframe) text="${text}"`);
          await page.waitForTimeout(2500);
          return true;
        }
      } catch {}
    }
  }

  return false;
}

// ─── Login wall detection ─────────────────────────────────────────────────────

async function detectLoginWall(page) {
  try {
    const content = await page.content();
    return (
      content.includes("log in") ||
      content.includes("Log In") ||
      content.includes("login_form") ||
      content.includes("You must log in")
    );
  } catch {
    return false;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Scrape Meta Ad Library for a single competitor.
 *
 * @param {object} competitor   - { raw, finalUrl, pageId }
 * @param {object} options      - { headful, maxAds, isLocal, pauseOnLoginWall, competitorIndex }
 * @returns {object}            - { ads, finalUrl, cookieAccepted, loginWall, adLinksFound }
 */
async function scrapeMetaAds(competitor, options = {}) {
  const { finalUrl } = competitor;
  const { headful = false, maxAds = 30, competitorIndex = 1 } = options;

  console.log(`GRAPHQL_DEBUG_MARKER: competitor start url=${finalUrl}`);

  const browser = await chromium.launch({
    channel: "chromium",
    headless: !headful,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();

  let responsesSeen = 0;
  let parsed = 0;
  const adMap = new Map();       // archiveId → ad object
  const rawIdFallback = new Set();
  let firstResponseLogged = false;

  // ✅ CRITICAL: attach handler BEFORE navigation
  page.on("response", async (response) => {
    const resUrl = response.url();
    const isGraphQL =
      resUrl.includes("/api/graphql") ||
      resUrl.includes("graph.facebook.com") ||
      resUrl.includes("graphql?");

    if (!isGraphQL) return;
    responsesSeen++;

    const ct = response.headers()["content-type"] || "";
    let body = "";
    try {
      body = await response.text();
    } catch {
      return;
    }

    // Log first response for debugging
    if (!firstResponseLogged) {
      firstResponseLogged = true;
      console.log(`GRAPHQL_DEBUG_MARKER: graphql-response content-type=${ct}`);
      console.log(`GRAPHQL_DEBUG_MARKER: graphql-response first200=${body.slice(0, 200)}`);
    }

    // ✅ Always parse regardless of content-type
    const clean = stripPrefix(body);
    let json = null;
    try {
      json = JSON.parse(clean);
      parsed++;
    } catch {
      // Not valid JSON — scan raw text for IDs anyway
      extractIdsFromText(body).forEach((id) => rawIdFallback.add(id));
      return;
    }

    // Walk the parsed JSON for ad nodes
    const nodes = collectAdNodes(json);
    for (const node of nodes) {
      const ad = parseAdNode(node);
      if (ad.adArchiveId) {
        adMap.set(ad.adArchiveId, ad);
      }
    }
  });

  // Navigate
  let actualUrl = finalUrl;
  try {
    await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    actualUrl = page.url();
  } catch (err) {
    console.error(`[competitor ${competitorIndex}] Navigation error: ${err.message}`);
  }

  // Accept cookies
  const cookieAccepted = await acceptCookies(page);
  console.log(`GRAPHQL_DEBUG_MARKER: cookieAccepted=${cookieAccepted}`);

  // Wait for ads to load after consent
  await page.waitForTimeout(cookieAccepted ? 5000 : 3000);

  // Detect login wall
  const loginWall = await detectLoginWall(page);

  // Scroll to trigger lazy-loaded GraphQL requests
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(1200);
  }

  // ─── DOM fallback ────────────────────────────────────────────────────────
  let domLinks = 0;
  try {
    const hrefs = await page.$$eval(
      "a[href*='ad_archive_id'], a[href*='/ads/library/?id=']",
      (els) => els.map((el) => el.href)
    );
    domLinks = hrefs.length;
    for (const href of hrefs) {
      extractIdsFromText(href).forEach((id) => rawIdFallback.add(id));
    }
  } catch {}

  // Add stub entries for IDs found only in raw text (no full node data)
  for (const id of rawIdFallback) {
    if (!adMap.has(id)) {
      adMap.set(id, {
        adArchiveId: id,
        adSnapshotUrl: `https://www.facebook.com/ads/library/?id=${id}`,
        creativePreview: "",
        landingLink: "",
        adLibraryLink: `https://www.facebook.com/ads/library/?id=${id}`,
        runtimeDays: 0,
        duplicates: 1,
        startDate: "",
      });
    }
  }

  console.log(
    `GRAPHQL_DEBUG_MARKER: summary responsesSeen=${responsesSeen} parsed=${parsed} ids=${adMap.size} domLinks=${domLinks} cookieAccepted=${cookieAccepted ? "yes" : "no"}`
  );

  await browser.close();

  // ─── Filter to winning ads (30+ days runtime) ────────────────────────────
  const allAds = Array.from(adMap.values());
  const adsWithDates = allAds.filter((ad) => ad.runtimeDays > 0);

  let ads;
  if (adsWithDates.length > 0) {
    // We have real date data — filter strictly to 30+ days
    ads = adsWithDates.filter((ad) => ad.runtimeDays >= 30);
  } else {
    // No date data yet (GraphQL parsing not returning startDate) — return all
    // scoreWinners in run.js will handle further ranking
    ads = allAds;
  }

  // Cap at maxAds
  ads = ads.slice(0, maxAds);

  return {
    ads,
    finalUrl: actualUrl || finalUrl,
    cookieAccepted,
    loginWall,
    adLinksFound: adMap.size,
  };
}

module.exports = { scrapeMetaAds };
