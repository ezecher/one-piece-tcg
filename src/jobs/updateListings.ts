/**
 * Update Listings Job
 * 
 * Fetches current seller listings for tracked products
 * Filters: English only, Near Mint only
 */

import { chromium, Browser, Page } from 'playwright';
import { REQUEST_DELAY_MS } from '../config.js';
import { join } from 'path';
import { 
  getAllCards, 
  updateCardListings,
  startScrapeRun, 
  updateScrapeRun, 
  finishScrapeRun,
  initializeDb,
  Card,
} from '../db/client.js';
import { scrapeListingsViaApi, scrapeListings } from '../tcg/scrapeListings.js';

// Path to browser session data
const USER_DATA_DIR = join(process.cwd(), '.browser-data');
const CHROME_USER_DATA = '/Users/evanzecher/Library/Application Support/Google/Chrome';
const CHROME_PROFILE = 'Default';

export interface UpdateListingsOptions {
  productIds?: number[];     // Specific products to update
  limit?: number;            // Max number of products to process
  headless?: boolean;
  useChrome?: boolean;       // Use real Chrome profile
}

/**
 * Run the listings update job
 */
export async function updateListings(options: UpdateListingsOptions = {}): Promise<void> {
  const { 
    productIds, 
    limit, 
    headless = true,
    useChrome = false,
  } = options;
  
  console.log('\n=== Update Listings Job ===');
  console.log(`Headless: ${headless}`);
  console.log(`Use Chrome: ${useChrome}`);
  if (limit) console.log(`Limit: ${limit} products`);
  console.log('Filters: English only, Near Mint only');
  console.log('');
  
  // Initialize database
  initializeDb();
  
  // Get cards to process
  let cards: Card[];
  
  if (productIds && productIds.length > 0) {
    cards = getAllCards().filter(c => productIds.includes(c.product_id));
    console.log(`Processing ${cards.length} specified products`);
  } else {
    cards = getAllCards();
    console.log(`Processing all ${cards.length} products`);
  }
  
  if (limit && cards.length > limit) {
    cards = cards.slice(0, limit);
    console.log(`Limited to first ${limit} products`);
  }
  
  if (cards.length === 0) {
    console.log('No products to process.');
    return;
  }
  
  // Start scrape run
  const runId = startScrapeRun('listings');
  console.log(`Started scrape run #${runId}\n`);
  
  let browser: Browser | null = null;
  let page: Page | null = null;
  let totalListingsFound = 0;
  let totalErrors = 0;
  let productsProcessed = 0;
  let productsWithListings = 0;
  
  try {
    // Launch browser
    let context;
    if (useChrome) {
      console.log('Launching with your Chrome profile...');
      context = await chromium.launchPersistentContext(
        join(CHROME_USER_DATA, CHROME_PROFILE),
        {
          headless: false,
          viewport: { width: 1280, height: 800 },
          channel: 'chrome',
        }
      );
    } else {
      console.log('Launching browser...');
      context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless,
        viewport: { width: 1280, height: 800 },
      });
    }
    browser = context.browser();
    page = context.pages()[0] || await context.newPage();
    
    // Process each card
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const progress = `[${i + 1}/${cards.length}]`;
      
      try {
        console.log(`${progress} ${card.name} (${card.product_id})...`);
        
        // Try API first, then UI fallback
        let summary = await scrapeListingsViaApi(page, card.product_id);
        
        // If API didn't work, try UI scraping
        if (summary.listing_count === 0 && card.tcg_url) {
          summary = await scrapeListings(page, card.product_id, card.tcg_url, card.name, card.product_type);
        }
        
        // Update database
        updateCardListings(
          card.product_id,
          summary.lowest_price,
          summary.lowest_price_with_shipping,
          summary.listing_count
        );
        
        if (summary.listing_count > 0) {
          productsWithListings++;
          totalListingsFound += summary.listing_count;
        }
        
        productsProcessed++;
        
        // Update run progress
        updateScrapeRun(runId, { 
          products_scraped: productsProcessed,
          sales_scraped: totalListingsFound, // Reusing field
        });
        
      } catch (error) {
        console.error(`  → Error: ${error}`);
        totalErrors++;
        updateScrapeRun(runId, { errors: totalErrors });
      }
      
      // Delay between requests
      if (i < cards.length - 1) {
        await page.waitForTimeout(REQUEST_DELAY_MS);
      }
    }
    
    // Summary
    console.log('\n=== Summary ===');
    console.log(`Products processed: ${productsProcessed}`);
    console.log(`Products with listings: ${productsWithListings}`);
    console.log(`Total listings found: ${totalListingsFound}`);
    console.log(`Errors: ${totalErrors}`);
    
    // Finish run
    const status = totalErrors === 0 ? 'success' : 
                   totalErrors < productsProcessed ? 'partial' : 'error';
    finishScrapeRun(runId, status);
    
  } catch (error) {
    console.error('Job failed:', error);
    finishScrapeRun(runId, 'error', String(error));
    throw error;
    
  } finally {
    if (page) {
      const context = page.context();
      await context.close();
    }
    console.log('\nBrowser closed.');
  }
}

