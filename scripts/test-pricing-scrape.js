#!/usr/bin/env node
/*
 * Pricing-scrape A/B test: SerpAPI vs Google Custom Search
 *
 * Usage:
 *   node scripts/test-pricing-scrape.js "Summit, NJ"
 *   node scripts/test-pricing-scrape.js "07901" --limit 5
 *   node scripts/test-pricing-scrape.js "Miami, FL" --provider=serp
 *   node scripts/test-pricing-scrape.js "Austin, TX" --provider=cse
 *
 * Env vars (in .env or shell):
 *   GOOGLE_PLACES_API_KEY  — reused from the marketplace
 *   SERPAPI_KEY            — from https://serpapi.com (free 100/mo)
 *   GOOGLE_CSE_API_KEY     — from Google Cloud Console (Custom Search API)
 *   GOOGLE_CSE_ENGINE_ID   — from https://programmablesearchengine.google.com
 */

require('dotenv').config();
const fetch = require('node-fetch');

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_ENGINE_ID = process.env.GOOGLE_CSE_ENGINE_ID || '';

// ── CLI args ──
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);

const LOCATION = positional[0];
const LIMIT = parseInt(flags.limit, 10) || 4;
const PROVIDER = flags.provider || 'both'; // 'serp', 'cse', or 'both'

if (!LOCATION) {
  console.error('Usage: node scripts/test-pricing-scrape.js "<city, state | zip>" [--limit N] [--provider=both|serp|cse]');
  process.exit(1);
}

// ── Provider availability checks ──
function checkKeys() {
  const missing = [];
  if (!GOOGLE_PLACES_API_KEY) missing.push('GOOGLE_PLACES_API_KEY (Places lookup)');
  if ((PROVIDER === 'serp' || PROVIDER === 'both') && !SERPAPI_KEY) missing.push('SERPAPI_KEY');
  if ((PROVIDER === 'cse' || PROVIDER === 'both') && (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_ENGINE_ID)) {
    missing.push('GOOGLE_CSE_API_KEY + GOOGLE_CSE_ENGINE_ID');
  }
  if (missing.length) {
    console.error('Missing env vars:\n  - ' + missing.join('\n  - '));
    console.error('\nAdd them to your .env file in the marketplace root.');
    process.exit(1);
  }
}

// ── Places lookup (mirrors server.js) ──
async function geocode(query) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_PLACES_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results?.length) return null;
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, formatted: data.results[0].formatted_address };
}

async function findFacilities(location, limit) {
  const geo = await geocode(location);
  if (!geo) throw new Error(`Could not geocode "${location}"`);

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${geo.lat},${geo.lng}&radius=16093&keyword=self+storage&type=storage&key=${GOOGLE_PLACES_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results?.length) return { geo, facilities: [] };

  const facilities = await Promise.all(
    data.results.slice(0, limit).map(async (p) => {
      const dUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=name,formatted_address,website&key=${GOOGLE_PLACES_API_KEY}`;
      const dRes = await fetch(dUrl);
      const dJson = await dRes.json();
      const d = dJson.result || {};
      return {
        name: d.name || p.name,
        address: d.formatted_address || p.vicinity || '',
        website: d.website || '',
      };
    })
  );

  return { geo, facilities };
}

// ── Query builders ──
function buildQueries(facility) {
  const namePart = facility.name;
  const cityPart = facility.address.split(',').slice(1).join(',').trim();
  const domain = facility.website
    ? new URL(facility.website).hostname.replace(/^www\./, '')
    : '';

  return [
    domain ? `site:${domain} storage unit price` : null,
    `${namePart} ${cityPart} 10x10 price`,
    `${namePart} ${cityPart} storage unit cost`,
  ].filter(Boolean);
}

// ── SerpAPI provider ──
async function querySerp(q) {
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&api_key=${SERPAPI_KEY}&num=10`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) return { error: data.error, results: [] };
  const results = (data.organic_results || []).map(r => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet || '',
  }));
  return { results, raw: { search_metadata: data.search_metadata } };
}

