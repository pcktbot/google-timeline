-- Timeline Database Schema
-- PostgreSQL with PostGIS

CREATE EXTENSION IF NOT EXISTS postgis;

-- Drop existing tables if recreating
-- DROP TABLE IF EXISTS timeline_entries CASCADE;
-- DROP TABLE IF EXISTS places CASCADE;

-- Main timeline entries table
CREATE TABLE timeline_entries (
    id SERIAL PRIMARY KEY,
    entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN ('visit', 'activity')),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER GENERATED ALWAYS AS 
        (EXTRACT(EPOCH FROM (end_time - start_time))::INTEGER) STORED,
    
    -- Spatial data
    location GEOGRAPHY(POINT, 4326),  -- For visits
    route GEOGRAPHY(LINESTRING, 4326), -- For activities
    
    -- Visit-specific fields
    place_id VARCHAR(100),
    place_name VARCHAR(255),
    semantic_type VARCHAR(50), -- Home, Work, Searched Address, etc.
    visit_probability DECIMAL(5,4),
    
    -- Activity-specific fields
    activity_type VARCHAR(50), -- walking, driving, cycling, unknown
    activity_probability DECIMAL(5,4),
    distance_meters DECIMAL(12,2),
    
    -- Metadata
    raw_data JSONB, -- Store original JSON for reference
    edited BOOLEAN DEFAULT FALSE,
    edit_notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Constraints
    CONSTRAINT valid_visit_data CHECK (
        entry_type != 'visit' OR (location IS NOT NULL AND place_id IS NOT NULL)
    ),
    CONSTRAINT valid_activity_data CHECK (
        entry_type != 'activity' OR (route IS NOT NULL)
    )
);

-- Indexes for common queries
CREATE INDEX idx_timeline_start_time ON timeline_entries(start_time);
CREATE INDEX idx_timeline_end_time ON timeline_entries(end_time);
CREATE INDEX idx_timeline_type ON timeline_entries(entry_type);
CREATE INDEX idx_timeline_semantic_type ON timeline_entries(semantic_type);
CREATE INDEX idx_timeline_activity_type ON timeline_entries(activity_type);
CREATE INDEX idx_timeline_location ON timeline_entries USING GIST(location);
CREATE INDEX idx_timeline_route ON timeline_entries USING GIST(route);
CREATE INDEX idx_timeline_date_range ON timeline_entries(start_time, end_time);
CREATE INDEX idx_timeline_edited ON timeline_entries(edited);

-- Optional: Table for places you visit frequently
CREATE TABLE places (
    id SERIAL PRIMARY KEY,
    place_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255),
    location GEOGRAPHY(POINT, 4326) NOT NULL,
    semantic_type VARCHAR(50),
    visit_count INTEGER DEFAULT 0,
    first_visit TIMESTAMPTZ,
    last_visit TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_places_location ON places USING GIST(location);
CREATE INDEX idx_places_semantic_type ON places(semantic_type);

-- Function to update places table from timeline
CREATE OR REPLACE FUNCTION update_places_from_timeline()
RETURNS void AS $$
BEGIN
    INSERT INTO places (place_id, name, location, semantic_type, visit_count, first_visit, last_visit)
    SELECT 
        place_id,
        place_name,
        location,
        semantic_type,
        COUNT(*) as visit_count,
        MIN(start_time) as first_visit,
        MAX(start_time) as last_visit
    FROM timeline_entries
    WHERE entry_type = 'visit' 
      AND place_id IS NOT NULL
    GROUP BY place_id, place_name, location, semantic_type
    ON CONFLICT (place_id) DO UPDATE SET
        visit_count = EXCLUDED.visit_count,
        last_visit = EXCLUDED.last_visit,
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql;

-- View for easy GeoJSON export
CREATE OR REPLACE VIEW timeline_geojson AS
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
    ) as feature
FROM timeline_entries;

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_timeline_entries_updated_at 
    BEFORE UPDATE ON timeline_entries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_places_updated_at 
    BEFORE UPDATE ON places
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions (adjust as needed)
-- GRANT ALL ON timeline_entries TO your_user;
-- GRANT ALL ON places TO your_user;
-- GRANT USAGE, SELECT ON SEQUENCE timeline_entries_id_seq TO your_user;
-- GRANT USAGE, SELECT ON SEQUENCE places_id_seq TO your_user;

-- ============================================
-- Trip tables
-- ============================================

CREATE TABLE trips (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    color VARCHAR(7) DEFAULT '#e11d48',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER update_trips_updated_at
    BEFORE UPDATE ON trips
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Ordered stops within a trip (either a timeline entry reference or a freeform waypoint)
CREATE TABLE trip_stops (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,

    -- Reference to an existing timeline entry (for visits)
    timeline_entry_id INTEGER REFERENCES timeline_entries(id) ON DELETE SET NULL,

    -- Freeform waypoint (user-dropped point)
    waypoint_location GEOGRAPHY(POINT, 4326),
    waypoint_name VARCHAR(255),

    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Must be one or the other
    CONSTRAINT stop_has_source CHECK (
        (timeline_entry_id IS NOT NULL AND waypoint_location IS NULL)
        OR (timeline_entry_id IS NULL AND waypoint_location IS NOT NULL)
    ),
    CONSTRAINT unique_position_per_trip UNIQUE (trip_id, position)
);

CREATE INDEX idx_trip_stops_trip_id ON trip_stops(trip_id);
CREATE INDEX idx_trip_stops_timeline_entry ON trip_stops(timeline_entry_id);

-- Cached route geometry between consecutive stops (from Mapbox Directions)
CREATE TABLE trip_route_segments (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    from_stop_id INTEGER NOT NULL REFERENCES trip_stops(id) ON DELETE CASCADE,
    to_stop_id INTEGER NOT NULL REFERENCES trip_stops(id) ON DELETE CASCADE,
    route_geometry GEOGRAPHY(LINESTRING, 4326) NOT NULL,
    distance_meters DECIMAL(12, 2),
    duration_seconds DECIMAL(10, 2),
    profile VARCHAR(30) DEFAULT 'driving',
    fetched_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_segment UNIQUE (trip_id, from_stop_id, to_stop_id)
);

CREATE INDEX idx_trip_segments_trip_id ON trip_route_segments(trip_id);
CREATE INDEX idx_trip_segments_geometry ON trip_route_segments USING GIST(route_geometry);