/**
 * PostgreSQL Database Client for User Authentication
 * 
 * Separate from SQLite (which stores card data)
 * PostgreSQL handles: users, sessions, user collections
 */

import pg from 'pg';
const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }
    
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    
    console.log('PostgreSQL pool created');
  }
  return pool;
}

export async function initPostgres(): Promise<void> {
  const client = await getPool().connect();
  
  try {
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create user_collection table (links users to product_ids)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_collection (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1,
        notes TEXT,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, product_id)
      )
    `);
    
    // Create index for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_collection_user_id ON user_collection(user_id)
    `);
    
    // Create user_watchlist table for price alerts
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_watchlist (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        target_price DECIMAL(10, 2),
        alerts_enabled BOOLEAN DEFAULT true,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, product_id)
      )
    `);
    
    // Create index for watchlist lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_watchlist_user_id ON user_watchlist(user_id)
    `);
    
    // ============ Card Data Tables ============
    
    // Create cards table (migrated from SQLite)
    await client.query(`
      CREATE TABLE IF NOT EXISTS cards (
        id SERIAL PRIMARY KEY,
        product_id INTEGER UNIQUE NOT NULL,
        name VARCHAR(500) NOT NULL,
        tcg_url TEXT,
        set_name VARCHAR(255),
        rarity VARCHAR(100),
        number VARCHAR(50),
        product_type VARCHAR(100) DEFAULT 'Singles',
        market_price DECIMAL(10, 2),
        lowest_listing DECIMAL(10, 2),
        in_collection BOOLEAN DEFAULT false,
        collection_qty INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        last_seen_at TIMESTAMP
      )
    `);
    
    // Add last_seen_at column if it doesn't exist (for existing databases)
    await client.query(`
      ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP
    `);
    
    // Create index for card lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cards_product_id ON cards(product_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cards_set_name ON cards(set_name)
    `);
    
    // Create sale_events table (migrated from SQLite)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sale_events (
        id SERIAL PRIMARY KEY,
        card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        sold_at TIMESTAMP NOT NULL,
        condition VARCHAR(50),
        variant VARCHAR(100),
        quantity INTEGER DEFAULT 1,
        price DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(product_id, sold_at, condition, variant, price)
      )
    `);
    
    // Create indexes for sale lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_events_card_id ON sale_events(card_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_events_product_id ON sale_events(product_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sale_events_sold_at ON sale_events(sold_at)
    `);
    
    // Create scrape_runs table for tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS scrape_runs (
        id SERIAL PRIMARY KEY,
        run_type VARCHAR(50) NOT NULL,
        mode VARCHAR(100),
        started_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'running',
        products_scraped INTEGER DEFAULT 0,
        new_sales INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        user_id INTEGER REFERENCES users(id)
      )
    `);
    
    // Create suspicious_listing table for tracking stale/bad API prices
    await client.query(`
      CREATE TABLE IF NOT EXISTS suspicious_listing (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL,
        api_price DECIMAL(10, 2) NOT NULL,
        verified_price DECIMAL(10, 2) NOT NULL,
        last_sale_price DECIMAL(10, 2),
        discount_claimed DECIMAL(5, 2),
        discount_actual DECIMAL(5, 2),
        verified_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create index for suspicious listing lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_suspicious_product_id ON suspicious_listing(product_id)
    `);
    
    // Create daily_market_snapshot table for trend tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_market_snapshot (
        id SERIAL PRIMARY KEY,
        snapshot_date DATE UNIQUE NOT NULL,
        total_market_value DECIMAL(12, 2),
        total_listing_value DECIMAL(12, 2),
        total_sales_value DECIMAL(12, 2),
        sales_count INTEGER DEFAULT 0,
        cards_tracked INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create index for snapshot lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_snapshot_date ON daily_market_snapshot(snapshot_date)
    `);
    
    console.log('PostgreSQL tables initialized (including cards, sales, and market snapshots)');
  } finally {
    client.release();
  }
}

// ============ User Operations ============

export interface User {
  id: number;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserPublic {
  id: number;
  email: string;
  display_name: string | null;
  created_at: Date;
}

export async function createUser(email: string, passwordHash: string, displayName?: string): Promise<User> {
  const result = await getPool().query<User>(
    `INSERT INTO users (email, password_hash, display_name) 
     VALUES ($1, $2, $3) 
     RETURNING *`,
    [email.toLowerCase(), passwordHash, displayName || null]
  );
  return result.rows[0];
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await getPool().query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  return result.rows[0] || null;
}

export async function getUserById(id: number): Promise<User | null> {
  const result = await getPool().query<User>(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

// ============ User Collection Operations ============

export interface UserCollectionItem {
  id: number;
  user_id: number;
  product_id: number;
  quantity: number;
  notes: string | null;
  added_at: Date;
}

export async function addToUserCollection(userId: number, productId: number, quantity: number = 1): Promise<UserCollectionItem> {
  const result = await getPool().query<UserCollectionItem>(
    `INSERT INTO user_collection (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id) 
     DO UPDATE SET quantity = user_collection.quantity + $3
     RETURNING *`,
    [userId, productId, quantity]
  );
  return result.rows[0];
}

export async function removeFromUserCollection(userId: number, productId: number): Promise<boolean> {
  const result = await getPool().query(
    'DELETE FROM user_collection WHERE user_id = $1 AND product_id = $2',
    [userId, productId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setUserCollectionQty(userId: number, productId: number, quantity: number): Promise<boolean> {
  if (quantity <= 0) {
    return removeFromUserCollection(userId, productId);
  }
  
  const result = await getPool().query(
    `INSERT INTO user_collection (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id) 
     DO UPDATE SET quantity = $3
     RETURNING *`,
    [userId, productId, quantity]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getUserCollection(userId: number): Promise<UserCollectionItem[]> {
  const result = await getPool().query<UserCollectionItem>(
    'SELECT * FROM user_collection WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return result.rows;
}

export async function getUserCollectionProductIds(userId: number): Promise<number[]> {
  const result = await getPool().query<{ product_id: number }>(
    'SELECT product_id FROM user_collection WHERE user_id = $1',
    [userId]
  );
  return result.rows.map(r => r.product_id);
}

// ============ User Watchlist Operations ============

export interface UserWatchlistItem {
  id: number;
  user_id: number;
  product_id: number;
  target_price: number | null;
  alerts_enabled: boolean;
  added_at: Date;
}

export async function addToUserWatchlist(
  userId: number, 
  productId: number, 
  targetPrice?: number
): Promise<UserWatchlistItem> {
  const result = await getPool().query<UserWatchlistItem>(
    `INSERT INTO user_watchlist (user_id, product_id, target_price)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id) 
     DO UPDATE SET target_price = COALESCE($3, user_watchlist.target_price)
     RETURNING *`,
    [userId, productId, targetPrice || null]
  );
  return result.rows[0];
}

export async function removeFromUserWatchlist(userId: number, productId: number): Promise<boolean> {
  const result = await getPool().query(
    'DELETE FROM user_watchlist WHERE user_id = $1 AND product_id = $2',
    [userId, productId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateUserWatchlistItem(
  userId: number, 
  productId: number, 
  data: { target_price?: number; alerts_enabled?: boolean }
): Promise<boolean> {
  const updates: string[] = [];
  const values: any[] = [userId, productId];
  let paramIndex = 3;
  
  if (data.target_price !== undefined) {
    updates.push(`target_price = $${paramIndex++}`);
    values.push(data.target_price);
  }
  if (data.alerts_enabled !== undefined) {
    updates.push(`alerts_enabled = $${paramIndex++}`);
    values.push(data.alerts_enabled);
  }
  
  if (updates.length === 0) return false;
  
  const result = await getPool().query(
    `UPDATE user_watchlist SET ${updates.join(', ')} WHERE user_id = $1 AND product_id = $2`,
    values
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getUserWatchlist(userId: number): Promise<UserWatchlistItem[]> {
  const result = await getPool().query<UserWatchlistItem>(
    'SELECT * FROM user_watchlist WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return result.rows;
}

export async function getUserWatchlistProductIds(userId: number): Promise<number[]> {
  const result = await getPool().query<{ product_id: number }>(
    'SELECT product_id FROM user_watchlist WHERE user_id = $1',
    [userId]
  );
  return result.rows.map(r => r.product_id);
}

// ============ Card Operations (PostgreSQL) ============

export interface PgCard {
  id: number;
  product_id: number;
  name: string;
  tcg_url: string | null;
  set_name: string | null;
  rarity: string | null;
  number: string | null;
  product_type: string;
  market_price: number | null;
  lowest_listing: number | null;
  in_collection: boolean;
  collection_qty: number;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date | null;
  // Joined fields
  last_sale_price?: number;
  last_sale_date?: Date;
  last_sale_condition?: string;
}

export async function pgSaveCard(card: {
  product_id: number;
  name: string;
  tcg_url?: string;
  set_name?: string;
  rarity?: string;
  number?: string;
  product_type?: string;
  market_price?: number;
  lowest_listing?: number;
}): Promise<PgCard> {
  const result = await getPool().query<PgCard>(
    `INSERT INTO cards (product_id, name, tcg_url, set_name, rarity, number, product_type, market_price, lowest_listing, updated_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     ON CONFLICT (product_id) 
     DO UPDATE SET 
       name = COALESCE(NULLIF($2, ''), cards.name),
       tcg_url = COALESCE($3, cards.tcg_url),
       set_name = COALESCE($4, cards.set_name),
       rarity = COALESCE($5, cards.rarity),
       number = COALESCE($6, cards.number),
       product_type = COALESCE($7, cards.product_type),
       market_price = COALESCE($8, cards.market_price),
       lowest_listing = COALESCE($9, cards.lowest_listing),
       updated_at = NOW(),
       last_seen_at = NOW()
     RETURNING *`,
    [
      card.product_id,
      card.name,
      card.tcg_url || null,
      card.set_name || null,
      card.rarity || null,
      card.number || null,
      card.product_type || 'Singles',
      card.market_price || null,
      card.lowest_listing || null,
    ]
  );
  return result.rows[0];
}

export async function pgGetAllCards(): Promise<PgCard[]> {
  const result = await getPool().query<PgCard>(`
    SELECT c.*,
      (SELECT price FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_price,
      (SELECT sold_at FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_date,
      (SELECT condition FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_condition
    FROM cards c
    ORDER BY c.market_price DESC NULLS LAST
  `);
  // Convert string numbers to actual numbers (PostgreSQL returns DECIMAL as strings)
  return result.rows.map(row => ({
    ...row,
    market_price: row.market_price ? parseFloat(String(row.market_price)) : null,
    lowest_listing: row.lowest_listing ? parseFloat(String(row.lowest_listing)) : null,
    last_sale_price: row.last_sale_price ? parseFloat(String(row.last_sale_price)) : null,
  }));
}

export async function pgGetCardByProductId(productId: number): Promise<PgCard | null> {
  const result = await getPool().query<PgCard>(`
    SELECT c.*,
      (SELECT price FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_price,
      (SELECT sold_at FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_date,
      (SELECT condition FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_condition
    FROM cards c
    WHERE c.product_id = $1
  `, [productId]);
  const row = result.rows[0];
  if (!row) return null;
  // Convert string numbers to actual numbers
  return {
    ...row,
    market_price: row.market_price ? parseFloat(String(row.market_price)) : null,
    lowest_listing: row.lowest_listing ? parseFloat(String(row.lowest_listing)) : null,
    last_sale_price: row.last_sale_price ? parseFloat(String(row.last_sale_price)) : null,
  };
}

export async function pgCountCards(): Promise<number> {
  const result = await getPool().query<{ count: string }>('SELECT COUNT(*) FROM cards');
  return parseInt(result.rows[0].count, 10);
}

export async function pgUpdateCardPrice(productId: number, marketPrice?: number, lowestListing?: number, updateLastSeen: boolean = false): Promise<void> {
  if (updateLastSeen) {
    await getPool().query(
      `UPDATE cards SET 
        market_price = COALESCE($2, market_price),
        lowest_listing = COALESCE($3, lowest_listing),
        updated_at = NOW(),
        last_seen_at = NOW()
       WHERE product_id = $1`,
      [productId, marketPrice || null, lowestListing || null]
    );
  } else {
    await getPool().query(
      `UPDATE cards SET 
        market_price = COALESCE($2, market_price),
        lowest_listing = COALESCE($3, lowest_listing),
        updated_at = NOW()
       WHERE product_id = $1`,
      [productId, marketPrice || null, lowestListing || null]
    );
  }
}

export async function pgUpdateCardListings(
  productId: number,
  lowestListing?: number | null,
  lowestWithShipping?: number | null,
  listingCount?: number,
  currentQuantity?: number
): Promise<void> {
  // If lowestListing is explicitly null, set it to NULL (to clear bad listings)
  // If lowestListing is undefined, keep the existing value
  if (lowestListing === null) {
    await getPool().query(
      `UPDATE cards SET lowest_listing = NULL, updated_at = NOW() WHERE product_id = $1`,
      [productId]
    );
  } else if (lowestListing !== undefined) {
    await getPool().query(
      `UPDATE cards SET lowest_listing = $2, updated_at = NOW() WHERE product_id = $1`,
      [productId, lowestListing]
    );
  }
  // Note: lowestWithShipping, listingCount, currentQuantity not stored in PostgreSQL schema yet
  // Add columns if needed: ALTER TABLE cards ADD COLUMN lowest_with_shipping DECIMAL(10, 2);
}

// ============ Sale Events Operations (PostgreSQL) ============

export interface PgSaleEvent {
  id: number;
  card_id: number;
  product_id: number;
  sold_at: Date;
  condition: string | null;
  variant: string | null;
  quantity: number;
  price: number;
  created_at: Date;
}

export async function pgSaveSaleEvent(sale: {
  product_id: number;
  sold_at: Date | string;
  condition?: string;
  variant?: string;
  quantity?: number;
  price: number;
}): Promise<PgSaleEvent | null> {
  // First get the card_id
  const cardResult = await getPool().query<{ id: number }>(
    'SELECT id FROM cards WHERE product_id = $1',
    [sale.product_id]
  );
  
  if (cardResult.rows.length === 0) {
    console.warn(`Card not found for product_id ${sale.product_id}`);
    return null;
  }
  
  const cardId = cardResult.rows[0].id;
  const soldAt = typeof sale.sold_at === 'string' ? new Date(sale.sold_at) : sale.sold_at;
  
  try {
    // Use date-only for deduplication - TCGplayer API has timezone bugs that shift times by ~5 hours
    const result = await getPool().query<PgSaleEvent>(
      `INSERT INTO sale_events (card_id, product_id, sold_at, condition, variant, quantity, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (product_id, (sold_at::date), condition, COALESCE(variant, ''), price) DO NOTHING
       RETURNING *`,
      [
        cardId,
        sale.product_id,
        soldAt,
        sale.condition || null,
        sale.variant || null,
        sale.quantity || 1,
        sale.price,
      ]
    );
    return result.rows[0] || null;
  } catch (error) {
    // Ignore duplicate errors
    return null;
  }
}

/**
 * Batch insert multiple sales at once - much faster than individual inserts!
 * Returns number of new sales inserted (ignores duplicates)
 */
export async function pgSaveSaleEventsBatch(
  productId: number,
  sales: Array<{
    sold_at: Date | string;
    condition?: string;
    variant?: string;
    quantity?: number;
    price: number;
  }>
): Promise<number> {
  if (sales.length === 0) return 0;
  
  // Get card_id once
  const cardResult = await getPool().query<{ id: number }>(
    'SELECT id FROM cards WHERE product_id = $1',
    [productId]
  );
  
  if (cardResult.rows.length === 0) {
    console.warn(`Card not found for product_id ${productId}`);
    return 0;
  }
  
  const cardId = cardResult.rows[0].id;
  
  // Build batch insert query
  const values: any[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;
  
  for (const sale of sales) {
    const soldAt = typeof sale.sold_at === 'string' ? new Date(sale.sold_at) : sale.sold_at;
    values.push(
      cardId,
      productId,
      soldAt,
      sale.condition || null,
      sale.variant || null,
      sale.quantity || 1,
      sale.price
    );
    placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`);
    paramIndex += 7;
  }
  
  try {
    const result = await getPool().query(
      `INSERT INTO sale_events (card_id, product_id, sold_at, condition, variant, quantity, price)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (product_id, (sold_at::date), condition, COALESCE(variant, ''), price) DO NOTHING`,
      values
    );
    return result.rowCount || 0;
  } catch (error) {
    console.error('Batch insert error:', error);
    return 0;
  }
}

export async function pgGetSalesForProduct(productId: number): Promise<PgSaleEvent[]> {
  const result = await getPool().query<PgSaleEvent>(
    'SELECT * FROM sale_events WHERE product_id = $1 ORDER BY sold_at DESC',
    [productId]
  );
  return result.rows;
}

export async function pgCountSales(): Promise<number> {
  const result = await getPool().query<{ count: string }>('SELECT COUNT(*) FROM sale_events');
  return parseInt(result.rows[0].count, 10);
}

export async function pgGetRecentSales(limit: number = 100): Promise<PgSaleEvent[]> {
  const result = await getPool().query<PgSaleEvent>(
    'SELECT * FROM sale_events ORDER BY sold_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

// ============ Scrape Run Operations ============

export interface PgScrapeRun {
  id: number;
  run_type: string;
  mode: string | null;
  started_at: Date;
  completed_at: Date | null;
  status: string;
  products_scraped: number;
  new_sales: number;
  errors: number;
  user_id: number | null;
}

export async function pgStartScrapeRun(runType: string, mode?: string): Promise<number> {
  const result = await getPool().query<{ id: number }>(
    `INSERT INTO scrape_runs (run_type, mode, started_at, status)
     VALUES ($1, $2, NOW(), 'running')
     RETURNING id`,
    [runType, mode || null]
  );
  return result.rows[0].id;
}

export async function pgCompleteScrapeRun(
  runId: number, 
  stats: { products_scraped?: number; new_sales?: number; errors?: number; status?: string }
): Promise<void> {
  await getPool().query(
    `UPDATE scrape_runs SET 
      completed_at = NOW(),
      status = $2,
      products_scraped = $3,
      new_sales = $4,
      errors = $5
     WHERE id = $1`,
    [
      runId,
      stats.status || 'completed',
      stats.products_scraped || 0,
      stats.new_sales || 0,
      stats.errors || 0,
    ]
  );
}

export async function pgGetRecentRuns(limit: number = 10): Promise<PgScrapeRun[]> {
  const result = await getPool().query<PgScrapeRun>(
    'SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT $1',
    [limit]
  );
  return result.rows;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ============ Suspicious Listing Operations (for deal verification) ============

export interface PgSuspiciousListing {
  id: number;
  product_id: number;
  api_price: number;
  verified_price: number;
  last_sale_price: number | null;
  discount_claimed: number | null;
  discount_actual: number | null;
  verified_at: Date;
}

/**
 * Record a suspicious listing (when API data doesn't match UI-verified data)
 */
export async function pgRecordSuspiciousListing(
  productId: number,
  apiPrice: number,
  verifiedPrice: number,
  lastSalePrice: number | null,
  discountClaimed: number,
  discountActual: number
): Promise<void> {
  await getPool().query(
    `INSERT INTO suspicious_listing 
      (product_id, api_price, verified_price, last_sale_price, discount_claimed, discount_actual)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [productId, apiPrice, verifiedPrice, lastSalePrice, discountClaimed, discountActual]
  );
}

/**
 * Check if a price matches a known suspicious pattern for this product
 */
export async function pgIsSuspiciousPrice(productId: number, price: number): Promise<boolean> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) as count FROM suspicious_listing
     WHERE product_id = $1
       AND ABS(api_price - $2) < 0.01`,
    [productId, price]
  );
  return parseInt(result.rows[0].count, 10) > 0;
}

/**
 * Get the cached verified price for a known-bad API price
 * Returns the verified_price if this exact API price was already flagged as stale
 */
export async function pgGetCachedVerifiedPrice(productId: number, apiPrice: number): Promise<number | null> {
  const result = await getPool().query<{ verified_price: string }>(
    `SELECT verified_price FROM suspicious_listing
     WHERE product_id = $1
       AND ABS(api_price - $2) < 0.01
     ORDER BY verified_at DESC
     LIMIT 1`,
    [productId, apiPrice]
  );
  return result.rows[0] ? parseFloat(result.rows[0].verified_price) : null;
}

/**
 * Get all suspicious listings (optionally for a specific product)
 */
export async function pgGetSuspiciousListings(productId?: number): Promise<PgSuspiciousListing[]> {
  if (productId) {
    const result = await getPool().query<PgSuspiciousListing>(
      `SELECT * FROM suspicious_listing WHERE product_id = $1 ORDER BY verified_at DESC`,
      [productId]
    );
    return result.rows;
  }
  const result = await getPool().query<PgSuspiciousListing>(
    `SELECT * FROM suspicious_listing ORDER BY verified_at DESC LIMIT 100`
  );
  return result.rows;
}

/**
 * Get count of products with suspicious listings
 */
export async function pgGetSuspiciousCount(): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(DISTINCT product_id) as count FROM suspicious_listing`
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Get potential deals (cards where lowest listing is below market price)
 * Excludes cards with known suspicious prices
 */
export async function pgGetPotentialDeals(minDiscountPct: number = 10): Promise<Array<{
  product_id: number;
  name: string;
  tcg_url: string;
  product_type: string;
  lowest_listing: number;
  market_price: number;
  discount_pct: number;
}>> {
  const factor = (100 - minDiscountPct) / 100;
  const result = await getPool().query(`
    SELECT 
      c.product_id,
      c.name,
      c.tcg_url,
      c.product_type,
      c.lowest_listing,
      c.market_price,
      ROUND(((c.market_price - c.lowest_listing) / c.market_price * 100)::numeric, 1) as discount_pct
    FROM cards c
    WHERE c.lowest_listing IS NOT NULL 
      AND c.market_price IS NOT NULL
      AND c.market_price > 0
      AND c.lowest_listing < c.market_price * $1
      AND NOT EXISTS (
        SELECT 1 FROM suspicious_listing sl 
        WHERE sl.product_id = c.product_id
          AND ABS(sl.api_price - c.lowest_listing) < 0.01
      )
    ORDER BY discount_pct DESC
  `, [factor]);
  
  return result.rows.map(row => ({
    ...row,
    lowest_listing: parseFloat(row.lowest_listing),
    market_price: parseFloat(row.market_price),
    discount_pct: parseFloat(row.discount_pct),
  }));
}

/**
 * Clear suspicious listings for specific products (after re-verification)
 */
export async function pgClearSuspiciousListings(productIds: number[]): Promise<void> {
  if (productIds.length === 0) return;
  await getPool().query(
    `DELETE FROM suspicious_listing WHERE product_id = ANY($1)`,
    [productIds]
  );
}

// ============ Market Trend Functions ============

export interface DailySalesAggregate {
  date: string;
  total_value: number;
  sales_count: number;
}

export interface MarketSnapshot {
  snapshot_date: string;
  total_market_value: number;
  total_listing_value: number;
  total_sales_value: number;
  sales_count: number;
  cards_tracked: number;
}

/**
 * Get daily sales totals for a date range (from sale_events)
 */
export async function pgGetDailySalesAggregates(days: number = 30): Promise<DailySalesAggregate[]> {
  const result = await getPool().query<{
    date: Date;
    total_value: string;
    sales_count: string;
  }>(`
    SELECT 
      sold_at::date as date,
      SUM(price * quantity) as total_value,
      COUNT(*) as sales_count
    FROM sale_events
    WHERE sold_at >= NOW() - INTERVAL '${days} days'
    GROUP BY sold_at::date
    ORDER BY date ASC
  `);
  
  return result.rows.map(row => ({
    date: row.date.toISOString().split('T')[0],
    total_value: parseFloat(row.total_value) || 0,
    sales_count: parseInt(row.sales_count, 10),
  }));
}

/**
 * Save a daily market snapshot (run once per day, e.g., after sales scrape)
 */
export async function pgSaveMarketSnapshot(): Promise<MarketSnapshot> {
  // Calculate current totals
  const totals = await getPool().query<{
    total_market_value: string;
    total_listing_value: string;
    cards_tracked: string;
  }>(`
    SELECT 
      COALESCE(SUM(market_price), 0) as total_market_value,
      COALESCE(SUM(lowest_listing), 0) as total_listing_value,
      COUNT(*) as cards_tracked
    FROM cards
    WHERE market_price IS NOT NULL
  `);
  
  // Get today's sales total
  const salesToday = await getPool().query<{
    total_value: string;
    sales_count: string;
  }>(`
    SELECT 
      COALESCE(SUM(price * quantity), 0) as total_value,
      COUNT(*) as sales_count
    FROM sale_events
    WHERE sold_at::date = CURRENT_DATE
  `);
  
  const snapshot = {
    total_market_value: parseFloat(totals.rows[0].total_market_value) || 0,
    total_listing_value: parseFloat(totals.rows[0].total_listing_value) || 0,
    total_sales_value: parseFloat(salesToday.rows[0].total_value) || 0,
    sales_count: parseInt(salesToday.rows[0].sales_count, 10),
    cards_tracked: parseInt(totals.rows[0].cards_tracked, 10),
  };
  
  // Upsert snapshot for today
  await getPool().query(`
    INSERT INTO daily_market_snapshot 
      (snapshot_date, total_market_value, total_listing_value, total_sales_value, sales_count, cards_tracked)
    VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)
    ON CONFLICT (snapshot_date) DO UPDATE SET
      total_market_value = $1,
      total_listing_value = $2,
      total_sales_value = $3,
      sales_count = $4,
      cards_tracked = $5
  `, [
    snapshot.total_market_value,
    snapshot.total_listing_value,
    snapshot.total_sales_value,
    snapshot.sales_count,
    snapshot.cards_tracked,
  ]);
  
  return {
    snapshot_date: new Date().toISOString().split('T')[0],
    ...snapshot,
  };
}

/**
 * Get market snapshots for trend charts
 */
export async function pgGetMarketSnapshots(days: number = 30): Promise<MarketSnapshot[]> {
  const result = await getPool().query<{
    snapshot_date: Date;
    total_market_value: string;
    total_listing_value: string;
    total_sales_value: string;
    sales_count: string;
    cards_tracked: string;
  }>(`
    SELECT * FROM daily_market_snapshot
    WHERE snapshot_date >= NOW() - INTERVAL '${days} days'
    ORDER BY snapshot_date ASC
  `);
  
  return result.rows.map(row => ({
    snapshot_date: row.snapshot_date.toISOString().split('T')[0],
    total_market_value: parseFloat(row.total_market_value) || 0,
    total_listing_value: parseFloat(row.total_listing_value) || 0,
    total_sales_value: parseFloat(row.total_sales_value) || 0,
    sales_count: parseInt(row.sales_count, 10),
    cards_tracked: parseInt(row.cards_tracked, 10),
  }));
}

/**
 * Backfill market snapshots from historical sales data
 * Useful for creating trend data from existing sales history
 */
export async function pgBackfillSalesSnapshots(days: number = 30): Promise<number> {
  // Get daily sales aggregates
  const result = await getPool().query(`
    INSERT INTO daily_market_snapshot (snapshot_date, total_sales_value, sales_count, cards_tracked)
    SELECT 
      sold_at::date as snapshot_date,
      SUM(price * quantity) as total_sales_value,
      COUNT(*) as sales_count,
      (SELECT COUNT(*) FROM cards) as cards_tracked
    FROM sale_events
    WHERE sold_at >= NOW() - INTERVAL '${days} days'
    GROUP BY sold_at::date
    ON CONFLICT (snapshot_date) DO UPDATE SET
      total_sales_value = EXCLUDED.total_sales_value,
      sales_count = EXCLUDED.sales_count
    RETURNING *
  `);
  
  return result.rowCount || 0;
}

// ============ Stale Card Management ============

/**
 * Get cards that weren't seen in the last discover-by-price run
 * These are cards that may have dropped below the price threshold
 */
export async function pgGetStaleCards(daysSinceLastSeen: number = 7): Promise<PgCard[]> {
  const result = await getPool().query<PgCard>(`
    SELECT * FROM cards 
    WHERE last_seen_at IS NULL 
       OR last_seen_at < NOW() - INTERVAL '${daysSinceLastSeen} days'
    ORDER BY market_price DESC NULLS LAST
  `);
  return result.rows;
}

/**
 * Get count of stale cards
 */
export async function pgGetStaleCardCount(daysSinceLastSeen: number = 7): Promise<number> {
  const result = await getPool().query<{ count: string }>(`
    SELECT COUNT(*) as count FROM cards 
    WHERE last_seen_at IS NULL 
       OR last_seen_at < NOW() - INTERVAL '${daysSinceLastSeen} days'
  `);
  return parseInt(result.rows[0].count, 10);
}

/**
 * Remove cards that haven't been seen recently and are below a price threshold
 */
export async function pgRemoveStaleCards(
  daysSinceLastSeen: number = 7, 
  maxMarketPrice: number = 10
): Promise<number> {
  const result = await getPool().query(`
    DELETE FROM cards 
    WHERE (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '${daysSinceLastSeen} days')
      AND (market_price IS NULL OR market_price < $1)
      AND in_collection = false
    RETURNING product_id
  `, [maxMarketPrice]);
  return result.rowCount || 0;
}

/**
 * Mark a card's last_seen_at timestamp
 */
export async function pgMarkCardSeen(productId: number): Promise<void> {
  await getPool().query(
    `UPDATE cards SET last_seen_at = NOW() WHERE product_id = $1`,
    [productId]
  );
}

