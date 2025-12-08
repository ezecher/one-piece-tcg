/**
 * SQLite Database Client
 * 
 * Provides typed access to the TCGplayer sales database
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DB_PATH } from '../config.js';

// Get __dirname equivalent in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

// Types for our data
export interface Card {
  id: number;
  product_id: number;
  name: string;
  set_name: string | null;
  rarity: string | null;
  product_type: 'single' | 'sealed';
  market_price: number | null;
  lowest_listing: number | null;
  lowest_listing_with_shipping: number | null;
  listing_count: number;
  current_quantity: number;
  current_sellers: number;
  listings_updated_at: string | null;
  in_collection: number;
  tcg_url: string;
  created_at: string;
  updated_at: string;
}

export interface SaleEvent {
  id: number;
  card_id: number;
  sold_at: string;
  price: number;
  condition: string | null;
  listing_type: string | null;
  quantity: number;
  source_raw: string | null;
  scrape_run_id: number | null;
  created_at: string;
}

export interface ScrapeRun {
  id: number;
  run_type: 'products' | 'sales';
  mode: string | null;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'success' | 'partial' | 'error';
  products_scraped: number;
  sales_scraped: number;
  errors: number;
  notes: string | null;
}

export interface CardInput {
  product_id: number;
  name: string;
  set_name?: string | null;
  rarity?: string | null;
  product_type?: 'single' | 'sealed';
  market_price?: number | null;
  tcg_url: string;
}

export interface SaleEventInput {
  sold_at: Date | string;
  price: number;
  condition?: string | null;
  listing_type?: string | null;
  quantity?: number;
  source_raw?: string | null;
}

/**
 * Get or create the database connection
 */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

/**
 * Initialize the database with schema
 */
export function initializeDb(): void {
  const database = getDb();
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  database.exec(schema);
  
  // Run migrations for existing databases
  runMigrations(database);
  
  console.log('Database initialized successfully');
}

/**
 * Run migrations to add new columns to existing tables
 */
function runMigrations(database: Database.Database): void {
  // Check if columns exist and add if they don't
  const columns = database.prepare("PRAGMA table_info(card)").all() as Array<{ name: string }>;
  const columnNames = columns.map(c => c.name);
  
  // Migration: Add current_quantity column
  if (!columnNames.includes('current_quantity')) {
    database.exec('ALTER TABLE card ADD COLUMN current_quantity INTEGER DEFAULT 0');
    console.log('Migration: Added current_quantity column');
  }
  
  // Migration: Add current_sellers column
  if (!columnNames.includes('current_sellers')) {
    database.exec('ALTER TABLE card ADD COLUMN current_sellers INTEGER DEFAULT 0');
    console.log('Migration: Added current_sellers column');
  }
  
  // Migration: Add in_collection column
  if (!columnNames.includes('in_collection')) {
    database.exec('ALTER TABLE card ADD COLUMN in_collection INTEGER DEFAULT 0');
    console.log('Migration: Added in_collection column');
  }
}

/**
 * Close the database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ============ Card Operations ============

/**
 * Save or update a card
 */
export function saveCard(card: CardInput): number {
  const database = getDb();
  
  const stmt = database.prepare(`
    INSERT INTO card (product_id, name, set_name, rarity, product_type, market_price, tcg_url, created_at, updated_at)
    VALUES (@product_id, @name, @set_name, @rarity, @product_type, @market_price, @tcg_url, datetime('now'), datetime('now'))
    ON CONFLICT(product_id) DO UPDATE SET
      name = excluded.name,
      set_name = COALESCE(excluded.set_name, card.set_name),
      rarity = COALESCE(excluded.rarity, card.rarity),
      product_type = excluded.product_type,
      market_price = excluded.market_price,
      tcg_url = excluded.tcg_url,
      updated_at = datetime('now')
  `);
  
  const result = stmt.run({
    product_id: card.product_id,
    name: card.name,
    set_name: card.set_name ?? null,
    rarity: card.rarity ?? null,
    product_type: card.product_type ?? 'single',
    market_price: card.market_price ?? null,
    tcg_url: card.tcg_url,
  });
  
  return result.lastInsertRowid as number;
}

