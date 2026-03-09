// ============================================================
// REYUS Marina Scraper — Railway Service
// Calls your Vercel /api/populate-marinas endpoint daily,
// rotating through one region per day to stay within
// Google's free API tier.
// ============================================================

// ── CONFIGURATION ──
// Set this as an environment variable in Railway
const API_URL = process.env.POPULATE_API_URL || "https://YOUR-VERCEL-SITE.vercel.app/api/populate-marinas";

// One region per day, rotating through all 8
const REGIONS = [
  "west-med",
  "east-med",
  "adriatic",
  "caribbean",
  "us-east",
  "us-west",
  "northern-europe",
  "arabian-gulf"
];

// ── MAIN ──
async function scanRegion() {
  // Pick today's region based on day of year (rotates every 8 days)
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const regionIndex = dayOfYear % REGIONS.length;
  const region = REGIONS[regionIndex];

  console.log(`[${new Date().toISOString()}] REYUS Marina Scraper`);
  console.log(`Day ${dayOfYear} of year → scanning region: ${region} (index ${regionIndex}/${REGIONS.length})`);
  console.log(`Calling: ${API_URL}`);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ region })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`API returned ${res.status}: ${errorText}`);
      process.exit(1);
    }

    const data = await res.json();
    console.log(`\nResults:`);
    console.log(`  Total marinas found: ${data.total}`);

    if (data.regions) {
      Object.entries(data.regions).forEach(([id, info]) => {
        if (info.error) {
          console.log(`  ${id}: ERROR — ${info.error}`);
        } else {
          console.log(`  ${id}: ${info.found} marinas (${info.name})`);
        }
      });
    }

    console.log(`\nDone. Next scan tomorrow: ${REGIONS[(regionIndex + 1) % REGIONS.length]}`);

  } catch (err) {
    console.error(`Failed to call API: ${err.message}`);
    process.exit(1);
  }
}

// ── RUN ──
// Railway cron jobs run the script once then exit.
// If you're using Railway's always-on service instead of cron,
// uncomment the setInterval block below.

scanRegion();

// ── ALTERNATIVE: Self-scheduling (if not using Railway cron) ──
// Uncomment below if your Railway service runs continuously
// and you want it to self-schedule every 24 hours:
//
// const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
//
// console.log("Marina scraper running in continuous mode.");
// console.log("Will scan one region every 24 hours.\n");
//
// // Run immediately on start
// scanRegion();
//
// // Then every 24 hours
// setInterval(scanRegion, TWENTY_FOUR_HOURS);
