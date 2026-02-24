require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { scrapeMetaAds } = require('./scrapeMetaAds');
const { scoreWinners } = require('./scoreWinners');
const { postWebhook } = require('./postWebhook');
const { discoverPages } = require('./discoverPages');

function loadLocalEnv() {
  const dotenvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(dotenvPath)) {
    require('dotenv').config({ path: dotenvPath });
  }
}

function parseYes(value) {
  if (!value) return false;
  return ['y', 'yes', 'true', '1'].includes(String(value).trim().toLowerCase());
}

function parseCompetitorUrls(raw) {
  const normalized = raw || '';
  return normalized
    .split(/\r?\n|\\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseSeedKeywords(raw) {
  const normalized = raw || '';
  return normalized
    .split(/\r?\n|\\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseCountries(raw) {
  if (!raw) return ['ALL'];
  const cleaned = raw.replace(/\n/g, ',');
  const parts = cleaned
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.toUpperCase());
  return parts.length > 0 ? parts : ['ALL'];
}

function inferCategory(url) {
  if (url.includes('view_all_page_id=')) return 'Meta competitor page';
  if (url.includes('/ads/library/?id=')) return 'Specific ad reference';
  if (url.includes('q=')) return 'Meta keyword search';
  return 'Meta';
}

function toRow(ad, competitorUrl, category) {
  return {
    competitor: competitorUrl,
    category,
    winningScore: ad.winningScore,
    runtimeDays: ad.runtimeDays,
    duplicates: ad.duplicates,
    adLibraryLink: ad.adLibraryLink,
    creativePreview: ad.creativePreview,
    landingLink: ad.landingLink,
    offerType: '',
    notes: 'Auto scraped by GitHub Actions'
  };
}

async function main() {
  const isLocal = process.argv.includes('--local');
  if (isLocal) {
    loadLocalEnv();
  }

  const webhookUrl = process.env.WEBHOOK_URL;
  const webhookToken = process.env.WEBHOOK_TOKEN;
  const competitorRaw = process.env.COMPETITOR_URLS;
  const seedRaw = process.env.SEED_KEYWORDS;
  const discoveryLimitRaw = process.env.DISCOVERY_LIMIT;
  const countriesRaw = process.env.COUNTRIES;
  const runHeadful = parseYes(process.env.RUN_HEADFUL);
  const pauseRaw = process.env.PAUSE_ON_LOGIN_WALL;
  const pauseOnLoginWall = isLocal
    ? (pauseRaw ? parseYes(pauseRaw) : true)
    : parseYes(pauseRaw);

  if (!webhookUrl || !webhookToken) {
    console.error('Missing required env vars. Ensure WEBHOOK_URL and WEBHOOK_TOKEN are set.');
    process.exit(1);
  }

  console.log(`[startup] WEBHOOK_URL endsWith /exec: ${String(webhookUrl).trim().endsWith('/exec')}`);
  console.log(`[startup] WEBHOOK_TOKEN length: ${String(webhookToken).trim().length}`);

  const competitorUrls = parseCompetitorUrls(competitorRaw);
  const seedKeywords = parseSeedKeywords(seedRaw);
  const discoveryLimit = Number.parseInt(discoveryLimitRaw || '30', 10) || 30;
  const countries = parseCountries(countriesRaw || 'ALL');

  if (competitorUrls.length === 0 && seedKeywords.length === 0) {
    console.error('No competitor URLs or seed keywords provided.');
    process.exit(1);
  }

  const cachePath = path.join(process.cwd(), 'discovered_pages.json');
  let cache = { updatedAt: null, pages: [] };
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (err) {
      console.warn('Failed to parse discovered_pages.json. Starting fresh.');
    }
  }

  const pageMap = new Map();
  if (Array.isArray(cache.pages)) {
    for (const page of cache.pages) {
      if (!page || !page.id) continue;
      pageMap.set(page.id, { ...page });
    }
  }

  if (seedKeywords.length > 0) {
    console.log(`Discovering competitors from ${seedKeywords.length} keyword(s) across ${countries.length} country setting(s).`);
    for (const country of countries) {
      for (const keyword of seedKeywords) {
        console.log(`Discovering pages for "${keyword}" (${country})`);
        try {
          const pages = await discoverPages(keyword, country, { headful: runHeadful });
          console.log(`Discovered pages: ${pages.length}`);

          for (const page of pages) {
            if (!page.id) continue;
            const existing = pageMap.get(page.id);
            const nowIso = new Date().toISOString();
            if (existing) {
              existing.count = (existing.count || 0) + (page.count || 0);
              if (!existing.name && page.name) existing.name = page.name;
              existing.lastSeen = nowIso;
              pageMap.set(page.id, existing);
            } else {
              pageMap.set(page.id, {
                id: page.id,
                name: page.name || '',
                count: page.count || 0,
                firstSeen: nowIso,
                lastSeen: nowIso
              });
            }
          }
        } catch (err) {
          console.error(`Discovery failed for "${keyword}" (${country}): ${err.message}`);
        }
      }
    }
  }

  const rankedPages = Array.from(pageMap.values())
    .sort((a, b) => (b.count || 0) - (a.count || 0))
    .slice(0, discoveryLimit);

  const discoveredUrls = rankedPages.map((page) => {
    const params = new URLSearchParams({
      active_status: 'active',
      ad_type: 'all',
      country: countries[0] || 'ALL',
      search_type: 'page',
      view_all_page_id: page.id
    });
    return `https://www.facebook.com/ads/library/?${params.toString()}`;
  });

  const allCompetitors = [...competitorUrls, ...discoveredUrls];
  const dedupedCompetitors = Array.from(new Set(allCompetitors));

  cache = {
    updatedAt: new Date().toISOString(),
    pages: Array.from(pageMap.values())
  };
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  console.log(`Competitors: ${dedupedCompetitors.length}`);

  for (let i = 0; i < dedupedCompetitors.length; i += 1) {
    const competitorUrl = dedupedCompetitors[i];
    const category = inferCategory(competitorUrl);

    console.log(`[${i + 1}/${dedupedCompetitors.length}] Scraping ${competitorUrl}`);

    try {
      const result = await scrapeMetaAds(competitorUrl, {
        headful: runHeadful,
        maxAds: 30,
        isLocal,
        pauseOnLoginWall
      });
      const ads = Array.isArray(result) ? result : result.ads;
      const finalUrl = result && result.finalUrl ? result.finalUrl : competitorUrl;
      const cookieAccepted = result && result.cookieAccepted ? 'yes' : 'no';
      const loginWall = result && result.loginWall ? 'yes' : 'no';
      const adLinksFound = result && typeof result.adLinksFound === 'number' ? result.adLinksFound : 0;

      console.log(`[${i + 1}/${dedupedCompetitors.length}] Final URL: ${finalUrl}`);
      console.log(`[${i + 1}/${dedupedCompetitors.length}] Cookie accepted: ${cookieAccepted}`);
      console.log(`[${i + 1}/${dedupedCompetitors.length}] Login wall: ${loginWall}`);
      console.log(`[${i + 1}/${dedupedCompetitors.length}] Ad links found: ${adLinksFound}`);
      console.log(`[${i + 1}/${dedupedCompetitors.length}] Ads parsed: ${ads.length}`);

      if (!ads || ads.length === 0) {
        continue;
      }

      const scored = scoreWinners(ads);
      const winners = scored.slice(0, 10);
      console.log(`[${i + 1}/${dedupedCompetitors.length}] Winners selected: ${winners.length}`);

      const rows = winners.map((ad) => toRow(ad, competitorUrl, category));

      for (let start = 0; start < rows.length; start += 20) {
        const batch = rows.slice(start, start + 20);
        try {
          const resultPost = await postWebhook(batch);
          console.log(`[${i + 1}/${dedupedCompetitors.length}] Webhook response: ${JSON.stringify(resultPost.parsed)}`);
        } catch (err) {
          console.error(`[${i + 1}/${dedupedCompetitors.length}] Webhook failed: ${err.message}`);
          if (err.responsePreview) {
            console.error(`[${i + 1}/${dedupedCompetitors.length}] Response preview: ${err.responsePreview}`);
          }
          continue;
        }
      }
    } catch (err) {
      console.error(`[${i + 1}/${dedupedCompetitors.length}] Failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
