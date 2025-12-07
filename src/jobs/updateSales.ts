/**
 * Update Sales Job
 * 
 * Fetches latest sales data for all tracked products
 */

import { chromium, Browser, Page } from 'playwright';
import { REQUEST_DELAY_MS } from '../config.js';
import { join } from 'path';

// Path to store browser session data (keeps you logged in)
const USER_DATA_DIR = join(process.cwd(), '.browser-data');

// Path to your actual Chrome profile (for login persistence)
const CHROME_USER_DATA = '/Users/evanzecher/Library/Application Support/Google/Chrome';
const CHROME_PROFILE = 'Default';

import { 
  getAllCards, 
  saveSaleEvents, 
  startScrapeRun, 
  updateScrapeRun, 
  finishScrapeRun,
  countSales,
  initializeDb,
  Card,
} from '../db/client.js';
import { getProductSales, NormalizedSale } from '../tcg/scrapeProductSales.js';

export interface UpdateSalesOptions {
  productIds?: number[];     // Specific products to update (default: all)
  setName?: string;          // Filter by set name
  limit?: number;            // Max number of products to process
  headless?: boolean;
  useApi?: boolean;          // Try API first before UI scraping
  useChrome?: boolean;       // Use real Chrome profile (for login)
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
 * Run the sales update job
 */
export async function updateSales(options: UpdateSalesOptions = {}): Promise<void> {
  const { 
    productIds, 
    setName,
    limit, 
    headless = true, 
    useApi = true,
    useChrome = false,
  } = options;
  
  console.log('\n=== Update Sales Job ===');
  console.log(`Headless: ${headless}`);
  console.log(`Use API: ${useApi}`);
  if (setName) console.log(`Set filter: ${setName}`);
  if (limit) console.log(`Limit: ${limit} products`);
  console.log('');
  
  // Initialize database
  initializeDb();
  
  const initialSalesCount = countSales();
  console.log(`Current sales in DB: ${initialSalesCount}`);
  
  // Get cards to process
  let cards: Card[];
  
  if (productIds && productIds.length > 0) {
    cards = getAllCards().filter(c => productIds.includes(c.product_id));
    console.log(`Processing ${cards.length} specified products`);
  } else if (setName) {
    // Filter by set name (case-insensitive partial match)
    cards = getAllCards().filter(c => 
      c.set_name?.toLowerCase().includes(setName.toLowerCase())
    );
    console.log(`Processing ${cards.length} products from "${setName}"`);
  } else {
    cards = getAllCards();
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
  const runId = startScrapeRun('sales');
  console.log(`Started scrape run #${runId}\n`);
  
  let browser: Browser | null = null;
  let page: Page | null = null;
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
      console.log('Launching browser (using saved session)...');
      context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless,
        viewport: { width: 1280, height: 800 },
      });
    }
    browser = context.browser();
    page = context.pages()[0] || await context.newPage();
    
    // Get API request context for faster fetching
    const request = useApi ? context.request : undefined;
    
    // Process each card
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const progress = `[${i + 1}/${cards.length}]`;
      
      try {
        console.log(`${progress} ${card.name} (${card.product_id})...`);
        
        // Get sales for this product
        const sales = await getProductSales(
          page, 
          card.product_id, 
          card.tcg_url, 
          request
        );
        
        if (sales.length > 0) {
          // Save to database
          const inserted = saveSaleEvents(
            card.product_id, 
            convertSalesForDb(sales),
            runId
          );
          
          console.log(`  → ${sales.length} sales found, ${inserted} new`);
          totalSalesScraped += inserted;
        } else {
          console.log(`  → No sales found`);
        }
        
        productsProcessed++;
        
        // Update run progress
        updateScrapeRun(runId, { 
          products_scraped: productsProcessed,
          sales_scraped: totalSalesScraped,
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
    console.log(`New sales scraped: ${totalSalesScraped}`);
    console.log(`Errors: ${totalErrors}`);
    
    const finalSalesCount = countSales();
    console.log(`\nSales in DB: ${initialSalesCount} → ${finalSalesCount} (+${finalSalesCount - initialSalesCount})`);
    
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

