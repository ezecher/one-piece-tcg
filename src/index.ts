#!/usr/bin/env node
/**
 * TCGplayer One Piece Sales Scraper
 * 
 * CLI tool to aggregate sales data for One Piece products
 */

import { Command } from 'commander';
import {
  initPostgres,
  closePool,
  pgCountCards,
  pgCountSales,
  pgGetAllCards,
  pgGetSalesForProduct,
  pgGetPotentialDeals,
  pgGetRecentRuns,
  pgGetSuspiciousListings,
  pgGetSuspiciousCount,
  pgGetStaleCards,
  pgGetStaleCardCount,
  pgRemoveStaleCards,
} from './db/postgres.js';
import { chromium } from 'playwright';
import { join } from 'path';
import { updateSales, updateSalesForProduct } from './jobs/updateSales.js';
import { updateListingsQuick } from './jobs/updateListingsQuick.js';
import { fixCardNames } from './jobs/fixCardNames.js';
import { verifyDeals } from './jobs/verifyDeals.js';
import { loginAndSaveCookies, testWithSavedCookies } from './jobs/loginAndSaveCookies.js';
import { discoverByPrice } from './jobs/discoverByPrice.js';

const USER_DATA_DIR = join(process.cwd(), '.browser-data');

const program = new Command();

program
  .name('tcg-onepiece')
  .description('Aggregate One Piece TCGplayer sales data')
  .version('1.0.0');

// ============ Database Commands ============

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

    await new Promise<void>((resolve) => {
      context.on('close', () => resolve());
    });

    console.log('\n✓ Session saved! Future commands will use your login.\n');
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
      await closePool();
    }
  });

program
  .command('db:status')
  .description('Show database status')
  .action(async () => {
    try {
      await initPostgres();

      const cards = await pgCountCards();
      const sales = await pgCountSales();
      const runs = await pgGetRecentRuns(5);

      console.log('\n=== Database Status ===\n');
      console.log(`Cards tracked: ${cards}`);
      console.log(`Sales recorded: ${sales}`);

      if (runs.length > 0) {
        console.log('\nRecent scrape runs:');
        for (const run of runs) {
          const duration = run.completed_at
            ? `(${Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s)`
            : '(running)';
          console.log(`  #${run.id}: ${run.run_type} [${run.status}] ${duration}`);
          console.log(`         Products: ${run.products_scraped}, Sales: ${run.new_sales}, Errors: ${run.errors}`);
        }
      }
    } finally {
      await closePool();
    }
  });

// ============ Price Discovery Commands ============

