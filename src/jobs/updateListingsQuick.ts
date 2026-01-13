/**
 * Quick Listings Update Job
 * 
 * Fast API-based listings update - similar to how update-sales works
 * Falls back to UI scraping if API fails
 */

import { chromium, Page } from 'playwright';
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
  productIds?: number[];     // Specific products to update
  setName?: string;          // Filter by set name
  limit?: number;            // Max products to process
  headless?: boolean;
  useApi?: boolean;          // Try API first (default: true)
  workers?: number;          // Number of parallel browser tabs (1-4)
}

interface ListingResult {
  lowestPrice: number | null;
  lowestWithShipping: number | null;
  listingCount: number;
  currentQuantity: number;
  currentSellers: number;
}

/**
 * Non-English indicators for filtering
 */
const NON_ENGLISH_INDICATORS = [
  'japanese', 'japan', 'jp version', '(jp)', '[jp]', ' jp ', 'jp card',
  'korean', 'korea', 'kr version', '(kr)', '[kr]', ' kr ', 'kr card',
  '日本語', '日本', '한국어', '한국',
];

/**
 * Simple string patterns for loose pack detection (fast checks first)
 */
const LOOSE_PACK_SIMPLE = [
  '+ tournament', '+ promo', '+ free', '+ tp',
  'loose pack', 'single pack', 'individual pack',
  'packs only', 'pack only',
];

/**
 * Pre-compiled regex patterns for loose pack detection
 */
const LOOSE_PACK_REGEX = [
  /\dx\s+\w/,              // "6x OP05" or "3x booster"
  /pack\s*x\s*\d/,         // "pack x6"
  /\d+\s*packs/,           // "6 packs" or "6packs"
];

function isNonEnglish(text: string): boolean {
  const lower = text.toLowerCase();
  return NON_ENGLISH_INDICATORS.some(ind => lower.includes(ind));
}

/**
 * Check if listing appears to be loose packs instead of a sealed box
 * Optimized: simple string checks first, then pre-compiled regex
 */
function isLoosePackListing(text: string): boolean {
  const lower = text.toLowerCase();
  
  // Fast: simple string checks first
  for (const s of LOOSE_PACK_SIMPLE) {
    if (lower.includes(s)) return true;
  }
  
  // Pre-compiled regex (faster than new RegExp each time)
  for (const r of LOOSE_PACK_REGEX) {
    if (r.test(lower)) return true;
  }
  
  return false;
}

function isNearMintOrUnopened(condition: string): boolean {
  const lower = condition.toLowerCase();
  return lower.includes('near mint') || lower === 'nm' || lower.includes('unopened');
}

/**
 * Fetch listings via TCGplayer API (fast!)
 * Uses POST to mp-search-api.tcgplayer.com
 */
