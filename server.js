require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const pricingCache = new Map();
const PRICING_TTL = 24 * 60 * 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Geocode a query (city, zip, address) to lat/lng ──
async function geocode(query) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.results && data.results.length > 0) {
    const loc = data.results[0].geometry.location;
    const formatted = data.results[0].formatted_address;
    return { lat: loc.lat, lng: loc.lng, formatted };
  }
  return null;
}

// ── Search for storage facilities near a location ──
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter q' });

    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ error: 'Google Places API key not configured. Set GOOGLE_PLACES_API_KEY environment variable.' });
    }

    const geo = await geocode(query);
    if (!geo) return res.json({ facilities: [], location: null });

    const radius = Math.min(Math.max(parseInt(req.query.radius, 10) || 16093, 1000), 50000);

    const cacheKey = `${geo.lat.toFixed(4)},${geo.lng.toFixed(4)}_${radius}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return res.json(cached.data);
    }

    const nearbyUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${geo.lat},${geo.lng}&radius=${radius}&keyword=self+storage&type=storage&key=${GOOGLE_API_KEY}`;
    const nearbyRes = await fetch(nearbyUrl);
    const nearbyData = await nearbyRes.json();

    if (!nearbyData.results || !nearbyData.results.length) {
      return res.json({ facilities: [], location: geo });
    }

    // Fetch details for each facility (batched)
    const detailPromises = nearbyData.results.slice(0, 20).map(async (place) => {
      try {
        const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,photos,geometry,opening_hours,business_status,url&key=${GOOGLE_API_KEY}`;
        const detailRes = await fetch(detailUrl);
        const detailData = await detailRes.json();
        const d = detailData.result || {};

        const lat = d.geometry?.location?.lat || place.geometry?.location?.lat;
        const lng = d.geometry?.location?.lng || place.geometry?.location?.lng;

        // Calculate distance from search center
        const dist = haversine(geo.lat, geo.lng, lat, lng);

        // Build photo URLs (proxied through our server)
        const photos = (d.photos || []).slice(0, 5).map(p =>
          `/api/photo?ref=${encodeURIComponent(p.photo_reference)}&w=600`
        );

        // Parse address components
        const addrParts = (d.formatted_address || '').split(',').map(s => s.trim());
        const street = addrParts[0] || '';
        const city = addrParts[1] || '';
        const stateZip = (addrParts[2] || '').split(' ');
        const state = stateZip[0] || '';
        const zip = stateZip[1] || '';

        const facilityName = d.name || place.name;
        const features = detectFeatures(facilityName, place.types || []);

        return {
          id: place.place_id,
          name: facilityName,
          address: street,
          city,
          state,
          zip,
          lat,
          lng,
          distance: parseFloat(dist.toFixed(1)),
          rating: d.rating || place.rating || 0,
          reviews: d.user_ratings_total || place.user_ratings_total || 0,
          phone: d.formatted_phone_number || '',
          website: d.website || d.url || `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
          mapsUrl: d.url || '',
          photos,
          units: [],            // populated on-demand by /api/pricing — no dummy data
          features,
          isOpen: d.opening_hours?.open_now ?? null,
          businessStatus: d.business_status || 'OPERATIONAL',
          pricingLoaded: false, // frontend flips to true after /api/pricing returns
        };
      } catch (err) {
        return null;
      }
    });

    const facilities = (await Promise.all(detailPromises)).filter(Boolean);
    facilities.sort((a, b) => a.distance - b.distance);

    const result = { facilities, location: geo };
    searchCache.set(cacheKey, { data: result, ts: Date.now() });
    if (searchCache.size > 100) {
      const oldest = searchCache.keys().next().value;
      searchCache.delete(oldest);
    }

    res.json(result);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Proxy Google Place photos (keeps API key server-side) ──