/**
 * Update listing data for a card
 */
export function updateCardListings(
  productId: number,
  lowestPrice: number | null,
  lowestPriceWithShipping: number | null,
  listingCount: number,
  currentQuantity?: number,
  currentSellers?: number
): void {
  const database = getDb();
  
  const stmt = database.prepare(`
    UPDATE card SET
      lowest_listing = ?,
      lowest_listing_with_shipping = ?,
      listing_count = ?,
      current_quantity = ?,
      current_sellers = ?,
      listings_updated_at = datetime('now'),
      updated_at = datetime('now')
    WHERE product_id = ?
  `);
  
  stmt.run(
    lowestPrice, 
    lowestPriceWithShipping, 
    listingCount, 
    currentQuantity ?? 0,
    currentSellers ?? 0,
    productId
  );
}

/**
 * Get a card by product ID
 */
export function getCardByProductId(productId: number): Card | undefined {
  const database = getDb();
  return database.prepare('SELECT * FROM card WHERE product_id = ?').get(productId) as Card | undefined;
}

/**
 * Get all cards
 */
export function getAllCards(): Card[] {
  const database = getDb();
  return database.prepare('SELECT * FROM card ORDER BY name').all() as Card[];
}

/**
 * Card with last sale info for dashboard
 */
export interface CardWithLastSale extends Card {
  last_sale_date: string | null;
  last_sale_price: number | null;
  last_sale_condition: string | null;
}

/**
 * Get all cards with last sale info, sorted by market price descending
 */
export function getAllCardsWithLastSale(): CardWithLastSale[] {
  const database = getDb();
  return database.prepare(`
    SELECT 
      c.*,
      (SELECT sold_at FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_date,
      (SELECT price FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_price,
      (SELECT condition FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_condition
    FROM card c
    ORDER BY c.market_price DESC NULLS LAST
  `).all() as CardWithLastSale[];
}

/**
 * Get cards with market price >= threshold
 */
export function getCardsAbovePrice(minPrice: number): Card[] {
  const database = getDb();
  return database.prepare('SELECT * FROM card WHERE market_price >= ? ORDER BY market_price DESC').all(minPrice) as Card[];
}

/**
 * Get cards by set
 */
export function getCardsBySet(setName: string): Card[] {
  const database = getDb();
  return database.prepare('SELECT * FROM card WHERE set_name = ? ORDER BY name').all(setName) as Card[];
}

/**
 * Count cards
 */
export function countCards(): number {
  const database = getDb();
  const result = database.prepare('SELECT COUNT(*) as count FROM card').get() as { count: number };
  return result.count;
}

// ============ Sale Event Operations ============

/**
 * Save sale events for a card
 * Returns the number of new sales inserted
 */
export function saveSaleEvents(productId: number, sales: SaleEventInput[], scrapeRunId?: number): number {
  const database = getDb();
  
  // Get card ID from product ID
  const card = getCardByProductId(productId);
  if (!card) {
    console.warn(`Card not found for product ID ${productId}`);
    return 0;
  }
  
  const stmt = database.prepare(`
    INSERT OR IGNORE INTO sale_event 
      (card_id, sold_at, price, condition, quantity, listing_type, source_raw, scrape_run_id)
    VALUES (@card_id, @sold_at, @price, @condition, @quantity, @listing_type, @source_raw, @scrape_run_id)
  `);
  
  let inserted = 0;
  
  for (const sale of sales) {
    const soldAt = sale.sold_at instanceof Date 
      ? sale.sold_at.toISOString() 
      : sale.sold_at;
    
    const result = stmt.run({
      card_id: card.id,
      sold_at: soldAt,
      price: sale.price,
      condition: sale.condition ?? null,
      quantity: sale.quantity ?? 1,
      listing_type: sale.listing_type ?? null,
      source_raw: sale.source_raw ?? null,
      scrape_run_id: scrapeRunId ?? null,
    });
    
    if (result.changes > 0) {
      inserted++;
    }
  }
  
  return inserted;
}