async function fetchListingsViaApi(
  page: Page,
  productId: number,
  productName?: string,
  productType?: string
): Promise<ListingResult> {
  // Check if this is a booster box (to filter out loose pack listings)
  const isBoosterBox = productType === 'sealed' && 
    productName?.toLowerCase().includes('booster box');
  const context = page.context();
  const request = context.request;
  
  try {
    // Listings API endpoint with cache-busting timestamp
    const url = `https://mp-search-api.tcgplayer.com/v1/product/${productId}/listings?mpfev=4528&_t=${Date.now()}`;
    
    const response = await request.post(url, {
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://www.tcgplayer.com',
        'referer': `https://www.tcgplayer.com/product/${productId}`,
        'cache-control': 'no-cache, no-store, must-revalidate',
        'pragma': 'no-cache',
      },
      data: {
        // Correct payload format from browser inspection
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
        size: 50,  // KEY: Must be > 0 to get actual results!
      },
    });
    
    if (!response.ok()) {
      return { lowestPrice: null, lowestWithShipping: null, listingCount: 0, currentQuantity: 0, currentSellers: 0 };
    }
    
    const data = await response.json() as {
      results?: Array<{
        totalResults?: number;
        results?: Array<{
          sellerName?: string;
          conditionName?: string;
          condition?: string;
          price?: number;
          shippingPrice?: number;
          quantity?: number;
          languageName?: string;
          language?: string;
          printing?: string;
          printingName?: string;
          customListingText?: string;
          customData?: {
            title?: string;
            description?: string;
          };
        }>;
      }>;
    };
    
    // Response is nested: data.results[0].results contains the listings
    const listingsWrapper = data.results?.[0];
    const listings = listingsWrapper?.results || [];
    
    if (listings.length === 0) {
      return { lowestPrice: null, lowestWithShipping: null, listingCount: 0, currentQuantity: 0, currentSellers: 0 };
    }
    
    // Calculate TOTAL market stats from ALL listings (before filtering)
    const uniqueSellers = new Set<string>();
    let totalQuantity = 0;
    
    for (const listing of listings) {
      totalQuantity += listing.quantity || 1;
      if (listing.sellerName) {
        uniqueSellers.add(listing.sellerName.toLowerCase());
      }
    }
    
    // Filter: English + Near Mint/Unopened + no Japanese/Korean in text
    const filtered = listings.filter(item => {
      // Check language field
      const lang = (item.languageName || item.language || '').toLowerCase();
      if (lang === 'japanese' || lang === 'korean') return false;
      
      // Check condition
      const cond = (item.conditionName || item.condition || '').toLowerCase();
      if (!cond.includes('near mint') && !cond.includes('unopened')) return false;
      
      // Check ALL text fields for non-English indicators
      // Key fix: customData.title contains the seller's listing title which often has "JAPANESE" etc.
      const customTitle = item.customData?.title || '';
      const customDesc = item.customData?.description || '';
      const descText = [
        item.customListingText || '',
        item.printingName || item.printing || '',
        customTitle,
        customDesc,
      ].join(' ');
      
      if (isNonEnglish(descText)) return false;
      
      // For booster boxes: filter out loose pack listings
      // Some sellers incorrectly list "6x Booster Packs" on the booster box page
      if (isBoosterBox && isLoosePackListing(descText)) {
        return false;
      }
      
      // Must have valid price
      if (!item.price || item.price <= 0) return false;
      
      return true;
    });
    
    if (filtered.length === 0) {
      return { 
        lowestPrice: null, 
        lowestWithShipping: null, 
        listingCount: 0,
        currentQuantity: totalQuantity,
        currentSellers: uniqueSellers.size,
      };
    }
    
    // Sort by total price
    filtered.sort((a, b) => {
      const totalA = (a.price || 0) + (a.shippingPrice || 0);
      const totalB = (b.price || 0) + (b.shippingPrice || 0);
      return totalA - totalB;
    });
    
    // SANITY CHECK: Filter out suspiciously cheap listings (likely stale API data)
    // If a listing is less than 30% of the median price, it's probably sold/cached
    if (filtered.length >= 3) {
      const medianIdx = Math.floor(filtered.length / 2);
      const medianPrice = filtered[medianIdx].price || 0;
      const minReasonablePrice = medianPrice * 0.3; // At least 30% of median
      
      const saneFiltered = filtered.filter((item: any) => item.price >= minReasonablePrice);
      if (saneFiltered.length < filtered.length && saneFiltered.length > 0) {
        // Only filter if we still have results
        filtered.length = 0;
        filtered.push(...saneFiltered);
      }
    }
    
    const lowest = filtered[0];
    const lowestPrice = lowest.price || 0;
    const lowestWithShipping = lowestPrice + (lowest.shippingPrice || 0);
    
    return {
      lowestPrice,
      lowestWithShipping,
      listingCount: filtered.length,
      currentQuantity: totalQuantity,
      currentSellers: uniqueSellers.size,
    };
    
  } catch (error) {
    // API failed, return empty
    return { lowestPrice: null, lowestWithShipping: null, listingCount: 0, currentQuantity: 0, currentSellers: 0 };
  }
}

/**
 * Fetch listings via UI scraping (slower, fallback)
 */
