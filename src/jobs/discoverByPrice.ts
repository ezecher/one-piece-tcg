/**
 * Discover By Price Job
 * 
 * Scrapes ALL One Piece products sorted by price (high to low)
 * until prices drop below a threshold. This captures every valuable
 * card regardless of which set it belongs to.
 */

import { chromium, Browser, Page } from 'playwright';
import { join } from 'path';
import { 
  TCGPLAYER_BASE_URL,
  MIN_MARKET_PRICE,
  REQUEST_DELAY_MS,
} from '../config.js';
import { 
  initPostgres,
  pgSaveCard,
  pgUpdateCardPrice,
  pgGetAllCards,
  pgCountCards,
  pgStartScrapeRun,
  pgCompleteScrapeRun,
  PgCard,
} from '../db/postgres.js';
import { ScrapedProduct } from '../tcg/scrapeSearchPage.js';

// Path to store browser session data
const USER_DATA_DIR = join(process.cwd(), '.browser-data');

export interface DiscoverByPriceOptions {
  mode?: 'singles' | 'sealed' | 'all';  // What to search for
  minPrice?: number;                     // Stop when prices drop below this (default: 10)
  maxPages?: number;                     // Safety limit on pages
  headless?: boolean;
}

/**
 * Build URL for One Piece search with page number
 * Using the exact URL format from TCGplayer that the user confirmed works
 */
function buildSearchUrl(page: number = 1): string {
  // Exact URL format: https://www.tcgplayer.com/search/one-piece-card-game/product?productLineName=one-piece-card-game&page=1&view=grid
  return `${TCGPLAYER_BASE_URL}/search/one-piece-card-game/product?productLineName=one-piece-card-game&page=${page}&view=grid`;
}

/**
 * Wait for search results to load
 */
async function waitForResults(page: Page): Promise<void> {
  try {
    await page.waitForSelector('a[href*="/product/"]', { timeout: 15000 });
    await page.waitForTimeout(1500);
  } catch {
    console.log('    ⚠️  Timeout waiting for results');
  }
}

/**
 * Click the sort dropdown and select "Price: High to Low"
 */
async function sortByPriceHighToLow(page: Page): Promise<boolean> {
  try {
    // The sort dropdown shows "Sort & View" label and current selection
    // Try multiple selectors to find the sort dropdown
    const sortSelectors = [
      'button:has-text("Price")',
      'button:has-text("Sort")',
      '[class*="sort"] button',
      'button:has-text("Toggle listbox")',
      '[aria-label*="sort"]',
    ];
    
    let clicked = false;
    for (const selector of sortSelectors) {
      try {
        const btn = await page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          await page.waitForTimeout(800);
          clicked = true;
          break;
        }
      } catch {
        // Try next selector
      }
    }
    
    if (!clicked) {
      console.log('  ⚠️  Could not find sort dropdown');
      return false;
    }
    
    // Now click "Price: High to Low" option
    await page.waitForTimeout(500);
    const priceHighOption = await page.locator('text=Price: High to Low').first();
    if (await priceHighOption.isVisible({ timeout: 3000 })) {
      await priceHighOption.click();
      await page.waitForTimeout(3000); // Wait for results to reload
      console.log('  ✓ Sorted by Price: High to Low');
      return true;
    }
    
    console.log('  ⚠️  Could not find "Price: High to Low" option');
    return false;
  } catch (error) {
    console.log('  ⚠️  Could not change sort order:', error);
    return false;
  }
}

/**
 * Parse market price from text
 */
function parseMarketPrice(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/\$?([\d,]+\.?\d*)/);
  if (match) {
    return parseFloat(match[1].replace(',', ''));
  }
  return null;
}

/**
 * Determine product type from URL or name
 */
function inferProductType(url: string, name: string): 'single' | 'sealed' {
  const sealedKeywords = ['booster box', 'booster pack', 'case', 'starter deck', 'bundle', 'display'];
  const lowerUrl = url.toLowerCase();
  const lowerName = name.toLowerCase();
  
  for (const keyword of sealedKeywords) {
    if (lowerUrl.includes(keyword.replace(' ', '-')) || lowerName.includes(keyword)) {
      return 'sealed';
    }
  }
  return 'single';
}

/**
 * Scrape products from the current page
 */
