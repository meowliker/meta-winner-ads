function normalizeCompetitorInputs(raw) {
  if (!raw) return [];
  const trimmed = String(raw).trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (err) {
      // fall through
    }
  }

  return trimmed
    .split(/\r?\n|\\n|,/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildStablePageUrl(pageId) {
  return `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=${pageId}`;
}

function buildAdLibraryUrl(competitor, options) {
  const input = String(competitor || '').trim();

  if (!input) {
    return { finalUrl: '', pageId: '', reason: 'BAD URL: empty input' };
  }

  const isAdLibrary = input.includes('facebook.com/ads/library');
  if (isAdLibrary) {
    try {
      const url = new URL(input);
      const pageId = url.searchParams.get('view_all_page_id') || '';
      if (pageId) {
        return { finalUrl: buildStablePageUrl(pageId), pageId, reason: 'ad library url' };
      }
      const searchTerm = url.searchParams.get('search_term') || url.searchParams.get('q') || '';
      if (searchTerm) {
        return { finalUrl: url.toString(), pageId: '', reason: 'search term url' };
      }
      return { finalUrl: '', pageId: '', reason: 'BAD URL: ad library url missing view_all_page_id or search_term' };
    } catch (err) {
      return { finalUrl: '', pageId: '', reason: 'BAD URL: invalid ad library url' };
    }
  }

  if (/^\d+$/.test(input)) {
    const finalUrl = buildStablePageUrl(input);
    return { finalUrl, pageId: input, reason: 'page id' };
  }

  try {
    const url = new URL(input);
    if (url.hostname.includes('facebook.com')) {
      const pageId = url.searchParams.get('id') || '';
      if (pageId && /^\d+$/.test(pageId)) {
        const finalUrl = buildStablePageUrl(pageId);
        return { finalUrl, pageId, reason: 'profile.php?id' };
      }

      const pathParts = url.pathname.split('/').filter(Boolean);
      const slug = pathParts[0] || '';
      if (/^\d+$/.test(slug)) {
        const finalUrl = buildStablePageUrl(slug);
        return { finalUrl, pageId: slug, reason: 'numeric slug' };
      }

      return { finalUrl: '', pageId: '', reason: 'BAD URL: cannot resolve page id from slug' };
    }
  } catch (err) {
    // fall through
  }

  return { finalUrl: '', pageId: '', reason: 'BAD URL: unsupported competitor input' };
}

module.exports = { normalizeCompetitorInputs, buildAdLibraryUrl };