/**
 * Get sales for a card
 */
export function getSalesForCard(cardId: number, limit = 100): SaleEvent[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM sale_event 
    WHERE card_id = ? 
    ORDER BY sold_at DESC 
    LIMIT ?
  `).all(cardId, limit) as SaleEvent[];
}

/**
 * Get sales for a product ID
 */
export function getSalesForProduct(productId: number, limit = 100): SaleEvent[] {
  const database = getDb();
  return database.prepare(`
    SELECT s.* FROM sale_event s
    JOIN card c ON s.card_id = c.id
    WHERE c.product_id = ? 
    ORDER BY s.sold_at DESC 
    LIMIT ?
  `).all(productId, limit) as SaleEvent[];
}

/**
 * Count total sales
 */
export function countSales(): number {
  const database = getDb();
  const result = database.prepare('SELECT COUNT(*) as count FROM sale_event').get() as { count: number };
  return result.count;
}

// ============ Scrape Run Operations ============

/**
 * Start a new scrape run
 */
export function startScrapeRun(runType: 'products' | 'sales', mode?: string): number {
  const database = getDb();
  
  const result = database.prepare(`
    INSERT INTO scrape_run (run_type, mode, started_at, status)
    VALUES (@run_type, @mode, datetime('now'), 'running')
  `).run({
    run_type: runType,
    mode: mode ?? null,
  });
  
  return result.lastInsertRowid as number;
}

/**
 * Update scrape run progress
 */
export function updateScrapeRun(
  runId: number, 
  updates: { products_scraped?: number; sales_scraped?: number; errors?: number }
): void {
  const database = getDb();
  
  const sets: string[] = [];
  const values: Record<string, number> = { id: runId };
  
  if (updates.products_scraped !== undefined) {
    sets.push('products_scraped = @products_scraped');
    values.products_scraped = updates.products_scraped;
  }
  if (updates.sales_scraped !== undefined) {
    sets.push('sales_scraped = @sales_scraped');
    values.sales_scraped = updates.sales_scraped;
  }
  if (updates.errors !== undefined) {
    sets.push('errors = @errors');
    values.errors = updates.errors;
  }
  
  if (sets.length > 0) {
    database.prepare(`UPDATE scrape_run SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }
}

/**
 * Finish a scrape run
 */
export function finishScrapeRun(
  runId: number, 
  status: 'success' | 'partial' | 'error', 
  notes?: string
): void {
  const database = getDb();
  
  database.prepare(`
    UPDATE scrape_run 
    SET finished_at = datetime('now'), status = @status, notes = @notes
    WHERE id = @id
  `).run({
    id: runId,
    status,
    notes: notes ?? null,
  });
}

/**
 * Get recent scrape runs
 */
