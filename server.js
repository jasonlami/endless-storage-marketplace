require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY || '';

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

    const radius = req.query.radius || 16093; // ~10 miles default
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
        const units = estimateUnits(state, city, facilityName);
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
          units,
          features,
          isOpen: d.opening_hours?.open_now ?? null,
          businessStatus: d.business_status || 'OPERATIONAL',
          estimatedPricing: true,
        };
      } catch (err) {
        return null;
      }
    });

    const facilities = (await Promise.all(detailPromises)).filter(Boolean);
    facilities.sort((a, b) => a.distance - b.distance);

    res.json({ facilities, location: geo });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Proxy Google Place photos (keeps API key server-side) ──
app.get('/api/photo', async (req, res) => {
  try {
    const ref = req.query.ref;
    const w = req.query.w || 400;
    if (!ref || !GOOGLE_API_KEY) return res.status(400).send('Missing params');

    const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${w}&photo_reference=${ref}&key=${GOOGLE_API_KEY}`;
    const photoRes = await fetch(photoUrl, { redirect: 'follow' });

    res.set('Content-Type', photoRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    photoRes.body.pipe(res);
  } catch (err) {
    res.status(500).send('Photo fetch failed');
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
});