async function scrapeCurrentPage(page: Page): Promise<ScrapedProduct[]> {
  const products = await page.evaluate((baseUrl) => {
    const results: Array<{
      productId: number | null;
      name: string;
      setName: string | null;
      marketPriceText: string | null;
      href: string;
    }> = [];
    
    const productLinks = document.querySelectorAll('a[href*="/product/"]');
    const seen = new Set<string>();
    
    productLinks.forEach((link) => {
      const href = (link as HTMLAnchorElement).href;
      
      const productIdMatch = href.match(/\/product\/(\d+)/);
      if (!productIdMatch) return;
      
      const productId = productIdMatch[1];
      if (seen.has(productId)) return;
      seen.add(productId);
      
      const container = link.closest('[class*="product-card"], [class*="search-result"]') || link.parentElement;
      if (!container) return;
      
      // Get product name
      let name = '';
      const spans = container.querySelectorAll('span, div');
      for (const span of spans) {
        const text = span.textContent?.trim() || '';
        if (text.length > 3 && 
            text.length < 150 &&
            !text.includes('$') && 
            !text.includes('listing') &&
            !text.includes('Market Price') &&
            !text.startsWith('#')) {
          if (!name || text.length > name.length) {
            name = text;
          }
        }
      }
      
      // Fallback to link text
      if (!name) {
        const linkText = link.textContent?.trim() || '';
        const parts = linkText.split(/\d+ listings/)[0];
        if (parts) {
          name = parts.replace(/Market Price.*$/, '').trim();
        }
      }
      
      // Get set name
      let setName: string | null = null;
      const h4 = container.querySelector('h4');
      if (h4) {
        const setSpan = h4.querySelector('span, div');
        if (setSpan?.textContent) {
          setName = setSpan.textContent.trim();
        }
      }
      
      // Get market price
      let marketPriceText: string | null = null;
      const priceContainer = container.querySelector('[class*="market-price"], [class*="price"]');
      if (priceContainer?.textContent?.includes('Market Price')) {
        marketPriceText = priceContainer.textContent;
      } else {
        const allText = container.textContent || '';
        const priceMatch = allText.match(/Market Price[:\s]*\$[\d,]+\.?\d*/);
        if (priceMatch) {
          marketPriceText = priceMatch[0];
        }
      }
      
      if (name && name.length > 2) {
        results.push({
          productId: parseInt(productId, 10),
          name: name.substring(0, 200),
          setName,
          marketPriceText,
          href,
        });
      }
    });
    
    return results;
  }, TCGPLAYER_BASE_URL);
  
  return products
    .filter(p => p.productId !== null)
    .map(p => ({
      productId: p.productId!,
      name: p.name,
      setName: p.setName,
      marketPrice: parseMarketPrice(p.marketPriceText),
      productType: inferProductType(p.href, p.name),
      tcgUrl: p.href,
    }));
}

/**
 * Check if a product is a One Piece card (filter out other games)
 */
function isOnePieceProduct(product: ScrapedProduct): boolean {
  const url = product.tcgUrl.toLowerCase();
  const name = product.name.toLowerCase();
  const setName = (product.setName || '').toLowerCase();
  
  // Must contain "one-piece" in the URL
  if (!url.includes('one-piece')) {
    return false;
  }
  
  // Filter out obvious non-One Piece products by name
  const nonOnePieceKeywords = [
    'pokemon', 'magic:', 'mtg', 'yugioh', 'yu-gi-oh', 'digimon', 
    'final fantasy', 'dragon ball', 'flesh and blood', 'lorcana',
    'weiss schwarz', 'star wars', 'marvel', 'dc comics'
  ];
  
  for (const keyword of nonOnePieceKeywords) {
    if (name.includes(keyword) || setName.includes(keyword)) {
      return false;
    }
  }
  
  return true;
}

/**
 * Save scraped products to PostgreSQL database
 * For existing cards: only update price (preserve existing name)
 * For new cards: save everything
 */
async function saveProducts(
  products: ScrapedProduct[], 
  existingProductIds: Set<number>
): Promise<{ saved: number; updated: number; filtered: number }> {
  let saved = 0;
  let updated = 0;
  let filtered = 0;
  
  for (const product of products) {
    // Skip non-One Piece products
    if (!isOnePieceProduct(product)) {
      filtered++;
      continue;
    }
    
    try {
      const isExisting = existingProductIds.has(product.productId);
      
      if (isExisting) {
        // Existing card - ONLY update price, preserve name
        await pgUpdateCardPrice(product.productId, product.marketPrice || undefined);
        updated++;
      } else {
        // New card - save everything including name
        await pgSaveCard({
          product_id: product.productId,
          name: product.name,
          set_name: product.setName || undefined,
          product_type: product.productType,
          market_price: product.marketPrice || undefined,
          tcg_url: product.tcgUrl,
        });
        saved++;
      }
    } catch (error) {
      // Error saving/updating
      console.log(`    ⚠️ Error saving ${product.productId}: ${error}`);
    }
  }
  
  return { saved, updated, filtered };
}