app.get('/api/photo', async (req, res) => {
  try {
    const ref = req.query.ref;
    const w = Math.min(Math.max(parseInt(req.query.w, 10) || 400, 50), 1600);
    if (!ref || !GOOGLE_API_KEY) return res.status(400).send('Missing params');
    if (!/^[A-Za-z0-9_-]+$/.test(ref)) return res.status(400).send('Invalid photo reference');

    const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${w}&photo_reference=${ref}&key=${GOOGLE_API_KEY}`;
    const photoRes = await fetch(photoUrl, { redirect: 'follow' });

    res.set('Content-Type', photoRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    photoRes.body.pipe(res);
  } catch (err) {
    res.status(500).send('Photo fetch failed');
  }
});

// ── Real pricing via SerpAPI (Google's index) ──
// Strict accuracy: only accept prices from sources clearly tied to the specific facility.
const PRICE_RE = /\$\s?(\d{1,3}(?:[.,]\d{2})?)/g;
const SIZE_RE = /(\d{1,2})['′]?\s*[x×]\s*(\d{1,2})['′]?/gi;
// Phrases that mean a $ amount is NOT a unit's monthly rent.
const NON_RENT_PHRASES = /(admin(?:istration)?\s*fee|service\s*fee|application\s*fee|setup\s*fee|deposit|processing\s*fee|lock\s*fee|insurance|protection\s*plan|merchandise|one-?time)/i;
// Promo phrases — when one of these appears within ~30 chars of a price, tag price as promo (likely first-month/teaser, not the perpetual rate).
const PROMO_PHRASES = /(rent\s*from|starting\s*at|as\s*low\s*as|first\s*month|1\s*month\s*free|move-?in\s*special|best\s*price\s*label|web\s*exclusive|online[-\s]?only|limited\s*time|\d+%\s*off)/i;
// Snippet patterns that indicate a web (online) rate vs street (in-store) rate.
const WEB_RATE_PHRASES = /(online[-\s]?only|online\s*price|web\s*exclusive|web\s*rate|online\s*rate)/i;
const STREET_RATE_PHRASES = /(standard\s*price|in-?store\s*price|walk[-\s]?in\s*rate|regular\s*price|in-?store)/i;
// Admin fee detection — captured separately for transparency
const ADMIN_FEE_RE = /\+?\s*(?:one-?time\s*)?\$\s?(\d{1,3})\s*(?:admin(?:istration)?|setup|application|processing)\s*fee/i;

// Hard-reject URL paths that publish non-facility-specific pricing.
const REJECT_PATH_RE = /\/(blog|article|articles|news|resources|guides?|press|how-much|how-to|tips|advice|learn|insights|stories|posts?)\//i;
const REJECT_KEYWORD_RE = /(cheap-storage|cheapest|storage-tips|storage-guide|how-much-does|comparing-storage|moving-tips)/i;

// Known chain operator domains — require facility-specific path to trust
const CHAIN_DOMAINS = new Set([
  'publicstorage.com', 'cubesmart.com', 'extraspace.com', 'extraspacestorage.com',
  'lifestorage.com', 'storquest.com', 'uhaul.com', 'smartstopselfstorage.com',
  'nsastorage.com', 'securespace.com', 'storagewest.com', 'sentinelstorage.com',
  'simplystorage.com', 'storagepost.com', 'metrostorageusa.com'
]);

function getStreetNumber(facility) {
  const m = (facility.address || '').match(/^(\d+)/);
  return m && m[1].length >= 3 ? m[1] : null;
}

// URL-level validation: does this URL belong to a context that could discuss THIS specific facility?
// For chain operators, the source URL's path must START with the facility's own URL path —
// otherwise we'd accept "nearby suggestion" cross-listings where another facility's prices appear.
function isAcceptableSourceUrl(url, facilityHost, facilityParentPath, isSolo) {
  if (!url) return false;
  if (REJECT_PATH_RE.test(url) || REJECT_KEYWORD_RE.test(url)) return false;

  let sourceHost, sourcePath;
  try {
    const parsed = new URL(url);
    sourceHost = parsed.hostname.replace(/^www\./, '');
    sourcePath = parsed.pathname.toLowerCase();
  } catch (_) { return false; }

  if (facilityHost && sourceHost === facilityHost) {
    // Chain: require source path to start with the facility's parent directory
    // (this rejects pages "about" other cities that happen to list our facility as a nearby option).
    if (!isSolo && facilityParentPath && facilityParentPath.length >= 4) {
      if (!sourcePath.startsWith(facilityParentPath)) return false;
    }
    return true;
  }

  // Different chain operator's domain → reject
  if (CHAIN_DOMAINS.has(sourceHost)) return false;

  // Cross-domain aggregators (Yelp, SpareFoot, StorageCafe, RentCafe, SelfStorage.com, etc.) → snippet check gates further
  return true;
}

// True if facility.website looks like a solo operator (no deep path, not a chain domain).
function isSoloOperatorWebsite(website, host) {
  if (!website || !host || CHAIN_DOMAINS.has(host)) return false;
  try {
    const p = new URL(website).pathname;
    return p === '/' || p === '' || p.length < 4;
  } catch (_) { return false; }
}

// Snippet must mention the facility's street number to be trusted, EXCEPT:
//   (a) Solo operator's own domain — URL alone identifies the facility
//   (b) Chain operator URL whose path starts with the facility's parent path — the URL slug is the facility identifier
function shouldTrustSnippet(snippet, streetNum, sourceHost, facilityHost, isSolo, sourcePath, facilityParentPath) {
  if (isSolo && sourceHost === facilityHost) return true;
  if (sourceHost === facilityHost && facilityParentPath && facilityParentPath.length >= 4 && sourcePath && sourcePath.startsWith(facilityParentPath)) {
    return true;
  }
  if (!streetNum || !snippet) return false;
  return snippet.includes(streetNum);
}

// Reject a price if the surrounding window (~25 chars before, 25 after) describes a non-rent fee.
function isRentPrice(scope, priceIdx) {
  const window = scope.substring(Math.max(0, priceIdx - 25), priceIdx + 25);
  return !NON_RENT_PHRASES.test(window);
}

// Classify the rate type and promo status of a price based on the surrounding snippet context.
function classifyPriceContext(scope, priceIdx) {
  const windowText = scope.substring(Math.max(0, priceIdx - 40), priceIdx + 40);
  const isPromo = PROMO_PHRASES.test(windowText);
  let rateType = 'unknown';
  if (WEB_RATE_PHRASES.test(windowText)) rateType = 'web';
  else if (STREET_RATE_PHRASES.test(windowText)) rateType = 'street';
  return { isPromo, rateType };
}

// Pull the admin/setup fee from a snippet if disclosed (e.g. "+ one-time $29 admin fee" → 29).
function extractAdminFee(snippet) {
  if (!snippet) return null;
  const m = snippet.match(ADMIN_FEE_RE);
  return m ? parseInt(m[1], 10) : null;
}

// Extract size+price pairs from snippet.
// When streetNum is present in snippet, scope extraction to a 350-char window after it (anchored mode).
// Otherwise (solo operator's own page), extract from the full snippet.
function extractHints(snippet, url, streetNum) {
  if (!snippet) return [];

  let scope;
  if (streetNum) {
    const idx = snippet.indexOf(streetNum);
    scope = idx === -1 ? snippet : snippet.substring(idx, idx + 350);
  } else {
    scope = snippet;
  }

  const sizes = [...scope.matchAll(SIZE_RE)].map(m => ({
    size: `${m[1]}x${m[2]}`.toLowerCase(),
    idx: m.index,
  }));
  const prices = [...scope.matchAll(PRICE_RE)]
    .map(m => ({ price: parseFloat(m[1].replace(',','')), idx: m.index }))
    .filter(p => p.price >= 15 && p.price <= 900 && isRentPrice(scope, p.idx));

  // Pair every price with the nearest size that appears BEFORE it (within 60 chars).
  // This handles tabular snippets ("8x10, $195, $103. 10x10, $131") where prices follow their size,
  // as well as "5x5 ... $39.50 · $79.00" patterns where multiple prices share one size.
  // Falls back to a closer size that appears AFTER if no preceding size is in range.
  const hints = [];
  for (const p of prices) {
    let chosenSize = null;
    let chosenDist = Infinity;
    // Prefer the most recent preceding size (within 80 chars) — handles tabular layouts and dual-rate "size ... $X online ... $Y in-store" patterns
    for (const s of sizes) {
      if (s.idx > p.idx) continue;
      const dist = p.idx - s.idx;
      if (dist < 80 && dist < chosenDist) { chosenDist = dist; chosenSize = s; }
    }
    // Fallback: closest size that comes after (e.g. "$58 for 5x5 units")
    if (!chosenSize) {
      for (const s of sizes) {
        if (s.idx <= p.idx) continue;
        const dist = s.idx - p.idx;
        if (dist < 30 && dist < chosenDist) { chosenDist = dist; chosenSize = s; }
      }
    }
    if (chosenSize) {
      const ctx = classifyPriceContext(scope, p.idx);
      hints.push({ size: chosenSize.size, price: p.price, ...ctx });
    }
  }

  // URL-size fallback: ONLY when snippet has no size AND the price is not a facility-wide
  // "starting from" minimum (which would be the lowest unit at the facility, not specific to the URL's size).
  if (!hints.length && sizes.length === 0 && prices.length) {
    const startingFromRe = /\b(rent\s*from|starting\s*at|starting\s*from|as\s*low\s*as|from\s*\$|from\s*just)\b/i;
    const hasGenericMin = startingFromRe.test(scope);
    if (!hasGenericMin) {
      const urlSizeMatch = url.match(/(\d{1,2})x(\d{1,2})-storage-units/i);
      if (urlSizeMatch) {
        const size = `${urlSizeMatch[1]}x${urlSizeMatch[2]}`;
        const ctx = classifyPriceContext(scope, prices[0].idx);
        hints.push({ size, price: prices[0].price, ...ctx });
      }
    }
  }
  return hints;
}

async function fetchRealPricing(facility) {
  if (!SERPAPI_KEY) return null;
  const { name, address, website } = facility;

  let facilityHost = null;
  let facilityParentPath = '';
  if (website) {
    try {
      const wUrl = new URL(website);
      facilityHost = wUrl.hostname.replace(/^www\./, '');
      const wPath = wUrl.pathname.toLowerCase();
      // Parent directory of facility-detail file, e.g. "/self-storage-nj-mountainside" from "/self-storage-nj-mountainside/1058.html"
      if (wPath.length > 1) {
        const idx = wPath.lastIndexOf('/');
        facilityParentPath = idx > 0 ? wPath.substring(0, idx) : wPath;
      }
    } catch (_) {}
  }

  const streetNum = getStreetNumber(facility);
  if (!streetNum) return { prices: [], sources: [] };

  const isSolo = isSoloOperatorWebsite(website, facilityHost);
  const streetLine = (address || '').split(',')[0]?.trim();
  const city = (address || '').split(',')[1]?.trim() || '';

  const queries = [];
  if (facilityHost) {
    if (isSolo) {
      // Solo operator: surface their pricing tables directly
      queries.push(`site:${facilityHost} "$" 5x5 10x10 monthly`);
      queries.push(`site:${facilityHost} unit sizing pricing rate`);
    } else if (facilityParentPath && facilityParentPath.length > 4) {
      // Chain with deep facility URL — query the exact facility's URL path for size tables
      const pathScope = `site:${facilityHost}${facilityParentPath}`;
      queries.push(`${pathScope} 5x5 OR 10x10 price`);
      queries.push(`${pathScope} unit size monthly rate`);
    } else {
      // Chain without facility path — anchor by location + size keywords
      queries.push(`site:${facilityHost} ${streetNum} ${city} 5x5 10x10 rate`);
      queries.push(`site:${facilityHost} ${streetNum} unit pricing`);
    }
  }
  // Aggregator-friendly fallback: surfaces SpareFoot/Yelp/StorageCafe listings for the specific facility
  queries.push(`"${name}" "${streetLine}" storage unit rate`);
  queries.push(`${streetLine} ${name} 10x10 storage unit price`);

  const allHints = [];
  const sourcesSet = new Set();
  const adminFees = new Set();
  let quotaExceeded = false;

  for (const q of queries) {
    if (quotaExceeded) break;
    try {
      const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&api_key=${SERPAPI_KEY}&num=10`;
      // 8s timeout per query so a hung SerpAPI doesn't stall the whole pricing fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (data.error) {
        // Detect quota-exhaustion and propagate so the response can flag it
        if (/run out of searches|no searches remaining|monthly searches|out of credits|exceeded.*quota|over.*limit/i.test(data.error)) {
          quotaExceeded = true;
        }
        continue;
      }
      for (const r of (data.organic_results || []).slice(0, 10)) {
        if (!isAcceptableSourceUrl(r.link, facilityHost, facilityParentPath, isSolo)) continue;
        const fullText = `${r.title || ''} ${r.snippet || ''}`;
        let sourceHost, sourcePath;
        try {
          const u = new URL(r.link);
          sourceHost = u.hostname.replace(/^www\./, '');
          sourcePath = u.pathname.toLowerCase();
        } catch (_) { continue; }
        if (!shouldTrustSnippet(fullText, streetNum, sourceHost, facilityHost, isSolo, sourcePath, facilityParentPath)) continue;
        // Anchor extraction on streetNum if it's in the snippet, otherwise full snippet
        const anchorNum = fullText.includes(streetNum) ? streetNum : null;
        const hints = extractHints(fullText, r.link, anchorNum);
        for (const h of hints) {
          allHints.push({ ...h, source: r.link, title: r.title, snippet: r.snippet });
        }
        if (hints.length) sourcesSet.add(r.link);
        const fee = extractAdminFee(fullText);
        if (fee !== null) adminFees.add(fee);
      }
    } catch (e) {
      console.error('SerpAPI fetch error:', e.message);
    }
  }

  if (!allHints.length) return { prices: [], sources: [], adminFee: null, quotaExceeded };

  // Group by size, dedupe identical (price, source) pairs
  const bySize = new Map();
  for (const h of allHints) {
    if (!h.size) continue;
    if (!bySize.has(h.size)) bySize.set(h.size, []);
    const seen = bySize.get(h.size).some(x => x.price === h.price && x.source === h.source);
    if (!seen) bySize.get(h.size).push(h);
  }

  // Build per-size breakdown with promo/rate-type signals
  const breakdown = [];
  for (const [size, list] of bySize) {
    list.sort((a, b) => a.price - b.price);
    const median = list[Math.floor(list.length / 2)].price;
    // Promo if ANY entry tagged as promo (any source confirms it's a promo rate)
    const hasPromo = list.some(p => p.isPromo);
    // If we have both web and street rates, split them; otherwise the lowest is the displayed rate
    const webPrices = list.filter(p => p.rateType === 'web').map(p => p.price);
    const streetPrices = list.filter(p => p.rateType === 'street').map(p => p.price);
    breakdown.push({
      size,
      prices: list.map(p => ({
        price: p.price,
        source: p.source,
        title: p.title,
        snippet: p.snippet,
        isPromo: p.isPromo,
        rateType: p.rateType,
      })),
      min: list[0].price,
      max: list[list.length - 1].price,
      median,
      count: list.length,
      hasPromo,
      webMin: webPrices.length ? Math.min(...webPrices) : null,
      webMax: webPrices.length ? Math.max(...webPrices) : null,
      streetMin: streetPrices.length ? Math.min(...streetPrices) : null,
      streetMax: streetPrices.length ? Math.max(...streetPrices) : null,
    });
  }

  // Sort sizes by area (smallest first)
  breakdown.sort((a, b) => {
    const area = s => s.split('x').reduce((acc, n) => acc * (parseInt(n, 10) || 0), 1);
    return area(a.size) - area(b.size);
  });

  // Use the most common admin fee if multiple were seen
  const adminFee = adminFees.size ? [...adminFees].sort((a, b) => b - a)[0] : null;

  return { prices: breakdown, sources: [...sourcesSet], adminFee, quotaExceeded };
}

