/**
 * Update Sales Job
 * 
 * Fetches latest sales data for all tracked products
 */

import { chromium, Page, BrowserContext } from 'playwright';
import { REQUEST_DELAY_MS } from '../config.js';
import { join } from 'path';
import fs from 'fs';

// Path to store browser session data (keeps you logged in)
const USER_DATA_DIR = join(process.cwd(), '.browser-data');

// Path to saved TCGplayer cookies (from tcg-login command)
const COOKIES_FILE = join(process.cwd(), 'tcgplayer-cookies.json');

// Path to your actual Chrome profile (for login persistence)
const CHROME_USER_DATA = '/Users/evanzecher/Library/Application Support/Google/Chrome';
const CHROME_PROFILE = 'Default';

/**
 * Load saved cookies from file or environment variable
 * Priority: 1. Local file, 2. TCGPLAYER_COOKIES env var (base64 encoded)
 */
async function loadSavedCookies(context: BrowserContext): Promise<boolean> {
  try {
    // Try local file first
    if (fs.existsSync(COOKIES_FILE)) {
      const cookiesJson = fs.readFileSync(COOKIES_FILE, 'utf-8');
      const cookies = JSON.parse(cookiesJson);
      await context.addCookies(cookies);
      console.log(`✅ Loaded ${cookies.length} cookies from file (logged-in session)`);
      return true;
    }
    
    // Try environment variable (base64 encoded)
    if (process.env.TCGPLAYER_COOKIES) {
      const cookiesJson = Buffer.from(process.env.TCGPLAYER_COOKIES, 'base64').toString('utf-8');
      const cookies = JSON.parse(cookiesJson);
      await context.addCookies(cookies);
      console.log(`✅ Loaded ${cookies.length} cookies from env var (logged-in session)`);
      return true;
    }
  } catch (error) {
    console.log(`⚠️ Could not load cookies: ${error}`);
  }
  console.log(`ℹ️ No saved cookies found. Run "npm run dev tcg-login" to save login.`);
  return false;
}

import { 
  initPostgres,
  pgGetAllCards, 
  pgSaveSaleEventsBatch, 
  pgStartScrapeRun, 
  pgCompleteScrapeRun,
  pgCountSales,
  pgSaveMarketSnapshot,
  PgCard,
} from '../db/postgres.js';
import { 
  getProductSales, 
  NormalizedSale, 
  GetProductSalesOptions,
  AdaptiveRateLimiter,
} from '../tcg/scrapeProductSales.js';

export interface UpdateSalesOptions {
  productIds?: number[];     // Specific products to update (default: all)
  setName?: string;          // Filter by set name
  limit?: number;            // Max number of products to process
  headless?: boolean;
  useApi?: boolean;          // Try API first before UI scraping
  useChrome?: boolean;       // Use real Chrome profile (for login)
  workers?: number;          // Number of parallel browser tabs (1-4)
  collectionOnly?: boolean;  // Only update collection items (much faster!)
  fastMode?: boolean;        // Reduce delays for faster processing
}

/**
 * Convert NormalizedSale to the format expected by saveSaleEvents
 */
function convertSalesForDb(sales: NormalizedSale[]): Array<{
  sold_at: Date | string;
  price: number;
  condition: string | null;
  listing_type: string | null;
  quantity: number;
  source_raw: string | null;
}> {
  return sales.map(sale => ({
    sold_at: sale.sold_at,
    price: sale.price,
    condition: sale.condition,
    listing_type: sale.listing_type,
    quantity: sale.quantity,
    source_raw: sale.source_raw,
  }));
}

/**
 * Process a single card's sales
 */
async function processCardSales(
  page: Page,
  card: PgCard,
  runId: number,
  request?: any,
  salesOptions?: GetProductSalesOptions
): Promise<{ salesFound: number; salesInserted: number; error: boolean; rateLimited: boolean }> {
  try {
    const result = await getProductSales(page, card.product_id, card.tcg_url || '', request, salesOptions);
    
    if (result.sales.length > 0) {
      // Batch insert all sales at once (much faster than individual inserts!)
      const insertedCount = await pgSaveSaleEventsBatch(
        card.product_id,
        result.sales.map(sale => ({
          sold_at: sale.sold_at,
          condition: sale.condition,
          variant: null,
          quantity: sale.quantity,
          price: sale.price,
        }))
      );
      return { salesFound: result.sales.length, salesInserted: insertedCount, error: false, rateLimited: false };
    }
    
    return { salesFound: 0, salesInserted: 0, error: false, rateLimited: result.rateLimited };
  } catch {
    return { salesFound: 0, salesInserted: 0, error: true, rateLimited: false };
  }
}

