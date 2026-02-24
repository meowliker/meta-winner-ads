const assert = require('assert');
const { normalizeCompetitorInputs, buildAdLibraryUrl } = require('../src/competitorUrl');

function testAdLibraryUrlPreserved() {
  const input = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&search_type=page&view_all_page_id=123';
  const result = buildAdLibraryUrl(input, { country: 'ALL' });
  assert.ok(result.finalUrl.includes('view_all_page_id=123'));
}

function testPageIdBuild() {
  const result = buildAdLibraryUrl('123', { country: 'ALL' });
  assert.ok(result.finalUrl.includes('view_all_page_id=123'));
}

function testInvalidInput() {
  const result = buildAdLibraryUrl('not a real page', { country: 'ALL' });
  assert.ok(result.reason && result.reason.startsWith('BAD URL'));
}

function testNormalize() {
  const raw = '["a","b"]';
  const list = normalizeCompetitorInputs(raw);
  assert.deepStrictEqual(list, ['a', 'b']);
}

function run() {
  testAdLibraryUrlPreserved();
  testPageIdBuild();
  testInvalidInput();
  testNormalize();
  console.log('competitorUrl tests passed');
}

run();