app.get('/api/pricing', async (req, res) => {
  try {
    const { name, address, website } = req.query;
    if (!name) return res.status(400).json({ error: 'name required' });

    if (!SERPAPI_KEY) {
      return res.status(503).json({ error: 'SerpAPI not configured', prices: [], adminFee: null, fetchedAt: null });
    }

    const cacheKey = (website || `${name}|${address || ''}`).toLowerCase();
    const cached = pricingCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < PRICING_TTL) {
      const ageMinutes = Math.round((Date.now() - cached.ts) / 60000);
      return res.json({
        ...cached.data,
        cached: true,
        fetchedAt: new Date(cached.ts).toISOString(),
        cacheAgeMinutes: ageMinutes,
      });
    }

    const result = await fetchRealPricing({ name, address, website });
    const payload = result || { prices: [], sources: [], adminFee: null };
    const now = Date.now();
    pricingCache.set(cacheKey, { data: payload, ts: now });
    if (pricingCache.size > 500) {
      const oldest = pricingCache.keys().next().value;
      pricingCache.delete(oldest);
    }

    res.json({
      ...payload,
      cached: false,
      fetchedAt: new Date(now).toISOString(),
      cacheAgeMinutes: 0,
    });
  } catch (err) {
    console.error('Pricing error:', err);
    res.status(500).json({ error: 'Pricing lookup failed', prices: [], adminFee: null, fetchedAt: null });
  }
});

