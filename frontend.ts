import mapboxgl from "mapbox-gl";

// ─── Types ───────────────────────────────────────────────────────────

interface Trip {
  id: number;
  name: string;
  description: string | null;
  color: string;
  stop_count: number;
}

interface TripStop {
  id: number;
  position: number;
  timeline_entry_id: number | null;
  name: string;
  lng: number;
  lat: number;
  type: "timeline_entry" | "waypoint";
}

interface TripDetail extends Trip {
  stops: TripStop[];
  route: GeoJSON.FeatureCollection;
}

type Mode = "browse" | "select-stops" | "drop-waypoint";

// ─── Init map ────────────────────────────────────────────────────────

const configRes = await fetch("/api/config");
const config = await configRes.json();
mapboxgl.accessToken = config.mapboxToken;

// Fetch data bounds to get a meaningful initial center
const boundsRes = await fetch("/api/timeline/bounds");
const dataBounds = await boundsRes.json();

const map = new mapboxgl.Map({
  container: "map",
  style: config.mapStyle || "mapbox://styles/mapbox/dark-v11",
  center: dataBounds.center || [-105.64, 36.53],
  zoom: 10,
});

map.addControl(new mapboxgl.NavigationControl(), "bottom-right");
map.addControl(new mapboxgl.GeolocateControl({ trackUserLocation: true }), "bottom-right");
map.addControl(new mapboxgl.ScaleControl(), "bottom-left");

// ─── DOM elements ────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $("status");
const startInput = $("start") as HTMLInputElement;
const endInput = $("end") as HTMLInputElement;
const loadBtn = $("load");
const showAllBtn = $("show-all");

const tripListEl = $("trip-list");
const activeTripEl = $("active-trip");
const newTripForm = $("new-trip-form");
const newTripBtn = $("new-trip-btn");
const tripNameInput = $("trip-name-input") as HTMLInputElement;
const tripColorInput = $("trip-color-input") as HTMLInputElement;
const createTripBtn = $("create-trip-btn");
const cancelTripBtn = $("cancel-trip-btn");
const backToListBtn = $("back-to-list");
const activeTripName = $("active-trip-name");
const activeTripColor = $("active-trip-color");
const selectStopsBtn = $("select-stops-btn");
const dropWaypointBtn = $("drop-waypoint-btn");
const dimMapBtn = $("dim-map-btn");
const generateRouteBtn = $("generate-route-btn");
const deleteTripBtn = $("delete-trip-btn");
const stopListEl = $("stop-list");
const routeStatsEl = $("route-stats");

const waypointPrompt = $("waypoint-prompt");
const waypointNameInput = $("waypoint-name-input") as HTMLInputElement;
const waypointConfirmBtn = $("waypoint-confirm");
const waypointCancelBtn = $("waypoint-cancel");

// ─── State ───────────────────────────────────────────────────────────

let mode: Mode = "browse";
let activeTrip: TripDetail | null = null;
let pendingWaypoint: { lng: number; lat: number } | null = null;
let overlayVisible = false;

// Multi-display: trips toggled visible from the list view
const displayedTrips = new Map<number, TripDetail>();

// ─── Default date range: last 7 days ─────────────────────────────────

const now = new Date();
const weekAgo = new Date(now);
weekAgo.setDate(weekAgo.getDate() - 7);
startInput.value = weekAgo.toISOString().slice(0, 10);
endInput.value = now.toISOString().slice(0, 10);

// ─── Status helpers ──────────────────────────────────────────────────

function showStatus(msg: string) {
  statusEl.textContent = msg;
  statusEl.style.display = "block";
}

function hideStatus() {
  statusEl.style.display = "none";
}

function flashStatus(msg: string, ms = 2000) {
  showStatus(msg);
  setTimeout(hideStatus, ms);
}

// ─── Timeline loading ────────────────────────────────────────────────

