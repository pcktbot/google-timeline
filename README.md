# google-timeline

> **Human's Note:**
>
> I like Google Timeline for tracking trips and I get a lot of meaning at seeing how I navigated the cities I have lived in via map. But I like working on desktops and Google Maps has removed support for editing timeline data on the web app. The data is not the most accurate in the world but does a good job of finding Google Places nearby 😉.
>
> I like the tech stack I got with only minimal prompting. Bun and Postgres is a current favorite combo. Just got a really performant app. I've learned a lot about backend that helps me desribe UI features. 
>
> Claude Opus 4.5.

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
