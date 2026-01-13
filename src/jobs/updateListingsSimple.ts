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
}

interface ListingResult {
  lowestPrice: number | null;
  listingCount: number;
  currentQuantity: number;
  rateLimited: boolean;
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
  card: PgCard,
  rateLimiter: AdaptiveRateLimiter
): Promise<{ updated: boolean; rateLimited: boolean; price: number | null }> {
  const result = await fetchListings(request, card.product_id);
  
  if (result.rateLimited) {
    rateLimiter.recordRateLimit();
    return { updated: false, rateLimited: true, price: null };
  }
  
  if (result.lowestPrice !== null) {
    await pgUpdateCardListings(
      card.product_id,
      result.lowestPrice,
      result.lowestPrice, // Use same for market price
      result.listingCount,
      result.currentQuantity
    );
    rateLimiter.recordSuccess();
    return { updated: true, rateLimited: false, price: result.lowestPrice };
  }
  
  rateLimiter.recordSuccess();
  return { updated: false, rateLimited: false, price: null };
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
  } = options;
  
  console.log('\n=== Update Listings Job ===');
  console.log(`Headless: ${headless}`);
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
  });
  
  const request = context.request;
  const rateLimiter = new AdaptiveRateLimiter(1000, 500, 15000);
  const startTime = Date.now();
  
  let totalUpdated = 0;
  let totalRateLimited = 0;
  let processed = 0;
  
  try {
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      process.stdout.write(`[${i + 1}/${cards.length}] ${card.name.substring(0, 40).padEnd(40)}...`);
      
      const result = await processCardListings(request, card, rateLimiter);
      
      if (result.rateLimited) {
        console.log(' (rate limited - retrying)');
        // Wait and retry once
        await rateLimiter.wait();
        const retry = await processCardListings(request, card, rateLimiter);
        if (retry.updated) {
          console.log(` $${retry.price?.toFixed(2)}`);
          totalUpdated++;
        } else if (retry.rateLimited) {
          console.log(' (still rate limited - skipping)');
          totalRateLimited++;
        } else {
          console.log(' (no listings)');
        }
      } else if (result.updated) {
        console.log(` $${result.price?.toFixed(2)}`);
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
    if (totalRateLimited > 0) console.log(`Rate limited: ${totalRateLimited}`);
    console.log(`Time: ${elapsed}s (${(cards.length / parseFloat(elapsed)).toFixed(1)} products/sec)`);
    
    await context.close();
    console.log('\nBrowser closed.');
    
  } catch (error) {
    console.error('Job failed:', error);
    await context.close();
    throw error;
  }
}