/**
 * Run the sales update job
 */
export async function updateSales(options: UpdateSalesOptions = {}): Promise<void> {
  const { 
    productIds, 
    setName,
    limit, 
    headless = false,  // Default to visible - TCGplayer blocks headless
    useApi = true,
    useChrome = false,
    workers = 1,
    collectionOnly = false,
    fastMode = false,
  } = options;
  
  const numWorkers = Math.min(Math.max(1, workers), 4);
  // Use shorter delay in fast mode (API can handle it)
  const delayMs = fastMode ? 300 : REQUEST_DELAY_MS;
  
  console.log('\n=== Update Sales Job ===');
  console.log(`Use API: ${useApi}`);
  if (numWorkers > 1) console.log(`Workers: ${numWorkers} (parallel)`);
  if (collectionOnly) console.log(`Mode: Collection only ⭐`);
  if (fastMode) console.log(`Fast mode: ${delayMs}ms delay`);
  if (setName) console.log(`Set filter: ${setName}`);
  if (limit) console.log(`Limit: ${limit} products`);
  console.log('');
  
  // Initialize PostgreSQL database
  await initPostgres();
  
  const initialSalesCount = await pgCountSales();
  console.log(`Current sales in DB: ${initialSalesCount}`);
  
  // Get cards to process
  const allCards = await pgGetAllCards();
  let cards: PgCard[];
  
  if (collectionOnly) {
    // Only process cards in the user's collection
    cards = allCards.filter(c => c.in_collection);
    console.log(`Processing ${cards.length} collection items ⭐`);
  } else if (productIds && productIds.length > 0) {
    cards = allCards.filter(c => productIds.includes(c.product_id));
    console.log(`Processing ${cards.length} specified products`);
  } else if (setName) {
    // Filter by set name (case-insensitive partial match)
    cards = allCards.filter(c => 
      c.set_name?.toLowerCase().includes(setName.toLowerCase())
    );
    console.log(`Processing ${cards.length} products from "${setName}"`);
  } else {
    cards = allCards;
    console.log(`Processing all ${cards.length} products`);
  }
  
  if (limit && cards.length > limit) {
    cards = cards.slice(0, limit);
    console.log(`Limited to first ${limit} products`);
  }
  
  if (cards.length === 0) {
    console.log('No products to process. Run update-products first.');
    return;
  }
  
  // Start scrape run
  const runId = await pgStartScrapeRun('sales', collectionOnly ? 'collection' : 'all');
  console.log(`Started scrape run #${runId}\n`);
  
  let totalSalesScraped = 0;
  let totalErrors = 0;
  let productsProcessed = 0;
  
  try {
    // Launch browser
    let context;
    if (useChrome) {
      console.log('Launching with your Chrome profile (logged in)...');
      context = await chromium.launchPersistentContext(
        join(CHROME_USER_DATA, CHROME_PROFILE),
        {
          headless: false,  // Must be visible when using Chrome profile
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
    
    // Load saved cookies for logged-in session (more sales data!)
    const hasCookies = await loadSavedCookies(context);
    if (hasCookies) {
      console.log('📊 Using logged-in session - will have access to full sales history!');
    }
    
    // Get API request context for faster fetching
    const request = useApi ? context.request : undefined;
    const startTime = Date.now();
    
    // Create adaptive rate limiter - starts fast, slows on 403s, speeds up on success
    // 800ms = ~75 req/min, safely under TCGplayer's rate limit
    const rateLimiter = new AdaptiveRateLimiter({
      minDelay: fastMode ? 800 : 1000,
      maxDelay: 15000,  // Max 15 seconds between requests when heavily rate limited
      startDelay: fastMode ? 800 : delayMs,
    });
    
    // In fast mode, skip slow UI fallback when API fails (just skip those cards)
    const salesOptions: GetProductSalesOptions = { 
      skipUiFallback: fastMode,
      rateLimiter,
    };
    let skippedCount = 0;
    
    if (numWorkers === 1) {
      // Single worker - detailed output
      const page = context.pages()[0] || await context.newPage();
      
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        process.stdout.write(`[${i + 1}/${cards.length}] ${card.name.substring(0, 40).padEnd(40)}...`);
        
        const result = await processCardSales(page, card, runId, request, salesOptions);
        
        if (result.error) {
          console.log(' ERROR');
          totalErrors++;
        } else if (result.salesInserted > 0) {
          console.log(` +${result.salesInserted} new (${result.salesFound} total)`);
          totalSalesScraped += result.salesInserted;
        } else if (result.rateLimited) {
          console.log(' (rate limited - will retry slower)');
          skippedCount++;
        } else if (result.salesFound === 0 && fastMode) {
          console.log(' (no sales)');
        } else {
          console.log(` ${result.salesFound} sales (0 new)`);
        }
        
        productsProcessed++;
        // Progress updates now happen at the end with pgCompleteScrapeRun
        
        // Use adaptive delay
        if (i < cards.length - 1) {
          await rateLimiter.wait();
        }
      }
    } else {
      // Parallel workers - progress bar output
      // Note: With rate limiting, parallel may not be faster since we need to respect limits
      const pages: Page[] = [];
      for (let i = 0; i < numWorkers; i++) {
        pages.push(await context.newPage());
      }
      
      for (let i = 0; i < cards.length; i += numWorkers) {
        const batch = cards.slice(i, Math.min(i + numWorkers, cards.length));
        
        const results = await Promise.all(
          batch.map((card, idx) => processCardSales(pages[idx], card, runId, request, salesOptions))
        );
        
        let batchRateLimited = false;
        for (const result of results) {
          productsProcessed++;
          if (result.error) {
            totalErrors++;
          } else {
            totalSalesScraped += result.salesInserted;
          }
          if (result.rateLimited) {
            batchRateLimited = true;
            skippedCount++;
          }
        }
        
        const pct = Math.round((productsProcessed / cards.length) * 100);
        const delayInfo = rateLimiter.isSlowed() ? ` | Delay: ${rateLimiter.getDelay()}ms` : '';
        process.stdout.write(`\r⏳ Progress: ${pct}% (${productsProcessed}/${cards.length}) | New sales: ${totalSalesScraped}${delayInfo}   `);
        
        // Use adaptive delay
        if (i + numWorkers < cards.length) {
          await rateLimiter.wait();
        }
      }
      console.log('');
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Summary
    console.log('\n=== Summary ===');
    console.log(`Products processed: ${productsProcessed}`);
    console.log(`New sales scraped: ${totalSalesScraped}`);
    if (skippedCount > 0) console.log(`Skipped (API unavailable): ${skippedCount}`);
    console.log(`Errors: ${totalErrors}`);
    console.log(`Time: ${elapsed}s (${(cards.length / parseFloat(elapsed)).toFixed(1)} products/sec)`);
    
    const finalSalesCount = await pgCountSales();
    console.log(`\nSales in DB: ${initialSalesCount} → ${finalSalesCount} (+${finalSalesCount - initialSalesCount})`);
    
    // Save market snapshot for trend tracking (includes last sale value)
    console.log('\n📊 Saving market snapshot...');
    const snapshot = await pgSaveMarketSnapshot();
    console.log(`   Total Market Value: $${snapshot.total_market_value.toLocaleString()}`);
    console.log(`   Total Last Sale Value: $${snapshot.total_last_sale_value.toLocaleString()}`);
    
    // Finish run
    const status = totalErrors === 0 ? 'completed' : 
                   totalErrors < productsProcessed ? 'partial' : 'error';
    await pgCompleteScrapeRun(runId, {
      products_scraped: productsProcessed,
      new_sales: totalSalesScraped,
      errors: totalErrors,
      status,
    });
    
    await context.close();
    console.log('\nBrowser closed.');
    
  } catch (error) {
    console.error('Job failed:', error);
    await pgCompleteScrapeRun(runId, {
      products_scraped: productsProcessed,
      new_sales: totalSalesScraped,
      errors: totalErrors + 1,
      status: 'error',
    });
    throw error;
  }
}

/**
 * Update sales for a single product
 */
export async function updateSalesForProduct(productId: number): Promise<void> {
  await updateSales({
    productIds: [productId],
    headless: true,
  });
}

/**
 * Quick sales update - limited to first N products
 */
export async function quickSalesUpdate(limit = 10): Promise<void> {
  await updateSales({
    limit,
    headless: true,
  });
}

