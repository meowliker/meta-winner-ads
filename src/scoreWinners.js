function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function parseStartedDate(value) {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/Started running on/i, '')
    .replace(/Started running/i, '')
    .trim();
  const parsed = Date.parse(cleaned);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed);
}

function runtimeDaysFrom(dateObj, now) {
  if (!dateObj) return 0;
  const diffMs = now.getTime() - dateObj.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function scoreWinners(rawAds, options) {
  const now = options?.now || new Date();
  const byKey = new Map();

  for (const ad of rawAds) {
    const primary = normalizeText((ad.primaryText || '').slice(0, 120));
    const creative = (ad.creativePreview || '').trim().toLowerCase();
    const key = `${creative}::${primary}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        ads: [],
        representative: ad
      });
    }
    byKey.get(key).ads.push(ad);
  }

  const scored = [];

  for (const entry of byKey.values()) {
    const duplicates = entry.ads.length;
    const startedDate = parseStartedDate(entry.representative.startedRunningOn);
    const runtimeDays = runtimeDaysFrom(startedDate, now);
    const winningScore = runtimeDays === 0
      ? duplicates * 10
      : (runtimeDays * 0.6) + (duplicates * 10 * 0.4);

    scored.push({
      ...entry.representative,
      duplicates,
      runtimeDays,
      winningScore
    });
  }

  scored.sort((a, b) => b.winningScore - a.winningScore);
  return scored;
}

module.exports = { scoreWinners };