export function getRecentRuns(limit = 10): ScrapeRun[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM scrape_run 
    ORDER BY started_at DESC 
    LIMIT ?
  `).all(limit) as ScrapeRun[];
}

// ============ Analytics Queries ============

export interface CardStats {
  card_id: number;
  product_id: number;
  name: string;
  set_name: string | null;
  market_price: number | null;
  sales_count_7d: number;
  avg_price_7d: number | null;
  min_price_7d: number | null;
  max_price_7d: number | null;
  sales_count_30d: number;
  avg_price_30d: number | null;
}

/**
 * Delete cards with market price below threshold
 */
export function deleteCardsUnderPrice(minPrice: number): number {
  const database = getDb();
  
  // First get the cards to delete (for logging)
  const cards = database.prepare(`
    SELECT id, product_id, name, market_price 
    FROM card 
    WHERE market_price < ? OR market_price IS NULL
  `).all(minPrice) as Card[];
  
  if (cards.length === 0) {
    return 0;
  }
  
  // Delete associated sales first (by card_id)
  const cardIds = cards.map(c => c.id);
  const placeholders = cardIds.map(() => '?').join(',');
  
  const salesDeleted = database.prepare(`
    DELETE FROM sale_event 
    WHERE card_id IN (${placeholders})
  `).run(...cardIds).changes;
  
  // Delete the cards
  const cardsDeleted = database.prepare(`
    DELETE FROM card 
    WHERE market_price < ? OR market_price IS NULL
  `).run(minPrice).changes;
  
  console.log(`Deleted ${cardsDeleted} cards and ${salesDeleted} associated sales`);
  
  return cardsDeleted;
}

/**
 * Get card stats with 7-day and 30-day averages
 */
export function getCardStats(minSales = 0): CardStats[] {
  const database = getDb();
  return database.prepare(`
    SELECT 
      c.id AS card_id,
      c.product_id,
      c.name,
      c.set_name,
      c.market_price,
      COALESCE(v7.sales_count_7d, 0) AS sales_count_7d,
      v7.avg_price_7d,
      v7.min_price_7d,
      v7.max_price_7d,
      COALESCE(v30.sales_count_30d, 0) AS sales_count_30d,
      v30.avg_price_30d
    FROM card c
    LEFT JOIN v_card_avg_7d v7 ON c.id = v7.card_id
    LEFT JOIN v_card_avg_30d v30 ON c.id = v30.card_id
    WHERE COALESCE(v7.sales_count_7d, 0) >= ?
    ORDER BY sales_count_7d DESC
  `).all(minSales) as CardStats[];
}

export interface DealCandidate {
  card_id: number;
  product_id: number;
  name: string;
  set_name: string | null;
  market_price: number | null;
  tcg_url: string;
  avg_price_7d: number | null;
  sales_count_7d: number;
  avg_price_30d: number | null;
  sales_count_30d: number;
  market_vs_7d_diff: number | null;
  market_vs_7d_pct: number | null;
}

/**
 * Get potential deals (cards selling below market)
 */
export function getPotentialDeals(minSales = 3, maxPctOfMarket = 90): DealCandidate[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM v_potential_deals
    WHERE sales_count_7d >= ?
      AND (market_vs_7d_pct IS NULL OR market_vs_7d_pct <= ?)
    ORDER BY market_vs_7d_pct DESC
    LIMIT 50
  `).all(minSales, 100 - maxPctOfMarket) as DealCandidate[];
}

/**
 * Get deals where lowest listing is below last sale price
 * This matches what the dashboard shows as "Deals"
 */
export interface ListingDeal {
  product_id: number;
  name: string;
  set_name: string | null;
  product_type: string;
  market_price: number | null;
  lowest_listing: number;
  last_sale_price: number;
  last_sale_date: string;
  tcg_url: string;
  discount_pct: number;
  savings: number;
}

export function getDealsUnderLastSale(minDiscountPct = 5): ListingDeal[] {
  const database = getDb();
  return database.prepare(`
    SELECT 
      c.product_id,
      c.name,
      c.set_name,
      c.product_type,
      c.market_price,
      c.lowest_listing,
      (SELECT price FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_price,
      (SELECT sold_at FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_date,
      c.tcg_url,
      ROUND((1.0 - c.lowest_listing / (SELECT price FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1)) * 100, 1) as discount_pct,
      ROUND((SELECT price FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) - c.lowest_listing, 2) as savings
    FROM card c
    WHERE c.lowest_listing IS NOT NULL
      AND (SELECT price FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) IS NOT NULL
      AND c.lowest_listing < (SELECT price FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) * (1 - ? / 100.0)
    ORDER BY discount_pct DESC
  `).all(minDiscountPct) as ListingDeal[];
}

/**
 * Record a suspicious listing (when API data doesn't match UI-verified data)
 */
export function recordSuspiciousListing(
  productId: number,
  apiPrice: number,
  verifiedPrice: number,
  lastSalePrice: number | null,
  discountClaimed: number,
  discountActual: number
): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO suspicious_listing 
      (product_id, api_price, verified_price, last_sale_price, discount_claimed, discount_actual)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(productId, apiPrice, verifiedPrice, lastSalePrice, discountClaimed, discountActual);
}

/**
 * Check if a price matches a known suspicious pattern for this product
 */
