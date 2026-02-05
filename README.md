# google-timeline

A web app for visualizing and organizing Google Location Timeline data on an interactive Mapbox GL map. Create trips from your visit history, generate road-following routes between stops, and add custom waypoints.

## Prerequisites

- [Bun](https://bun.sh) runtime
- PostgreSQL with [PostGIS](https://postgis.net/) extension
- [Mapbox](https://mapbox.com) access token

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Create the database

```bash
createdb google_timeline
```

### 3. Initialize the schema

```bash
psql google_timeline < schema.sql
```

This creates the `timeline_entries`, `places`, `trips`, `trip_stops`, and `trip_route_segments` tables, along with indexes and PostGIS extensions.

### 4. Configure environment

Create a `.env` file:

```
DATABASE_URL=postgresql://localhost:5432/google_timeline
MAPBOX_TOKEN=your_mapbox_token
MAP_STYLE=mapbox://styles/mapbox/dark-v11
```

### 5. Import timeline data

Export your Google Timeline data as JSON, then:

```bash
DATABASE_URL=postgresql://localhost:5432/google_timeline node import-timeline.js ./location-history.json
```

### 6. Start the dev server

```bash
bun run dev
```

Opens at [http://localhost:3000](http://localhost:3000).
