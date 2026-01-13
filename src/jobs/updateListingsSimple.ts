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
  tcgUrl: string,
  debug: boolean = false
): Promise<ListingResult> {
  try {
    const url = tcgUrl || `https://www.tcgplayer.com/product/${productId}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000); // Wait for JS to render
    
    // Check if we hit a block page or captcha
    const pageTitle = await page.title();
    const pageUrl = page.url();
    
    if (debug) {
      console.log(`\n  DEBUG: Title="${pageTitle}" URL=${pageUrl}`);
    }
    
    // Check for common block indicators
    if (pageTitle.includes('Access Denied') || pageTitle.includes('blocked') || 
        pageUrl.includes('captcha') || pageUrl.includes('challenge')) {
      if (debug) console.log('  DEBUG: Detected block/captcha page');
      return { lowestPrice: null, listingCount: 0, currentQuantity: 0, rateLimited: true, fromUi: true };
    }
    
    // Try to find the market price first (always visible)
    const marketPriceEl = await page.$('[data-testid="product-price"]');
    if (marketPriceEl) {
      const text = await marketPriceEl.textContent();
      if (text) {
        const match = text.match(/\$?([\d,]+\.?\d*)/);
        if (match) {
          const price = parseFloat(match[1].replace(',', ''));
          if (!isNaN(price) && price > 0) {
            if (debug) console.log(`  DEBUG: Found market price: $${price}`);
            return {
              lowestPrice: price,
              listingCount: 1,
              currentQuantity: 0,
              rateLimited: false,
              fromUi: true,
            };
          }
        }
      }
    }
    
    // Look for the lowest price in the listings
    const priceSelectors = [
      '.listing-item__listing-data__info__price',
      '[class*="listing"] [class*="price"]',
      '.product-details__market-price',
      '.price-point__data',
      '[class*="MarketPrice"]',
    ];
    
    let lowestPrice: number | null = null;
    
    for (const selector of priceSelectors) {
      const priceElements = await page.$$(selector);
      if (debug && priceElements.length > 0) {
        console.log(`  DEBUG: Found ${priceElements.length} elements with "${selector}"`);
      }
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
    
    if (debug) {
      if (lowestPrice) {
        console.log(`  DEBUG: Found lowest price: $${lowestPrice}`);
      } else {
        console.log('  DEBUG: No prices found on page');
        // Take a screenshot for debugging
        const bodyText = await page.textContent('body');
        console.log(`  DEBUG: Page body preview: ${bodyText?.substring(0, 200)}...`);
      }
    }
    
    return {
      lowestPrice,
      listingCount: lowestPrice ? 1 : 0,
      currentQuantity: 0,
      rateLimited: false,
      fromUi: true,
    };
  } catch (error) {
    if (debug) console.log(`  DEBUG: Error in UI scrape: ${error}`);
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
  useUiFallback: boolean = true,
  debug: boolean = false
): Promise<{ updated: boolean; rateLimited: boolean; price: number | null; usedUi: boolean }> {
  // Try API first
  const result = await fetchListings(request, card.product_id);
  
  if (result.rateLimited && useUiFallback) {
    // API rate limited - try UI scraping instead
    console.log(' (trying UI fallback...)');
    const uiResult = await fetchListingsViaUI(page, card.product_id, card.tcg_url || '', debug);
    
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
  
  // When using proxy, use regular launch instead of persistent context
  // This avoids JavaScript execution issues with proxies
  let context;
  if (proxyConfig) {
    const browser = await chromium.launch({
      headless,
      proxy: proxyConfig,
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  } else {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless,
      viewport: { width: 1280, height: 800 },
    });
  }
  
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
  
  // Quick session establishment - just load homepage briefly
  console.log('Establishing session...');
  try {
    await page.goto('https://www.tcgplayer.com/', { 
      waitUntil: 'domcontentloaded',
      timeout: 15000 
    });
    await page.waitForTimeout(1000);
    console.log('Session established ✓');
  } catch (e) {
    console.log('Warning: Could not establish session, continuing anyway...');
  }
  
  const request = context.request;
  // Start faster now that proxy is working - API should be quick
  // 500ms between requests, can slow down if rate limited
  const rateLimiter = new AdaptiveRateLimiter(500, 300, 10000);
  const startTime = Date.now();
  
  let totalUpdated = 0;
  let totalRateLimited = 0;
  let totalUiFallbacks = 0;
  let processed = 0;
  
  try {
    // Track API success rate to decide on fallback
    let apiSuccesses = 0;
    let apiFailures = 0;
    
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      
      // Progress indicator every 50 cards or for first few
      const showProgress = i < 5 || i % 50 === 0;
      if (showProgress) {
        process.stdout.write(`[${i + 1}/${cards.length}] ${card.name.substring(0, 40).padEnd(40)}...`);
      }
      
      // Only use UI fallback if API is consistently failing (>50% failure rate after 10+ tries)
      const useUiFallback = apiFailures > 10 && apiFailures > apiSuccesses;
      const debug = i < 3;
      const result = await processCardListings(request, page, card, rateLimiter, useUiFallback, debug);
      
      if (result.usedUi) totalUiFallbacks++;
      
      if (result.rateLimited) {
        apiFailures++;
        if (showProgress) console.log(' (rate limited)');
        totalRateLimited++;
      } else if (result.updated) {
        apiSuccesses++;
        const source = result.usedUi ? ' [UI]' : '';
        if (showProgress) console.log(` $${result.price?.toFixed(2)}${source}`);
        totalUpdated++;
      } else {
        apiSuccesses++; // No listings is still a successful API call
        if (showProgress) console.log(' (no listings)');
      }
      
      processed++;
      
      // Show batch progress every 100 cards
      if (i > 0 && i % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = (i / parseFloat(elapsed)).toFixed(1);
        console.log(`  ⏱️  ${i}/${cards.length} (${rate}/sec) - Updated: ${totalUpdated}, Rate limited: ${totalRateLimited}`);
      }
      
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

