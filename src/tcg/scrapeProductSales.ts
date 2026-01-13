/**
 * Product Sales Scraper
 * 
 * Scrapes sales history from individual product pages on TCGplayer
 */

import { Page, APIRequestContext } from 'playwright';
import { REQUEST_DELAY_MS, SALES_ENDPOINT_TEMPLATE, API_HEADERS } from '../config.js';

/**
 * Adaptive Rate Limiter
 * Slows down when hitting 403s, speeds up when requests succeed
 */
export class AdaptiveRateLimiter {
  private currentDelay: number;
  private minDelay: number;
  private maxDelay: number;
  private consecutiveSuccesses: number = 0;
  private consecutiveFailures: number = 0;
  private successesNeededToSpeedUp: number = 3; // Need 3 successes to speed up (was 5)
  
  constructor(options: { minDelay?: number; maxDelay?: number; startDelay?: number } = {}) {
    this.minDelay = options.minDelay ?? 650;  // 650ms = ~92 req/min, safely under TCGplayer's limit
    this.maxDelay = options.maxDelay ?? 15000;
    this.currentDelay = options.startDelay ?? this.minDelay;
  }
  
  /**
   * Record a successful request - speed up more aggressively
   */
  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    
    // After enough successes, speed up
    if (this.consecutiveSuccesses >= this.successesNeededToSpeedUp) {
      const oldDelay = this.currentDelay;
      // Reduce delay by 40% but not below minimum (was 20%)
      this.currentDelay = Math.max(this.minDelay, Math.floor(this.currentDelay * 0.6));
      if (this.currentDelay < oldDelay) {
        console.log(`  📈 Rate limit eased: ${oldDelay}ms → ${this.currentDelay}ms`);
      }
      this.consecutiveSuccesses = 0;
    }
  }
  
  /**
   * Record a rate limit (403) - slow down immediately
   */
  onRateLimit(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures++;
    
    const oldDelay = this.currentDelay;
    // Double the delay on each failure, up to max
    this.currentDelay = Math.min(this.maxDelay, this.currentDelay * 2);
    console.log(`  🐢 Rate limited! Slowing down: ${oldDelay}ms → ${this.currentDelay}ms (waiting ${this.currentDelay}ms before retry...)`);
  }
  
  /**
   * Get current delay in ms
   */
  getDelay(): number {
    return this.currentDelay;
  }
  
  /**
   * Wait for the current delay
   */
  async wait(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, this.currentDelay));
  }
  
  /**
   * Check if we're in a slow-down state
   */
  isSlowed(): boolean {
    return this.currentDelay > this.minDelay * 2;
  }
}

// Global rate limiter instance for shared state across calls
let globalRateLimiter: AdaptiveRateLimiter | null = null;

export function getGlobalRateLimiter(options?: { minDelay?: number; maxDelay?: number; startDelay?: number }): AdaptiveRateLimiter {
  if (!globalRateLimiter) {
    globalRateLimiter = new AdaptiveRateLimiter(options);
  }
  return globalRateLimiter;
}

export function resetGlobalRateLimiter(): void {
  globalRateLimiter = null;
}

export interface RawSale {
  // These fields will be adjusted once you inspect the actual JSON response
  date: string;           // ISO date string or similar
  price: number;          // Sale price
  condition: string;      // "Near Mint", "Lightly Played", etc.
  quantity: number;       // Number of items in sale
  listingType?: string;   // "normal", "direct", etc.
  purchasePrice?: number; // Alternative price field
  orderDate?: string;     // Alternative date field
}

export interface NormalizedSale {
  sold_at: Date;
  price: number;
  condition: string | null;
  quantity: number;
  listing_type: string | null;
  source_raw: string;
}

/**
 * Normalize a raw sale from the API/DOM into our standard format
 */
export function normalizeSale(raw: RawSale): NormalizedSale {
  // Handle various date formats
  const dateStr = raw.date || raw.orderDate;
  let soldAt: Date;
  
  try {
    soldAt = new Date(dateStr);
    if (isNaN(soldAt.getTime())) {
      soldAt = new Date(); // Fallback to now if parsing fails
    }
  } catch {
    soldAt = new Date();
  }
  
  // Handle various price fields
  const price = raw.price ?? raw.purchasePrice ?? 0;
  
  return {
    sold_at: soldAt,
    price,
    condition: raw.condition || null,
    quantity: raw.quantity ?? 1,
    listing_type: raw.listingType || null,
    source_raw: JSON.stringify(raw),
  };
}

/**
 * Parse condition from text
 */
function parseCondition(text: string): string {
  const conditions = [
    'Near Mint',
    'Lightly Played',
    'Moderately Played',
    'Heavily Played',
    'Damaged',
    'NM',
    'LP',
    'MP',
    'HP',
    'DMG',
  ];
  
  for (const condition of conditions) {
    if (text.toLowerCase().includes(condition.toLowerCase())) {
      // Normalize short forms
      if (text.includes('NM')) return 'Near Mint';
      if (text.includes('LP')) return 'Lightly Played';
      if (text.includes('MP')) return 'Moderately Played';
      if (text.includes('HP')) return 'Heavily Played';
      if (text.includes('DMG')) return 'Damaged';
      return condition;
    }
  }
  
  return text;
}

