/**
 * Simple Listings Update Job
 * 
 * Clean and simple - matches the pattern of updateSales.ts
 * Fetches current listing prices for all tracked products
 */

import { chromium, Page, APIRequestContext } from 'playwright';
import { REQUEST_DELAY_MS } from '../config.js';
import { join } from 'path';

const USER_DATA_DIR = join(process.cwd(), '.browser-data');

import { 
  initPostgres,
  pgGetAllCards, 
  pgUpdateCardListings,
  PgCard,
} from '../db/postgres.js';

export interface UpdateListingsOptions {
  productIds?: number[];     // Specific products to update (default: all)
  setName?: string;          // Filter by set name
  limit?: number;            // Max number of products to process
  headless?: boolean;
  workers?: number;          // Number of parallel browser tabs (1-4)
  useProxy?: boolean;        // Use residential proxy from environment
}

/**
 * Get proxy configuration from environment
 * Set these env vars:
 *   PROXY_SERVER=http://proxy.example.com:port
 *   PROXY_USERNAME=your_username
 *   PROXY_PASSWORD=your_password
 */
function getProxyConfig(): { server: string; username?: string; password?: string } | undefined {
  const server = process.env.PROXY_SERVER;
  if (!server) return undefined;
  
  return {
    server,
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  };
}

interface ListingResult {
  lowestPrice: number | null;
  listingCount: number;
  currentQuantity: number;
  rateLimited: boolean;
  fromUi?: boolean;
}

/**
 * Adaptive rate limiter - starts at a reasonable speed, slows on 403s
 */
class AdaptiveRateLimiter {
  private currentDelay: number;
  private minDelay: number;
  private maxDelay: number;
  private successCount = 0;
  private readonly successThreshold = 10;
  private readonly speedUpFactor = 0.8;
  private readonly slowDownFactor = 3;
  
  constructor(startDelay = 1000, minDelay = 500, maxDelay = 15000) {
    this.currentDelay = startDelay;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
  }
  
  recordSuccess(): void {
    this.successCount++;
    if (this.successCount >= this.successThreshold && this.currentDelay > this.minDelay) {
      const oldDelay = this.currentDelay;
      this.currentDelay = Math.max(Math.round(this.currentDelay * this.speedUpFactor), this.minDelay);
      if (this.currentDelay !== oldDelay) {
        console.log(`  📈 Speed up: ${oldDelay}ms → ${this.currentDelay}ms`);
      }
      this.successCount = 0;
    }
  }
  
  recordRateLimit(): void {
    this.successCount = 0;
    const oldDelay = this.currentDelay;
    this.currentDelay = Math.min(this.currentDelay * this.slowDownFactor, this.maxDelay);
    console.log(`  🐢 Rate limited! Slowing: ${oldDelay}ms → ${this.currentDelay}ms`);
  }
  
  getDelay(): number {
    return this.currentDelay;
  }
  
  async wait(): Promise<void> {
    await new Promise(r => setTimeout(r, this.currentDelay));
  }
  
  isSlowed(): boolean {
    return this.currentDelay > this.minDelay * 2;
  }
}

/**
 * Fetch listings via UI scraping (slower but more reliable)
 */
