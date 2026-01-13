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
  
  // Check for duplicates
  const dupes = await pool.query(`
    SELECT product_id, COUNT(*) as cnt 
    FROM cards 
    GROUP BY product_id 
    HAVING COUNT(*) > 1
  `);
  
  if (dupes.rows.length > 0) {
    console.log(`\n⚠️  Duplicate product_ids found:`, dupes.rows);
  } else {
    console.log(`\n✅ No duplicates - all good!`);
  }
  
  process.exit(0);
}

check().catch(console.error);