/**
 * Navigate to next page by clicking pagination
 */
async function goToNextPage(page: Page, currentPage: number): Promise<boolean> {
  try {
    // Scroll to bottom to reveal pagination
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    
    // Try the ">" next arrow first (most reliable)
    // The pagination looks like: 1 2 3 4 5 ... 200 >
    const nextSelectors = [
      'a[aria-label="Next page"]',
      'button[aria-label="Next page"]', 
      'a:has-text(">")',
      '.tcg-pagination a:last-child',
    ];
    
    for (const selector of nextSelectors) {
      try {
        const nextBtn = await page.locator(selector).first();
        if (await nextBtn.isVisible({ timeout: 2000 })) {
          const isDisabled = await nextBtn.getAttribute('disabled');
          const ariaDisabled = await nextBtn.getAttribute('aria-disabled');
          if (isDisabled !== 'true' && ariaDisabled !== 'true') {
            console.log(`    → Clicking next page...`);
            await nextBtn.click();
            await page.waitForTimeout(2500);
            await waitForResults(page);
            return true;
          }
        }
      } catch {
        // Try next selector
      }
    }
    
    // Fallback: Try clicking the next page number directly
    const nextPageNum = currentPage + 1;
    try {
      const pageLink = await page.locator(`a:has-text("${nextPageNum}")`).first();
      if (await pageLink.isVisible({ timeout: 2000 })) {
        console.log(`    → Clicking page ${nextPageNum}...`);
        await pageLink.click();
        await page.waitForTimeout(2500);
        await waitForResults(page);
        return true;
      }
    } catch {
      // No page link found
    }
    
    return false;
  } catch (e) {
    console.log(`    ⚠️ Navigation error: ${e}`);
    return false;
  }
}

/**
 * Discover all valuable products by price
 */
