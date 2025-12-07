/**
 * Scrape Top Cards Job
 * 
 * Iterates through each set, sorts by price high to low,
 * and scrapes the top cards (first few pages per set).
 * This is the most efficient way to track high-value cards.
 */

import { chromium, Browser, Page } from 'playwright';
import { 
  ONE_PIECE_SETS, 
  MAIN_BOOSTER_SETS,
  PAGES_PER_SET,
  REQUEST_DELAY_MS,
  buildSetSearchUrl,
  TCGPLAYER_BASE_URL,
} from '../config.js';
import { join } from 'path';
import { 
  saveCard, 
  startScrapeRun, 
  updateScrapeRun, 
  finishScrapeRun,
  countCards,
  initializeDb,
  updateCardListings,
} from '../db/client.js';
import { ScrapedProduct } from '../tcg/scrapeSearchPage.js';
import { scrapeListings } from '../tcg/scrapeListings.js';

export interface ScrapeTopCardsOptions {
  sets?: typeof ONE_PIECE_SETS;  // Which sets to scrape
  pagesPerSet?: number;           // How many pages per set (default 3)
  headless?: boolean;
  verbose?: boolean;              // Show detailed progress
  useChrome?: boolean;            // Use real Chrome profile (for login)
  withListings?: boolean;         // Also fetch listings for each card
}

// Path to store browser session data (keeps you logged in)
const USER_DATA_DIR = join(process.cwd(), '.browser-data');

// Path to your actual Chrome profile (for login persistence)
// macOS Chrome default profile location
const CHROME_USER_DATA = '/Users/evanzecher/Library/Application Support/Google/Chrome';
const CHROME_PROFILE = 'Default';  // or 'Profile 1', 'Profile 2', etc.

/**
 * Parse market price from text like "$12.34" or "Market Price: $12.34"
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
 * Scroll to the bottom of the page to load all content and reveal pagination
 */
async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
  await page.waitForTimeout(500);
}

/**
 * Click the sort dropdown and select "Price: High to Low"
 */
async function sortByPriceHighToLow(page: Page): Promise<boolean> {
  try {
    // Find and click the sort dropdown
    const sortButton = await page.$('button:has-text("Toggle listbox"), [class*="sort"] button');
    if (sortButton) {
      await sortButton.click();
      await page.waitForTimeout(500);
      
      // Click "Price: High to Low" option
      const priceHighOption = await page.$('text=Price: High to Low');
      if (priceHighOption) {
        await priceHighOption.click();
        await page.waitForTimeout(2000); // Wait for results to reload
        console.log('    ✓ Sorted by Price: High to Low');
        return true;
      }
    }
    
    // Alternative: Try direct URL parameter approach
    return false;
  } catch (error) {
    console.log('    ⚠️  Could not change sort order');
    return false;
  }
}

/**
 * Scrape products from the current page
 */
