-- D1 schema for anime search index
-- Run: wrangler d1 execute anime-search-index --file=schema.sql

CREATE TABLE IF NOT EXISTS anime (
  id INTEGER PRIMARY KEY,
  t TEXT,
  rT TEXT,
  nT TEXT,
  y INTEGER,
  s TEXT,
  ty TEXT,
  st TEXT,
  eC INTEGER,
  img TEXT,
  sc REAL,
  uA TEXT,
  g TEXT,     -- JSON string (array of genres)
  stu TEXT,   -- JSON string (array of studios)
  pro TEXT,   -- JSON string (array of producers)
  r TEXT,
  se TEXT,
  pop REAL
);

-- Index for stale lookup (admin/stale endpoint)
CREATE INDEX IF NOT EXISTS idx_anime_updated_at ON anime(uA);