/**
 * Fix Card Names Job
 * 
 * Updates cards with generic names (like "Super Rare, #OP08-106") 
 * by fetching the real name from their product page
 */

import { chromium, BrowserContext } from 'playwright';
import { join } from 'path';
import { 
  initializeDb, 
  getAllCards, 
  getDb,
} from '../db/client.js';
import { REQUEST_DELAY_MS } from '../config.js';

const USER_DATA_DIR = join(process.cwd(), '.browser-data');

// Patterns that indicate a card needs its name fixed
const GENERIC_NAME_PATTERNS = [
  /^Super Rare,/,
  /^Secret Rare,/,
  /^Common,/,
  /^Rare,/,
  /^Uncommon,/,
  /^Leader,/,
  /^Treasure Rare,/,
];

// Set names that shouldn't be used as card names
const SET_NAMES = [
  'Romance Dawn',
  'Paramount War',
  'Pillars of Strength',
  'Kingdoms of Intrigue',
  'Awakening of the New Era',
  'Wings of the Captain',
  '500 Years in the Future',
  'Emperors in the New World',
  'Two Legends',
  'Carrying On His Will',
  'A Fist of Divine Speed',
  'Memorial Collection',
  'Royal Blood',
  'Legacy of the Master',
];

function needsNameFix(name: string, setName?: string): boolean {
  // Check rarity patterns
  if (GENERIC_NAME_PATTERNS.some(pattern => pattern.test(name))) {
    return true;
  }
  
  // Check if card name matches its set name (except sealed products)
  if (setName && name === setName) {
    return true;
  }
  
  // Check if card name is JUST a set name
  if (SET_NAMES.includes(name)) {
    return true;
  }
  
  return false;
}

export interface FixCardNamesOptions {
  headless?: boolean;
  limit?: number;
}

export async function fixCardNames(options: FixCardNamesOptions = {}): Promise<void> {
  const { headless = true, limit } = options;

  initializeDb();
  
  // Get cards with generic names (excluding sealed products which often share set name)
  const allCards = getAllCards();
  let cardsToFix = allCards.filter(card => {
    // Skip sealed products - they legitimately use set names
    if (card.product_type === 'sealed') return false;
    return needsNameFix(card.name, card.set_name);
  });
  
  if (limit) {
    cardsToFix = cardsToFix.slice(0, limit);
  }

  console.log(`\n🔧 Found ${cardsToFix.length} cards with generic names to fix\n`);

  if (cardsToFix.length === 0) {
    console.log('No cards need fixing!');
    return;
  }

  // Launch browser
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless,
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();
  let fixed = 0;
  let errors = 0;

  try {
    for (let i = 0; i < cardsToFix.length; i++) {
      const card = cardsToFix[i];
      console.log(`[${i + 1}/${cardsToFix.length}] ${card.name}...`);

      try {
        await page.goto(card.tcg_url, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        // Try to get the product name from the page (h1 contains "CardName - SetName (SetCode)")
        // Wait for h1 to appear
        await page.waitForSelector('h1', { timeout: 5000 }).catch(() => null);
        const nameElement = await page.$('h1');
        
        if (nameElement) {
          let fullText = await nameElement.textContent();
          fullText = fullText?.trim() || null;

          if (fullText) {
            // Extract just the card name (before the " - SetName" part)
            // Format: "Portgas.D.Ace (SP) - Two Legends (OP08)"
            const match = fullText.match(/^(.+?)\s+-\s+.+/);
            const newName = match ? match[1].trim() : fullText;

            if (newName && newName !== card.name && !needsNameFix(newName)) {
              // Update the card name in the database
              const db = getDb();
              db.prepare("UPDATE card SET name = ?, updated_at = datetime('now') WHERE id = ?")
                .run(newName, card.id);
              
              console.log(`   ✓ Updated: "${newName}"`);
              fixed++;
            } else {
              console.log(`   - Name unchanged or still generic`);
            }
          } else {
            console.log(`   ⚠ Could not get name text`);
          }
        } else {
          console.log(`   ⚠ Could not find name element`);
        }

        // Rate limiting
        await page.waitForTimeout(REQUEST_DELAY_MS);
      } catch (error) {
        console.log(`   ✗ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        errors++;
      }
    }
  } finally {
    await context.close();
  }

  console.log(`\n=== Summary ===`);
  console.log(`Fixed: ${fixed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Remaining: ${cardsToFix.length - fixed - errors}`);
}