program
  .command('discover-by-price')
  .description('Discover ALL valuable cards by price (not by set) - stops when prices hit threshold')
  .option('-m, --mode <mode>', 'Product mode: singles, sealed, or all', 'singles')
  .option('-p, --min-price <number>', 'Stop when prices drop below this amount', '10')
  .option('--max-pages <number>', 'Safety limit on pages to scrape', '200')
  .option('--headless', 'Run browser in headless mode')
  .option('--no-proxy', 'Disable proxy even if configured')
  .action(async (options) => {
    try {
      await discoverByPrice({
        mode: options.mode as 'singles' | 'sealed' | 'all',
        minPrice: parseFloat(options.minPrice),
        maxPages: parseInt(options.maxPages, 10),
        headless: options.headless === true,
        useProxy: options.proxy !== false,
      });
      process.exit(0);
    } catch (error) {
      console.error('Failed to discover products:', error);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

// ============ Sales Commands ============

program
  .command('update-sales')
  .description('Fetch latest sales data for tracked products')
  .option('-l, --limit <number>', 'Max products to process')
  .option('-p, --product <id>', 'Specific product ID to update')
  .option('-s, --set <setName>', 'Filter by set name (e.g., "romance-dawn")')
  .option('-w, --workers <number>', 'Parallel workers 1-4 (default: 1)', '1')
  .option('-c, --collection', 'Only update your collection items (much faster!)')
  .option('-f, --fast', 'Fast mode - shorter delays (3x faster)')
  .option('--no-api', 'Skip API and use UI scraping only')
  .option('--headless', 'Run browser in headless mode (default: visible)')
  .option('--chrome', 'Use your Chrome profile (already logged in)')
  .action(async (options) => {
    try {
      if (options.product) {
        await updateSalesForProduct(parseInt(options.product, 10));
      } else {
        await updateSales({
          setName: options.set,
          limit: options.limit ? parseInt(options.limit, 10) : undefined,
          headless: options.headless === true,
          useApi: options.api !== false,
          useChrome: options.chrome,
          workers: parseInt(options.workers, 10),
          collectionOnly: options.collection === true,
          fastMode: options.fast === true,
        });
      }
      process.exit(0);
    } catch (error) {
      console.error('Failed to update sales:', error);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

program
  .command('refresh-listings')
  .description('Quick API-based listings refresh with parallel workers')
  .option('-s, --set <name>', 'Filter by set name')
  .option('-l, --limit <number>', 'Max products to process')
  .option('-p, --product <id>', 'Specific product ID to refresh')
  .option('-w, --workers <number>', 'Parallel workers (1-4)', '3')
  .option('--headless', 'Run browser in headless mode (default: visible)')
  .option('--no-proxy', 'Disable proxy even if configured')
  .action(async (options) => {
    try {
      await updateListingsQuick({
        setName: options.set,
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        productIds: options.product ? [parseInt(options.product, 10)] : undefined,
        headless: options.headless === true,
        workers: options.workers ? parseInt(options.workers, 10) : 3,
        useApi: true,
        useProxy: options.proxy !== false,
      });
      process.exit(0);
    } catch (error) {
      console.error('Failed to refresh listings:', error);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

// Refresh market prices (fast page scraper)
program
  .command('refresh-prices')
  .description('Quick market price refresh by scraping search pages (~2 mins)')
  .option('-p, --pages <number>', 'Max pages to scrape (default: 60)', '60')
  .option('--headless', 'Run browser in headless mode')
  .action(async (options) => {
    try {
      const { refreshPrices } = await import('./jobs/refreshPrices.js');
      await refreshPrices({
        maxPages: parseInt(options.pages, 10),
        headless: options.headless === true,
      });
      process.exit(0);
    } catch (error) {
      console.error('Failed to refresh prices:', error);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

// ============ Query Commands ============

program
  .command('list-cards')
  .description('List all tracked cards')
  .option('-l, --limit <number>', 'Limit results', '50')
  .action(async (options) => {
    try {
      await initPostgres();

      const cards = (await pgGetAllCards()).slice(0, parseInt(options.limit, 10));

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
      await closePool();
    }
  });

program
  .command('card-sales <productId>')
  .description('Show sales history for a specific card')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (productId, options) => {
    try {
      await initPostgres();

      const limit = parseInt(options.limit, 10);
      const sales = (await pgGetSalesForProduct(parseInt(productId, 10))).slice(0, limit);

      if (sales.length === 0) {
        console.log(`No sales found for product ${productId}`);
        return;
      }

      console.log(`\n=== Sales for Product ${productId} ===\n`);

      for (const sale of sales) {
        const date = new Date(sale.sold_at).toLocaleDateString();
        const price = typeof sale.price === 'number' ? sale.price : parseFloat(String(sale.price));
        console.log(`${date} | $${price.toFixed(2)} | ${sale.condition || 'N/A'} | Qty: ${sale.quantity}`);
      }

      const prices = sales.map(s => typeof s.price === 'number' ? s.price : parseFloat(String(s.price)));
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const min = Math.min(...prices);
      const max = Math.max(...prices);

      console.log(`\nStats (${sales.length} sales):`);
      console.log(`  Avg: $${avg.toFixed(2)}`);
      console.log(`  Min: $${min.toFixed(2)}`);
      console.log(`  Max: $${max.toFixed(2)}`);
    } finally {
      await closePool();
    }
  });

program
  .command('deals')
  .description('Find potential deals (lowest listing significantly below market)')
  .option('-d, --discount <number>', 'Minimum discount percentage', '10')
  .action(async (options) => {
    try {
      await initPostgres();

      const deals = await pgGetPotentialDeals(parseInt(options.discount, 10));

      console.log('\n=== Potential Deals ===\n');
      console.log(`Cards listed ${options.discount}%+ below market price:\n`);

      if (deals.length === 0) {
        console.log('No deals found matching criteria.');
        return;
      }

      for (const deal of deals) {
        const market = deal.market_price ? `$${deal.market_price.toFixed(2)}` : 'N/A';
        const lowest = deal.lowest_listing ? `$${deal.lowest_listing.toFixed(2)}` : 'N/A';
        const discount = `${deal.discount_pct.toFixed(1)}%`;

        console.log(`🔥 ${deal.name}`);
        console.log(`   Market: ${market} → Lowest listing: ${lowest} (${discount} below)`);
        console.log(`   Type: ${deal.product_type}`);
        console.log(`   ${deal.tcg_url}`);
        console.log('');
      }
    } finally {
      await closePool();
    }
  });

program
  .command('verify-deals')
  .description('Verify potential deals using UI scraping (bypasses stale API cache)')
  .option('-d, --min-discount <number>', 'Minimum discount percentage (vs market price)', '10')
  .option('-l, --limit <number>', 'Max deals to verify')
  .option('--visible', 'Run browser in visible mode')
  .action(async (options) => {
    try {
      await verifyDeals({
        minDiscount: parseInt(options.minDiscount, 10),
        limit: options.limit ? parseInt(options.limit, 10) : undefined,
        headless: !options.visible,
      });
    } catch (error) {
      console.error('Failed to verify deals:', error);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

program
  .command('tcg-login')
  .description('Login to TCGplayer manually and save cookies for extended sales access')
  .action(async () => {
    try {
      await loginAndSaveCookies();
    } catch (error) {
      console.error('Login failed:', error);
      process.exit(1);
    }
  });

program
  .command('tcg-test-cookies')
  .description('Test if saved TCGplayer cookies still work')
  .action(async () => {
    try {
      await testWithSavedCookies();
    } catch (error) {
      console.error('Test failed:', error);
      process.exit(1);
    }
  });

program
  .command('suspicious')
  .description('Show products with known stale/suspicious API prices')
  .action(async () => {
    try {
      await initPostgres();
      
      const count = await pgGetSuspiciousCount();
      const listings = await pgGetSuspiciousListings();
      
      console.log('\n=== Suspicious API Prices ===\n');
      console.log(`Products with known stale prices: ${count}\n`);
      
      if (listings.length === 0) {
        console.log('No suspicious listings recorded yet.');
        console.log('Run "verify-deals" to identify stale API data.');
        return;
      }
      
      for (const item of listings) {
        const apiPrice = parseFloat(String(item.api_price));
        const verifiedPrice = parseFloat(String(item.verified_price));
        const discountClaimed = parseFloat(String(item.discount_claimed || 0));
        const discountActual = parseFloat(String(item.discount_actual || 0));
        const diff = ((verifiedPrice - apiPrice) / apiPrice * 100).toFixed(1);
        console.log(`⚠️  Product ${item.product_id}`);
        console.log(`   API claimed: $${apiPrice.toFixed(2)} (${discountClaimed.toFixed(1)}% off)`);
        console.log(`   Actually: $${verifiedPrice.toFixed(2)} (${discountActual.toFixed(1)}% off)`);
        console.log(`   Price was ${diff}% different from API`);
        console.log('');
      }
    } finally {
      await closePool();
    }
  });

// Stale cards management
program
  .command('stale-cards')
  .description('Find and optionally remove cards not seen in recent discover-by-price runs')
  .option('-d, --days <number>', 'Days since last seen to consider stale', '7')
  .option('-p, --max-price <number>', 'Only remove cards below this market price', '10')
  .option('--remove', 'Actually remove the stale cards (default: just list them)')
  .action(async (options) => {
    try {
      await initPostgres();
      
      const days = parseInt(options.days, 10);
      const maxPrice = parseFloat(options.maxPrice);
      
      console.log(`\n🔍 Finding cards not seen in last ${days} days...\n`);
      
      const staleCount = await pgGetStaleCardCount(days);
      
      if (staleCount === 0) {
        console.log('✅ No stale cards found! All cards were seen in recent scrapes.\n');
        return;
      }
      
      console.log(`Found ${staleCount} stale cards\n`);
      
      if (options.remove) {
        console.log(`🗑️  Removing stale cards with market price < $${maxPrice}...`);
        console.log('   (Cards in your collection will NOT be removed)\n');
        
        const removed = await pgRemoveStaleCards(days, maxPrice);
        console.log(`✅ Removed ${removed} stale cards\n`);
      } else {
        // Just list them
        const staleCards = await pgGetStaleCards(days);
        
        console.log('Stale cards (not seen recently):');
        console.log('─'.repeat(80));
        
        for (const card of staleCards.slice(0, 50)) {
          const lastSeen = card.last_seen_at 
            ? new Date(card.last_seen_at).toLocaleDateString()
            : 'never';
          const price = card.market_price ? `$${card.market_price.toFixed(2)}` : 'no price';
          console.log(`  ${card.name}`);
          console.log(`    Market: ${price} | Last seen: ${lastSeen}`);
        }
        
        if (staleCards.length > 50) {
          console.log(`\n  ... and ${staleCards.length - 50} more`);
        }
        
        console.log('\n─'.repeat(80));
        console.log(`\nTo remove stale cards below $${maxPrice}, run:`);
        console.log(`  node dist/index.js stale-cards --days ${days} --max-price ${maxPrice} --remove\n`);
      }
    } catch (error) {
      console.error('Error:', error);
      process.exit(1);
    } finally {
      await closePool();
    }
  });

// Parse and run
program.parse();

