/**
 * Quick script to check PostgreSQL database status
 */

import { getPool, initPostgres, pgCountCards, pgCountSales } from './postgres.js';

async function check() {
  console.log('\n📊 PostgreSQL Database Status\n');
  
  await initPostgres();
  const pool = getPool();
  
  const cardCount = await pgCountCards();
  const salesCount = await pgCountSales();
  
  console.log(`Cards: ${cardCount}`);
  console.log(`Sales: ${salesCount}`);
  console.log(`Expected sales from SQLite: 19,557`);
  console.log(`Difference: ${salesCount - 19557}`);
  
  // Check for duplicate cards
  const cardDupes = await pool.query(`
    SELECT product_id, COUNT(*) as cnt 
    FROM cards 
    GROUP BY product_id 
    HAVING COUNT(*) > 1
  `);
  
  if (cardDupes.rows.length > 0) {
    console.log(`\n⚠️  Duplicate cards found:`, cardDupes.rows.length);
  } else {
    console.log(`\n✅ No duplicate cards`);
  }
  
  // Check for duplicate sales (ignoring variant - that's where duplicates hide)
  const saleDupes = await pool.query(`
    SELECT product_id, sold_at, condition, price, COUNT(*) as cnt 
    FROM sale_events 
    GROUP BY product_id, sold_at, condition, price
    HAVING COUNT(*) > 1
    LIMIT 5
  `);
  
  if (saleDupes.rows.length > 0) {
    console.log(`\n⚠️  Duplicate sales (ignoring variant):`, saleDupes.rows.length);
    
    // Count total duplicates
    const totalDupes = await pool.query(`
      SELECT SUM(cnt - 1) as extra_rows FROM (
        SELECT COUNT(*) as cnt 
        FROM sale_events 
        GROUP BY product_id, sold_at, condition, price
        HAVING COUNT(*) > 1
      ) subq
    `);
    console.log(`   Extra rows if we ignore variant: ${totalDupes.rows[0].extra_rows}`);
  } else {
    console.log(`✅ No duplicate sales (ignoring variant)`);
  }
  
  // Check variant values
  const variants = await pool.query(`
    SELECT variant, COUNT(*) as cnt 
    FROM sale_events 
    GROUP BY variant 
    ORDER BY cnt DESC
    LIMIT 5
  `);
  console.log(`\nVariant values:`, variants.rows);
  
  // Check constraints on sale_events table
  const constraints = await pool.query(`
    SELECT conname, contype 
    FROM pg_constraint 
    WHERE conrelid = 'sale_events'::regclass
  `);
  console.log(`\nConstraints on sale_events:`, constraints.rows);
  
  // Actually count unique sale combinations
  const uniqueSales = await pool.query(`
    SELECT COUNT(*) FROM (
      SELECT DISTINCT product_id, sold_at, condition, variant, price 
      FROM sale_events
    ) subq
  `);
  console.log(`\nUnique sale combinations: ${uniqueSales.rows[0].count}`);
  console.log(`Total rows: 20342`);
  console.log(`If these match, no duplicates. If different, we have duplicates.`);
  
  process.exit(0);
}

check().catch(console.error);

