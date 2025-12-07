/**
 * Verify Deals Job
 * 
 * Takes potential deals identified from the database and re-verifies them
 * using UI scraping (not API) to ensure accurate pricing.
 * 
 * This is the "hybrid approach" - use fast API for bulk updates,
 * then verify the deals that actually matter with accurate UI scraping.
 */

import { chromium, Browser, Page } from 'playwright';
import { REQUEST_DELAY_MS } from '../config.js';
import { join } from 'path';
import { 
  getPotentialDeals,
  updateCardListings,
  initializeDb,
  DealCandidate,
} from '../db/client.js';
import { scrapeListings } from '../tcg/scrapeListings.js';

const USER_DATA_DIR = join(process.cwd(), '.browser-data');

export interface VerifyDealsOptions {
  minSales?: number;        // Minimum 7-day sales to consider
  minDiscount?: number;     // Minimum discount % to verify
  limit?: number;           // Max deals to verify
  headless?: boolean;
}

/**
 * Verify potential deals using UI scraping
 */
export async function verifyDeals(options: VerifyDealsOptions = {}): Promise<void> {
  const { 
    minSales = 3,
    minDiscount = 10,
    limit,
    headless = true,
  } = options;
  
  console.log('\n=== Verify Deals Job ===');
  console.log(`Min Sales: ${minSales}`);
  console.log(`Min Discount: ${minDiscount}%`);
  console.log(`Headless: ${headless}`);
  console.log('Method: UI Scraping (bypasses API cache)\n');
  
  // Initialize database
  initializeDb();
  
  // Get potential deals
  let deals = getPotentialDeals(minSales, minDiscount);
  
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
  let errors = 0;
  
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
        const discount = deal.market_vs_7d_pct?.toFixed(1) || '?';
        console.log(`${progress} 🔍 ${deal.name}`);
        console.log(`   Expected: Market $${deal.market_price?.toFixed(2)} → Avg $${deal.avg_price_7d?.toFixed(2)} (${discount}% below)`);
        
        // Use UI scraping to get ACTUAL current prices
        const summary = await scrapeListings(
          page, 
          deal.product_id, 
          deal.tcg_url,
          deal.name,
          'single' // Assuming singles for now
        );
        
        // Update database with verified prices
        updateCardListings(
          deal.product_id,
          summary.lowest_price,
          summary.lowest_price_with_shipping,
          summary.listing_count,
          true // Mark as verified
        );
        
        verified++;
        
        // Check if it's still a deal after verification
        const actualPrice = summary.lowest_price_with_shipping;
        const marketPrice = deal.market_price;
        
        if (actualPrice && marketPrice) {
          const actualDiscount = ((marketPrice - actualPrice) / marketPrice * 100);
          
          if (actualDiscount >= minDiscount) {
            console.log(`   ✅ VERIFIED DEAL: $${actualPrice.toFixed(2)} (${actualDiscount.toFixed(1)}% below market)`);
            stillDeals++;
          } else if (actualDiscount > 0) {
            console.log(`   ⚠️  Small discount: $${actualPrice.toFixed(2)} (${actualDiscount.toFixed(1)}% below, not ${discount}%)`);
            notDeals++;
          } else {
            console.log(`   ❌ NOT A DEAL: $${actualPrice.toFixed(2)} (${Math.abs(actualDiscount).toFixed(1)}% ABOVE market)`);
            notDeals++;
          }
        } else {
          console.log(`   ℹ️  No listings found`);
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
    
    // Summary
    console.log('=== Summary ===');
    console.log(`Deals verified: ${verified}`);
    console.log(`Still good deals: ${stillDeals} ✅`);
    console.log(`Not really deals: ${notDeals} ❌`);
    console.log(`Errors: ${errors}`);
    
    if (stillDeals > 0) {
      console.log(`\n💡 Run "npm run dev deals" to see verified deals!`);
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