async function loadTimeline() {
  const start = startInput.value;
  const end = endInput.value;
  if (!start || !end) return;

  showStatus("Loading...");

  const params = new URLSearchParams({ start, end });
  const res = await fetch(`/api/timeline?${params}`);
  const geojson = await res.json();

  if (map.getSource("timeline")) {
    map.removeLayer("timeline-points");
    map.removeSource("timeline");
  }

  map.addSource("timeline", { type: "geojson", data: geojson });

  map.addLayer({
    id: "timeline-points",
    type: "circle",
    source: "timeline",
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-radius": 6,
      "circle-color": [
        "match", ["get", "semantic_type"],
        "Home", "#ef4444",
        "Work", "#8b5cf6",
        "#f97316",
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
      "circle-opacity": 0.9,
    },
  });

  const bounds = new mapboxgl.LngLatBounds();
  for (const f of geojson.features) {
    if (f.geometry.type === "Point") {
      bounds.extend(f.geometry.coordinates as [number, number]);
    }
  }
  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 60 });
  }

  flashStatus(`${geojson.features.length} features loaded`);
}

// ─── Mode management ─────────────────────────────────────────────────

function setMode(newMode: Mode) {
  mode = newMode;

  selectStopsBtn.classList.remove("active");
  dropWaypointBtn.classList.remove("active");

  if (mode === "select-stops") {
    selectStopsBtn.classList.add("active");
    selectStopsBtn.textContent = "Selecting...";
    map.getCanvas().style.cursor = "crosshair";
  } else {
    selectStopsBtn.textContent = "Select Points";
  }

  if (mode === "drop-waypoint") {
    dropWaypointBtn.classList.add("active");
    dropWaypointBtn.textContent = "Click map...";
    map.getCanvas().style.cursor = "crosshair";
  } else {
    dropWaypointBtn.textContent = "Drop Waypoint";
  }

  if (mode === "browse") {
    map.getCanvas().style.cursor = "";
  }
}

// ─── Overlay (dim map) ──────────────────────────────────────────────

const OVERLAY_SOURCE_DATA: GeoJSON.Feature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]],
  },
  properties: {},
};

function addOverlay() {
  if (map.getLayer("trip-overlay")) return;
  if (!map.getSource("trip-overlay")) {
    map.addSource("trip-overlay", { type: "geojson", data: OVERLAY_SOURCE_DATA });
  }
  // Insert below the first trip layer so route/stops render on top
  const beforeId = ["trip-route", "trip-stops", "trip-stop-labels"]
    .find((id) => !!map.getLayer(id));
  map.addLayer({
    id: "trip-overlay",
    type: "fill",
    source: "trip-overlay",
    paint: {
      "fill-color": "#1f2937",
      "fill-opacity": 0.5,
    },
  }, beforeId);
}

function removeOverlay() {
  if (map.getLayer("trip-overlay")) map.removeLayer("trip-overlay");
  if (map.getSource("trip-overlay")) map.removeSource("trip-overlay");
}

function syncOverlay() {
  if (overlayVisible) addOverlay();
  else removeOverlay();
  // Update button style
  dimMapBtn.classList.toggle("active", overlayVisible);
}

dimMapBtn.addEventListener("click", () => {
  overlayVisible = !overlayVisible;
  syncOverlay();
});

// ─── Multi-display: render/clear a single trip by ID ─────────────────

function displayTripLayerIds(tripId: number) {
  return {
    route: `display-route-${tripId}`,
    stops: `display-stops-${tripId}`,
    labels: `display-labels-${tripId}`,
  };
}

function clearDisplayTrip(tripId: number) {
  const ids = displayTripLayerIds(tripId);
  for (const id of [ids.labels, ids.stops, ids.route]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [ids.route, ids.stops]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

function renderDisplayTrip(trip: TripDetail) {
  clearDisplayTrip(trip.id);
  const ids = displayTripLayerIds(trip.id);
  const color = trip.color;

  if (trip.route.features.length > 0) {
    map.addSource(ids.route, { type: "geojson", data: trip.route });
    map.addLayer({
      id: ids.route,
      type: "line",
      source: ids.route,
      paint: {
        "line-color": color,
        "line-width": 4,
        "line-opacity": 1.0,
      },
    });
  }

  if (trip.stops.length > 0) {
    const stopsGeoJson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: trip.stops.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
        properties: { id: s.id, position: s.position + 1, name: s.name, stopType: s.type },
      })),
    };

    map.addSource(ids.stops, { type: "geojson", data: stopsGeoJson });

    map.addLayer({
      id: ids.stops,
      type: "circle",
      source: ids.stops,
      paint: {
        "circle-radius": 10,
        "circle-color": color,
        "circle-stroke-width": 3,
        "circle-stroke-color": "#fff",
      },
    });

    map.addLayer({
      id: ids.labels,
      type: "symbol",
      source: ids.stops,
      layout: {
        "text-field": ["to-string", ["get", "position"]],
        "text-size": 11,
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#fff" },
    });
  }
}