export function isSuspiciousPrice(productId: number, price: number): boolean {
  const database = getDb();
  const result = database.prepare(`
    SELECT COUNT(*) as count FROM suspicious_listing
    WHERE product_id = ?
      AND ABS(api_price - ?) < 0.01
  `).get(productId, price) as { count: number };
  return result.count > 0;
}

/**
 * Get all suspicious listings for a product
 */
export function getSuspiciousListings(productId?: number): Array<{
  product_id: number;
  api_price: number;
  verified_price: number;
  last_sale_price: number | null;
  discount_claimed: number;
  discount_actual: number;
  verified_at: string;
}> {
  const database = getDb();
  if (productId) {
    return database.prepare(`
      SELECT * FROM suspicious_listing WHERE product_id = ? ORDER BY verified_at DESC
    `).all(productId) as any[];
  }
  return database.prepare(`
    SELECT * FROM suspicious_listing ORDER BY verified_at DESC LIMIT 100
  `).all() as any[];
}

/**
 * Get count of suspicious listings by product
 */
export function getSuspiciousCount(): number {
  const database = getDb();
  const result = database.prepare(`
    SELECT COUNT(DISTINCT product_id) as count FROM suspicious_listing
  `).get() as { count: number };
  return result.count;
}

/**
 * Get top volume cards in last 24 hours
 */
export function getTopVolume24h(limit = 20): Array<{ card_id: number; name: string; sales_24h: number; avg_price: number }> {
  const database = getDb();
  return database.prepare(`
    SELECT 
      c.id AS card_id,
      c.name,
      COUNT(s.id) AS sales_24h,
      ROUND(AVG(s.price), 2) AS avg_price
    FROM card c
    JOIN sale_event s ON c.id = s.card_id
    WHERE s.sold_at >= datetime('now', '-1 day')
    GROUP BY c.id
    ORDER BY sales_24h DESC
    LIMIT ?
  `).all(limit) as Array<{ card_id: number; name: string; sales_24h: number; avg_price: number }>;
}

// ============ Collection/Watchlist Operations ============

/**
 * Add a card to the collection by product ID
 */
export function addToCollection(productId: number): boolean {
  const database = getDb();
  const result = database.prepare(`
    UPDATE card SET in_collection = 1, updated_at = datetime('now')
    WHERE product_id = ?
  `).run(productId);
  return result.changes > 0;
}

/**
 * Remove a card from the collection by product ID
 */
export function removeFromCollection(productId: number): boolean {
  const database = getDb();
  const result = database.prepare(`
    UPDATE card SET in_collection = 0, updated_at = datetime('now')
    WHERE product_id = ?
  `).run(productId);
  return result.changes > 0;
}

/**
 * Toggle a card's collection status
 */
export function toggleCollection(productId: number): boolean {
  const database = getDb();
  const result = database.prepare(`
    UPDATE card SET 
      in_collection = CASE WHEN in_collection = 1 THEN 0 ELSE 1 END,
      updated_at = datetime('now')
    WHERE product_id = ?
  `).run(productId);
  return result.changes > 0;
}

/**
 * Get all cards in the collection
 */
export function getCollectionCards(): CardWithLastSale[] {
  const database = getDb();
  return database.prepare(`
    SELECT 
      c.*,
      (SELECT sold_at FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_date,
      (SELECT price FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_price,
      (SELECT condition FROM sale_event WHERE card_id = c.id ORDER BY sold_at DESC LIMIT 1) as last_sale_condition
    FROM card c
    WHERE c.in_collection = 1
    ORDER BY c.market_price DESC NULLS LAST
  `).all() as CardWithLastSale[];
}

/**
 * Get collection count
 */
export function getCollectionCount(): number {
  const database = getDb();
  const result = database.prepare('SELECT COUNT(*) as count FROM card WHERE in_collection = 1').get() as { count: number };
  return result.count;
}

/**
 * Search cards by name (for adding to collection)
 */
export function searchCardsByName(query: string, limit = 20): Card[] {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM card 
    WHERE name LIKE ? 
    ORDER BY market_price DESC
    LIMIT ?
  `).all(`%${query}%`, limit) as Card[];
}