// ── Haversine distance (miles) ──
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Estimate unit pricing by region (deterministic per facility) ──
function estimateUnits(state, city, facilityName) {
  const expensive = ['CA', 'NY', 'NJ', 'MA', 'CT', 'DC', 'HI'];
  const moderate = ['FL', 'TX', 'IL', 'CO', 'WA', 'OR', 'AZ', 'GA', 'VA', 'MD', 'PA'];
  let mult = 1.0;
  if (expensive.includes(state)) mult = 1.4;
  else if (moderate.includes(state)) mult = 1.1;
  else mult = 0.85;

  const v = seedRandom(facilityName || city || 'default');

  return [
    { size: '5x5', price: Math.round(45 * mult * v), estimated: true },
    { size: '5x10', price: Math.round(75 * mult * v), estimated: true },
    { size: '10x10', price: Math.round(130 * mult * v), estimated: true },
    { size: '10x15', price: Math.round(175 * mult * v), estimated: true },
    { size: '10x20', price: Math.round(220 * mult * v), estimated: true },
    { size: '10x30', price: Math.round(300 * mult * v), estimated: true },
  ];
}

// ── Detect features from facility name/types ──
function detectFeatures(name, types) {
  const features = [];
  const lower = name.toLowerCase();
  if (/climate|cool|temperature|ac |a\/c|air.?condition/i.test(lower)) features.push('climate');
  if (/24|hour|access|anytime/i.test(lower)) features.push('24hr');
  if (/drive.?up|drive.?in|vehicle|outdoor/i.test(lower)) features.push('drive_up');
  if (/secur|camera|surveillance|guard|gate/i.test(lower)) features.push('surveillance');
  if (/ground|first.?floor/i.test(lower)) features.push('ground');
  return features;
}

// ── Estimate unit pricing by seed so same facility gets same prices ──
function seedRandom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return (((h & 0x7fffffff) % 1000) / 1000) * 0.2 + 0.9;
}

app.listen(PORT, () => {
  console.log(`Endless Storage Marketplace running on port ${PORT}`);
  if (!GOOGLE_API_KEY) {
    console.warn('⚠️  GOOGLE_PLACES_API_KEY not set — API search will not work.');
    console.warn('   Set it as an environment variable or Replit secret.');
  }
  if (!SERPAPI_KEY) {
    console.warn('⚠️  SERPAPI_KEY not set — /api/pricing will return empty results.');
  }
});