async function toggleDisplayTrip(tripId: number) {
  if (displayedTrips.has(tripId)) {
    clearDisplayTrip(tripId);
    displayedTrips.delete(tripId);
  } else {
    const res = await fetch(`/api/trips/${tripId}`);
    const trip: TripDetail = await res.json();
    displayedTrips.set(tripId, trip);
    renderDisplayTrip(trip);
  }
}

// ─── Trip list ───────────────────────────────────────────────────────

async function loadTripList() {
  const res = await fetch("/api/trips");
  const trips: Trip[] = await res.json();

  tripListEl.innerHTML = "";
  for (const t of trips) {
    const isVisible = displayedTrips.has(t.id);
    const div = document.createElement("div");
    div.className = "trip-item";
    div.innerHTML = `
      <button class="trip-eye${isVisible ? " visible" : ""}" data-id="${t.id}" title="Show on map">&#9679;</button>
      <div class="trip-color" style="background:${t.color}"></div>
      <span class="trip-name">${t.name}</span>
      <span class="trip-count">${t.stop_count} stops</span>
    `;

    // Eye toggle — stop propagation so it doesn't open the trip
    const eyeBtn = div.querySelector<HTMLButtonElement>(".trip-eye")!;
    eyeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleDisplayTrip(t.id);
      eyeBtn.classList.toggle("visible", displayedTrips.has(t.id));
    });

    // Click the name area to open for editing
    div.querySelector(".trip-name")!.addEventListener("click", () => openTrip(t.id));
    // Click color dot to open too
    div.querySelector(".trip-color")!.addEventListener("click", () => openTrip(t.id));

    tripListEl.appendChild(div);
  }

  if (trips.length === 0) {
    tripListEl.innerHTML = '<p style="color:#9ca3af;padding:8px 0">No trips yet</p>';
  }
}

// ─── Open a trip for editing ─────────────────────────────────────────

async function openTrip(tripId: number) {
  const res = await fetch(`/api/trips/${tripId}`);
  activeTrip = await res.json();
  if (!activeTrip) return;

  // Hide display layers for this trip if shown (edit layers replace them)
  if (displayedTrips.has(tripId)) {
    clearDisplayTrip(tripId);
  }

  tripListEl.style.display = "none";
  newTripForm.style.display = "none";
  newTripBtn.style.display = "none";
  activeTripEl.style.display = "block";

  activeTripName.textContent = activeTrip.name;
  activeTripColor.style.background = activeTrip.color;

  renderStopList();
  renderTripOnMap();
  syncOverlay();
  setMode("browse");
}

// ─── Render stops in panel ───────────────────────────────────────────

