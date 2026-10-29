-- Courier provenance (one courier per store; history survives a deliberate switch).
ALTER TABLE courier_submissions ADD COLUMN provider TEXT NOT NULL DEFAULT 'ozon';
ALTER TABLE cities ADD COLUMN provider TEXT NOT NULL DEFAULT 'ozon';
-- Sendit district extras (NULL/0 for Ozon).
ALTER TABLE cities ADD COLUMN arabic_name TEXT;
ALTER TABLE cities ADD COLUMN is_pickup INTEGER NOT NULL DEFAULT 0 CHECK (is_pickup IN (0,1));

CREATE INDEX IF NOT EXISTS idx_submissions_provider_status ON courier_submissions(provider, status);
CREATE INDEX IF NOT EXISTS idx_cities_provider_name ON cities(provider, name);
