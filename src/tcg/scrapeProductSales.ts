/**
 * Product Sales Scraper
 * 
 * Scrapes sales history from individual product pages on TCGplayer
 */

import { Page, APIRequestContext } from 'playwright';
import { REQUEST_DELAY_MS, SALES_ENDPOINT_TEMPLATE, API_HEADERS } from '../config.js';

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
    
    // Normalize the scraped data
    const normalizedSales: NormalizedSale[] = sales.map((sale) => ({
      sold_at: parseDate(sale.date),
      price: parsePrice(sale.price),
      condition: parseCondition(sale.condition),
      quantity: parseInt(sale.quantity, 10) || 1,
      listing_type: null,
      source_raw: JSON.stringify(sale),
    })).filter(s => s.price > 0);
    
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
  request: APIRequestContext
): Promise<NormalizedSale[]> {
  const url = SALES_ENDPOINT_TEMPLATE.replace('{productId}', String(productId));
  console.log(`Fetching sales from API: ${url}`);
  
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
    
    if (!response.ok()) {
      console.warn(`API request failed for product ${productId}: ${response.status()}`);
      return [];
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
    
    const normalizedSales = rawSales.map(normalizeSale);
    console.log(`Fetched ${normalizedSales.length} sales from API`);
    
    return normalizedSales;
    
  } catch (error) {
    console.error(`Error fetching sales from API for product ${productId}:`, error);
    return [];
  }
}

/**
 * Main function to get sales for a product
 * Tries API first, falls back to UI scraping
 */
export async function getProductSales(
  page: Page,
  productId: number,
  productUrl: string,
  request?: APIRequestContext
): Promise<NormalizedSale[]> {
  // Try API first if we have a request context
  if (request) {
    try {
      const sales = await fetchProductSalesFromAPI(productId, request);
      if (sales.length > 0) {
        return sales;
      }
    } catch {
      console.log('API fetch failed, falling back to UI scraping...');
    }
  }
  
  // Fall back to UI scraping
  return scrapeProductSalesFromUI(page, productUrl);
}

/**
 * Scrape sales for multiple products with progress tracking
 */
export async function scrapeMultipleProductSales(
  page: Page,
  products: Array<{ productId: number; tcgUrl: string }>,
  request?: APIRequestContext,
  onProgress?: (current: number, total: number, sales: NormalizedSale[]) => void
): Promise<Map<number, NormalizedSale[]>> {
  const results = new Map<number, NormalizedSale[]>();
  
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    
    try {
      const sales = await getProductSales(page, product.productId, product.tcgUrl, request);
      results.set(product.productId, sales);
      
      if (onProgress) {
        onProgress(i + 1, products.length, sales);
      }
    } catch (error) {
      console.error(`Failed to get sales for product ${product.productId}:`, error);
      results.set(product.productId, []);
    }
    
    // Delay between requests
    if (i < products.length - 1) {
      await page.waitForTimeout(REQUEST_DELAY_MS);
    }
  }
  
  return results;
}