async function fetchListingsViaUI(
  page: Page,
  productUrl: string
): Promise<ListingResult> {
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    
    // Wait for listings
    try {
      await page.waitForSelector('.listing-item, .product-listing, [data-testid="listing-row"]', { timeout: 5000 });
    } catch {
      return { lowestPrice: null, lowestWithShipping: null, listingCount: 0, currentQuantity: 0, currentSellers: 0 };
    }
    
    // Scroll to load listings
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    
    // Extract listing data and market stats
    const result = await page.evaluate(() => {
      const listings: Array<{ price: number; shipping: number; condition: string; text: string; seller: string }> = [];
      
      // Find all Add to Cart buttons (each = 1 listing)
      const buttons = Array.from(document.querySelectorAll('button')).filter(btn =>
        btn.textContent?.includes('Add to Cart')
      );
      
      const seen = new Set<string>();
      const allSellers = new Set<string>();
      
      buttons.forEach(button => {
        let container = button.parentElement;
        for (let i = 0; i < 8 && container; i++) {
          container = container.parentElement;
          const text = container?.textContent || '';
          if (container?.querySelector('a[href*="sellerfeedback"]') && text.includes('$')) {
            if (container.parentElement) container = container.parentElement;
            break;
          }
        }
        if (!container) return;
        
        const sellerLink = container.querySelector('a[href*="sellerfeedback"]');
        const seller = sellerLink?.textContent?.trim() || '';
        const priceMatch = container.textContent?.match(/\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/);
        const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : 0;
        
        // Track all sellers for market stats
        if (seller) allSellers.add(seller.toLowerCase());
        
        const key = `${seller}|${price}`;
        if (seen.has(key) || !price) return;
        seen.add(key);
        
        const conditionEl = container.querySelector('h3');
        const condition = conditionEl?.textContent?.trim() || '';
        
        let shipping = 0;
        const shippingIncluded = container.querySelector('a[href*="Shipping-Included"]');
        if (!shippingIncluded) {
          const shipMatch = container.textContent?.match(/\+\s*\$?([\d.]+)\s*Shipping/);
          if (shipMatch) shipping = parseFloat(shipMatch[1]);
        }
        
        listings.push({
          price,
          shipping,
          condition,
          text: container.textContent || '',
          seller,
        });
      });
      
      // Try to get current quantity/sellers from price points section
      let currentQty = listings.length;  // Fallback to listings count
      let currentSellers = allSellers.size;
      
      // Look for "Current Quantity:" text
      const qtyMatch = document.body.textContent?.match(/Current\s*Quantity:?\s*(\d+)/i);
      if (qtyMatch) currentQty = parseInt(qtyMatch[1], 10);
      
      // Look for "Current Sellers:" text  
      const sellersMatch = document.body.textContent?.match(/Current\s*Sellers:?\s*(\d+)/i);
      if (sellersMatch) currentSellers = parseInt(sellersMatch[1], 10);
      
      return { listings, currentQty, currentSellers };
    });
    
    // Filter in JS - exclude non-English listings
    const nonEngPatterns = [
      // Japanese
      'japanese', 'japan', 'jp ', '(jp)', '[jp]', '-jp-',
      // Korean
      'korean', 'korea', 'kr ', '(kr)', '[kr]', '-kr-',
      // Chinese
      'chinese', 'china', 'cn ', '(cn)', '[cn]', '-cn-',
      // Taiwanese
      'taiwanese', 'taiwan', '(tw)', '[tw]',
      // Photo listings are almost always non-English variants trying to avoid filters
      'view details',
    ];
    
    // Conditions to explicitly exclude
    const badConditions = [
      'lightly played', 'light play', 'lp ',
      'moderately played', 'moderate play', 'mp ',
      'heavily played', 'heavy play', 'hp ',
      'damaged', 'dmg',
    ];
    
    const filtered = result.listings.filter(item => {
      const lowerText = item.text.toLowerCase();
      if (nonEngPatterns.some(p => lowerText.includes(p))) return false;
      
      const lowerCond = item.condition.toLowerCase();
      
      // Explicitly exclude bad conditions
      if (badConditions.some(c => lowerCond.includes(c))) return false;
      
      // Must be Near Mint or Unopened
      if (!lowerCond.includes('near mint') && !lowerCond.includes('unopened') && lowerCond !== 'nm') return false;
      
      return true;
    });
    
    if (filtered.length === 0) {
      return { 
        lowestPrice: null, 
        lowestWithShipping: null, 
        listingCount: 0,
        currentQuantity: result.currentQty,
        currentSellers: result.currentSellers,
      };
    }
    
    // Sort by total
    filtered.sort((a, b) => (a.price + a.shipping) - (b.price + b.shipping));
    
    const lowest = filtered[0];
    return {
      lowestPrice: lowest.price,
      lowestWithShipping: lowest.price + lowest.shipping,
      listingCount: filtered.length,
      currentQuantity: result.currentQty,
      currentSellers: result.currentSellers,
    };
    
  } catch {
    return { lowestPrice: null, lowestWithShipping: null, listingCount: 0, currentQuantity: 0, currentSellers: 0 };
  }
}

/**
 * Process a single card and return results
 */
