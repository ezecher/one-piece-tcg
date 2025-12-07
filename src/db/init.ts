/**
 * Database initialization script
 * Run with: npm run db:init
 */

import { initializeDb, closeDb, countCards, countSales } from './client.js';

console.log('Initializing TCGplayer sales database...');

try {
  initializeDb();
  
  const cardCount = countCards();
  const salesCount = countSales();
  
  console.log(`\nDatabase status:`);
  console.log(`  Cards: ${cardCount}`);
  console.log(`  Sales: ${salesCount}`);
  console.log(`\nDatabase ready!`);
} catch (error) {
  console.error('Failed to initialize database:', error);
  process.exit(1);
} finally {
  closeDb();
}

