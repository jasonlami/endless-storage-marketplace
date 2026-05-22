require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const searchCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const pricingCache = new Map();
const PRICING_TTL = 24 * 60 * 60 * 1000;

// Data dir for persistent NDJSON logs (clicks, leads). Survives restarts on persistent filesystems.
const DATA_DIR = path.join(__dirname, 'data');
const CLICKS_FILE = path.join(DATA_DIR, 'clicks.ndjson');
const LEADS_FILE = path.join(DATA_DIR, 'leads.ndjson');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

function appendNdjson(file, entry) {
  try { fs.appendFile(file, JSON.stringify(entry) + '\n', () => {}); }
  catch (e) { console.error('Persist error:', file, e.message); }
}

function loadNdjsonTail(file, cap) {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-cap);
    return tail.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (e) {
    console.error('Load error:', file, e.message);
    return [];
  }
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Structured request logging — parseable in Replit's log viewer
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    // Only log API + non-static traffic; skip noisy /api/photo bytes
    if (req.path.startsWith('/api/') && req.path !== '/api/photo') {
      const q = req.query.q || req.query.name || '';
      const qShort = String(q).slice(0, 60);
      console.log(`[req] ${req.method} ${req.path} q="${qShort}" -> ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// In-memory click + lead + partner-lead logs, seeded from disk on startup, appended on every event
const CLICK_LOG_CAP = 5000;
const LEAD_LOG_CAP = 5000;
const PARTNER_LEAD_LOG_CAP = 1000;
const PARTNER_LEADS_FILE = path.join(DATA_DIR, 'partner-leads.ndjson');
const clickLog = loadNdjsonTail(CLICKS_FILE, CLICK_LOG_CAP);
const leadLog = loadNdjsonTail(LEADS_FILE, LEAD_LOG_CAP);
const partnerLeadLog = loadNdjsonTail(PARTNER_LEADS_FILE, PARTNER_LEAD_LOG_CAP);
if (clickLog.length || leadLog.length || partnerLeadLog.length) {
  console.log(`Restored ${clickLog.length} clicks, ${leadLog.length} leads, ${partnerLeadLog.length} partner-leads from disk`);
}

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

// Known chain operator domains — require facility-specific path to trust.
// Anything in this set: a different chain's pages cannot be trusted for THIS facility's data.
const CHAIN_DOMAINS = new Set([
  // Top-10 REITs and major chains
  'publicstorage.com', 'cubesmart.com', 'extraspace.com', 'extraspacestorage.com',
  'lifestorage.com', 'storquest.com', 'uhaul.com',
  // Mid-tier chains
  'smartstopselfstorage.com', 'nsastorage.com', 'securespace.com',
  'storagewest.com', 'sentinelstorage.com', 'simplystorage.com',
  'storagepost.com', 'metrostorageusa.com', 'compassselfstorage.com',
  'safeguardit.com', 'storage-mart.com', 'stufstorage.com', 'stor-n-lock.com',
  'primestorage.com', 'sentinelselfstorage.com', 'storeitall.com',
  'devonselfstorage.com', 'atlasstoragecenters.com', 'easystorage.com',
  // Tech-forward / newer entrants
  'storeitnow.com', 'storagetoday.com', 'spaces.io',
  'goldstoragesolutions.com', 'westsidestorage.com',
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

// ── Click-through tracking — measures marketplace performance ──
app.post('/api/click', (req, res) => {
  try {
    const { facilityId, facilityName, size, destination, kind } = req.body || {};
    if (!facilityId) return res.status(400).json({ error: 'facilityId required' });
    const entry = {
      ts: new Date().toISOString(),
      facilityId: String(facilityId).slice(0, 100),
      facilityName: (facilityName || '').slice(0, 120),
      size: (size || '').slice(0, 12),
      destination: (destination || '').slice(0, 500),
      kind: (kind || 'reserve').slice(0, 24),
      referer: (req.headers.referer || '').slice(0, 200),
      ua: (req.headers['user-agent'] || '').slice(0, 200),
    };
    clickLog.push(entry);
    if (clickLog.length > CLICK_LOG_CAP) clickLog.shift();
    appendNdjson(CLICKS_FILE, entry);
    console.log(`[click] ${entry.kind} fac=${entry.facilityName} size=${entry.size}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Click track error:', err);
    res.status(500).json({ error: 'Click track failed' });
  }
});

app.get('/api/click/recent', (req, res) => {
  res.json({ count: clickLog.length, recent: clickLog.slice(-100).reverse() });
});

// ── Email lead capture ──
// Cheap email validation — full validation belongs in whatever ESP we send to later
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

