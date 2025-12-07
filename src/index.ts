#!/usr/bin/env node
/**
 * TCGplayer One Piece Sales Scraper
 * 
 * CLI tool to aggregate sales data for One Piece products
 */

import { Command } from 'commander';
import { 
  initializeDb, 
  closeDb, 
  countCards, 
  countSales,
  getAllCards,
  getCardStats,
  getPotentialDeals,
  getTopVolume24h,
  getSalesForProduct,
  getRecentRuns,
  deleteCardsUnderPrice,
  addToCollection,
  removeFromCollection,
  getCollectionCards,
  getCollectionCount,
  searchCardsByName,
  getCardByProductId,
} from './db/client.js';
import { chromium } from 'playwright';
import { join } from 'path';
import { updateProducts, updateAllSets } from './jobs/updateProducts.js';
import { updateSales, updateSalesForProduct } from './jobs/updateSales.js';
import { updateListings } from './jobs/updateListings.js';
import { updateListingsQuick } from './jobs/updateListingsQuick.js';
import { scrapeTopCards, scrapeOneSet } from './jobs/scrapeTopCards.js';
import { fixCardNames } from './jobs/fixCardNames.js';
import { verifyDeals } from './jobs/verifyDeals.js';
import { ProductMode, ONE_PIECE_SETS, MAIN_BOOSTER_SETS } from './config.js';

const USER_DATA_DIR = join(process.cwd(), '.browser-data');

const program = new Command();

program
  .name('tcg-onepiece')
  .description('Aggregate One Piece TCGplayer sales data')
  .version('1.0.0');

// ============ Database Commands ============

program
  .command('db:init')
  .description('Initialize the database')
  .action(() => {
    try {
      initializeDb();
      console.log('Database initialized successfully!');
      
      const cards = countCards();
      const sales = countSales();
      console.log(`\nCurrent data:`);
      console.log(`  Cards: ${cards}`);
      console.log(`  Sales: ${sales}`);
    } finally {
      closeDb();
    }
  });

program
  .command('login')
  .description('Open browser to login to TCGplayer (session will be saved)')
  .action(async () => {
    console.log('\n🔐 Opening browser for login...');
    console.log('   Login manually, then close the browser when done.\n');
    
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
    
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://www.tcgplayer.com/login');
    
    console.log('   Waiting for you to login and close the browser...');
    
    // Wait for the browser to be closed by the user
    await new Promise<void>((resolve) => {
      context.on('close', () => resolve());
    });
    
    console.log('\n✓ Session saved! Future commands will use your login.\n');
  });

program
  .command('db:cleanup')
  .description('Remove low-value cards from database')
  .option('-m, --min-price <number>', 'Minimum market price to keep', '5')
  .action((options) => {
    try {
      initializeDb();
      
      const minPrice = parseFloat(options.minPrice);
      console.log(`\n🧹 Removing cards with market price < $${minPrice}...\n`);
      
      const deleted = deleteCardsUnderPrice(minPrice);
      
      if (deleted === 0) {
        console.log('No cards to remove.');
      } else {
        console.log(`\n✓ Removed ${deleted} low-value cards from database.`);
      }
      
      const remaining = countCards();
      console.log(`Remaining cards: ${remaining}`);
    } finally {
      closeDb();
    }
  });

