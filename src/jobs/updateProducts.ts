/**
 * Update Products Job
 * 
 * Scrapes TCGplayer search pages to discover and update One Piece products
 */

import { chromium, Browser, Page } from 'playwright';
import { 
  buildSearchUrl, 
  MAX_PAGES_PER_SEARCH, 
  ProductMode,
  ONE_PIECE_SETS,
} from '../config.js';
import { 
  saveCard, 
  startScrapeRun, 
  updateScrapeRun, 
  finishScrapeRun,
  countCards,
  initializeDb,
} from '../db/client.js';
import { scrapeAllSearchPages, ScrapedProduct } from '../tcg/scrapeSearchPage.js';

export interface UpdateProductsOptions {
  mode: ProductMode;
  setName?: string;
  maxPages?: number;
  headless?: boolean;
}

/**
 * Save scraped products to database
 */
function saveProducts(products: ScrapedProduct[]): number {
  let saved = 0;
  
  for (const product of products) {
    try {
      saveCard({
        product_id: product.productId,
        name: product.name,
        set_name: product.setName,
        product_type: product.productType,
        market_price: product.marketPrice,
        tcg_url: product.tcgUrl,
      });
      saved++;
    } catch (error) {
      console.error(`Failed to save product ${product.productId}:`, error);
    }
  }
  
  return saved;
}

/**
 * Run the product update job
 */
export async function updateProducts(options: UpdateProductsOptions): Promise<void> {
  const { mode, setName, maxPages = MAX_PAGES_PER_SEARCH, headless = true } = options;
  
  console.log('\n=== Update Products Job ===');
  console.log(`Mode: ${mode}`);
  if (setName) console.log(`Set: ${setName}`);
  console.log(`Max pages: ${maxPages}`);
  console.log(`Headless: ${headless}`);
  console.log('');
  
  // Initialize database
  initializeDb();
  
  const initialCount = countCards();
  console.log(`Current cards in DB: ${initialCount}`);
  
  // Start scrape run
  const runId = startScrapeRun('products', mode);
  console.log(`Started scrape run #${runId}\n`);
  
  let browser: Browser | null = null;
  let page: Page | null = null;
  let totalProducts = 0;
  let totalErrors = 0;
  
  try {
    // Launch browser
    console.log('Launching browser...');
    browser = await chromium.launch({ headless });
    page = await browser.newPage();
    
    // Set a realistic viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    
    // Build the search URL
    const baseUrl = buildSearchUrl(mode, 1, setName);
    console.log(`Starting URL: ${baseUrl}\n`);
    
    // Scrape all pages
    const products = await scrapeAllSearchPages(page, baseUrl, maxPages, (pageNum, pageProducts) => {
      console.log(`  Page ${pageNum}: ${pageProducts.length} products`);
      
      // Save products as we go
      const saved = saveProducts(pageProducts);
      totalProducts += saved;
      
      // Update run progress
      updateScrapeRun(runId, { products_scraped: totalProducts });
    });
    
    console.log(`\nTotal products found: ${products.length}`);
    console.log(`Total products saved: ${totalProducts}`);
    
    const finalCount = countCards();
    console.log(`\nCards in DB: ${initialCount} → ${finalCount} (+${finalCount - initialCount})`);
    
    // Finish run
    finishScrapeRun(runId, totalErrors > 0 ? 'partial' : 'success');
    
  } catch (error) {
    console.error('Job failed:', error);
    totalErrors++;
    
    finishScrapeRun(runId, 'error', String(error));
    throw error;
    
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
    console.log('\nBrowser closed.');
  }
}

/**
 * Update products for all known sets
 */
export async function updateAllSets(options: Omit<UpdateProductsOptions, 'setName'>): Promise<void> {
  console.log('\n=== Update All Sets ===');
  console.log(`Processing ${ONE_PIECE_SETS.length} sets...\n`);
  
  for (const set of ONE_PIECE_SETS) {
    console.log(`\n--- Processing set: ${set.name} ---`);
    
    try {
      await updateProducts({
        ...options,
        setName: set.slug,
      });
    } catch (error) {
      console.error(`Failed to process set ${set.name}:`, error);
      // Continue with next set
    }
  }
  
  console.log('\n=== Finished all sets ===');
}

/**
 * Quick update - just singles mode, limited pages
 */
export async function quickUpdate(): Promise<void> {
  await updateProducts({
    mode: 'singles',
    maxPages: 10,
    headless: true,
  });
}

