/**
 * Migration Script: SQLite to PostgreSQL
 * 
 * This script migrates all card and sales data from SQLite to PostgreSQL.
 * Run with: npx tsx src/db/migrate-to-postgres.ts
 */

import { initializeDb, getAllCards, countCards, countSales, getDb } from './client.js';
import { initPostgres, getPool, pgSaveCard, pgSaveSaleEvent, pgCountCards, pgCountSales } from './postgres.js';

async function migrate() {
  console.log('\n🚀 Starting SQLite to PostgreSQL Migration\n');
  
  // Initialize both databases
  console.log('📦 Initializing databases...');
  initializeDb();
  await initPostgres();
  
  const sqliteCards = countCards();
  const sqliteSales = countSales();
  console.log(`   SQLite: ${sqliteCards} cards, ${sqliteSales} sales`);
  
  const pgCardsCount = await pgCountCards();
  const pgSalesCount = await pgCountSales();
  console.log(`   PostgreSQL: ${pgCardsCount} cards, ${pgSalesCount} sales`);
  
  // Step 1: Migrate Cards (skip if already done)
  if (pgCardsCount >= sqliteCards) {
    console.log('\n📋 Cards already migrated, skipping...');
  } else {
    console.log('\n📋 Migrating cards...');
    const cards = getAllCards();
    let cardsMigrated = 0;
    let cardsSkipped = 0;
    
    for (const card of cards) {
      try {
        await pgSaveCard({
          product_id: card.product_id,
          name: card.name,
          tcg_url: card.tcg_url,
          set_name: card.set_name,
          rarity: card.rarity,
          // 'number' doesn't exist in SQLite schema
          product_type: card.product_type,
          market_price: card.market_price,
          lowest_listing: card.lowest_listing,
        });
        cardsMigrated++;
        
        if (cardsMigrated % 100 === 0) {
          console.log(`   Migrated ${cardsMigrated}/${cards.length} cards...`);
        }
      } catch (error) {
        console.error(`   Error migrating card ${card.product_id}:`, error);
        cardsSkipped++;
      }
    }
    
    console.log(`   ✅ Cards migrated: ${cardsMigrated}, skipped: ${cardsSkipped}`);
  }
  
  // Step 2: Migrate Sales (BATCH INSERT - much faster!)
  console.log('\n📊 Migrating sales...');
  const db = getDb();
  const pool = getPool();
  
  // Get all sales from SQLite
  const sales = db.prepare(`
    SELECT se.*, c.product_id 
    FROM sale_event se
    JOIN card c ON se.card_id = c.id
    ORDER BY se.sold_at ASC
  `).all() as Array<{
    id: number;
    product_id: number;
    sold_at: string;
    condition: string;
    variant: string;
    quantity: number;
    price: number;
  }>;
  
  console.log(`   Found ${sales.length} sales to migrate...`);
  
  // Build a map of product_id -> card_id from PostgreSQL
  const cardIdMap = new Map<number, number>();
  const cardRows = await pool.query<{ id: number; product_id: number }>('SELECT id, product_id FROM cards');
  for (const row of cardRows.rows) {
    cardIdMap.set(row.product_id, row.id);
  }
  console.log(`   Loaded ${cardIdMap.size} card IDs from PostgreSQL`);
  
  let salesMigrated = 0;
  let salesSkipped = 0;
  const batchSize = 500; // Insert 500 at a time
  
  for (let i = 0; i < sales.length; i += batchSize) {
    const batch = sales.slice(i, i + batchSize);
    
    // Build batch insert values
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;
    
    for (const sale of batch) {
      const cardId = cardIdMap.get(sale.product_id);
      if (!cardId) {
        salesSkipped++;
        continue;
      }
      
      placeholders.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`);
      values.push(
        cardId,
        sale.product_id,
        sale.sold_at,
        sale.condition || null,
        sale.variant || null,
        sale.quantity || 1,
        sale.price
      );
      paramIndex += 7;
    }
    
    if (placeholders.length > 0) {
      try {
        const result = await pool.query(`
          INSERT INTO sale_events (card_id, product_id, sold_at, condition, variant, quantity, price)
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (product_id, sold_at, condition, variant, price) DO NOTHING
        `, values);
        salesMigrated += result.rowCount || 0;
      } catch (error) {
        console.error(`   Batch error at ${i}:`, error);
        salesSkipped += batch.length;
      }
    }
    
    const processed = Math.min(i + batchSize, sales.length);
    process.stdout.write(`\r   Processed ${processed}/${sales.length} sales (${salesMigrated} inserted)...`);
  }
  
  console.log(`\n   ✅ Sales migrated: ${salesMigrated}, skipped: ${salesSkipped}`);
  
  // Final counts
  console.log('\n📈 Final counts:');
  const finalCards = await pgCountCards();
  const finalSales = await pgCountSales();
  console.log(`   PostgreSQL: ${finalCards} cards, ${finalSales} sales`);
  
  console.log('\n✅ Migration complete!\n');
  
  process.exit(0);
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});