program
  .command('db:fix-names')
  .description('Fix cards with generic names (e.g., "Super Rare, #OP08-106")')
  .option('-l, --limit <number>', 'Limit number of cards to fix')
  .option('--visible', 'Run browser in visible mode')
  .action(async (options) => {
    try {
      await fixCardNames({
        headless: !options.visible,
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
      });
    } catch (error) {
      console.error('Failed to fix card names:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('db:status')
  .description('Show database status')
  .action(() => {
    try {
      initializeDb();
      
      const cards = countCards();
      const sales = countSales();
      const runs = getRecentRuns(5);
      
      console.log('\n=== Database Status ===\n');
      console.log(`Cards tracked: ${cards}`);
      console.log(`Sales recorded: ${sales}`);
      
      if (runs.length > 0) {
        console.log('\nRecent scrape runs:');
        for (const run of runs) {
          const duration = run.finished_at 
            ? `(${Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s)`
            : '(running)';
          console.log(`  #${run.id}: ${run.run_type} [${run.status}] ${duration}`);
          console.log(`         Products: ${run.products_scraped}, Sales: ${run.sales_scraped}, Errors: ${run.errors}`);
        }
      }
    } finally {
      closeDb();
    }
  });

// ============ Product Commands ============

program
  .command('update-products')
  .description('Scrape TCGplayer to discover One Piece products')
  .option('-m, --mode <mode>', 'Product mode: singles, sealed, or all', 'all')
  .option('-s, --set <setName>', 'Filter by set name (slug format)')
  .option('-p, --pages <number>', 'Max pages to scrape', '100')
  .option('--visible', 'Run browser in visible mode (not headless)')
  .action(async (options) => {
    try {
      await updateProducts({
        mode: options.mode as ProductMode,
        setName: options.set,
        maxPages: parseInt(options.pages, 10),
        headless: !options.visible,
      });
    } catch (error) {
      console.error('Failed to update products:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('update-all-sets')
  .description('Update products for all known One Piece sets')
  .option('-m, --mode <mode>', 'Product mode: singles, sealed, or all', 'singles')
  .option('-p, --pages <number>', 'Max pages per set', '20')
  .option('--visible', 'Run browser in visible mode')
  .action(async (options) => {
    try {
      await updateAllSets({
        mode: options.mode as ProductMode,
        maxPages: parseInt(options.pages, 10),
        headless: !options.visible,
      });
    } catch (error) {
      console.error('Failed to update sets:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// ============ Top Cards Commands (Recommended) ============

program
  .command('scrape-top-cards')
  .description('Scrape top cards from each set (sorted by price high to low)')
  .option('-p, --pages <number>', 'Pages per set (default 3)', '3')
  .option('--all-sets', 'Include all sets (not just main boosters)')
  .option('--visible', 'Run browser in visible mode')
  .option('--chrome', 'Use your Chrome profile (already logged in)')
  .option('--with-listings', 'Also fetch listings for each card')
  .action(async (options) => {
    try {
      await scrapeTopCards({
        sets: options.allSets ? ONE_PIECE_SETS : MAIN_BOOSTER_SETS,
        pagesPerSet: parseInt(options.pages, 10),
        headless: !options.visible && !options.chrome,
        verbose: true,
        useChrome: options.chrome,
        withListings: options.withListings,
      });
    } catch (error) {
      console.error('Failed to scrape top cards:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('scrape-set <setSlug>')
  .description('Scrape top cards from a specific set')
  .option('-p, --pages <number>', 'Pages to scrape', '3')
  .option('--visible', 'Run browser in visible mode')
  .option('--chrome', 'Use your Chrome profile (already logged in)')
  .option('--with-listings', 'Also fetch listings for each card')
  .action(async (setSlug, options) => {
    try {
      const set = ONE_PIECE_SETS.find(s => s.slug === setSlug);
      if (!set) {
        console.error(`Set not found: ${setSlug}`);
        console.log('Available sets:', ONE_PIECE_SETS.map(s => s.slug).join(', '));
        process.exit(1);
      }
      await scrapeTopCards({
        sets: [set],
        pagesPerSet: parseInt(options.pages, 10),
        headless: !options.visible && !options.chrome,
        verbose: true,
        useChrome: options.chrome,
        withListings: options.withListings,
      });
    } catch (error) {
      console.error('Failed to scrape set:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('list-sets')
  .description('List all available One Piece sets')
  .action(() => {
    console.log('\n=== One Piece Sets ===\n');
    console.log('Main Booster Sets:');
    MAIN_BOOSTER_SETS.forEach(s => {
      console.log(`  ${s.slug.padEnd(45)} (${s.count} products)`);
    });
    console.log('\nAll Sets:');
    ONE_PIECE_SETS.forEach(s => {
      console.log(`  ${s.slug.padEnd(55)} (${s.count} products)`);
    });
  });

// ============ Sales Commands ============

program
  .command('update-sales')
  .description('Fetch latest sales data for tracked products')
  .option('-l, --limit <number>', 'Max products to process')
  .option('-p, --product <id>', 'Specific product ID to update')
  .option('-s, --set <setName>', 'Filter by set name (e.g., "romance-dawn")')
  .option('--no-api', 'Skip API and use UI scraping only')
  .option('--visible', 'Run browser in visible mode')
  .option('--chrome', 'Use your Chrome profile (already logged in)')
  .action(async (options) => {
    try {
      if (options.product) {
        await updateSalesForProduct(parseInt(options.product, 10));
      } else {
        await updateSales({
          setName: options.set,
          limit: options.limit ? parseInt(options.limit, 10) : undefined,
          headless: !options.visible && !options.chrome,
          useApi: options.api !== false,
          useChrome: options.chrome,
        });
      }
    } catch (error) {
      console.error('Failed to update sales:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('update-listings')
  .description('Fetch current seller listings (English, Near Mint only)')
  .option('-l, --limit <number>', 'Max products to process')
  .option('--visible', 'Run browser in visible mode')
  .option('--chrome', 'Use your Chrome profile (already logged in)')
  .action(async (options) => {
    try {
      await updateListings({
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        headless: !options.visible && !options.chrome,
        useChrome: options.chrome,
      });
    } catch (error) {
      console.error('Failed to update listings:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('refresh-listings')
  .description('Quick API-based listings refresh (much faster than update-listings)')
  .option('-s, --set <name>', 'Filter by set name')
  .option('-l, --limit <number>', 'Max products to process')
  .option('-p, --product <id>', 'Specific product ID to refresh')
  .option('--visible', 'Run browser in visible mode')
  .option('--no-api', 'Skip API and use UI scraping only')
  .action(async (options) => {
    try {
      await updateListingsQuick({
        setName: options.set,
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        productIds: options.product ? [parseInt(options.product, 10)] : undefined,
        headless: !options.visible,
        useApi: options.api !== false,
      });
    } catch (error) {
      console.error('Failed to refresh listings:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// ============ Query Commands ============

program
  .command('list-cards')
  .description('List all tracked cards')
  .option('-l, --limit <number>', 'Limit results', '50')
  .action((options) => {
    try {
      initializeDb();
      
      const cards = getAllCards().slice(0, parseInt(options.limit, 10));
      
      console.log('\n=== Tracked Cards ===\n');
      console.log(`Showing ${cards.length} cards:\n`);
      
      for (const card of cards) {
        const price = card.market_price ? `$${card.market_price.toFixed(2)}` : 'N/A';
        console.log(`[${card.product_id}] ${card.name}`);
        console.log(`  Set: ${card.set_name || 'Unknown'} | Type: ${card.product_type} | Market: ${price}`);
        console.log(`  ${card.tcg_url}`);
        console.log('');
      }
    } finally {
      closeDb();
    }
  });

program
  .command('card-sales <productId>')
  .description('Show sales history for a specific card')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action((productId, options) => {
    try {
      initializeDb();
      
      const sales = getSalesForProduct(parseInt(productId, 10), parseInt(options.limit, 10));
      
      if (sales.length === 0) {
        console.log(`No sales found for product ${productId}`);
        return;
      }
      
      console.log(`\n=== Sales for Product ${productId} ===\n`);
      
      for (const sale of sales) {
        const date = new Date(sale.sold_at).toLocaleDateString();
        console.log(`${date} | $${sale.price.toFixed(2)} | ${sale.condition || 'N/A'} | Qty: ${sale.quantity}`);
      }
      
      // Calculate stats
      const prices = sales.map(s => s.price);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      
      console.log(`\nStats (${sales.length} sales):`);
      console.log(`  Avg: $${avg.toFixed(2)}`);
      console.log(`  Min: $${min.toFixed(2)}`);
      console.log(`  Max: $${max.toFixed(2)}`);
    } finally {
      closeDb();
    }
  });

program
  .command('stats')
  .description('Show card statistics with averages')
  .option('-m, --min-sales <number>', 'Minimum sales to show', '3')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action((options) => {
    try {
      initializeDb();
      
      const stats = getCardStats(parseInt(options.minSales, 10))
        .slice(0, parseInt(options.limit, 10));
      
      console.log('\n=== Card Statistics ===\n');
      console.log('Cards with sales data (sorted by 7-day volume):\n');
      
      for (const stat of stats) {
        const market = stat.market_price ? `$${stat.market_price.toFixed(2)}` : 'N/A';
        const avg7d = stat.avg_price_7d ? `$${stat.avg_price_7d.toFixed(2)}` : 'N/A';
        const avg30d = stat.avg_price_30d ? `$${stat.avg_price_30d.toFixed(2)}` : 'N/A';
        
        console.log(`${stat.name}`);
        console.log(`  Market: ${market} | 7d Avg: ${avg7d} (${stat.sales_count_7d} sales) | 30d Avg: ${avg30d} (${stat.sales_count_30d} sales)`);
        console.log('');
      }
    } finally {
      closeDb();
    }
  });

program
  .command('deals')
  .description('Find potential deals (cards selling below market)')
  .option('-m, --min-sales <number>', 'Minimum 7-day sales', '3')
  .option('-d, --discount <number>', 'Minimum discount percentage', '10')
  .action((options) => {
    try {
      initializeDb();
      
      const deals = getPotentialDeals(
        parseInt(options.minSales, 10),
        parseInt(options.discount, 10)
      );
      
      console.log('\n=== Potential Deals ===\n');
      console.log(`Cards selling ${options.discount}%+ below market (min ${options.minSales} sales):\n`);
      
      if (deals.length === 0) {
        console.log('No deals found matching criteria.');
        return;
      }
      
      for (const deal of deals) {
        const market = deal.market_price ? `$${deal.market_price.toFixed(2)}` : 'N/A';
        const avg7d = deal.avg_price_7d ? `$${deal.avg_price_7d.toFixed(2)}` : 'N/A';
        const discount = deal.market_vs_7d_pct ? `${deal.market_vs_7d_pct.toFixed(1)}%` : 'N/A';
        
        console.log(`🔥 ${deal.name}`);
        console.log(`   Market: ${market} → Selling at: ${avg7d} (${discount} below)`);
        console.log(`   7d sales: ${deal.sales_count_7d} | Set: ${deal.set_name || 'Unknown'}`);
        console.log(`   ${deal.tcg_url}`);
        console.log('');
      }
    } finally {
      closeDb();
    }
  });

program
  .command('verify-deals')
  .description('Verify potential deals using UI scraping (bypasses API cache)')
  .option('-m, --min-sales <number>', 'Minimum 7-day sales', '3')
  .option('-d, --discount <number>', 'Minimum discount percentage', '10')
  .option('-l, --limit <number>', 'Max deals to verify')
  .option('--visible', 'Run browser in visible mode')
  .action(async (options) => {
    try {
      await verifyDeals({
        minSales: parseInt(options.minSales, 10),
        minDiscount: parseInt(options.discount, 10),
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        headless: !options.visible,
      });
    } catch (error) {
      console.error('Failed to verify deals:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('volume')
  .description('Show top volume cards in last 24 hours')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action((options) => {
    try {
      initializeDb();
      
      const volume = getTopVolume24h(parseInt(options.limit, 10));
      
      console.log('\n=== Top Volume (24h) ===\n');
      
      if (volume.length === 0) {
        console.log('No sales data in the last 24 hours.');
        return;
      }
      
      for (const item of volume) {
        console.log(`${item.sales_24h} sales | $${item.avg_price.toFixed(2)} avg | ${item.name}`);
      }
    } finally {
      closeDb();
    }
  });

// ============ Full Workflow Commands ============

program
  .command('full-update')
  .description('Run full update: products then sales')
  .option('-m, --mode <mode>', 'Product mode', 'all')
  .option('-p, --pages <number>', 'Max pages for products', '50')
  .option('-l, --limit <number>', 'Max products for sales', '100')
  .option('--visible', 'Run browser in visible mode')
  .action(async (options) => {
    try {
      console.log('=== Starting Full Update ===\n');
      
      // Step 1: Update products
      console.log('Step 1: Updating products...\n');
      await updateProducts({
        mode: options.mode as ProductMode,
        maxPages: parseInt(options.pages, 10),
        headless: !options.visible,
      });
      
      // Step 2: Update sales
      console.log('\nStep 2: Updating sales...\n');
      await updateSales({
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        headless: !options.visible,
      });
      
      console.log('\n=== Full Update Complete ===');
    } catch (error) {
      console.error('Full update failed:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

// ============ Collection Commands ============

program
  .command('collection')
  .description('View your collection/watchlist')
  .action(() => {
    try {
      initializeDb();
      
      const cards = getCollectionCards();
      
      if (cards.length === 0) {
        console.log('\n📦 Your collection is empty!\n');
        console.log('Add cards with: npm run dev collection-add -- <product_id>');
        console.log('Or search: npm run dev collection-search -- "card name"');
        return;
      }
      
      console.log(`\n📦 Your Collection (${cards.length} items)\n`);
      console.log('─'.repeat(100));
      
      let totalValue = 0;
      for (const card of cards) {
        const price = card.market_price ?? 0;
        const listing = card.lowest_listing ? `$${card.lowest_listing.toFixed(2)}` : '-';
        totalValue += price;
        console.log(
          `${card.product_id.toString().padEnd(10)} ` +
          `$${price.toFixed(2).padStart(8)} ` +
          `${listing.padStart(8)} listing ` +
          `${(card.set_name || '').slice(0, 25).padEnd(26)} ` +
          `${card.name.slice(0, 40)}`
        );
      }
      
      console.log('─'.repeat(100));
      console.log(`Total Market Value: $${totalValue.toFixed(2)}`);
    } finally {
      closeDb();
    }
  });

program
  .command('collection-add <productId>')
  .description('Add a card to your collection by product ID')
  .action((productId) => {
    try {
      initializeDb();
      
      const id = parseInt(productId, 10);
      const card = getCardByProductId(id);
      
      if (!card) {
        console.log(`\n❌ Card with product ID ${id} not found in database.`);
        console.log('   Make sure to scrape the set first.\n');
        return;
      }
      
      if (card.in_collection) {
        console.log(`\n⚠️  "${card.name}" is already in your collection.\n`);
        return;
      }
      
      addToCollection(id);
      console.log(`\n✅ Added to collection: ${card.name}`);
      console.log(`   Set: ${card.set_name}`);
      console.log(`   Market Price: $${card.market_price?.toFixed(2) ?? 'N/A'}\n`);
    } finally {
      closeDb();
    }
  });

program
  .command('collection-remove <productId>')
  .description('Remove a card from your collection')
  .action((productId) => {
    try {
      initializeDb();
      
      const id = parseInt(productId, 10);
      const card = getCardByProductId(id);
      
      if (!card) {
        console.log(`\n❌ Card with product ID ${id} not found.\n`);
        return;
      }
      
      if (!card.in_collection) {
        console.log(`\n⚠️  "${card.name}" is not in your collection.\n`);
        return;
      }
      
      removeFromCollection(id);
      console.log(`\n✅ Removed from collection: ${card.name}\n`);
    } finally {
      closeDb();
    }
  });

program
  .command('collection-search <query>')
  .description('Search for cards to add to your collection')
  .option('-l, --limit <number>', 'Max results', '20')
  .action((query, options) => {
    try {
      initializeDb();
      
      const cards = searchCardsByName(query, parseInt(options.limit, 10));
      
      if (cards.length === 0) {
        console.log(`\n❌ No cards found matching "${query}"\n`);
        return;
      }
      
      console.log(`\n🔍 Cards matching "${query}" (${cards.length} results)\n`);
      console.log('─'.repeat(100));
      console.log('Product ID   Price     In Coll   Set                        Name');
      console.log('─'.repeat(100));
      
      for (const card of cards) {
        const inColl = card.in_collection ? '  ✓  ' : '     ';
        console.log(
          `${card.product_id.toString().padEnd(12)} ` +
          `$${(card.market_price ?? 0).toFixed(2).padStart(7)} ` +
          `${inColl}     ` +
          `${(card.set_name || '').slice(0, 24).padEnd(25)} ` +
          `${card.name.slice(0, 35)}`
        );
      }
      
      console.log('─'.repeat(100));
      console.log('\nTo add a card: npm run dev collection-add -- <product_id>\n');
    } finally {
      closeDb();
    }
  });

program
  .command('collection-refresh')
  .description('Refresh listings for only your collection items')
  .option('--visible', 'Run browser in visible mode')
  .action(async (options) => {
    try {
      initializeDb();
      
      const cards = getCollectionCards();
      
      if (cards.length === 0) {
        console.log('\n📦 Your collection is empty! Nothing to refresh.\n');
        return;
      }
      
      console.log(`\n📦 Refreshing listings for ${cards.length} collection items...\n`);
      
      const productIds = cards.map(c => c.product_id);
      
      await updateListingsQuick({
        productIds,
        headless: !options.visible,
      });
      
      console.log('\n✓ Collection listings refreshed!\n');
    } finally {
      closeDb();
    }
  });

// Parse and run
program.parse();