// ── Google Custom Search provider ──
async function queryCse(q) {
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_API_KEY}&cx=${GOOGLE_CSE_ENGINE_ID}&q=${encodeURIComponent(q)}&num=10`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) return { error: data.error.message, results: [] };
  const results = (data.items || []).map(r => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet || '',
  }));
  return { results, raw: { searchInformation: data.searchInformation } };
}

// ── Price extraction from snippet text ──
// Looks for $ amounts in plausible storage-rental range, with size hints nearby
const SIZE_RE = /(\d{1,2}\s*[x×]\s*\d{1,2})/gi;
const PRICE_RE = /\$\s?(\d{1,3}(?:[.,]\d{2})?)/g;

function extractPriceHints(text) {
  if (!text) return [];
  const hints = [];
  const sizes = [...text.matchAll(SIZE_RE)].map(m => ({ size: m[1].replace(/\s/g, ''), idx: m.index }));
  const prices = [...text.matchAll(PRICE_RE)].map(m => ({ price: parseFloat(m[1].replace(',', '')), idx: m.index }));

  if (!sizes.length && prices.length) {
    return prices
      .filter(p => p.price >= 20 && p.price <= 700)
      .map(p => ({ size: null, price: p.price }));
  }

  for (const s of sizes) {
    let nearest = null;
    let minDist = Infinity;
    for (const p of prices) {
      if (p.price < 20 || p.price > 700) continue;
      const dist = Math.abs(p.idx - s.idx);
      if (dist < minDist) { minDist = dist; nearest = p; }
    }
    if (nearest) hints.push({ size: s.size.toLowerCase(), price: nearest.price });
  }

  if (!hints.length) {
    for (const p of prices) {
      if (p.price >= 20 && p.price <= 700) hints.push({ size: null, price: p.price });
    }
  }
  return hints;
}

// ── Main ──
(async function main() {
  checkKeys();

  console.log(`\n=== Pricing-scrape test ===`);
  console.log(`Location: ${LOCATION}`);
  console.log(`Provider(s): ${PROVIDER}`);
  console.log(`Facility limit: ${LIMIT}\n`);

  console.log(`→ Finding facilities via Google Places...`);
  const { geo, facilities } = await findFacilities(LOCATION, LIMIT);
  if (!facilities.length) {
    console.log('No facilities found.');
    return;
  }
  console.log(`Found ${facilities.length} facilities near ${geo.formatted}\n`);

  let totals = {
    serp: { queries: 0, results: 0, withPrice: 0, errors: 0 },
    cse: { queries: 0, results: 0, withPrice: 0, errors: 0 },
  };

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    console.log(`\n─────────── [${i + 1}/${facilities.length}] ${f.name} ───────────`);
    console.log(`Address : ${f.address}`);
    console.log(`Website : ${f.website || '(none)'}\n`);

    const queries = buildQueries(f);

    for (const q of queries) {
      console.log(`  Query: "${q}"`);

      // SerpAPI
      if (PROVIDER === 'serp' || PROVIDER === 'both') {
        try {
          const { results, error } = await querySerp(q);
          totals.serp.queries++;
          if (error) {
            totals.serp.errors++;
            console.log(`    [SerpAPI] ERROR: ${error}`);
          } else {
            totals.serp.results += results.length;
            const topThree = results.slice(0, 3);
            for (const r of topThree) {
              const hints = extractPriceHints(`${r.title} ${r.snippet}`);
              if (hints.length) totals.serp.withPrice++;
              console.log(`    [SerpAPI] ${r.link}`);
              console.log(`              "${(r.snippet || '').slice(0, 140).replace(/\n/g, ' ')}"`);
              if (hints.length) console.log(`              → extracted: ${JSON.stringify(hints.slice(0, 4))}`);
            }
            if (!topThree.length) console.log(`    [SerpAPI] (no organic results)`);
          }
        } catch (e) {
          totals.serp.errors++;
          console.log(`    [SerpAPI] EXCEPTION: ${e.message}`);
        }
      }

      // Google CSE
      if (PROVIDER === 'cse' || PROVIDER === 'both') {
        try {
          const { results, error } = await queryCse(q);
          totals.cse.queries++;
          if (error) {
            totals.cse.errors++;
            console.log(`    [CSE]     ERROR: ${error}`);
          } else {
            totals.cse.results += results.length;
            const topThree = results.slice(0, 3);
            for (const r of topThree) {
              const hints = extractPriceHints(`${r.title} ${r.snippet}`);
              if (hints.length) totals.cse.withPrice++;
              console.log(`    [CSE]     ${r.link}`);
              console.log(`              "${(r.snippet || '').slice(0, 140).replace(/\n/g, ' ')}"`);
              if (hints.length) console.log(`              → extracted: ${JSON.stringify(hints.slice(0, 4))}`);
            }
            if (!topThree.length) console.log(`    [CSE]     (no items returned)`);
          }
        } catch (e) {
          totals.cse.errors++;
          console.log(`    [CSE]     EXCEPTION: ${e.message}`);
        }
      }
    }
  }

  console.log(`\n\n=== Summary ===`);
  if (PROVIDER === 'serp' || PROVIDER === 'both') {
    console.log(`SerpAPI    │ queries: ${totals.serp.queries}  results: ${totals.serp.results}  with-price-hint: ${totals.serp.withPrice}  errors: ${totals.serp.errors}`);
  }
  if (PROVIDER === 'cse' || PROVIDER === 'both') {
    console.log(`Google CSE │ queries: ${totals.cse.queries}  results: ${totals.cse.results}  with-price-hint: ${totals.cse.withPrice}  errors: ${totals.cse.errors}`);
  }
  console.log('');
})().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