app.post('/api/lead', (req, res) => {
  try {
    const { email, source, searchQuery, savedFacilities } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });
    const entry = {
      ts: new Date().toISOString(),
      email: email.slice(0, 120).toLowerCase(),
      source: (source || 'swipe_gate').slice(0, 40),
      searchQuery: (searchQuery || '').slice(0, 200),
      savedFacilities: Array.isArray(savedFacilities) ? savedFacilities.slice(0, 25).map(String) : [],
      referer: (req.headers.referer || '').slice(0, 200),
      ua: (req.headers['user-agent'] || '').slice(0, 200),
    };
    leadLog.push(entry);
    if (leadLog.length > LEAD_LOG_CAP) leadLog.shift();
    appendNdjson(LEADS_FILE, entry);
    console.log(`[lead] ${entry.email} src=${entry.source} q="${entry.searchQuery}"`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Lead capture error:', err);
    res.status(500).json({ error: 'Lead capture failed' });
  }
});

app.get('/api/lead/recent', (req, res) => {
  res.json({ count: leadLog.length, recent: leadLog.slice(-50).reverse() });
});

// ── Operator partner-lead capture ──
// Operators claim/inquire about a listing on Endless Storage Marketplace.
app.post('/api/partner-lead', (req, res) => {
  try {
    const { facilityId, facilityName, address, contactName, email, phone, role, unitCount, monthlyMarketingSpend, notes } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });
    if (!facilityName) return res.status(400).json({ error: 'facilityName required' });
    const entry = {
      ts: new Date().toISOString(),
      facilityId: String(facilityId || '').slice(0, 100),
      facilityName: String(facilityName).slice(0, 120),
      address: String(address || '').slice(0, 200),
      contactName: String(contactName || '').slice(0, 80),
      email: email.slice(0, 120).toLowerCase(),
      phone: String(phone || '').slice(0, 30),
      role: String(role || '').slice(0, 40),         // 'owner' | 'manager' | 'corporate' | 'other'
      unitCount: String(unitCount || '').slice(0, 16),
      monthlyMarketingSpend: String(monthlyMarketingSpend || '').slice(0, 16),
      notes: String(notes || '').slice(0, 1000),
      referer: (req.headers.referer || '').slice(0, 200),
      ua: (req.headers['user-agent'] || '').slice(0, 200),
    };
    partnerLeadLog.push(entry);
    if (partnerLeadLog.length > PARTNER_LEAD_LOG_CAP) partnerLeadLog.shift();
    appendNdjson(PARTNER_LEADS_FILE, entry);
    console.log(`[partner] ${entry.email} fac="${entry.facilityName}" role=${entry.role}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Partner lead error:', err);
    res.status(500).json({ error: 'Partner lead capture failed' });
  }
});

app.get('/api/partner-lead/recent', (req, res) => {
  res.json({ count: partnerLeadLog.length, recent: partnerLeadLog.slice(-50).reverse() });
});

// ── Admin dashboard ── (HTTP basic auth via ADMIN_PASSWORD env var) ──
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send('Admin disabled — set ADMIN_PASSWORD env var to enable.');
  }
  const header = req.headers.authorization || '';
  const m = header.match(/^Basic (.+)$/);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString();
      const pw = decoded.split(':')[1] || '';
      if (pw === ADMIN_PASSWORD) return next();
    } catch (_) {}
  }
  res.set('WWW-Authenticate', 'Basic realm="Endless Storage Admin"');
  res.status(401).send('Authentication required');
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.get('/admin', requireAdmin, (req, res) => {
  const days = 7;
  const since = Date.now() - days * 86400000;
  const recentClicks = clickLog.filter(c => new Date(c.ts).getTime() >= since);
  const recentLeads = leadLog.filter(l => new Date(l.ts).getTime() >= since);
  const recentPartnerLeads = partnerLeadLog.filter(l => new Date(l.ts).getTime() >= since);

  const clickByFacility = {};
  for (const c of recentClicks) {
    const key = c.facilityName || c.facilityId || '(unknown)';
    clickByFacility[key] = (clickByFacility[key] || 0) + 1;
  }
  const topFacilities = Object.entries(clickByFacility)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const clickByKind = {};
  for (const c of recentClicks) {
    clickByKind[c.kind || 'reserve'] = (clickByKind[c.kind || 'reserve'] || 0) + 1;
  }

  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>Endless Storage — Admin</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px; color: #1a2e2a; }
  h1 { margin-bottom: 4px; }
  .sub { color: #6b7280; margin-bottom: 24px; font-size: 0.9rem; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: #f0fdf4; border: 1px solid #86efac; border-radius: 10px; padding: 16px; }
  .card .v { font-size: 1.8rem; font-weight: 800; color: #14532d; }
  .card .l { font-size: 0.78rem; color: #166534; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
  h2 { margin-top: 32px; border-bottom: 2px solid #d1fae5; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; margin-top: 12px; }
  th { text-align: left; background: #f9fafb; padding: 8px 10px; border-bottom: 2px solid #e5e7eb; font-weight: 600; }
  td { padding: 6px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  tr:hover td { background: #fafafa; }
  .ts { color: #6b7280; font-size: 0.78rem; white-space: nowrap; }
  .small { font-size: 0.78rem; color: #6b7280; }
  .kind { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 0.72rem; font-weight: 600; background: #dbeafe; color: #1e40af; }
  .kind-reserve, .kind-reserve_modal { background: #dcfce7; color: #14532d; }
  .kind-call { background: #fef3c7; color: #92400e; }
  .kind-unit_pill { background: #f3e8ff; color: #6b21a8; }
  .empty { color: #9ca3af; font-style: italic; padding: 20px; text-align: center; }
</style>
</head><body>
<h1>Endless Storage — Marketplace Admin</h1>
<div class="sub">Last ${days} days of activity. Data persists across restarts (data/*.ndjson). Live counters below.</div>

<div class="cards">
  <div class="card"><div class="v">${recentClicks.length}</div><div class="l">Clicks (${days}d)</div></div>
  <div class="card"><div class="v">${recentLeads.length}</div><div class="l">Consumer leads (${days}d)</div></div>
  <div class="card" style="background:#fff7ed;border-color:#fb923c"><div class="v" style="color:#9a3412">${recentPartnerLeads.length}</div><div class="l" style="color:#9a3412">Operator leads (${days}d)</div></div>
  <div class="card"><div class="v">${clickLog.length}</div><div class="l">Clicks (total)</div></div>
</div>

<h2>Click breakdown by kind</h2>
<table>
  <tr><th>Kind</th><th style="text-align:right">Count</th></tr>
  ${Object.entries(clickByKind).sort((a,b) => b[1] - a[1]).map(([k, v]) =>
    `<tr><td><span class="kind kind-${esc(k)}">${esc(k)}</span></td><td style="text-align:right">${v}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="empty">No clicks yet</td></tr>'}
</table>

<h2>Top facilities by clicks (${days}d)</h2>
<table>
  <tr><th>Facility</th><th style="text-align:right">Clicks</th></tr>
  ${topFacilities.map(([name, count]) =>
    `<tr><td>${esc(name)}</td><td style="text-align:right">${count}</td></tr>`
  ).join('') || '<tr><td colspan="2" class="empty">No clicks yet</td></tr>'}
</table>

<h2>Operator partner leads</h2>
<table>
  <tr><th>When</th><th>Facility</th><th>Email</th><th>Role</th><th>Units</th><th>Spend</th><th>Notes</th></tr>
  ${partnerLeadLog.slice(-30).reverse().map(p => `
    <tr>
      <td class="ts">${esc(p.ts)}</td>
      <td><strong>${esc(p.facilityName)}</strong><div class="small">${esc(p.address)}</div></td>
      <td>${esc(p.email)}${p.phone ? '<div class="small">' + esc(p.phone) + '</div>' : ''}</td>
      <td><span class="kind">${esc(p.role) || '—'}</span></td>
      <td class="small">${esc(p.unitCount) || '—'}</td>
      <td class="small">${esc(p.monthlyMarketingSpend) || '—'}</td>
      <td class="small">${esc((p.notes || '').slice(0, 120))}${(p.notes || '').length > 120 ? '…' : ''}</td>
    </tr>
  `).join('') || '<tr><td colspan="7" class="empty">No operator inquiries yet</td></tr>'}
</table>

<h2>Consumer leads</h2>
<table>
  <tr><th>When</th><th>Email</th><th>Source</th><th>Search</th><th>Saved</th></tr>
  ${leadLog.slice(-30).reverse().map(l => `
    <tr>
      <td class="ts">${esc(l.ts)}</td>
      <td><strong>${esc(l.email)}</strong></td>
      <td><span class="kind">${esc(l.source)}</span></td>
      <td>${esc(l.searchQuery) || '<span class="small">—</span>'}</td>
      <td class="small">${(l.savedFacilities || []).length}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No leads yet</td></tr>'}
</table>

<h2>Recent clicks (last 50)</h2>
<table>
  <tr><th>When</th><th>Facility</th><th>Size</th><th>Kind</th><th>Destination</th></tr>
  ${clickLog.slice(-50).reverse().map(c => `
    <tr>
      <td class="ts">${esc(c.ts)}</td>
      <td>${esc(c.facilityName) || esc(c.facilityId)}</td>
      <td>${esc(c.size)}</td>
      <td><span class="kind kind-${esc(c.kind)}">${esc(c.kind)}</span></td>
      <td class="small">${c.destination ? '<a href="' + esc(c.destination) + '" target="_blank" rel="noopener">' + esc((c.destination || '').slice(0,60)) + '…</a>' : '—'}</td>
    </tr>
  `).join('') || '<tr><td colspan="5" class="empty">No clicks yet</td></tr>'}
</table>

<div class="sub" style="margin-top:40px">
  Endless Storage Marketplace · ${new Date().toISOString()}
</div>
</body></html>`);
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
