/**
 * Verify Deals Job
 * 
 * Takes potential deals (where lowest listing < market price)
 * and re-verifies them using UI scraping to get accurate prices.
 * 
 * The API sometimes has stale cached data. This job uses the actual
 * webpage to get real current prices and updates the database.
 */

import { chromium, Browser, Page } from 'playwright';
import { REQUEST_DELAY_MS } from '../config.js';
import { join } from 'path';
import { 
  initPostgres,
  pgGetPotentialDeals,
  pgUpdateCardListings,
  pgRecordSuspiciousListing,
} from '../db/postgres.js';
import { scrapeListings } from '../tcg/scrapeListings.js';

const USER_DATA_DIR = join(process.cwd(), '.browser-data');

export interface VerifyDealsOptions {
  minDiscount?: number;     // Minimum discount % to verify (default 10)
  limit?: number;           // Max deals to verify
  headless?: boolean;
}

export interface ListingDeal {
  product_id: number;
  name: string;
  tcg_url: string;
  product_type: string;
  lowest_listing: number;
  market_price: number;
  discount_pct: number;
}

/**
 * Verify potential deals using UI scraping
 */
export async function verifyDeals(options: VerifyDealsOptions = {}): Promise<void> {
  const { 
    minDiscount = 10,
    limit,
    headless = true,
  } = options;
  
  console.log('\n=== Verify Deals Job ===');
  console.log(`Min Discount: ${minDiscount}%`);
  console.log(`Headless: ${headless}`);
  console.log('Method: UI Scraping (bypasses stale API cache)');
  console.log('Comparing: Lowest Listing vs Market Price\n');
  
  // Initialize PostgreSQL
  await initPostgres();
  
  // Get deals where lowest_listing < market_price (excluding known-bad prices)
  let deals = await pgGetPotentialDeals(minDiscount);
  
  if (deals.length === 0) {
    console.log('No deals found matching criteria.');
    return;
  }
  
  console.log(`Found ${deals.length} potential deals to verify\n`);
  
  if (limit && deals.length > limit) {
    deals = deals.slice(0, limit);
    console.log(`Limited to first ${limit} deals\n`);
  }
  
  let browser: Browser | null = null;
  let page: Page | null = null;
  let verified = 0;
  let stillDeals = 0;
  let notDeals = 0;
  let noListings = 0;
  let errors = 0;
  
  const startTime = Date.now();
  
  try {
    // Launch browser
    console.log('Launching browser...\n');
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless,
      viewport: { width: 1280, height: 800 },
    });
    browser = context.browser();
    page = context.pages()[0] || await context.newPage();
    
    // Verify each deal
    for (let i = 0; i < deals.length; i++) {
      const deal = deals[i];
      const progress = `[${i + 1}/${deals.length}]`;
      
      try {
        console.log(`${progress} 🔍 ${deal.name}`);
        console.log(`   API says: $${deal.lowest_listing.toFixed(2)} listing vs $${deal.market_price.toFixed(2)} market (${deal.discount_pct}% off)`);
        
        // Use UI scraping to get ACTUAL current prices
        const summary = await scrapeListings(
          page, 
          deal.product_id, 
          deal.tcg_url,
          deal.name,
          deal.product_type
        );
        
        // Update database with real prices
        await pgUpdateCardListings(
          deal.product_id,
          summary.lowest_price,
          summary.lowest_price_with_shipping,
          summary.listing_count
        );
        
        verified++;
        
        // Check if it's still a deal after verification
        const actualPrice = summary.lowest_price_with_shipping || summary.lowest_price;
        const marketPrice = deal.market_price;
        const apiPrice = deal.lowest_listing;
        
        if (actualPrice && marketPrice) {
          const actualDiscount = ((marketPrice - actualPrice) / marketPrice * 100);
          
          // Record if API was significantly wrong (more than 5% off)
          const priceDiff = Math.abs(actualPrice - apiPrice) / apiPrice * 100;
          if (priceDiff > 5) {
            await pgRecordSuspiciousListing(
              deal.product_id,
              apiPrice,
              actualPrice,
              marketPrice,
              deal.discount_pct,
              actualDiscount
            );
          }
          
          if (actualDiscount >= minDiscount) {
            console.log(`   ✅ VERIFIED: $${actualPrice.toFixed(2)} (${actualDiscount.toFixed(1)}% below market)`);
            stillDeals++;
          } else if (actualDiscount > 0) {
            console.log(`   ⚠️  Small: $${actualPrice.toFixed(2)} (only ${actualDiscount.toFixed(1)}% off, was ${deal.discount_pct}%)`);
            notDeals++;
          } else {
            console.log(`   ❌ NOT A DEAL: $${actualPrice.toFixed(2)} is ${Math.abs(actualDiscount).toFixed(1)}% ABOVE market`);
            notDeals++;
          }
        } else if (!actualPrice) {
          console.log(`   ℹ️  No English NM listings found`);
          noListings++;
        }
        
        console.log('');
        
      } catch (error) {
        console.error(`   → Error: ${error}\n`);
        errors++;
      }
      
      // Delay between requests
      if (i < deals.length - 1) {
        await page.waitForTimeout(REQUEST_DELAY_MS);
      }
    }
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Summary
    console.log('=== Summary ===');
    console.log(`Time: ${elapsed}s`);
    console.log(`Deals checked: ${verified}`);
    console.log(`Still good deals: ${stillDeals} ✅`);
    console.log(`Not actually deals: ${notDeals} ❌ (stale API data)`);
    console.log(`No English NM listings: ${noListings} ℹ️`);
    console.log(`Errors: ${errors}`);
    
    if (stillDeals > 0) {
      console.log(`\n🎉 ${stillDeals} real deals found! Check the dashboard.`);
    } else if (verified > 0) {
      console.log(`\n📊 All ${verified} "deals" were stale API data. Prices have been updated.`);
    }
    
  } catch (error) {
    console.error('Job failed:', error);
    throw error;
    
  } finally {
    if (page) {
      const context = page.context();
      await context.close();
    }
    console.log('\nBrowser closed.');
  }
}
