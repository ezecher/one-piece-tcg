/**
 * Refresh Market Prices
 * 
 * Simple script that scrapes market prices from TCGplayer search results.
 * Much faster than scrape-top-cards because it just reads pages sequentially.
 * 
 * ~55 pages × 2 seconds = ~2 minutes total
 */

import { chromium, Page } from 'playwright';
import { initPostgres, pgUpdateCardPrice, pgSaveMarketSnapshot, getPool } from '../db/postgres.js';

const TCGPLAYER_SEARCH_URL = 'https://www.tcgplayer.com/search/one-piece-card-game/product?productLineName=one-piece-card-game&view=grid&page=';

interface PriceData {
  productId: number;
  marketPrice: number | null;
}

/**
 * Parse market price from text like "Market Price: $24.99"
 */
function parseMarketPrice(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/\$[\d,]+\.?\d*/);
  if (match) {
    return parseFloat(match[0].replace(/[$,]/g, ''));
  }
  return null;
}

/**
 * Click the sort dropdown and select "Price: High to Low"
 */
async function sortByPriceHighToLow(page: Page): Promise<boolean> {
  try {
    // Find and click the sort dropdown
    const sortButton = await page.$('button:has-text("Toggle listbox"), [class*="sort"] button, button[aria-haspopup="listbox"]');
    if (sortButton) {
      await sortButton.click();
      await page.waitForTimeout(500);
      
      // Click "Price: High to Low" option
      const priceHighOption = await page.$('text=Price: High to Low');
      if (priceHighOption) {
        await priceHighOption.click();
        await page.waitForTimeout(2000); // Wait for results to reload
        console.log('✓ Sorted by Price: High to Low');
        return true;
      }
    }
    console.log('⚠️ Could not find sort dropdown');
    return false;
  } catch (error) {
    console.log('⚠️ Could not change sort order:', error);
    return false;
  }
}

/**
 * Click the "Next" button to go to next page (preserves sort order)
 */
async function clickNextPage(page: Page): Promise<boolean> {
  try {
    // Try multiple selectors for the Next button
    const selectors = [
      'a[aria-label="Next page"]',
      'a[aria-label="Next"]',
      'button[aria-label="Next page"]',
      'a.tcg-pagination__arrow--next',
      'a:has-text("Next")',
      'button:has-text("Next")',
      '.tcg-pagination a:last-child',
      '[class*="pagination"] a:last-child',
    ];
    
    for (const selector of selectors) {
      const nextButton = await page.$(selector);
      if (nextButton && await nextButton.isVisible()) {
        await nextButton.click();
        await page.waitForTimeout(2000); // Wait for page to load
        return true;
      }
    }
    
    // Fallback: look for any link with "Next" in it
    const nextLink = await page.locator('a').filter({ hasText: /^Next$|→|»/ }).first();
    if (await nextLink.isVisible()) {
      await nextLink.click();
      await page.waitForTimeout(2000);
      return true;
    }
    
    return false;
  } catch (e) {
    console.log('Next button error:', e);
    return false;
  }
}

/**
 * Scrape prices from the current page (don't navigate, just read)
 */
async function scrapeCurrentPage(page: Page): Promise<PriceData[]> {
  try {
    const prices = await page.evaluate(() => {
      const results: Array<{ productId: number | null; marketPrice: string | null }> = [];
      
      // Find all product cards
      const productLinks = document.querySelectorAll('a[href*="/product/"]');
      
      productLinks.forEach((link) => {
        const href = (link as HTMLAnchorElement).href;
        
        // Extract product ID from URL
        const productMatch = href.match(/\/product\/(\d+)\//);
        if (!productMatch) return;
        
        const productId = parseInt(productMatch[1], 10);
        
        // Find the container for this product
        const container = link.closest('[class*="search-result"]') || 
                         link.closest('[class*="product-card"]') ||
                         link.closest('div');
        
        if (!container) return;
        
        // Find market price
        let marketPrice: string | null = null;
        const allText = container.textContent || '';
        const priceMatch = allText.match(/Market Price[:\s]*\$[\d,]+\.?\d*/);
        if (priceMatch) {
          marketPrice = priceMatch[0];
        }
        
        results.push({ productId, marketPrice });
      });
      
      // Deduplicate by productId
      const seen = new Set<number>();
      return results.filter(r => {
        if (r.productId && !seen.has(r.productId)) {
          seen.add(r.productId);
          return true;
        }
        return false;
      });
    });
    
    return prices.map(p => ({
      productId: p.productId!,
      marketPrice: parseMarketPrice(p.marketPrice),
    })).filter(p => p.productId);
    
  } catch (error) {
    console.error(`Error scraping current page:`, error);
    return [];
  }
}

export interface RefreshPricesOptions {
  maxPages?: number;
  headless?: boolean;
}

export async function refreshPrices(options: RefreshPricesOptions = {}): Promise<void> {
  const { maxPages = 60, headless = false } = options;
  
  console.log('\n=== Refresh Market Prices ===');
  console.log(`Max pages: ${maxPages}`);
  console.log(`Headless: ${headless}`);
  
  await initPostgres();
  
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const startTime = Date.now();
  let totalUpdated = 0;
  let totalProducts = 0;
  
  try {
    // Load page 1 and sort
    console.log('\nLoading page 1...');
    await page.goto(TCGPLAYER_SEARCH_URL + '1', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Sort by price high to low (cookies preserve this)
    await sortByPriceHighToLow(page);
    await page.waitForTimeout(2000);
    
    // Go through all pages via URL (sort preserved in cookies)
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const pageStart = Date.now();
      
      // For page 2+, navigate via URL
      if (pageNum > 1) {
        await page.goto(TCGPLAYER_SEARCH_URL + pageNum, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1500);
      }
      
      const prices = await scrapeCurrentPage(page);
      const elapsed = ((Date.now() - pageStart) / 1000).toFixed(1);
      process.stdout.write(`\r[${pageNum}/${maxPages}] ${prices.length} products (${elapsed}s)   `);
      
      if (prices.length === 0) {
        console.log(`\n✓ Reached end at page ${pageNum}`);
        break;
      }
      
      totalProducts += prices.length;
      
      // Update prices in database (only updates existing cards, doesn't add new ones)
      for (const p of prices) {
        if (p.marketPrice !== null) {
          await pgUpdateCardPrice(p.productId, p.marketPrice);
          totalUpdated++;
        }
      }
    }
    
    // Save market snapshot after updating prices
    console.log('\n\n📊 Saving market snapshot...');
    const snapshot = await pgSaveMarketSnapshot();
    console.log(`   Total Market Value: $${snapshot.total_market_value.toLocaleString()}`);
    console.log(`   Total Listing Value: $${snapshot.total_listing_value.toLocaleString()}`);
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== Summary ===`);
    console.log(`Products found: ${totalProducts}`);
    console.log(`Prices updated: ${totalUpdated}`);
    console.log(`Time: ${elapsed}s`);
    
  } finally {
    await browser.close();
  }
}