/**
 * Parse price from text like "$12.34"
 */
function parsePrice(text: string): number {
  const match = text.match(/\$?([\d,]+\.?\d*)/);
  if (match) {
    return parseFloat(match[1].replace(',', ''));
  }
  return 0;
}

/**
 * Parse date from various formats
 */
function parseDate(text: string): Date {
  // Try standard date parsing first
  const date = new Date(text);
  if (!isNaN(date.getTime())) {
    return date;
  }
  
  // Try common formats like "Dec 5, 2025" or "12/5/2025"
  const patterns = [
    /(\w+)\s+(\d+),?\s+(\d{4})/,  // "Dec 5, 2025"
    /(\d{1,2})\/(\d{1,2})\/(\d{4})/,  // "12/5/2025"
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return new Date(text);
    }
  }
  
  return new Date();
}

/**
 * Option 1: Scrape sales from the product page UI
 * This is more reliable but slower
 */
export async function scrapeProductSalesFromUI(page: Page, productUrl: string): Promise<NormalizedSale[]> {
  console.log(`Scraping sales from UI: ${productUrl}`);
  
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
    
    // Wait for page to load
    await page.waitForTimeout(3000);
    
    // Try to find and click the "View More Data" button to expand sales history
    const viewMoreDataSelectors = [
      'button:has-text("View More Data")',
      'button:has-text("View More")',
      '[class*="view-more"]',
    ];
    
    for (const selector of viewMoreDataSelectors) {
      try {
        const button = await page.$(selector);
        if (button) {
          await button.click();
          console.log(`Clicked View More Data button`);
          await page.waitForTimeout(2000);
          break;
        }
      } catch {
        continue;
      }
    }
    
    // Try to find sales data in the page
    // The sales table has rows with format: Date | Condition | Qty | Price
    const sales = await page.evaluate(() => {
      const results: Array<{
        date: string;
        price: string;
        condition: string;
        quantity: string;
      }> = [];
      
      // Find all tables that might contain sales data
      const tables = document.querySelectorAll('table');
      
      for (const table of tables) {
        const tableText = table.textContent || '';
        
        // Check if this table looks like a sales table (has Date, Condition, Qty, Price headers)
        if (tableText.includes('Date') && tableText.includes('Price') && tableText.includes('Qty')) {
          // Get all rows from tbody
          const rows = table.querySelectorAll('tbody tr');
          
          rows.forEach((row) => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 4) {
              const date = cells[0]?.textContent?.trim() || '';
              const condition = cells[1]?.textContent?.trim() || '';
              const quantity = cells[2]?.textContent?.trim() || '1';
              const price = cells[3]?.textContent?.trim() || '';
              
              // Only add if we have a valid price
              if (price.includes('$')) {
                results.push({
                  date,
                  price,
                  condition,
                  quantity,
                });
              }
            }
          });
        }
      }
      
      // If no sales table found, try to find any rows with date/price patterns
      if (results.length === 0) {
        // Look for elements containing sales-like data
        const allText = document.body.innerText;
        const salePattern = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(NM|LP|MP|HP|Near Mint|Lightly Played|Moderately Played|Heavily Played)[^$]*\$(\d+\.?\d*)/gi;
        let match;
        
        while ((match = salePattern.exec(allText)) !== null) {
          results.push({
            date: match[1],
            condition: match[2],
            quantity: '1',
            price: `$${match[3]}`,
          });
        }
      }
      
      return results;
    });
    
    // Normalize the scraped data - FILTER FOR NEAR MINT ONLY
    // This helps exclude Japanese/Korean variants which are often cheaper
    const normalizedSales: NormalizedSale[] = sales.map((sale) => ({
      sold_at: parseDate(sale.date),
      price: parsePrice(sale.price),
      condition: parseCondition(sale.condition),
      quantity: parseInt(sale.quantity, 10) || 1,
      listing_type: null,
      source_raw: JSON.stringify(sale),
    })).filter(s => {
      if (s.price <= 0) return false;
      // Only keep Near Mint sales (English cards are typically NM)
      const cond = (s.condition || '').toLowerCase();
      return cond.includes('near mint') || cond === 'nm' || cond.includes('unopened');
    });
    
    console.log(`Found ${normalizedSales.length} sales from UI`);
    return normalizedSales;
    
  } catch (error) {
    console.error(`Error scraping sales from UI for ${productUrl}:`, error);
    return [];
  }
}

/**
 * Option 2: Fetch sales from the API endpoint (faster, but may need adjustment)
 * Use this once you've captured the actual API endpoint from DevTools
 */