async function scrapeCurrentPage(page: Page, setName: string): Promise<ScrapedProduct[]> {
  const products = await page.evaluate((baseUrl) => {
    const results: Array<{
      productId: number | null;
      name: string;
      setName: string | null;
      marketPriceText: string | null;
      rarity: string | null;
      href: string;
    }> = [];
    
    // Find all product links
    const productLinks = document.querySelectorAll('a[href*="/product/"]');
    const seen = new Set<string>();
    
    productLinks.forEach((link) => {
      const href = (link as HTMLAnchorElement).href;
      
      // Extract product ID
      const productIdMatch = href.match(/\/product\/(\d+)/);
      if (!productIdMatch) return;
      
      const productId = productIdMatch[1];
      if (seen.has(productId)) return;
      seen.add(productId);
      
      // Find the product card container
      const container = link.closest('[class*="product-card"], [class*="search-result"]') || link.parentElement;
      if (!container) return;
      
      // Get product name
      let name = '';
      const nameEl = container.querySelector('h4, [class*="product-card__name"], [class*="product-name"]');
      if (nameEl) {
        // The name is usually in a span inside the h4, after the set name
        const spans = container.querySelectorAll('span, div');
        for (const span of spans) {
          const text = span.textContent?.trim() || '';
          // Skip set names, rarities, prices, and short text
          if (text.length > 3 && 
              text.length < 150 &&
              !text.includes('$') && 
              !text.includes('listing') &&
              !text.includes('Market Price') &&
              !text.startsWith('#')) {
            // This is likely the product name
            if (!name || text.length > name.length) {
              name = text;
            }
          }
        }
      }
      
      // Try to get name from link text as fallback
      if (!name) {
        const linkText = link.textContent?.trim() || '';
        // Extract just the card name part
        const parts = linkText.split(/\d+ listings/)[0];
        if (parts) {
          name = parts.replace(/Market Price.*$/, '').trim();
        }
      }
      
      // Get set name from heading
      let setNameFromPage: string | null = null;
      const h4 = container.querySelector('h4');
      if (h4) {
        const setSpan = h4.querySelector('span, div');
        if (setSpan?.textContent) {
          setNameFromPage = setSpan.textContent.trim();
        }
      }
      
      // Get rarity
      let rarity: string | null = null;
      const rarityEl = container.querySelector('[class*="rarity"]');
      if (rarityEl?.textContent) {
        const rarityText = rarityEl.textContent.trim();
        const rarityMatch = rarityText.match(/(Common|Uncommon|Rare|Super Rare|Secret Rare|Leader|DON!!|None)/i);
        if (rarityMatch) {
          rarity = rarityMatch[1];
        }
      }
      
      // Get market price
      let marketPriceText: string | null = null;
      const priceContainer = container.querySelector('[class*="market-price"], [class*="price"]');
      if (priceContainer?.textContent?.includes('Market Price')) {
        marketPriceText = priceContainer.textContent;
      } else {
        // Look for any price text
        const allText = container.textContent || '';
        const priceMatch = allText.match(/Market Price[:\s]*\$[\d,]+\.?\d*/);
        if (priceMatch) {
          marketPriceText = priceMatch[0];
        }
      }
      
      if (name && name.length > 2) {
        results.push({
          productId: parseInt(productId, 10),
          name: name.substring(0, 200), // Limit name length
          setName: setNameFromPage,
          marketPriceText,
          rarity,
          href,
        });
      }
    });
    
    return results;
  }, TCGPLAYER_BASE_URL);
  
  // Convert to ScrapedProduct format
  const scrapedProducts: ScrapedProduct[] = products
    .filter(p => p.productId !== null)
    .map(p => ({
      productId: p.productId!,
      name: p.name,
      setName: p.setName || setName,
      marketPrice: parseMarketPrice(p.marketPriceText),
      productType: inferProductType(p.href, p.name),
      tcgUrl: p.href,
      rarity: p.rarity || undefined,
    }));
  
  return scrapedProducts;
}

/**
 * Determine product type from URL or text
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
 * Check if there's a next page
 */