function renderStopList() {
  if (!activeTrip) return;
  stopListEl.innerHTML = "";

  for (const stop of activeTrip.stops) {
    const li = document.createElement("li");
    li.className = "stop-item";
    li.innerHTML = `
      <span class="stop-num" style="background:${activeTrip.color}">${stop.position + 1}</span>
      <span class="stop-name">${stop.name}</span>
      <span class="stop-type">${stop.type === "waypoint" ? "wp" : ""}</span>
      <button class="stop-move" data-dir="up" data-id="${stop.id}" title="Move up">&uarr;</button>
      <button class="stop-move" data-dir="down" data-id="${stop.id}" title="Move down">&darr;</button>
      <button class="stop-remove" data-id="${stop.id}" title="Remove">&times;</button>
    `;
    stopListEl.appendChild(li);
  }

  stopListEl.querySelectorAll<HTMLButtonElement>(".stop-move").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const dir = btn.dataset.dir;
      if (!activeTrip) return;
      const order = activeTrip.stops.map((s) => s.id);
      const idx = order.indexOf(Number(btn.dataset.id));
      if (dir === "up" && idx > 0) {
        [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
      } else if (dir === "down" && idx < order.length - 1) {
        [order[idx + 1], order[idx]] = [order[idx], order[idx + 1]];
      } else return;

      await fetch(`/api/trips/${activeTrip.id}/stops/reorder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order }),
      });
      await openTrip(activeTrip.id);
    });
  });

  stopListEl.querySelectorAll<HTMLButtonElement>(".stop-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!activeTrip) return;
      await fetch(`/api/trips/${activeTrip.id}/stops/${btn.dataset.id}`, { method: "DELETE" });
      await openTrip(activeTrip.id);
    });
  });

  if (activeTrip.route.features.length > 0) {
    const totalDist = activeTrip.route.features.reduce(
      (sum: number, f: any) => sum + (f.properties.distance_meters || 0),
      0
    );
    const totalTime = activeTrip.route.features.reduce(
      (sum: number, f: any) => sum + (f.properties.duration_seconds || 0),
      0
    );
    routeStatsEl.innerHTML = `
      <strong>${(totalDist / 1000).toFixed(1)} km</strong> &bull;
      <strong>${Math.round(totalTime / 60)} min</strong> driving &bull;
      ${activeTrip.stops.length} stops &bull;
      ${activeTrip.route.features.length} segments
    `;
    routeStatsEl.style.display = "block";
  } else {
    routeStatsEl.style.display = "none";
  }
}

// ─── Render active trip on map (edit mode) ───────────────────────────

function clearTripLayers() {
  for (const id of ["trip-route", "trip-stops", "trip-stop-labels"]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of ["trip-route", "trip-stops"]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

function renderTripOnMap() {
  clearTripLayers();
  if (!activeTrip) return;

  const color = activeTrip.color;

  // Route segments
  if (activeTrip.route.features.length > 0) {
    map.addSource("trip-route", { type: "geojson", data: activeTrip.route });

    map.addLayer({
      id: "trip-route",
      type: "line",
      source: "trip-route",
      paint: {
        "line-color": color,
        "line-width": 4,
        "line-opacity": 1.0,
      },
    });
  }

  // Stop markers
  if (activeTrip.stops.length > 0) {
    const stopsGeoJson: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: activeTrip.stops.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
        properties: {
          id: s.id,
          position: s.position + 1,
          name: s.name,
          stopType: s.type,
        },
      })),
    };

    map.addSource("trip-stops", { type: "geojson", data: stopsGeoJson });

    map.addLayer({
      id: "trip-stops",
      type: "circle",
      source: "trip-stops",
      paint: {
        "circle-radius": 10,
        "circle-color": color,
        "circle-stroke-width": 3,
        "circle-stroke-color": "#fff",
      },
    });

    map.addLayer({
      id: "trip-stop-labels",
      type: "symbol",
      source: "trip-stops",
      layout: {
        "text-field": ["to-string", ["get", "position"]],
        "text-size": 11,
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#fff" },
    });
  }
}

// ─── Back to trip list ───────────────────────────────────────────────

function closeTrip() {
  const closedId = activeTrip?.id;
  activeTrip = null;
  setMode("browse");
  clearTripLayers();
  removeOverlay();
  activeTripEl.style.display = "none";
  tripListEl.style.display = "block";
  newTripBtn.style.display = "inline-block";

  // Re-render display layers for the trip we just closed if it was toggled visible
  if (closedId && displayedTrips.has(closedId)) {
    renderDisplayTrip(displayedTrips.get(closedId)!);
  }

  loadTripList();
}

// ─── New trip form ───────────────────────────────────────────────────

newTripBtn.addEventListener("click", () => {
  newTripForm.style.display = "block";
  tripNameInput.focus();
});

cancelTripBtn.addEventListener("click", () => {
  newTripForm.style.display = "none";
  tripNameInput.value = "";
});

createTripBtn.addEventListener("click", async () => {
  const name = tripNameInput.value.trim();
  if (!name) return;
  const color = tripColorInput.value;

  const res = await fetch("/api/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, color }),
  });
  const trip = await res.json();

  tripNameInput.value = "";
  newTripForm.style.display = "none";

  await openTrip(trip.id);
  setMode("select-stops");
});

backToListBtn.addEventListener("click", closeTrip);

// ─── Select stops mode ──────────────────────────────────────────────

selectStopsBtn.addEventListener("click", () => {
  if (mode === "select-stops") setMode("browse");
  else setMode("select-stops");
});

// ─── Drop waypoint mode ─────────────────────────────────────────────

dropWaypointBtn.addEventListener("click", () => {
  if (mode === "drop-waypoint") setMode("browse");
  else setMode("drop-waypoint");
});

// ─── Waypoint prompt ─────────────────────────────────────────────────

function showWaypointPrompt(lng: number, lat: number) {
  pendingWaypoint = { lng, lat };
  waypointNameInput.value = "";
  waypointPrompt.style.display = "block";
  waypointNameInput.focus();
}

waypointCancelBtn.addEventListener("click", () => {
  waypointPrompt.style.display = "none";
  pendingWaypoint = null;
});

waypointConfirmBtn.addEventListener("click", async () => {
  if (!activeTrip || !pendingWaypoint) return;

  await fetch(`/api/trips/${activeTrip.id}/stops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: pendingWaypoint.lat,
      lng: pendingWaypoint.lng,
      name: waypointNameInput.value.trim() || null,
    }),
  });

  waypointPrompt.style.display = "none";
  pendingWaypoint = null;
  await openTrip(activeTrip.id);
  flashStatus("Waypoint added");
});

waypointNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") waypointConfirmBtn.click();
  if (e.key === "Escape") waypointCancelBtn.click();
});

// ─── Generate route ──────────────────────────────────────────────────

generateRouteBtn.addEventListener("click", async () => {
  if (!activeTrip) return;
  if (activeTrip.stops.length < 2) {
    flashStatus("Need at least 2 stops");
    return;
  }

  showStatus("Generating route...");
  generateRouteBtn.textContent = "Routing...";
  generateRouteBtn.setAttribute("disabled", "true");

  try {
    const res = await fetch(`/api/trips/${activeTrip.id}/routes`, { method: "POST" });
    if (!res.ok) {
      const err = await res.json();
      flashStatus(`Error: ${err.error}`);
      return;
    }
    activeTrip = await res.json();
    renderStopList();
    renderTripOnMap();
    flashStatus("Route generated");
  } catch (e: any) {
    flashStatus(`Error: ${e.message}`);
  } finally {
    generateRouteBtn.textContent = "Generate Route";
    generateRouteBtn.removeAttribute("disabled");
  }
});

// ─── Delete trip ─────────────────────────────────────────────────────

deleteTripBtn.addEventListener("click", async () => {
  if (!activeTrip) return;
  if (!confirm(`Delete trip "${activeTrip.name}"?`)) return;
  const tripId = activeTrip.id;
  // Clean up display state too
  if (displayedTrips.has(tripId)) {
    clearDisplayTrip(tripId);
    displayedTrips.delete(tripId);
  }
  await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
  closeTrip();
  flashStatus("Trip deleted");
});

// ─── Draggable point marker ──────────────────────────────────────────

let dragMarker: mapboxgl.Marker | null = null;
let dragPopup: mapboxgl.Popup | null = null;
let lastMove: { entryId: number; prevLng: number; prevLat: number; props: any } | null = null;

function clearDragMarker() {
  if (dragMarker) { dragMarker.remove(); dragMarker = null; }
  if (dragPopup) { dragPopup.remove(); dragPopup = null; }
}

function makeDragPopupHTML(props: any, lngLat: { lng: number; lat: number }, showUndo: boolean) {
  return `
    <div class="popup-title">${props.semantic_type || "Visit"}</div>
    <div class="popup-dates">
      ${new Date(props.start_time).toLocaleString()}<br/>
      ${new Date(props.end_time).toLocaleString()}
    </div>
    <div class="popup-coords">${lngLat.lat.toFixed(6)}, ${lngLat.lng.toFixed(6)}</div>
    <div class="popup-hint">Drag marker to relocate</div>
    ${showUndo ? '<button class="popup-undo">Undo move</button>' : ""}
  `;
}

function updateSourcePoint(entryId: number, lng: number, lat: number) {
  const src = map.getSource("timeline") as mapboxgl.GeoJSONSource | undefined;
  if (src) {
    const data = (src as any)._data as GeoJSON.FeatureCollection;
    const feature = data.features.find((f: any) => f.properties.id === entryId);
    if (feature && feature.geometry.type === "Point") {
      (feature.geometry as GeoJSON.Point).coordinates = [lng, lat];
      src.setData(data);
    }
  }
}