async function processCard(
  page: Page,
  card: PgCard,
  useApi: boolean
): Promise<{ updated: boolean; apiSuccess: boolean; uiFallback: boolean; result: ListingResult | null }> {
  try {
    let result: ListingResult;
    let apiSuccess = false;
    let uiFallback = false;
    
    if (useApi) {
      result = await fetchListingsViaApi(page, card.product_id, card.name, card.product_type);
      if (result.listingCount > 0) {
        apiSuccess = true;
      } else if (card.tcg_url) {
        result = await fetchListingsViaUI(page, card.tcg_url);
        if (result.listingCount > 0) uiFallback = true;
      }
    } else if (card.tcg_url) {
      result = await fetchListingsViaUI(page, card.tcg_url);
    } else {
      return { updated: false, apiSuccess: false, uiFallback: false, result: null };
    }
    
    if (result.lowestPrice !== null || result.currentQuantity > 0) {
      await pgUpdateCardListings(
        card.product_id,
        result.lowestPrice,
        result.lowestWithShipping || result.lowestPrice,
        result.listingCount,
        result.currentQuantity
      );
      
      return { updated: true, apiSuccess, uiFallback, result };
    }
    
    return { updated: false, apiSuccess, uiFallback, result: null };
  } catch {
    return { updated: false, apiSuccess: false, uiFallback: false, result: null };
  }
}

/**
 * Main job: Update listings for all/filtered cards
 */
export async function updateListingsQuick(options: UpdateListingsOptions = {}): Promise<void> {
  const { 
    productIds, 
    setName,
    limit, 
    headless = false,  // Default to visible - TCGplayer blocks headless browsers 
    useApi = true,
    workers = 1,
  } = options;
  
  const numWorkers = Math.min(Math.max(1, workers), 4);
  
  console.log('\n=== Quick Listings Update ===');
  console.log(`Mode: ${useApi ? 'API (fast)' : 'UI scraping'}`);
  if (numWorkers > 1) console.log(`Workers: ${numWorkers} (parallel)`);
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
  
  // Launch browser
  console.log('Launching browser...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    viewport: { width: 1280, height: 800 },
  });
  
  try {
    const startTime = Date.now();
    let totalUpdated = 0;
    let totalErrors = 0;
    let apiSuccesses = 0;
    let uiFallbacks = 0;
    let processed = 0;
    
    if (numWorkers === 1) {
      // Single worker - original behavior with detailed output
      const page = context.pages()[0] || await context.newPage();
      
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        process.stdout.write(`[${i + 1}/${cards.length}] ${card.name.substring(0, 40).padEnd(40)}...`);
        
        const res = await processCard(page, card, useApi);
        
        if (res.updated && res.result) {
          if (res.result.lowestPrice !== null) {
            console.log(` $${res.result.lowestPrice.toFixed(2)} (${res.result.listingCount} NM)`);
          } else {
            console.log(` no NM`);
          }
          totalUpdated++;
        } else {
          console.log(' -');
        }
        
        if (res.apiSuccess) apiSuccesses++;
        if (res.uiFallback) uiFallbacks++;
        if (!res.updated && !res.apiSuccess && !res.uiFallback) totalErrors++;
        
        if (i < cards.length - 1) {
          await page.waitForTimeout(useApi ? 150 : REQUEST_DELAY_MS);
        }
      }
    } else {
      // Parallel workers - progress bar output
      const pages: Page[] = [];
      for (let i = 0; i < numWorkers; i++) {
        pages.push(await context.newPage());
      }
      
      // Process cards in parallel batches
      for (let i = 0; i < cards.length; i += numWorkers) {
        const batch = cards.slice(i, Math.min(i + numWorkers, cards.length));
        
        const results = await Promise.all(
          batch.map((card, idx) => processCard(pages[idx], card, useApi))
        );
        
        for (const res of results) {
          processed++;
          if (res.updated) totalUpdated++;
          if (res.apiSuccess) apiSuccesses++;
          if (res.uiFallback) uiFallbacks++;
          if (!res.updated && !res.apiSuccess && !res.uiFallback) totalErrors++;
        }
        
        const pct = Math.round((processed / cards.length) * 100);
        process.stdout.write(`\r⏳ Progress: ${pct}% (${processed}/${cards.length}) | Updated: ${totalUpdated}   `);
        
        if (i + numWorkers < cards.length) {
          await pages[0].waitForTimeout(useApi ? 100 : REQUEST_DELAY_MS);
        }
      }
      console.log(''); // New line after progress
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('\n=== Summary ===');
    console.log(`Products processed: ${cards.length}`);
    console.log(`Listings updated: ${totalUpdated}`);
    console.log(`Errors: ${totalErrors}`);
    if (useApi) {
      console.log(`API successes: ${apiSuccesses}`);
      console.log(`UI fallbacks: ${uiFallbacks}`);
    }
    console.log(`Time: ${elapsed}s (${(cards.length / parseFloat(elapsed)).toFixed(1)} products/sec)`);
    
  } finally {
    await context.close();
    console.log('\nBrowser closed.');
  }
}