export async function fetchProductSalesFromAPI(
  productId: number,
  request: APIRequestContext,
  rateLimiter?: AdaptiveRateLimiter
): Promise<{ sales: NormalizedSale[]; rateLimited: boolean }> {
  const url = SALES_ENDPOINT_TEMPLATE.replace('{productId}', String(productId));
  console.log(`Fetching sales from API: ${url}`);
  
  const maxRetries = 3;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
  try {
    // TCGplayer uses POST for the sales endpoint
    const response = await request.post(url, {
      headers: {
        ...API_HEADERS,
        'content-type': 'application/json',
      },
      data: {
        // The API might expect filtering parameters
        // These are optional but might help get more data
      },
    });
      
      if (response.status() === 403) {
        // Rate limited!
        if (rateLimiter) {
          rateLimiter.onRateLimit();
          
          if (attempt < maxRetries) {
            // Wait with backoff before retrying
            await rateLimiter.wait();
            continue;
          }
        }
        console.warn(`API rate limited for product ${productId} after ${maxRetries + 1} attempts`);
        return { sales: [], rateLimited: true };
      }
    
    if (!response.ok()) {
      console.warn(`API request failed for product ${productId}: ${response.status()}`);
        return { sales: [], rateLimited: false };
    }
    
    const data = await response.json();
    
    // The structure will depend on the actual API response
    // Adjust this based on what you see in DevTools
    let rawSales: RawSale[] = [];
    
    if (Array.isArray(data)) {
      rawSales = data;
    } else if (data.sales && Array.isArray(data.sales)) {
      rawSales = data.sales;
    } else if (data.data && Array.isArray(data.data)) {
      rawSales = data.data;
    } else if (data.results && Array.isArray(data.results)) {
      rawSales = data.results;
    }
    
    // Filter for Near Mint only - excludes Japanese/Korean variants
    const normalizedSales = rawSales.map(normalizeSale).filter(s => {
      if (s.price <= 0) return false;
      const cond = (s.condition || '').toLowerCase();
      return cond.includes('near mint') || cond === 'nm' || cond.includes('unopened');
    });
    console.log(`Fetched ${normalizedSales.length} NM sales from API`);
    
      // Success! Let rate limiter know
      if (rateLimiter) {
        rateLimiter.onSuccess();
      }
      
      return { sales: normalizedSales, rateLimited: false };
    
  } catch (error) {
    console.error(`Error fetching sales from API for product ${productId}:`, error);
      return { sales: [], rateLimited: false };
  }
  }
  
  return { sales: [], rateLimited: true };
}

/**
 * Main function to get sales for a product
 * Tries API first, falls back to UI scraping
 */
export interface GetProductSalesOptions {
  skipUiFallback?: boolean;  // If true, don't fall back to slow UI scraping on API failure
  rateLimiter?: AdaptiveRateLimiter;  // Adaptive rate limiter for handling 403s
}

export interface GetProductSalesResult {
  sales: NormalizedSale[];
  rateLimited: boolean;
}

export async function getProductSales(
  page: Page,
  productId: number,
  productUrl: string,
  request?: APIRequestContext,
  options?: GetProductSalesOptions
): Promise<GetProductSalesResult> {
  const { skipUiFallback = false, rateLimiter } = options || {};
  
  // Try API first if we have a request context
  if (request) {
    try {
      const result = await fetchProductSalesFromAPI(productId, request, rateLimiter);
      if (result.sales.length > 0) {
        return { sales: result.sales, rateLimited: false };
      }
      // API returned empty - might be rate limited
      if (result.rateLimited || skipUiFallback) {
        return { sales: [], rateLimited: result.rateLimited };
      }
    } catch {
      if (skipUiFallback) {
        return { sales: [], rateLimited: false };
      }
      console.log('API fetch failed, falling back to UI scraping...');
    }
  }
  
  // Fall back to UI scraping (slow)
  const sales = await scrapeProductSalesFromUI(page, productUrl);
  return { sales, rateLimited: false };
}

/**
 * Scrape sales for multiple products with progress tracking
 */
export async function scrapeMultipleProductSales(
  page: Page,
  products: Array<{ productId: number; tcgUrl: string }>,
  request?: APIRequestContext,
  onProgress?: (current: number, total: number, sales: NormalizedSale[]) => void,
  options?: GetProductSalesOptions
): Promise<Map<number, NormalizedSale[]>> {
  const results = new Map<number, NormalizedSale[]>();
  const rateLimiter = options?.rateLimiter || new AdaptiveRateLimiter();
  
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    
    try {
      const result = await getProductSales(page, product.productId, product.tcgUrl, request, {
        ...options,
        rateLimiter,
      });
      results.set(product.productId, result.sales);
      
      if (onProgress) {
        onProgress(i + 1, products.length, result.sales);
      }
    } catch (error) {
      console.error(`Failed to get sales for product ${product.productId}:`, error);
      results.set(product.productId, []);
    }
    
    // Use adaptive delay between requests
    if (i < products.length - 1) {
      await rateLimiter.wait();
    }
  }
  
  return results;
}