function bindUndoButton() {
  const btn = dragPopup?.getElement()?.querySelector(".popup-undo");
  if (!btn || !lastMove) return;
  const move = lastMove;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    showStatus("Undoing move...");

    const res = await fetch(`/api/timeline/${move.entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lng: move.prevLng, lat: move.prevLat }),
    });

    if (res.ok) {
      const pos = { lng: move.prevLng, lat: move.prevLat };
      updateSourcePoint(move.entryId, pos.lng, pos.lat);
      dragMarker?.setLngLat(pos);
      dragPopup?.setLngLat(pos);
      lastMove = null;
      dragPopup?.setHTML(makeDragPopupHTML(move.props, pos, false));
      flashStatus("Move undone");
    } else {
      flashStatus("Failed to undo");
    }
  });
}

function showDragMarker(coords: [number, number], props: any) {
  clearDragMarker();

  const lngLat = { lng: coords[0], lat: coords[1] };
  const entryId = props.id;
  const canUndo = lastMove?.entryId === entryId;

  dragMarker = new mapboxgl.Marker({ draggable: true, color: "#3b82f6" })
    .setLngLat(lngLat)
    .addTo(map);

  dragPopup = new mapboxgl.Popup({ offset: 30, closeOnClick: false })
    .setLngLat(lngLat)
    .setHTML(makeDragPopupHTML(props, lngLat, canUndo))
    .addTo(map);

  if (canUndo) bindUndoButton();

  dragPopup.on("close", clearDragMarker);

  dragMarker.on("drag", () => {
    const pos = dragMarker!.getLngLat();
    dragPopup?.setLngLat(pos);
    const coordsEl = dragPopup?.getElement()?.querySelector(".popup-coords");
    if (coordsEl) coordsEl.textContent = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;
  });

  dragMarker.on("dragend", async () => {
    const pos = dragMarker!.getLngLat();
    const prevLng = lngLat.lng;
    const prevLat = lngLat.lat;
    showStatus("Updating location...");

    const res = await fetch(`/api/timeline/${entryId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lng: pos.lng, lat: pos.lat }),
    });

    if (res.ok) {
      updateSourcePoint(entryId, pos.lng, pos.lat);
      lastMove = { entryId, prevLng, prevLat, props };
      flashStatus("Location updated");
      dragPopup?.setHTML(makeDragPopupHTML(props, pos, true));
      bindUndoButton();
    } else {
      flashStatus("Failed to update location");
    }
  });
}

// ─── Map click handlers ──────────────────────────────────────────────

map.on("click", "timeline-points", async (e) => {
  if (mode === "select-stops" && activeTrip) {
    const props = e.features?.[0]?.properties;
    if (!props?.id) return;

    await fetch(`/api/trips/${activeTrip.id}/stops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeline_entry_id: props.id }),
    });
    await openTrip(activeTrip.id);
    flashStatus(`Stop added: ${props.semantic_type || "Visit"}`);
    return;
  }

  const feature = e.features?.[0];
  if (!feature?.properties) return;
  const coords = (feature.geometry as GeoJSON.Point).coordinates as [number, number];
  showDragMarker(coords, feature.properties);
});

map.on("click", (e) => {
  if (mode !== "drop-waypoint" || !activeTrip) return;

  const features = map.queryRenderedFeatures(e.point, {
    layers: ["timeline-points", "trip-stops"],
  });
  if (features.length > 0) return;

  showWaypointPrompt(e.lngLat.lng, e.lngLat.lat);
});

map.on("click", "trip-stops", (e) => {
  if (mode !== "browse") return;
  const props = e.features?.[0]?.properties;
  if (!props) return;
  new mapboxgl.Popup()
    .setLngLat(e.lngLat)
    .setHTML(
      `<strong>#${props.position} ${props.name}</strong><br/>
       ${props.stopType === "waypoint" ? "Waypoint" : "Timeline stop"}`
    )
    .addTo(map);
});

for (const layer of ["timeline-points", "trip-stops"]) {
  map.on("mouseenter", layer, () => {
    if (mode === "browse") map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layer, () => {
    if (mode === "browse") map.getCanvas().style.cursor = "";
  });
}

// ─── Init ────────────────────────────────────────────────────────────

loadBtn.addEventListener("click", loadTimeline);

showAllBtn.addEventListener("click", async () => {
  if (dataBounds.minDate && dataBounds.maxDate) {
    startInput.value = dataBounds.minDate;
    endInput.value = dataBounds.maxDate;
    await loadTimeline();
  }
});

map.on("load", () => {
  loadTimeline();
  loadTripList();
});
