#!/usr/bin/env node

const fs = require('fs');
const { Pool } = require('pg');

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function parseGeoString(geoStr) {
  // Parse "geo:44.045063,-121.309156" format
  if (!geoStr) return null;
  const match = geoStr.match(/geo:([-\d.]+),([-\d.]+)/);
  if (!match) return null;
  return {
    lat: parseFloat(match[1]),
    lng: parseFloat(match[2])
  };
}

async function importTimeline(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  console.log(`Importing ${data.length} timeline entries...`);
  
  let visitCount = 0;
  let activityCount = 0;
  let errorCount = 0;
  
  for (const entry of data) {
    try {
      if (entry.visit) {
        await importVisit(entry);
        visitCount++;
      } else if (entry.activity) {
        await importActivity(entry);
        activityCount++;
      }
      
      // Progress indicator
      if ((visitCount + activityCount) % 100 === 0) {
        process.stdout.write(`\rProcessed: ${visitCount + activityCount}`);
      }
    } catch (err) {
      console.error(`\nError processing entry:`, err.message);
      errorCount++;
    }
  }
  
  console.log(`\n\nImport complete!`);
  console.log(`Visits: ${visitCount}`);
  console.log(`Activities: ${activityCount}`);
  console.log(`Errors: ${errorCount}`);
}

async function importVisit(entry) {
  const visit = entry.visit;
  const candidate = visit.topCandidate || {};
  const location = parseGeoString(candidate.placeLocation);
  
  if (!location) {
    throw new Error('No valid location found');
  }
  
  await pool.query(`
    INSERT INTO timeline_entries (
      entry_type,
      start_time,
      end_time,
      location,
      place_id,
      semantic_type,
      visit_probability,
      raw_data
    ) VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7, $8, $9)
  `, [
    'visit',
    entry.startTime,
    entry.endTime,
    location.lng,
    location.lat,
    candidate.placeID,
    candidate.semanticType,
    parseFloat(candidate.probability),
    JSON.stringify(entry)
  ]);
}

async function importActivity(entry) {
  const activity = entry.activity;
  const candidate = activity.topCandidate || {};
  const start = parseGeoString(activity.start);
  const end = parseGeoString(activity.end);
  
  if (!start || !end) {
    throw new Error('No valid start/end locations found');
  }
  
  // Create a simple linestring from start to end
  // Note: This is simplified - actual route might have waypoints
  const routeWKT = `LINESTRING(${start.lng} ${start.lat}, ${end.lng} ${end.lat})`;
  
  await pool.query(`
    INSERT INTO timeline_entries (
      entry_type,
      start_time,
      end_time,
      route,
      activity_type,
      activity_probability,
      distance_meters,
      raw_data
    ) VALUES ($1, $2, $3, ST_GeomFromText($4, 4326)::geography, $5, $6, $7, $8)
  `, [
    'activity',
    entry.startTime,
    entry.endTime,
    routeWKT,
    candidate.type,
    parseFloat(candidate.probability || 0),
    parseFloat(activity.distanceMeters || 0),
    JSON.stringify(entry)
  ]);
}

// Run the import
const filePath = process.argv[2] || './location-history.json';

importTimeline(filePath)
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });