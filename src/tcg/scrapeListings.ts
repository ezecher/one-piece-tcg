/**
 * Listings Scraper
 * 
 * Scrapes current seller listings for a product
 * Filters: English only, Near Mint only
 */

import { Page } from 'playwright';
import { REQUEST_DELAY_MS } from '../config.js';

export interface Listing {
  seller_name: string;
  seller_rating: number | null;
  seller_sales: number | null;
  condition: string;
  price: number;
  shipping: number | null;
  quantity: number;
  is_foil: boolean;
}

export interface ListingsSummary {
  product_id: number;
  lowest_price: number | null;
  lowest_price_with_shipping: number | null;
  listing_count: number;
  listings: Listing[];
  scraped_at: Date;
}

/**
 * Check if a listing is non-English (Japanese, Korean, etc. - should be excluded)
 * Sellers often mark these with *Japanese*, ***Japanese***, (JP), KOREAN, etc.
 */
function isNonEnglishListing(text: string): boolean {
  const lowerText = text.toLowerCase();
  
  // Remove asterisks and other decorators to catch *japanese*, **japanese**, etc.
  const cleanedText = lowerText.replace(/[*_~]/g, '');
  
  const nonEnglishIndicators = [
    // Japanese
    'japanese',
    'japan',
    'jp version',
    '(jp)',
    '[jp]',
    ' jp ',
    '-jp-',
    'jp card',
    'jp promo',
    '日本語',
    '日本',
    // Korean
    'korean',
    'korea',
    'kr version',
    '(kr)',
    '[kr]',
    ' kr ',
    '-kr-',
    'kr card',
    '한국어',
    '한국',
  ];
  
  return nonEnglishIndicators.some(indicator => cleanedText.includes(indicator));
}

/**
 * Check if condition is Near Mint or Unopened (for sealed products)
 */
function isNearMintOrUnopened(condition: string): boolean {
  const lowerCondition = condition.toLowerCase();
  return lowerCondition.includes('near mint') || 
         lowerCondition === 'nm' ||
         lowerCondition.includes('nm ') ||
         lowerCondition.includes('unopened');
}

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

/**
 * Parse price string to number
 */
function parsePrice(priceStr: string): number {
  const cleaned = priceStr.replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

/**
 * Scrape listings for a product
 * Returns filtered listings (English + Near Mint only)
 */
export async function scrapeListings(
  page: Page,
  productId: number,
  productUrl: string,
  productName?: string,
  productType?: string
): Promise<ListingsSummary> {
  // Check if this is a booster box (to filter out loose pack listings)
  const isBoosterBox = productType === 'sealed' && 
    productName?.toLowerCase().includes('booster box');
  console.log(`    📋 Fetching listings...`);
  
  // Navigate to the product page
  await page.goto(productUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(REQUEST_DELAY_MS);
  
  // Wait for listings to load
  try {
    await page.waitForSelector('.listing-item, .product-listing', { timeout: 5000 });
  } catch {
    // No listings found
    return {
      product_id: productId,
      lowest_price: null,
      lowest_price_with_shipping: null,
      listing_count: 0,
      listings: [],
      scraped_at: new Date(),
    };
  }
  
  // Scroll to load all listings
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  
  // Extract listings from the page
  const rawListings = await page.evaluate(() => {
    const listings: Array<{
      seller: string;
      condition: string;
      price: string;
      shipping: string;
      quantity: string;
      fullText: string;
      listingDescription: string;
    }> = [];
    
    // Find all "Add to Cart" buttons - each one represents exactly one listing
    const allButtons = Array.from(document.querySelectorAll('button'));
    const addToCartButtons = allButtons.filter(btn => 
      btn.textContent?.includes('Add to Cart') || 
      btn.className?.includes('add-to-cart')
    );
    const seen = new Set<string>(); // Dedupe by seller+price
    
    addToCartButtons.forEach(button => {
      // Walk up to find the listing container
      // Need to go high enough to include Japanese variant descriptions which are siblings
      let container = button.parentElement;
      for (let i = 0; i < 8 && container; i++) {
        container = container.parentElement;
        // Stop when we have seller info AND the container is big enough to include descriptions
        const text = container?.textContent || '';
        if (container?.querySelector('a[href*="sellerfeedback"]') && 
            text.includes('$') &&
            text.includes('Add to Cart')) {
          // Walk up one more level to get sibling elements with Japanese descriptions
          if (container.parentElement) {
            container = container.parentElement;
          }
          break;
        }
      }
      
      if (!container) return;
      
      // Get seller name
      const sellerLink = container.querySelector('a[href*="sellerfeedback"]');
      const seller = sellerLink?.textContent?.trim() || '';
      
      // Get price from the listing (look for $ followed by numbers)
      const priceMatch = container.textContent?.match(/\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/);
      const price = priceMatch ? '$' + priceMatch[1] : '';
      
      // Dedupe check
      const key = `${seller}|${price}`;
      if (seen.has(key)) return;
      seen.add(key);
      
      // Get condition
      const conditionEl = container.querySelector('h3');
      const condition = conditionEl?.textContent?.trim() || '';
      
      // Get shipping info
      let shipping = '';
      const shippingIncluded = container.querySelector('a[href*="Shipping-Included"]');
      if (shippingIncluded) {
        shipping = 'Included';
      } else {
        const shippingMatch = container.textContent?.match(/\+\s*\$?([\d.]+)\s*Shipping/);
        if (shippingMatch) {
          shipping = shippingMatch[1];
        }
      }
      
      // Get quantity
      const qtyMatch = container.textContent?.match(/of\s+(\d+)/);
      const quantity = qtyMatch ? qtyMatch[1] : '1';
      
      // Get ALL text in the container - includes Japanese variant descriptions
      const fullText = container.textContent || '';
      
      // Also specifically get text from image alt tags and detail links
      let listingDescription = '';
      const images = container.querySelectorAll('img');
      images.forEach(img => {
        const alt = img.getAttribute('alt') || '';
        if (alt.length > 5) listingDescription += ' ' + alt;
      });
      
      if (seller && price) {
        listings.push({
          seller,
          condition,
          price,
          shipping,
          quantity,
          fullText,
          listingDescription,
        });
      }
    });
    
    return listings;
  });
  
  // Filter and normalize listings
  const filteredListings: Listing[] = [];
  let skippedJapanese = 0;
  let skippedCondition = 0;
  
  let skippedLoosePacks = 0;
  
  for (const raw of rawListings) {
    // Skip Japanese listings - check EVERYTHING in the row
    const combinedText = raw.fullText + ' ' + raw.listingDescription;
    if (isNonEnglishListing(combinedText)) {
      skippedJapanese++;
      continue;
    }
    
    // For booster boxes: skip loose pack listings
    // Some sellers list "6x Booster Packs" on the booster box page
    if (isBoosterBox && isLoosePackListing(combinedText)) {
      skippedLoosePacks++;
      continue;
    }
    
    // Skip non-Near Mint / non-Unopened listings
    if (!isNearMintOrUnopened(raw.condition)) {
      skippedCondition++;
      continue;
    }
    
    // Parse price
    const price = parsePrice(raw.price);
    if (price <= 0) continue;
    
    // Parse shipping
    let shipping: number | null = null;
    if (raw.shipping.toLowerCase().includes('included') || raw.shipping.toLowerCase().includes('free')) {
      shipping = 0;
    } else {
      const shippingMatch = raw.shipping.match(/\$?([\d.]+)/);
      if (shippingMatch) {
        shipping = parseFloat(shippingMatch[1]);
      }
    }
    
    // Parse quantity
    const qtyMatch = raw.quantity.match(/(\d+)/);
    const quantity = qtyMatch ? parseInt(qtyMatch[1]) : 1;
    
    // Check if foil
    const isFoil = raw.condition.toLowerCase().includes('foil');
    
    filteredListings.push({
      seller_name: raw.seller,
      seller_rating: null, // Would need additional parsing
      seller_sales: null,
      condition: raw.condition,
      price,
      shipping,
      quantity,
      is_foil: isFoil,
    });
  }
  
  // Sort by total price (price + shipping)
  filteredListings.sort((a, b) => {
    const totalA = a.price + (a.shipping || 0);
    const totalB = b.price + (b.shipping || 0);
    return totalA - totalB;
  });
  
  // Calculate summary
  const lowestListing = filteredListings[0];
  
  const totalRaw = rawListings.length;
  const skippedPacksMsg = skippedLoosePacks > 0 ? `, ${skippedLoosePacks} packs` : '';
  console.log(`       Found ${filteredListings.length} EN NM listings (skipped: ${skippedJapanese} non-EN, ${skippedCondition} cond${skippedPacksMsg})`);
  
  if (lowestListing) {
    const totalPrice = lowestListing.price + (lowestListing.shipping || 0);
    console.log(`       Lowest: $${totalPrice.toFixed(2)}`);
  }
  
  return {
    product_id: productId,
    lowest_price: lowestListing?.price || null,
    lowest_price_with_shipping: lowestListing 
      ? lowestListing.price + (lowestListing.shipping || 0) 
      : null,
    listing_count: filteredListings.length,
    listings: filteredListings,
    scraped_at: new Date(),
  };
}

/**
 * Scrape listings using the TCGplayer API
 * This is faster and more reliable than UI scraping
 */
export async function scrapeListingsViaApi(
  page: Page,
  productId: number
): Promise<ListingsSummary> {
  console.log(`    📋 Fetching listings via API...`);
  
  const context = page.context();
  const request = context.request;
  
  try {
    // TCGplayer listings API endpoint
    const url = `https://mpapi.tcgplayer.com/v2/product/${productId}/listings`;
    
    const response = await request.get(url, {
      headers: {
        'accept': 'application/json',
        'origin': 'https://www.tcgplayer.com',
        'referer': 'https://www.tcgplayer.com/',
      },
    });
    
    if (!response.ok()) {
      console.log(`       API returned ${response.status()}, falling back to UI`);
      return {
        product_id: productId,
        lowest_price: null,
        lowest_price_with_shipping: null,
        listing_count: 0,
        listings: [],
        scraped_at: new Date(),
      };
    }
    
    const data = await response.json() as {
      results?: Array<{
        sellerName?: string;
        condition?: string;
        price?: number;
        shippingPrice?: number;
        quantity?: number;
        language?: string;
        printing?: string;
      }>;
    };
    
    if (!data.results) {
      return {
        product_id: productId,
        lowest_price: null,
        lowest_price_with_shipping: null,
        listing_count: 0,
        listings: [],
        scraped_at: new Date(),
      };
    }
    
    // Filter listings
    const filteredListings: Listing[] = [];
    
    for (const item of data.results) {
      // Skip Japanese
      if (item.language?.toLowerCase() === 'japanese') continue;
      
      // Skip non-Near Mint
      const condition = item.condition || '';
      if (!isNearMintOrUnopened(condition)) continue;
      
      const price = item.price || 0;
      if (price <= 0) continue;
      
      filteredListings.push({
        seller_name: item.sellerName || 'Unknown',
        seller_rating: null,
        seller_sales: null,
        condition,
        price,
        shipping: item.shippingPrice || null,
        quantity: item.quantity || 1,
        is_foil: condition.toLowerCase().includes('foil'),
      });
    }
    
    // Sort by total price
    filteredListings.sort((a, b) => {
      const totalA = a.price + (a.shipping || 0);
      const totalB = b.price + (b.shipping || 0);
      return totalA - totalB;
    });
    
    const lowestListing = filteredListings[0];
    
    console.log(`       Found ${filteredListings.length} English Near Mint listings`);
    if (lowestListing) {
      const totalPrice = lowestListing.price + (lowestListing.shipping || 0);
      console.log(`       Lowest: $${lowestListing.price.toFixed(2)} + $${(lowestListing.shipping || 0).toFixed(2)} = $${totalPrice.toFixed(2)}`);
    }
    
    return {
      product_id: productId,
      lowest_price: lowestListing?.price || null,
      lowest_price_with_shipping: lowestListing 
        ? lowestListing.price + (lowestListing.shipping || 0) 
        : null,
      listing_count: filteredListings.length,
      listings: filteredListings,
      scraped_at: new Date(),
    };
    
  } catch (error) {
    console.log(`       Error fetching listings: ${error}`);
    return {
      product_id: productId,
      lowest_price: null,
      lowest_price_with_shipping: null,
      listing_count: 0,
      listings: [],
      scraped_at: new Date(),
    };
  }
}

