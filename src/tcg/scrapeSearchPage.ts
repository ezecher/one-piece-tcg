/**
 * Search Page Scraper
 * 
 * Scrapes TCGplayer search result pages to discover One Piece products
 */

import { Page } from 'playwright';
import { MIN_MARKET_PRICE, REQUEST_DELAY_MS, SELECTORS, TCGPLAYER_BASE_URL } from '../config.js';

export interface ScrapedProduct {
  productId: number;
  name: string;
  setName: string | null;
  marketPrice: number | null;
  productType: 'single' | 'sealed';
  tcgUrl: string;
}

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
 * Extract product ID from URL like "/product/628353/..."
 */
function extractProductId(url: string): number | null {
  const match = url.match(/\/product\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Determine product type from URL or text
 */
function inferProductType(url: string, name: string): 'single' | 'sealed' {
  const sealedKeywords = [
    'booster box',
    'booster pack',
    'case',
    'starter deck',
    'structure deck',
    'bundle',
    'collection',
    'premium',
    'gift box',
    'display',
  ];
  
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
 * Wait for the search results to load
 */
async function waitForSearchResults(page: Page): Promise<void> {
  try {
    // Wait for either product links or the results heading to appear
    await Promise.race([
      page.waitForSelector('a[href*="/product/"]', { timeout: 20000 }),
      page.waitForSelector('h1:has-text("results")', { timeout: 20000 }),
      page.waitForSelector('[class*="no-results"], [class*="empty"]', { timeout: 20000 }),
    ]);
    
    // Additional wait for any dynamic content to fully load
    await page.waitForTimeout(2000);
  } catch (error) {
    console.warn('Timeout waiting for search results, continuing anyway...');
  }
}

/**
 * Check if there are no more results
 */
async function hasNoResults(page: Page): Promise<boolean> {
  const noResults = await page.$('[class*="no-results"], [class*="empty-state"]');
  if (noResults) return true;
  
  // Also check if product count is 0
  const products = await page.$$('a[href*="/product/"]');
  return products.length === 0;
}

/**
 * Scrape a single search results page
 */
export async function scrapeSearchPage(page: Page, url: string): Promise<ScrapedProduct[]> {
  console.log(`Scraping: ${url}`);
  
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForSearchResults(page);
  
  // Check for no results
  if (await hasNoResults(page)) {
    console.log('No results found on this page');
    return [];
  }
  
  // Extract products from the page
  // This uses a flexible approach to find product cards
  const products = await page.evaluate((baseUrl) => {
    const results: Array<{
      productId: number | null;
      name: string;
      setName: string | null;
      marketPriceText: string | null;
      href: string;
    }> = [];
    
    // Find all product links
    const productLinks = document.querySelectorAll('a[href*="/product/"]');
    const seen = new Set<string>();
    
    productLinks.forEach((link) => {
      const href = (link as HTMLAnchorElement).href;
      
      // Skip if we've already seen this product
      const productIdMatch = href.match(/\/product\/(\d+)/);
      if (!productIdMatch) return;
      
      const productId = productIdMatch[1];
      if (seen.has(productId)) return;
      seen.add(productId);
      
      // Try to find the product card container
      let container = link.closest('[class*="product-card"], [class*="search-result"]') || link.parentElement;
      
      // Get product name - try multiple selectors
      let name = '';
      const nameSelectors = [
        '[class*="product-card__name"]',
        '[class*="product-name"]',
        '[class*="title"]',
        'span[class*="name"]',
      ];
      
      for (const sel of nameSelectors) {
        const nameEl = container?.querySelector(sel);
        if (nameEl?.textContent?.trim()) {
          name = nameEl.textContent.trim();
          break;
        }
      }
      
      // Fallback: use link text if it looks like a name
      if (!name) {
        const linkText = link.textContent?.trim() || '';
        if (linkText.length > 3 && linkText.length < 200) {
          name = linkText;
        }
      }
      
      // Get set name
      let setName: string | null = null;
      const setSelectors = [
        '[class*="product-card__set"]',
        '[class*="set-name"]',
        '[class*="subtitle"]',
      ];
      
      for (const sel of setSelectors) {
        const setEl = container?.querySelector(sel);
        if (setEl?.textContent?.trim()) {
          setName = setEl.textContent.trim();
          break;
        }
      }
      
      // Get market price
      let marketPriceText: string | null = null;
      const priceSelectors = [
        '[class*="market-price"]',
        '[class*="product-card__market-price"]',
        '[class*="price"]',
      ];
      
      for (const sel of priceSelectors) {
        const priceEl = container?.querySelector(sel);
        const text = priceEl?.textContent?.trim();
        if (text && text.includes('$')) {
          marketPriceText = text;
          break;
        }
      }
      
      if (name) {
        results.push({
          productId: parseInt(productId, 10),
          name,
          setName,
          marketPriceText,
          href,
        });
      }
    });
    
    return results;
  }, TCGPLAYER_BASE_URL);
  
  // Process and filter results
  const scrapedProducts: ScrapedProduct[] = [];
  
  for (const p of products) {
    if (!p.productId) continue;
    
    const marketPrice = parseMarketPrice(p.marketPriceText);
    
    // Filter by minimum price
    if (marketPrice !== null && marketPrice < MIN_MARKET_PRICE) {
      continue;
    }
    
    scrapedProducts.push({
      productId: p.productId,
      name: p.name,
      setName: p.setName,
      marketPrice,
      productType: inferProductType(p.href, p.name),
      tcgUrl: p.href,
    });
  }
  
  console.log(`Found ${scrapedProducts.length} products (after filtering)`);
  return scrapedProducts;
}

/**
 * Check if there's a next page
 */
export async function hasNextPage(page: Page): Promise<boolean> {
  // Look for next page button/link that's not disabled
  const nextButton = await page.$('a[aria-label="Next page"]:not([disabled]), a:has-text("Next"):not([disabled])');
  if (nextButton) {
    // Check if it's actually clickable (not disabled)
    const isDisabled = await nextButton.getAttribute('disabled');
    const ariaDisabled = await nextButton.getAttribute('aria-disabled');
    return isDisabled !== 'true' && ariaDisabled !== 'true';
  }
  return false;
}

/**
 * Get the current page number from URL
 */
export function getPageNumber(url: string): number {
  const match = url.match(/[?&]page=(\d+)/);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * Build URL for next page
 */
export function buildNextPageUrl(currentUrl: string): string {
  const currentPage = getPageNumber(currentUrl);
  const nextPage = currentPage + 1;
  
  if (currentUrl.includes('page=')) {
    return currentUrl.replace(/page=\d+/, `page=${nextPage}`);
  } else {
    const separator = currentUrl.includes('?') ? '&' : '?';
    return `${currentUrl}${separator}page=${nextPage}`;
  }
}

/**
 * Scrape all pages for a search query
 */
export async function scrapeAllSearchPages(
  page: Page,
  baseUrl: string,
  maxPages = 100,
  onProgress?: (page: number, products: ScrapedProduct[]) => void
): Promise<ScrapedProduct[]> {
  const allProducts: ScrapedProduct[] = [];
  let currentUrl = baseUrl;
  let pageNum = 1;
  
  while (pageNum <= maxPages) {
    const products = await scrapeSearchPage(page, currentUrl);
    
    if (products.length === 0) {
      console.log(`No products on page ${pageNum}, stopping`);
      break;
    }
    
    allProducts.push(...products);
    
    if (onProgress) {
      onProgress(pageNum, products);
    }
    
    // Check for next page
    const hasNext = await hasNextPage(page);
    if (!hasNext) {
      console.log(`No next page after page ${pageNum}, stopping`);
      break;
    }
    
    // Build next URL and continue
    currentUrl = buildNextPageUrl(currentUrl);
    pageNum++;
    
    // Be respectful with delays
    await page.waitForTimeout(REQUEST_DELAY_MS);
  }
  
  console.log(`\nTotal products scraped: ${allProducts.length}`);
  return allProducts;
}