export async function discoverByPrice(options: DiscoverByPriceOptions = {}): Promise<void> {
  const { 
    mode = 'singles',
    minPrice = MIN_MARKET_PRICE,
    maxPages = 200,
    headless = false,
  } = options;
  
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║      DISCOVER ALL CARDS BY PRICE               ║');
  console.log('╚════════════════════════════════════════════════╝\n');
  console.log(`Mode: ${mode}`);
  console.log(`Min price threshold: $${minPrice}`);
  console.log(`Max pages: ${maxPages}`);
  console.log(`Headless: ${headless}`);
  console.log('');
  
  // Initialize PostgreSQL database
  await initPostgres();
  
  // Get existing product IDs to track new discoveries
  const existingCards = await pgGetAllCards();
  const existingProductIds = new Set(existingCards.map(c => c.product_id));
  console.log(`📊 Existing cards in DB: ${existingCards.length}`);
  
  // Start scrape run
  const runId = await pgStartScrapeRun('products', `price-discovery-${mode}`);
  console.log(`Started scrape run #${runId}\n`);
  
  let totalProducts = 0;
  let newProducts = 0;
  let totalErrors = 0;
  let lowestPriceSeen = Infinity;
  let stoppedAtPrice = false;
  let currentPage = 0;
  
  try {
    // Launch browser with persistent context
    console.log('🚀 Launching browser...\n');
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless,
      viewport: { width: 1400, height: 900 },
    });
    const page = context.pages()[0] || await context.newPage();
    
    // Navigate to first page - using exact URL format from user
    const firstUrl = buildSearchUrl(1);
    console.log(`📄 Loading: ${firstUrl}`);
    await page.goto(firstUrl, { waitUntil: 'domcontentloaded' });
    await waitForResults(page);
    
    // Sort by price high to low (this is crucial!)
    const sorted = await sortByPriceHighToLow(page);
    if (!sorted) {
      console.log('⚠️  Warning: Could not sort by price. Results may not be in order.');
    }
    await waitForResults(page);
    
    // Scrape pages until we hit the price threshold
    while (currentPage < maxPages) {
      currentPage++;
      
      // For pages after the first, navigate directly by URL
      if (currentPage > 1) {
        const pageUrl = buildSearchUrl(currentPage);
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`📄 Page ${currentPage}: ${pageUrl}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        
        try {
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await waitForResults(page);
          
          // Re-apply sort (TCGplayer may reset it on new page load)
          await sortByPriceHighToLow(page);
          await waitForResults(page);
        } catch (e) {
          console.log(`  ⚠️  Failed to load page: ${e}`);
          break;
        }
      } else {
        console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`📄 Page ${currentPage}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      }
      
      // Scrape products from this page
      let products: ScrapedProduct[];
      try {
        products = await scrapeCurrentPage(page);
      } catch (e) {
        console.log(`  ⚠️  Failed to scrape page: ${e}`);
        break;
      }
      
      if (products.length === 0) {
        console.log('  ⚠️  No products found, stopping.');
        break;
      }
      
      // Check prices on this page (One Piece products only)
      const onePieceProducts = products.filter(p => isOnePieceProduct(p));
      const pricesOnPage = onePieceProducts
        .filter(p => p.marketPrice !== null)
        .map(p => p.marketPrice!);
      
      if (pricesOnPage.length > 0) {
        const minOnPage = Math.min(...pricesOnPage);
        const maxOnPage = Math.max(...pricesOnPage);
        lowestPriceSeen = Math.min(lowestPriceSeen, minOnPage);
        
        console.log(`  💰 One Piece price range: $${maxOnPage.toFixed(2)} - $${minOnPage.toFixed(2)}`);
        
        // If ALL One Piece prices on page are below threshold, we're done
        if (maxOnPage < minPrice) {
          console.log(`\n✅ All One Piece prices on page below $${minPrice}, stopping!`);
          stoppedAtPrice = true;
          break;
        }
      } else {
        console.log(`  ℹ️  No One Piece products on this page`);
      }
      
      // Filter products above threshold (One Piece only)
      const valuableProducts = onePieceProducts.filter(p => 
        p.marketPrice === null || p.marketPrice >= minPrice
      );
      
      // Track new vs existing
      const newOnPage = valuableProducts.filter(p => !existingProductIds.has(p.productId));
      
      // Save products (only updates price for existing, full save for new)
      const { saved, updated, filtered } = await saveProducts(valuableProducts, existingProductIds);
      totalProducts += saved;
      newProducts += saved;  // Only count truly new cards
      
      // Add to existing set so we don't double-count
      for (const p of valuableProducts) {
        existingProductIds.add(p.productId);
      }
      
      console.log(`  ✓ Found ${products.length} total, ${onePieceProducts.length} One Piece, ${valuableProducts.length} above $${minPrice}`);
      console.log(`  ✓ New: ${saved}, Price updated: ${updated}, Filtered: ${filtered}`);
      
      // Show some examples
      if (newOnPage.length > 0) {
        console.log(`  📝 New cards:`);
        newOnPage.slice(0, 3).forEach(p => {
          const price = p.marketPrice ? `$${p.marketPrice.toFixed(2)}` : 'N/A';
          console.log(`      • ${p.name.substring(0, 45)}... (${price})`);
        });
      }
      
      // Update run progress (PostgreSQL doesn't have partial updates, we'll update at the end)
      
      // Be respectful with delay between pages
      await page.waitForTimeout(REQUEST_DELAY_MS);
    }
    
    // Summary
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║                   SUMMARY                       ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`Pages scraped: ${currentPage}`);
    console.log(`Total products saved: ${totalProducts}`);
    console.log(`New products discovered: ${newProducts}`);
    console.log(`Lowest price seen: $${lowestPriceSeen === Infinity ? 'N/A' : lowestPriceSeen.toFixed(2)}`);
    if (stoppedAtPrice) {
      console.log(`Stopped: Reached price threshold ($${minPrice})`);
    }
    
    const finalCount = await pgCountCards();
    console.log(`\nCards in DB: ${existingCards.length} → ${finalCount} (+${finalCount - existingCards.length})`);
    
    // Finish run
    await pgCompleteScrapeRun(runId, {
      products_scraped: totalProducts,
      status: totalErrors > 0 ? 'partial' : 'completed',
      errors: totalErrors,
    });
    
    await context.close();
    console.log('\n🏁 Browser closed.\n');
    
  } catch (error) {
    console.error('Job failed:', error);
    totalErrors++;
    await pgCompleteScrapeRun(runId, {
      products_scraped: totalProducts,
      status: 'error',
      errors: totalErrors,
    });
    throw error;
  }
}

/**
 * Discover all singles above $10
 */
export async function discoverAllValueSingles(): Promise<void> {
  await discoverByPrice({
    mode: 'singles',
    minPrice: 10,
    headless: false,
  });
}

/**
 * Discover all sealed products above $10
 */
export async function discoverAllValueSealed(): Promise<void> {
  await discoverByPrice({
    mode: 'sealed',
    minPrice: 10,
    headless: false,
  });
}

