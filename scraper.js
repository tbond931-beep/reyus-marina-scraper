// ============================================================
// REYUS Marina Scraper — Railway Service
// Calls the AI enrichment endpoint daily to fill in missing
// maritime data (VHF, berths, LOA, draft, contacts, notes)
// for marinas in the Supabase database.
// ============================================================

const API_URL = process.env.ENRICH_API_URL || "https://reyus-intel.vercel.app/api/enrich-marina";
const MARINAS_PER_RUN = parseInt(process.env.MARINAS_PER_RUN || "5");

async function run() {
  console.log(`[${new Date().toISOString()}] REYUS Marina Enrichment`);
  console.log(`Enriching up to ${MARINAS_PER_RUN} marinas with incomplete data`);
  console.log(`Calling: ${API_URL}\n`);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch: true, limit: MARINAS_PER_RUN })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`API returned ${res.status}: ${errorText}`);
      process.exit(1);
    }

    const data = await res.json();

    if (data.message) {
      console.log(data.message);
    } else {
      console.log(`Enriched: ${data.enriched} marinas\n`);
      if (data.results) {
        data.results.forEach(function(r) {
          if (r.status === "enriched") {
            console.log(`  ✓ ${r.name} — updated: ${r.fields.join(", ")}`);
          } else if (r.status === "no_new_data") {
            console.log(`  – ${r.name} — no new data found`);
          } else {
            console.log(`  ✗ ${r.name} — ${r.status}: ${r.error || ""}`);
          }
        });
      }
    }

    console.log("\nDone.");
  } catch (err) {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  }
}

run();
