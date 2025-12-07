-- TCGplayer One Piece Sales Database Schema
-- SQLite v1

-- Card table: one row per TCGplayer product
CREATE TABLE IF NOT EXISTS card (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER UNIQUE NOT NULL,  -- TCGplayer product ID
    name TEXT NOT NULL,                   -- Card/product name
    set_name TEXT,                        -- Set name (e.g., "Carrying on His Will")
    rarity TEXT,                          -- R, SR, SEC, L, etc.
    product_type TEXT NOT NULL DEFAULT 'single',  -- 'single' or 'sealed'
    market_price REAL,                    -- Market price at time of scrape
    lowest_listing REAL,                  -- Lowest English Near Mint listing price
    lowest_listing_with_shipping REAL,    -- Including shipping
    listing_count INTEGER DEFAULT 0,      -- Number of English NM listings
    current_quantity INTEGER DEFAULT 0,   -- Total cards available on market
    current_sellers INTEGER DEFAULT 0,    -- Number of unique sellers
    listings_updated_at DATETIME,         -- When listings were last scraped
    listing_verified_at DATETIME,         -- When listings were verified via UI scraping
    in_collection INTEGER DEFAULT 0,      -- 1 if in user's personal collection/watchlist
    tcg_url TEXT NOT NULL,                -- Full TCGplayer URL
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now'))
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_card_product_id ON card(product_id);
CREATE INDEX IF NOT EXISTS idx_card_set_name ON card(set_name);
CREATE INDEX IF NOT EXISTS idx_card_market_price ON card(market_price);
CREATE INDEX IF NOT EXISTS idx_card_product_type ON card(product_type);

-- Sale event table: one row per sale from Latest Sales
CREATE TABLE IF NOT EXISTS sale_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,             -- FK to card.id
    sold_at DATETIME NOT NULL,            -- Timestamp of sale
    price REAL NOT NULL,                  -- Sale price
    condition TEXT,                       -- "Near Mint", "Lightly Played", etc.
    listing_type TEXT,                    -- normal / direct / etc.
    quantity INTEGER DEFAULT 1,           -- Number of copies in that sale
    source_raw TEXT,                      -- JSON string for debugging
    scrape_run_id INTEGER,                -- FK to scrape_run.id
    created_at DATETIME DEFAULT (datetime('now')),
    
    FOREIGN KEY (card_id) REFERENCES card(id) ON DELETE CASCADE,
    FOREIGN KEY (scrape_run_id) REFERENCES scrape_run(id)
);

-- Index for fast lookups and deduplication
CREATE INDEX IF NOT EXISTS idx_sale_card_id ON sale_event(card_id);
CREATE INDEX IF NOT EXISTS idx_sale_sold_at ON sale_event(sold_at);
CREATE INDEX IF NOT EXISTS idx_sale_price ON sale_event(price);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_unique 
    ON sale_event(card_id, sold_at, price, quantity, condition);

-- Scrape run table: for debugging and tracking
CREATE TABLE IF NOT EXISTS scrape_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_type TEXT NOT NULL,               -- 'products' or 'sales'
    mode TEXT,                            -- 'singles', 'sealed', 'all'
    started_at DATETIME DEFAULT (datetime('now')),
    finished_at DATETIME,
    status TEXT DEFAULT 'running',        -- 'running', 'success', 'partial', 'error'
    products_scraped INTEGER DEFAULT 0,
    sales_scraped INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    notes TEXT                            -- Error data or additional info
);

-- Views for common queries

-- Average price by card over last 7 days
CREATE VIEW IF NOT EXISTS v_card_avg_7d AS
SELECT 
    c.id AS card_id,
    c.product_id,
    c.name,
    c.set_name,
    c.market_price,
    COUNT(s.id) AS sales_count_7d,
    ROUND(AVG(s.price), 2) AS avg_price_7d,
    ROUND(MIN(s.price), 2) AS min_price_7d,
    ROUND(MAX(s.price), 2) AS max_price_7d
FROM card c
LEFT JOIN sale_event s ON c.id = s.card_id 
    AND s.sold_at >= datetime('now', '-7 days')
GROUP BY c.id;

-- Average price by card over last 30 days
CREATE VIEW IF NOT EXISTS v_card_avg_30d AS
SELECT 
    c.id AS card_id,
    c.product_id,
    c.name,
    c.set_name,
    c.market_price,
    COUNT(s.id) AS sales_count_30d,
    ROUND(AVG(s.price), 2) AS avg_price_30d,
    ROUND(MIN(s.price), 2) AS min_price_30d,
    ROUND(MAX(s.price), 2) AS max_price_30d
FROM card c
LEFT JOIN sale_event s ON c.id = s.card_id 
    AND s.sold_at >= datetime('now', '-30 days')
GROUP BY c.id;

-- Potential deals: cards where recent avg is below market price
CREATE VIEW IF NOT EXISTS v_potential_deals AS
SELECT 
    c.id AS card_id,
    c.product_id,
    c.name,
    c.set_name,
    c.market_price,
    c.tcg_url,
    v7.avg_price_7d,
    v7.sales_count_7d,
    v30.avg_price_30d,
    v30.sales_count_30d,
    ROUND(c.market_price - v7.avg_price_7d, 2) AS market_vs_7d_diff,
    ROUND((c.market_price - v7.avg_price_7d) / c.market_price * 100, 1) AS market_vs_7d_pct
FROM card c
JOIN v_card_avg_7d v7 ON c.id = v7.card_id
JOIN v_card_avg_30d v30 ON c.id = v30.card_id
WHERE v7.sales_count_7d >= 3  -- At least 3 sales
  AND v7.avg_price_7d < c.market_price * 0.9  -- 10%+ below market
ORDER BY market_vs_7d_pct DESC;