async function fetchListingsViaUI(
  page: Page,
  productId: number,
  tcgUrl: string
): Promise<ListingResult> {
  try {
    const url = tcgUrl || `https://www.tcgplayer.com/product/${productId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    // Look for the lowest price in the listings
    const priceSelectors = [
      '.listing-item__listing-data__info__price',
      '[class*="listing"] [class*="price"]',
      '.product-details__market-price',
    ];
    
    let lowestPrice: number | null = null;
    
    for (const selector of priceSelectors) {
      const priceElements = await page.$$(selector);
      for (const el of priceElements) {
        const text = await el.textContent();
        if (text) {
          const match = text.match(/\$?([\d,]+\.?\d*)/);
          if (match) {
            const price = parseFloat(match[1].replace(',', ''));
            if (!isNaN(price) && price > 0) {
              if (lowestPrice === null || price < lowestPrice) {
                lowestPrice = price;
              }
            }
          }
        }
      }
      if (lowestPrice !== null) break;
    }
    
    return {
      lowestPrice,
      listingCount: lowestPrice ? 1 : 0,
      currentQuantity: 0,
      rateLimited: false,
      fromUi: true,
    };
  } catch (error) {
    return { lowestPrice: null, listingCount: 0, currentQuantity: 0, rateLimited: false };
  }
}

/**
 * Fetch listings via TCGplayer API
 */
async function fetchListings(
  request: APIRequestContext,
  productId: number
): Promise<ListingResult> {
  try {
    const url = `https://mp-search-api.tcgplayer.com/v1/product/${productId}/listings?mpfev=4528&_t=${Date.now()}`;
    
    const response = await request.post(url, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://www.tcgplayer.com',
        'referer': `https://www.tcgplayer.com/product/${productId}`,
      },
      data: {
        filters: {
          term: {
            sellerStatus: 'Live',
            channelId: 0,
          },
          range: {
            quantity: { gte: 1 },
          },
        },
        aggregations: ['listingType'],
        context: {
          shippingCountry: 'US',
          cart: {},
        },
        size: 50,
      },
    });
    
    if (!response.ok()) {
      const isRateLimited = response.status() === 403 || response.status() === 429;
      return { lowestPrice: null, listingCount: 0, currentQuantity: 0, rateLimited: isRateLimited };
    }
    
    const data = await response.json() as {
      results?: Array<{
        totalResults?: number;
        results?: Array<{
          price?: number;
          quantity?: number;
          conditionName?: string;
        }>;
      }>;
    };
    
    const listingsWrapper = data.results?.[0];
    const listings = listingsWrapper?.results || [];
    const totalResults = listingsWrapper?.totalResults || listings.length;
    
    if (listings.length === 0) {
      return { lowestPrice: null, listingCount: 0, currentQuantity: 0, rateLimited: false };
    }
    
    // Find lowest price (Near Mint preferred)
    let lowestPrice: number | null = null;
    let totalQuantity = 0;
    
    for (const listing of listings) {
      if (listing.price !== undefined && listing.price > 0) {
        if (lowestPrice === null || listing.price < lowestPrice) {
          lowestPrice = listing.price;
        }
      }
      totalQuantity += listing.quantity || 1;
    }
    
    return {
      lowestPrice,
      listingCount: totalResults,
      currentQuantity: totalQuantity,
      rateLimited: false,
    };
  } catch (error) {
    console.error(`  Error fetching listings:`, error);
    return { lowestPrice: null, listingCount: 0, currentQuantity: 0, rateLimited: false };
  }
}

/**
 * Process a single card's listings
 */
async function processCardListings(
  request: APIRequestContext,
  page: Page,
  card: PgCard,
  rateLimiter: AdaptiveRateLimiter,
  useUiFallback: boolean = true
): Promise<{ updated: boolean; rateLimited: boolean; price: number | null; usedUi: boolean }> {
  // Try API first
  const result = await fetchListings(request, card.product_id);
  
  if (result.rateLimited && useUiFallback) {
    // API rate limited - try UI scraping instead
    console.log(' (trying UI fallback...)');
    const uiResult = await fetchListingsViaUI(page, card.product_id, card.tcg_url || '');
    
    if (uiResult.lowestPrice !== null) {
      await pgUpdateCardListings(
        card.product_id,
        uiResult.lowestPrice,
        uiResult.lowestPrice,
        uiResult.listingCount,
        uiResult.currentQuantity
      );
      rateLimiter.recordSuccess();
      return { updated: true, rateLimited: false, price: uiResult.lowestPrice, usedUi: true };
    }
    
    // UI also failed
    rateLimiter.recordRateLimit();
    return { updated: false, rateLimited: true, price: null, usedUi: true };
  }
  
  if (result.rateLimited) {
    rateLimiter.recordRateLimit();
    return { updated: false, rateLimited: true, price: null, usedUi: false };
  }
  
  if (result.lowestPrice !== null) {
    await pgUpdateCardListings(
      card.product_id,
      result.lowestPrice,
      result.lowestPrice,
      result.listingCount,
      result.currentQuantity
    );
    rateLimiter.recordSuccess();
    return { updated: true, rateLimited: false, price: result.lowestPrice, usedUi: false };
  }
  
  rateLimiter.recordSuccess();
  return { updated: false, rateLimited: false, price: null, usedUi: false };
}

