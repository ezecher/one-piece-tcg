/**
 * Manual Login & Cookie Saver
 * 
 * Opens your REAL Chrome browser (not Playwright's Chromium),
 * lets you login manually to TCGplayer, then saves cookies.
 */

import { chromium } from 'playwright';
import { join } from 'path';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';

const COOKIES_FILE = join(process.cwd(), 'tcgplayer-cookies.json');

// Path to real Chrome on macOS
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Use a separate profile to avoid messing with your main Chrome
const CHROME_USER_DATA = join(homedir(), '.tcgplayer-chrome-profile');

export async function loginAndSaveCookies(): Promise<void> {
  console.log('\n=== TCGplayer Manual Login (Real Chrome) ===\n');
  console.log('1. Your REAL Chrome browser will open');
  console.log('2. Login to TCGplayer normally');
  console.log('3. Once logged in, press Enter in this terminal');
  console.log('4. Cookies will be saved for future use\n');
  
  // Launch real Chrome with a dedicated profile
  const context = await chromium.launchPersistentContext(CHROME_USER_DATA, {
    headless: false,
    executablePath: CHROME_PATH,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  
  const page = context.pages()[0] || await context.newPage();
  
  // Navigate to TCGplayer login
  console.log('Opening TCGplayer login page...\n');
  await page.goto('https://www.tcgplayer.com/login');
  
  // Wait for user to login manually
  console.log('👆 Please login in the browser window...');
  console.log('   Press ENTER here when you\'re logged in.\n');
  
  // Wait for Enter key
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
  
  // Check if logged in by looking for account indicators
  const isLoggedIn = await page.evaluate(() => {
    // Look for signs of being logged in - use simple selectors
    const pageText = document.body.innerText.toLowerCase();
    const hasAccountText = pageText.includes('my account') || 
                          pageText.includes('sign out') || 
                          pageText.includes('my orders');
    const accountLinks = document.querySelectorAll('[href*="/account"], [href*="/my/"]');
    return hasAccountText || accountLinks.length > 0;
  });
  
  if (!isLoggedIn) {
    console.log('⚠️  Could not verify login. Saving cookies anyway...\n');
  } else {
    console.log('✅ Login detected!\n');
  }
  
  // Get all cookies
  const cookies = await context.cookies();
  
  // Save cookies to file
  writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log(`✅ Saved ${cookies.length} cookies to ${COOKIES_FILE}\n`);
  
  // Test by navigating to a product page
  console.log('Testing access to sales data...');
  await page.goto('https://www.tcgplayer.com/product/471498/one-piece-card-game-romance-dawn-monkey-d-luffy-op01-003-secret-rare');
  await page.waitForTimeout(3000);
  
  // Try to find sales data
  const salesCount = await page.evaluate(() => {
    // Look for sales history section
    const salesSection = document.querySelector('[class*="sales"], [class*="history"], [data-testid*="sales"]');
    const salesRows = document.querySelectorAll('tr, [class*="sale-row"], [class*="transaction"]');
    return {
      hasSalesSection: !!salesSection,
      rowCount: salesRows.length,
      pageText: document.body.innerText.substring(0, 5000),
    };
  });
  
  console.log(`Found ${salesCount.rowCount} potential sales rows`);
  
  // Look for "View More Data" or sales count in page
  if (salesCount.pageText.includes('View More Data')) {
    console.log('✅ "View More Data" button found - you have access to extended sales!');
  }
  
  // Check for price history section
  if (salesCount.pageText.includes('Price History') || salesCount.pageText.includes('Recent Sales')) {
    console.log('✅ Price History section found');
  }
  
  console.log('\n📋 Browser will stay open so you can explore.');
  console.log('   Check the sales/price history section manually.');
  console.log('   Press ENTER to close the browser.\n');
  
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
  
  await context.close();
  console.log('Browser closed. Cookies saved!\n');
}

export async function testWithSavedCookies(): Promise<void> {
  console.log('\n=== Testing Saved Cookies ===\n');
  
  if (!existsSync(COOKIES_FILE)) {
    console.log('❌ No saved cookies found. Run login first.');
    return;
  }
  
  const cookies = JSON.parse(readFileSync(COOKIES_FILE, 'utf-8'));
  console.log(`Loaded ${cookies.length} cookies from file\n`);
  
  // Use real Chrome for testing too
  const browser = await chromium.launch({ 
    headless: false,
    executablePath: CHROME_PATH,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext();
  
  // Add cookies
  await context.addCookies(cookies);
  
  const page = await context.newPage();
  
  // Test a product page
  console.log('Testing product page with cookies...');
  await page.goto('https://www.tcgplayer.com/product/471498/one-piece-card-game-romance-dawn-monkey-d-luffy-op01-003-secret-rare');
  await page.waitForTimeout(3000);
  
  // Check if still logged in
  const loginStatus = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      isLoggedIn: text.includes('My Account') || text.includes('Sign Out'),
      hasSalesAccess: text.includes('View More Data') || text.includes('Price History'),
    };
  });
  
  console.log(`Logged in: ${loginStatus.isLoggedIn ? '✅ Yes' : '❌ No'}`);
  console.log(`Sales access: ${loginStatus.hasSalesAccess ? '✅ Yes' : '❌ No'}`);
  
  console.log('\nPress ENTER to close browser...');
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });
  
  await browser.close();
}