async function hasNextPage(page: Page, currentPage: number): Promise<boolean> {
  // Look for the "Next page" link that's not disabled
  const nextLink = await page.$('a[aria-label="Next page"]:not([disabled])');
  if (nextLink) {
    const isDisabled = await nextLink.getAttribute('disabled');
    return isDisabled !== 'true';
  }
  
  // Alternative: check for page number links
  const pageLinks = await page.$$('a[href*="page="]');
  for (const link of pageLinks) {
    const href = await link.getAttribute('href');
    if (href?.includes(`page=${currentPage + 1}`)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Save products to database
 */
function saveProducts(products: ScrapedProduct[], setName: string): number {
  let saved = 0;
  for (const product of products) {
    try {
      saveCard({
        product_id: product.productId,
        name: product.name,
        set_name: setName,
        product_type: product.productType,
        market_price: product.marketPrice,
        tcg_url: product.tcgUrl,
        rarity: (product as any).rarity || null,
      });
      saved++;
    } catch (error) {
      // Ignore duplicates
    }
  }
  return saved;
}

/**
 * Main job: Scrape top cards from each set
 */
export async function scrapeTopCards(options: ScrapeTopCardsOptions = {}): Promise<void> {
  const { 
    sets = MAIN_BOOSTER_SETS,
    pagesPerSet = PAGES_PER_SET,
    headless = true,
    verbose = true,
    useChrome = false,
    withListings = false,
  } = options;
  
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║       SCRAPE TOP CARDS FROM EACH SET           ║');
  console.log('╚════════════════════════════════════════════════╝\n');
  console.log(`Sets to process: ${sets.length}`);
  console.log(`Pages per set: ${pagesPerSet}`);
  console.log(`Headless: ${headless}`);
  console.log(`Fetch listings: ${withListings}`);
  console.log('');
  
  // Initialize database
  initializeDb();
  const initialCount = countCards();
  console.log(`📊 Current cards in DB: ${initialCount}\n`);
  
  // Start scrape run
  const runId = startScrapeRun('products', 'top-cards');
  
  let browser: Browser | null = null;
  let page: Page | null = null;
  let totalProducts = 0;
  let totalSaved = 0;
  
  try {
    if (useChrome) {
      console.log('🚀 Launching with your Chrome profile (logged in)...\n');
      // Use actual Chrome browser with your profile
      const context = await chromium.launchPersistentContext(
        join(CHROME_USER_DATA, CHROME_PROFILE),
        {
          headless: false,  // Must be visible when using Chrome profile
          viewport: { width: 1400, height: 900 },
          channel: 'chrome',  // Use installed Chrome
        }
      );
      browser = context.browser();
      page = context.pages()[0] || await context.newPage();
    } else {
      console.log('🚀 Launching browser...\n');
      // Use Playwright's browser with persistent session
      const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless,
        viewport: { width: 1400, height: 900 },
      });
      browser = context.browser();
      page = context.pages()[0] || await context.newPage();
    }
    
    // Process each set
    for (let setIndex = 0; setIndex < sets.length; setIndex++) {
      const set = sets[setIndex];
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📦 [${setIndex + 1}/${sets.length}] ${set.name}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      
      let setProducts = 0;
      const allSetProducts: ScrapedProduct[] = [];  // Collect all products for listings
      
      // First, navigate to the set and sort by price high to low
      const firstUrl = buildSetSearchUrl(set.slug, 1);
      if (verbose) console.log(`\n  📄 Loading set: ${firstUrl}`);
      
      try {
        await page.goto(firstUrl, { waitUntil: 'domcontentloaded' });
        await waitForResults(page);
        
        // Sort by price high to low (this is crucial!)
        await sortByPriceHighToLow(page);
        await waitForResults(page);
        
        // Now scrape pages by clicking "Next" to preserve sort order
        for (let pageNum = 1; pageNum <= pagesPerSet; pageNum++) {
          if (verbose) console.log(`\n  📄 Page ${pageNum}:`);
          
          // Scrape products from this page
          const products = await scrapeCurrentPage(page, set.name);
          
          if (products.length === 0) {
            console.log(`    ⚠️  No products found, stopping set`);
            break;
          }
          
          // Save to database
          const saved = saveProducts(products, set.name);
          setProducts += products.length;
          totalProducts += products.length;
          totalSaved += saved;
          
          // Collect ALL products for listings (singles get Near Mint, sealed get Unopened)
          allSetProducts.push(...products);
          
          if (verbose) {
            console.log(`    ✓ Found ${products.length} products (${saved} new)`);
            // Show top 3 products from this page
            products.slice(0, 3).forEach(p => {
              const price = p.marketPrice ? `$${p.marketPrice.toFixed(2)}` : 'N/A';
              console.log(`      • ${p.name.substring(0, 40)}... (${price})`);
            });
          }
          
          // Update run progress
          updateScrapeRun(runId, { products_scraped: totalProducts });
          
          // If fewer products than expected, might be last page
          if (products.length < 20) {
            console.log(`    ℹ️  Reached end of set (fewer products than expected)`);
            break;
          }
          
          // Navigate to next page if not on last page
          if (pageNum < pagesPerSet) {
            // Scroll to bottom to reveal pagination
            console.log(`    → Scrolling to pagination...`);
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(1000);
            
            // Click the next page number in pagination
            // The pagination buttons have classes like "tcg-button" and the page number as text
            const nextPageNum = pageNum + 1;
            
            try {
              // Find and click the page number link
              const pageLink = await page.locator(`a.tcg-button:has-text("${nextPageNum}")`).first();
              if (await pageLink.isVisible()) {
                console.log(`    → Clicking page ${nextPageNum}...`);
                await pageLink.click();
                await page.waitForTimeout(2000);
                await waitForResults(page);
              } else {
                // Try the ">" next button
                const nextArrow = await page.locator('a[aria-label="Next page"]').first();
                if (await nextArrow.isVisible()) {
                  console.log(`    → Clicking next arrow...`);
                  await nextArrow.click();
                  await page.waitForTimeout(2000);
                  await waitForResults(page);
                } else {
                  console.log(`    ℹ️  No next page available`);
                  break;
                }
              }
            } catch (e) {
              console.log(`    ℹ️  Could not navigate to page ${nextPageNum}`);
              break;
            }
          }
          
          // Delay between pages
          await page.waitForTimeout(REQUEST_DELAY_MS);
        }
      } catch (error) {
        console.error(`    ❌ Error processing set:`, error);
      }
      
      console.log(`  📊 Set total: ${setProducts} products`);
      
      // Fetch listings for all products in this set
      if (withListings && allSetProducts.length > 0) {
        console.log(`\n  📋 Fetching listings for ${allSetProducts.length} products...`);
        let updatedCount = 0;
        
        for (let i = 0; i < allSetProducts.length; i++) {
          const product = allSetProducts[i];
          process.stdout.write(`    [${i + 1}/${allSetProducts.length}] ${product.name.substring(0, 35).padEnd(35)}...`);
          
          try {
            const listingsSummary = await scrapeListings(page, product.productId, product.tcgUrl, product.name, product.productType);
            
            // Update card with lowest listing price
            updateCardListings(
              product.productId,
              listingsSummary.lowest_price,
              listingsSummary.lowest_price_with_shipping,
              listingsSummary.listing_count
            );
            
            if (listingsSummary.lowest_price) {
              console.log(` $${listingsSummary.lowest_price.toFixed(2)} (${listingsSummary.listing_count} listings)`);
              updatedCount++;
            } else {
              console.log(' no listings');
            }
          } catch (error) {
            console.log(` ⚠️ ${error}`);
          }
          
          await page.waitForTimeout(REQUEST_DELAY_MS);
        }
        
        console.log(`  📊 Updated ${updatedCount}/${allSetProducts.length} cards with listing data`);
      }
      
      // Delay between sets
      if (setIndex < sets.length - 1) {
        await page.waitForTimeout(REQUEST_DELAY_MS * 2);
      }
    }
    
    // Summary
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║                   SUMMARY                       ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`Total products found: ${totalProducts}`);
    console.log(`New products saved: ${totalSaved}`);
    
    const finalCount = countCards();
    console.log(`Cards in DB: ${initialCount} → ${finalCount} (+${finalCount - initialCount})`);
    
    // Finish run
    finishScrapeRun(runId, 'success');
    
  } catch (error) {
    console.error('\n❌ Job failed:', error);
    finishScrapeRun(runId, 'error', String(error));
    throw error;
    
  } finally {
    if (page) {
      const context = page.context();
      await context.close();
    }
    console.log('\n🏁 Browser closed.\n');
  }
}

/**
 * Quick test: Scrape just one set
 */
export async function scrapeOneSet(setSlug: string, pages = 3, headless = false): Promise<void> {
  const set = ONE_PIECE_SETS.find(s => s.slug === setSlug);
  if (!set) {
    console.error(`Set not found: ${setSlug}`);
    console.log('Available sets:', ONE_PIECE_SETS.map(s => s.slug).join(', '));
    return;
  }
  
  await scrapeTopCards({
    sets: [set],
    pagesPerSet: pages,
    headless,
    verbose: true,
  });
}

