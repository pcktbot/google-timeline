import index from "./index.html";

const db = Bun.sql;

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";
const MAP_STYLE = process.env.MAP_STYLE || "mapbox://styles/mapbox/dark-v11";

// --- Mapbox Directions helper ---
interface RouteSegment {
  geometry?: {
    type: string;
    coordinates: number[][];
  };
  distance: number;
  duration: number;
}

interface MapboxDirectionsResponse {
  code: string;
  routes?: Array<{
    geometry: {
      type: "LineString";
      coordinates: number[][];
    };
    distance: number;
    duration: number;
  }>;
}

async function fetchRouteSegment(
  fromLng: number,
  fromLat: number,
  toLng: number,
  toLat: number,
  profile = "driving"
): Promise<RouteSegment> {
  const coords = `${fromLng},${fromLat};${toLng},${toLat}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json() as MapboxDirectionsResponse;
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`Mapbox Directions failed: ${data.code}`);
  }
  const route = data.routes[0];
  if (!route) {
    throw new Error("No route returned from Mapbox Directions API");
  }
  return {
    geometry: route.geometry as { type: "LineString"; coordinates: number[][] },
    distance: route.distance as number,
    duration: route.duration as number,
  };
}

// --- Helper: load stops with coordinates for a trip ---

async function loadStopsWithCoords(tripId: number) {
  return db`
    SELECT
      ts.id,
      ts.position,
      ts.timeline_entry_id,
      COALESCE(te.place_name, ts.waypoint_name, 'Waypoint') AS name,
      CASE
        WHEN ts.timeline_entry_id IS NOT NULL THEN ST_X(te.location::geometry)
        ELSE ST_X(ts.waypoint_location::geometry)
      END AS lng,
      CASE
        WHEN ts.timeline_entry_id IS NOT NULL THEN ST_Y(te.location::geometry)
        ELSE ST_Y(ts.waypoint_location::geometry)
      END AS lat,
      CASE WHEN ts.timeline_entry_id IS NOT NULL THEN 'timeline_entry' ELSE 'waypoint' END AS type
    FROM trip_stops ts
    LEFT JOIN timeline_entries te ON ts.timeline_entry_id = te.id
    WHERE ts.trip_id = ${tripId}
    ORDER BY ts.position
  `;
}

// --- Helper: build full trip response ---

async function buildTripResponse(tripId: number) {
  const [trip] = await db`SELECT * FROM trips WHERE id = ${tripId}`;
  if (!trip) return null;

  const stops = await loadStopsWithCoords(tripId);

  const segments = await db`
    SELECT
      from_stop_id, to_stop_id,
      ST_AsGeoJSON(route_geometry)::jsonb AS geometry,
      distance_meters, duration_seconds
    FROM trip_route_segments
    WHERE trip_id = ${tripId}
  `;

  const routeFeatures = segments.map((s: any) => ({
    type: "Feature",
    geometry: s.geometry,
    properties: {
      from_stop_id: s.from_stop_id,
      to_stop_id: s.to_stop_id,
      distance_meters: Number(s.distance_meters),
      duration_seconds: Number(s.duration_seconds),
    },
  }));

  return {
    ...trip,
    stops,
    route: { type: "FeatureCollection", features: routeFeatures },
  };
}

Bun.serve({
  port: 3000,
  routes: {
    "/": index,

    // --- Config ---
    "/api/config": {
      GET: () =>
        Response.json({
          mapboxToken: MAPBOX_TOKEN,
          mapStyle: MAP_STYLE,
        }),
    },

    // --- Update timeline entry location ---
    "/api/timeline/:id": {
      PATCH: async (req) => {
        const { id } = req.params;
        const { lng, lat } = await req.json() as { lng: number; lat: number };

        if (lng == null || lat == null) {
          return Response.json({ error: "lng and lat required" }, { status: 400 });
        }

        await db`
          UPDATE timeline_entries
          SET location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
              edited = true
          WHERE id = ${id}
        `;

        return Response.json({ ok: true, id: Number(id), lng, lat });
      },
    },

    // --- Timeline bounds (date range + center) ---
    "/api/timeline/bounds": {
      GET: async () => {
        const [row] = await db`
          SELECT
            TO_CHAR(MIN(start_time), 'YYYY-MM-DD') AS min_date,
            TO_CHAR(MAX(end_time), 'YYYY-MM-DD') AS max_date,
            COUNT(*)::int AS total,
            AVG(ST_Y(location::geometry)) FILTER (WHERE location IS NOT NULL) AS center_lat,
            AVG(ST_X(location::geometry)) FILTER (WHERE location IS NOT NULL) AS center_lng
          FROM timeline_entries
        `;
        return Response.json({
          minDate: row.min_date,
          maxDate: row.max_date,
          total: row.total,
          center: row.center_lat != null
            ? [Number(row.center_lng), Number(row.center_lat)]
            : null,
        });
      },
    },

    // --- Timeline (existing) ---
    "/api/timeline": {
      GET: async (req) => {
        const url = new URL(req.url);
        const start = url.searchParams.get("start");
        const end = url.searchParams.get("end");

        if (!start || !end) {
          return Response.json(
            { error: "start and end query params required (YYYY-MM-DD)" },
            { status: 400 }
          );
        }

        const limit = Math.min(Number(url.searchParams.get("limit")) || 5000, 5000);

        const rows = await db`
          SELECT
            id,
            entry_type,
            jsonb_build_object(
              'type', 'Feature',
              'geometry', CASE
                WHEN entry_type = 'visit' THEN ST_AsGeoJSON(location)::jsonb
                WHEN entry_type = 'activity' THEN ST_AsGeoJSON(route)::jsonb
              END,
              'properties', jsonb_build_object(
                'id', id,
                'type', entry_type,
                'start_time', start_time,
                'end_time', end_time,
                'duration_seconds', duration_seconds,
                'semantic_type', semantic_type,
                'activity_type', activity_type,
                'distance_meters', distance_meters,
                'edited', edited
              )
            ) AS feature
          FROM timeline_entries
          WHERE entry_type = 'visit'
            AND start_time >= ${start}::timestamptz
            AND end_time <= (${end}::date + interval '1 day')
          ORDER BY start_time
          LIMIT ${limit}
        `;

        const features = rows.map((r: { feature: object }) => r.feature);

        return Response.json({
          type: "FeatureCollection",
          features,
        });
      },
    },

    // --- Trip CRUD ---
    "/api/trips": {
      GET: async () => {
        const trips = await db`
          SELECT t.*, COUNT(ts.id)::int AS stop_count
          FROM trips t
          LEFT JOIN trip_stops ts ON ts.trip_id = t.id
          GROUP BY t.id
          ORDER BY t.created_at DESC
        `;
        return Response.json(trips);
      },
      POST: async (req) => {
        const { name, description, color } = await req.json();
        if (!name) {
          return Response.json({ error: "name required" }, { status: 400 });
        }
        const [trip] = await db`
          INSERT INTO trips (name, description, color)
          VALUES (${name}, ${description || null}, ${color || "#e11d48"})
          RETURNING *
        `;
        return Response.json(trip, { status: 201 });
      },
    },

    "/api/trips/:id": {
      GET: async (req) => {
        const id = Number(req.params.id);
        const trip = await buildTripResponse(id);
        if (!trip) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(trip);
      },
      PUT: async (req) => {
        const id = Number(req.params.id);
        const { name, description, color } = await req.json();
        const [trip] = await db`
          UPDATE trips
          SET name = COALESCE(${name ?? null}, name),
              description = COALESCE(${description ?? null}, description),
              color = COALESCE(${color ?? null}, color)
          WHERE id = ${id}
          RETURNING *
        `;
        if (!trip) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(trip);
      },
      DELETE: async (req) => {
        const id = Number(req.params.id);
        await db`DELETE FROM trips WHERE id = ${id}`;
        return Response.json({ ok: true });
      },
    },

    // --- Stop management ---
    "/api/trips/:id/stops": {
      POST: async (req) => {
        const tripId = Number(req.params.id);
        const body = await req.json();

        // Determine position: explicit or append
        let position = body.position;
        if (position == null) {
          const [{ max }] = await db`
            SELECT COALESCE(MAX(position), -1) AS max FROM trip_stops WHERE trip_id = ${tripId}
          `;
          position = max + 1;
        } else {
          // Shift existing stops to make room
          await db`
            UPDATE trip_stops
            SET position = position + 1
            WHERE trip_id = ${tripId} AND position >= ${position}
          `;
        }

        let stop;
        if (body.timeline_entry_id) {
          [stop] = await db`
            INSERT INTO trip_stops (trip_id, position, timeline_entry_id)
            VALUES (${tripId}, ${position}, ${body.timeline_entry_id})
            RETURNING *
          `;
        } else if (body.lat != null && body.lng != null) {
          [stop] = await db`
            INSERT INTO trip_stops (trip_id, position, waypoint_location, waypoint_name)
            VALUES (
              ${tripId}, ${position},
              ST_SetSRID(ST_MakePoint(${body.lng}, ${body.lat}), 4326)::geography,
              ${body.name || null}
            )
            RETURNING *
          `;
        } else {
          return Response.json(
            { error: "Provide timeline_entry_id or lat/lng" },
            { status: 400 }
          );
        }

        // Invalidate adjacent route segments
        await db`
          DELETE FROM trip_route_segments
          WHERE trip_id = ${tripId}
            AND (from_stop_id = ${stop.id} OR to_stop_id = ${stop.id})
        `;
        // Also invalidate segments that span across the new stop's position
        const neighbors = await db`
          SELECT id FROM trip_stops
          WHERE trip_id = ${tripId}
            AND position IN (${position - 1}, ${position + 1})
        `;
        if (neighbors.length === 2) {
          await db`
            DELETE FROM trip_route_segments
            WHERE trip_id = ${tripId}
              AND from_stop_id = ${neighbors[0].id}
              AND to_stop_id = ${neighbors[1].id}
          `;
        }

        return Response.json(stop, { status: 201 });
      },
    },

    "/api/trips/:id/stops/:stopId": {
      DELETE: async (req) => {
        const tripId = Number(req.params.id);
        const stopId = Number(req.params.stopId);

        // Get the stop's position before deleting
        const [stop] = await db`
          SELECT position FROM trip_stops WHERE id = ${stopId} AND trip_id = ${tripId}
        `;
        if (!stop) return Response.json({ error: "Not found" }, { status: 404 });

        // Delete the stop (cascades route segments via FK)
        await db`DELETE FROM trip_stops WHERE id = ${stopId}`;

        // Renumber remaining stops
        await db`
          UPDATE trip_stops
          SET position = position - 1
          WHERE trip_id = ${tripId} AND position > ${stop.position}
        `;

        return Response.json({ ok: true });
      },
    },

    "/api/trips/:id/stops/reorder": {
      PUT: async (req) => {
        const tripId = Number(req.params.id);
        const { order } = await req.json(); // array of stop IDs in desired order

        if (!Array.isArray(order)) {
          return Response.json({ error: "order must be an array of stop IDs" }, { status: 400 });
        }

        // Delete all route segments — they're invalidated by reorder
        await db`DELETE FROM trip_route_segments WHERE trip_id = ${tripId}`;

        // Temporarily set positions to negative values to avoid unique constraint violations
        for (let i = 0; i < order.length; i++) {
          await db`
            UPDATE trip_stops SET position = ${-(i + 1)}
            WHERE id = ${order[i]} AND trip_id = ${tripId}
          `;
        }
        // Now set to correct positive values
        for (let i = 0; i < order.length; i++) {
          await db`
            UPDATE trip_stops SET position = ${i}
            WHERE id = ${order[i]} AND trip_id = ${tripId}
          `;
        }

        return Response.json({ ok: true });
      },
    },

    // --- Route generation ---
    "/api/trips/:id/routes": {
      POST: async (req) => {
        const tripId = Number(req.params.id);
        const url = new URL(req.url);
        const force = url.searchParams.get("force") === "true";

        const stops = await loadStopsWithCoords(tripId);

        if (stops.length < 2) {
          return Response.json(
            { error: "Need at least 2 stops to generate routes" },
            { status: 400 }
          );
        }

        if (force) {
          await db`DELETE FROM trip_route_segments WHERE trip_id = ${tripId}`;
        }

        for (let i = 0; i < stops.length - 1; i++) {
          const from = stops[i];
          const to = stops[i + 1];

          // Check if segment already cached
          if (!force) {
            const [existing] = await db`
              SELECT id FROM trip_route_segments
              WHERE trip_id = ${tripId}
                AND from_stop_id = ${from.id}
                AND to_stop_id = ${to.id}
            `;
            if (existing) continue;
          }

          const route = await fetchRouteSegment(
            Number(from.lng),
            Number(from.lat),
            Number(to.lng),
            Number(to.lat)
          );

          await db`
            INSERT INTO trip_route_segments
              (trip_id, from_stop_id, to_stop_id, route_geometry, distance_meters, duration_seconds)
            VALUES (
              ${tripId},
              ${from.id},
              ${to.id},
              ST_GeomFromGeoJSON(${JSON.stringify(route.geometry)})::geography,
              ${route.distance},
              ${route.duration}
            )
            ON CONFLICT (trip_id, from_stop_id, to_stop_id) DO UPDATE SET
              route_geometry = EXCLUDED.route_geometry,
              distance_meters = EXCLUDED.distance_meters,
              duration_seconds = EXCLUDED.duration_seconds,
              fetched_at = NOW()
          `;
        }

        // Return the updated trip
        const trip = await buildTripResponse(tripId);
        return Response.json(trip);
      },
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log("Server running at http://localhost:3000");
