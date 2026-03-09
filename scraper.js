// ============================================================
// REYUS Marina Scraper — Railway Service
//
// Daily cycle:
//   1. DISCOVER — Query OpenStreetMap Overpass API for marinas
//      in today's region, insert any new ones into Supabase
//   2. ENRICH — Call the AI enrichment endpoint to fill in
//      VHF, berths, LOA, draft, contacts for incomplete marinas
// ============================================================

const ENRICH_URL = process.env.ENRICH_API_URL || "https://YOUR-VERCEL-SITE.vercel.app/api/enrich-marina";
const SB_URL = process.env.SUPABASE_URL || "";
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const MARINAS_PER_RUN = parseInt(process.env.MARINAS_PER_RUN || "10");

const REGIONS = [
  { id: "west-med",        name: "Western Mediterranean",   south: 35, north: 45, west: -6,   east: 16 },
  { id: "east-med",        name: "Eastern Mediterranean",   south: 30, north: 42, west: 16,   east: 37 },
  { id: "adriatic",        name: "Adriatic & Balkans",      south: 39, north: 46, west: 13,   east: 21 },
  { id: "caribbean",       name: "Caribbean",               south: 10, north: 26, west: -87,  east: -59 },
  { id: "us-east",         name: "US East Coast",           south: 25, north: 45, west: -82,  east: -66 },
  { id: "us-west",         name: "US West Coast & Pacific", south: 20, north: 49, west: -160, east: -117 },
  { id: "northern-europe", name: "Northern Europe",         south: 49, north: 62, west: -11,  east: 25 },
  { id: "arabian-gulf",    name: "Arabian Gulf & Red Sea",  south: 12, north: 30, west: 32,   east: 60 }
];

// ── STEP 1: Discover marinas via OpenStreetMap Overpass API ──
async function discoverMarinas(region) {
  console.log(`\n[DISCOVER] Searching OpenStreetMap for marinas in ${region.name}...`);

  // Overpass QL query: find all nodes/ways tagged as marinas in the bounding box
  const query = `
    [out:json][timeout:30];
    (
      node["leisure"="marina"](${region.south},${region.west},${region.north},${region.east});
      way["leisure"="marina"](${region.south},${region.west},${region.north},${region.east});
    );
    out center tags;
  `;

  try {
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query)
    });

    if (!res.ok) {
      console.log(`  Overpass API returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const elements = data.elements || [];
    console.log(`  Found ${elements.length} marinas in OpenStreetMap`);

    // Extract marina data
    const marinas = [];
    for (const el of elements) {
      const tags = el.tags || {};
      const name = tags.name || tags["name:en"] || "";
      if (!name) continue; // Skip unnamed marinas

      const lat = el.lat || (el.center && el.center.lat) || 0;
      const lng = el.lon || (el.center && el.center.lon) || 0;
      if (!lat || !lng) continue;

      marinas.push({
        name: name,
        city: tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || "",
        country: tags["addr:country"] || "",
        region: region.id,
        lat: lat,
        lng: lng,
        phone: tags.phone || tags["contact:phone"] || "",
        email: tags.email || tags["contact:email"] || "",
        website: (tags.website || tags["contact:website"] || "").replace(/^https?:\/\//, "").replace(/\/$/, ""),
        vhf: tags["seamark:calling-in_point:channel"] || tags["vhf"] || "",
        berths: parseInt(tags.capacity) || 0,
        source: "openstreetmap"
      });
    }

    return marinas;
  } catch (e) {
    console.log(`  Overpass API error: ${e.message}`);
    return [];
  }
}

// ── STEP 2: Insert new marinas into Supabase (skip duplicates) ──
async function insertNewMarinas(marinas, region) {
  if (!SB_URL || !SB_KEY) {
    console.log("  Supabase not configured — skipping insert");
    return 0;
  }

  // Get existing marina names in this region
  const existingRes = await fetch(
    `${SB_URL}/rest/v1/marinas_global?region=eq.${region.id}&select=name,lat,lng`,
    { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } }
  );
  const existing = await existingRes.json();
  const existingNames = new Set(existing.map(m => m.name.toLowerCase()));

  // Also check by proximity — skip if within ~500m of an existing marina
  function isNearExisting(lat, lng) {
    return existing.some(e => {
      const dlat = Math.abs(e.lat - lat);
      const dlng = Math.abs(e.lng - lng);
      return dlat < 0.005 && dlng < 0.005; // Roughly 500m
    });
  }

  // Filter to genuinely new marinas
  const newMarinas = marinas.filter(m => {
    const nameLower = m.name.toLowerCase();
    if (existingNames.has(nameLower)) return false;
    // Fuzzy name match — skip if existing name contains this or vice versa
    for (const en of existingNames) {
      if (en.includes(nameLower) || nameLower.includes(en)) return false;
    }
    if (isNearExisting(m.lat, m.lng)) return false;
    return true;
  });

  if (!newMarinas.length) {
    console.log(`  No new marinas to add (all ${marinas.length} already in database)`);
    return 0;
  }

  // Insert
  const records = newMarinas.map(m => ({
    name: m.name,
    city: m.city || "",
    country: m.country || "",
    region: m.region,
    lat: m.lat,
    lng: m.lng,
    phone: m.phone || "",
    email: m.email || "",
    website: m.website || "",
    vhf: m.vhf || "",
    berths: m.berths || 0,
    maxLOA: 0,
    maxDraft: 0,
    notes: "",
    source: "openstreetmap",
    last_updated: new Date().toISOString()
  }));

  const insertRes = await fetch(`${SB_URL}/rest/v1/marinas_global`, {
    method: "POST",
    headers: {
      "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`,
      "Content-Type": "application/json", "Prefer": "return=minimal"
    },
    body: JSON.stringify(records)
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    console.log(`  Supabase insert error: ${err}`);
    return 0;
  }

  console.log(`  Added ${records.length} new marinas to database`);
  return records.length;
}

// ── STEP 3: Enrich incomplete marinas via AI ──
async function enrichMarinas() {
  console.log(`\n[ENRICH] Enriching up to ${MARINAS_PER_RUN} marinas with incomplete data...`);

  try {
    const res = await fetch(ENRICH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch: true, limit: MARINAS_PER_RUN })
    });

    if (!res.ok) {
      console.log(`  Enrich API returned ${res.status}: ${await res.text()}`);
      return;
    }

    const data = await res.json();

    if (data.message) {
      console.log(`  ${data.message}`);
    } else {
      console.log(`  Enriched: ${data.enriched || 0} / ${data.total || 0} marinas`);
      if (data.results) {
        data.results.forEach(function(r) {
          if (r.status === "enriched") {
            console.log(`    + ${r.name} — updated: ${r.fields.join(", ")}`);
          } else if (r.status === "no_new_data") {
            console.log(`    - ${r.name} — no new data found`);
          } else {
            console.log(`    x ${r.name} — ${r.status}: ${r.error || ""}`);
          }
        });
      }
    }
  } catch (e) {
    console.log(`  Enrich error: ${e.message}`);
  }
}

// ── MAIN ──
async function run() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const regionIndex = dayOfYear % REGIONS.length;
  const region = REGIONS[regionIndex];

  console.log(`[${ new Date().toISOString()}] REYUS Marina Daily Update`);
  console.log(`Day ${dayOfYear} — Region: ${region.name} (${region.id})`);

  // Step 1: Discover new marinas from OpenStreetMap
  const discovered = await discoverMarinas(region);
  if (discovered.length > 0) {
    await insertNewMarinas(discovered, region);
  }

  // Step 2: Enrich incomplete marinas (from any region)
  await enrichMarinas();

  console.log(`\nDone. Tomorrow: ${REGIONS[(regionIndex + 1) % REGIONS.length].name}`);
}

run();