/**
 * Run the listings update job
 */
export async function updateListingsSimple(options: UpdateListingsOptions = {}): Promise<void> {
  const { 
    productIds, 
    setName,
    limit, 
    headless = false,
    workers = 1,
    useProxy = true,  // Default to using proxy if available
  } = options;
  
  console.log('\n=== Update Listings Job ===');
  console.log(`Headless: ${headless}`);
  
  // Check for proxy configuration
  const proxyConfig = useProxy ? getProxyConfig() : undefined;
  if (proxyConfig) {
    console.log(`Proxy: ${proxyConfig.server} ✓`);
  } else if (useProxy) {
    console.log('Proxy: Not configured (set PROXY_SERVER env var)');
  }
  if (setName) console.log(`Set filter: ${setName}`);
  if (limit) console.log(`Limit: ${limit} products`);
  console.log('');
  
  // Initialize PostgreSQL database
  await initPostgres();
  
  // Get cards to process
  const allCards = await pgGetAllCards();
  let cards: PgCard[];
  
  if (productIds && productIds.length > 0) {
    cards = allCards.filter(c => productIds.includes(c.product_id));
    console.log(`Processing ${cards.length} specified products`);
  } else if (setName) {
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
    console.log('No products to process.');
    return;
  }
  
  // Launch browser (needed for API context with proper cookies)
  console.log('Launching browser...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    viewport: { width: 1280, height: 800 },
    ...(proxyConfig && { proxy: proxyConfig }),
  });
  
  // Test proxy by checking our external IP
  const page = context.pages()[0] || await context.newPage();
  
  if (proxyConfig) {
    console.log('Testing proxy connection...');
    try {
      await page.goto('https://api.ipify.org?format=json', { timeout: 30000 });
      const ipText = await page.textContent('body');
      console.log(`Proxy IP: ${ipText}`);
    } catch (e) {
      console.log('Warning: Could not verify proxy IP');
    }
  }
  
  // Visit TCGplayer first to establish session cookies
  console.log('Establishing session with TCGplayer...');
  try {
    await page.goto('https://www.tcgplayer.com/search/one-piece-card-game/product?productLineName=one-piece-card-game&view=grid', { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    await page.waitForTimeout(3000); // Let cookies/session establish
    console.log('Session established ✓');
  } catch (e) {
    console.log('Warning: Could not establish session, continuing anyway...');
  }
  
  const request = context.request;
  // Start MUCH slower to avoid immediate rate limiting (5 seconds between requests)
  const rateLimiter = new AdaptiveRateLimiter(5000, 2000, 30000);
  const startTime = Date.now();
  
  let totalUpdated = 0;
  let totalRateLimited = 0;
  let totalUiFallbacks = 0;
  let processed = 0;
  
  try {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      process.stdout.write(`[${i + 1}/${cards.length}] ${card.name.substring(0, 40).padEnd(40)}...`);
      
      const result = await processCardListings(request, page, card, rateLimiter, true);
      
      if (result.usedUi) totalUiFallbacks++;
      
      if (result.rateLimited) {
        console.log(' (rate limited - skipping)');
        totalRateLimited++;
      } else if (result.updated) {
        const source = result.usedUi ? ' [UI]' : '';
        console.log(` $${result.price?.toFixed(2)}${source}`);
        totalUpdated++;
      } else {
        console.log(' (no listings)');
      }
      
      processed++;
      
      // Wait between requests
      if (i < cards.length - 1) {
        await rateLimiter.wait();
      }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Summary
    console.log('\n=== Summary ===');
    console.log(`Products processed: ${processed}`);
    console.log(`Listings updated: ${totalUpdated}`);
    if (totalUiFallbacks > 0) console.log(`Used UI fallback: ${totalUiFallbacks}`);
    if (totalRateLimited > 0) console.log(`Rate limited (skipped): ${totalRateLimited}`);
    console.log(`Time: ${elapsed}s (${(cards.length / parseFloat(elapsed)).toFixed(1)} products/sec)`);
    
    await context.close();
    console.log('\nBrowser closed.');
    
  } catch (error) {
    console.error('Job failed:', error);
    await context.close();
    throw error;
  }
}

