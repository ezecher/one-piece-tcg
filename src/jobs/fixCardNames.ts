/**
 * Fix Card Names Job
 * 
 * Updates cards with generic names (like "Super Rare, #OP08-106") 
 * by fetching the real name from their product page
 */

import { chromium, BrowserContext } from 'playwright';
import { join } from 'path';
import { 
  initPostgres,
  pgGetAllCards,
  getPool,
} from '../db/postgres.js';
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
  // Main sets
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
  'Azure Seven Seas',
  // Premium/Extra sets
  'Premium Booster -The Best-',
  'Premium Booster -The Best- Vol. 2',
  'Extra Booster: Anime 25th Collection',
  'Extra Booster: Memorial Collection',
  // Promo sets
  'One Piece Promotion Cards',
  'One Piece Demo Deck Cards',
  // Starter decks
  'Starter Deck EX: Gear 5',
  'Ultra Deck: The Three Brothers',
  'Ultra Deck: The Three Captains',
  'Learn Together Deck Set',
  // Tournament/Pre-release
  'Carrying On His Will: 3rd Anniversary Tournament Cards',
  'Emperors in the New World: 2nd Anniversary Tournament Cards',
  'Awakening of the New Era: 1st Anniversary Tournament Cards',
  'Romance Dawn Pre-Release Cards',
  'Paramount War Pre-Release Cards',
  'Pillars of Strength Pre-Release Cards',
  'Kingdoms of Intrigue Pre-Release Cards',
  'Awakening of the New Era Pre-Release Cards',
  'Wings of the Captain Pre-Release Cards',
  '500 Years in the Future Pre-Release Cards',
  'Emperors in the New World Pre-Release Cards',
  'Two Legends Pre-Release Cards',
  'Carrying On His Will Pre-Release Cards',
  'A Fist of Divine Speed Pre-Release Cards',
  'Royal Blood Pre-Release Cards',
  'Legacy of the Master Pre-Release Cards',
  'Azure Seven Seas Pre-Release Cards',
  // Release event cards
  'Romance Dawn Release Event Cards',
  'Paramount War Release Event Cards',
  'Pillars of Strength Release Event Cards',
  'Kingdoms of Intrigue Release Event Cards',
  'Awakening of the New Era Release Event Cards',
  'Wings of the Captain Release Event Cards',
  '500 Years in the Future Release Event Cards',
  'Emperors in the New World Release Event Cards',
  'Two Legends Release Event Cards',
  'Carrying On His Will Release Event Cards',
  'A Fist of Divine Speed Release Event Cards',
  'Royal Blood Release Event Cards',
  'Legacy of the Master Release Event Cards',
  'Azure Seven Seas Release Event Cards',
];

// Patterns that indicate name is actually a set name (not a card name)
const SET_NAME_PATTERNS = [
  /Pre-Release Cards$/,
  /Release Event Cards$/,
  /Tournament Cards$/,
  /Promotion Cards$/,
  /Demo Deck Cards$/,
  /^Starter Deck/,
  /^Ultra Deck/,
  /^Extra Booster/,
  /^Premium Booster/,
  /Winner Pack/,
  /Event Pack/,
  /^Super Pre-Release/,
];

function needsNameFix(name: string, setName?: string): boolean {
  // Check rarity patterns (like "Super Rare, #OP08-106")
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
  
  // Check if name matches set name patterns
  if (SET_NAME_PATTERNS.some(pattern => pattern.test(name))) {
    return true;
  }
  
  // Check if name is too short to be a real card name (likely truncated)
  if (name.length < 3) {
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

  await initPostgres();
  
  // Get cards with generic names (excluding sealed products which often share set name)
  const allCards = await pgGetAllCards();
  let cardsToFix = allCards.filter(card => {
    // Skip sealed products - they legitimately use set names
    if (card.product_type === 'sealed') return false;
    return needsNameFix(card.name, card.set_name || undefined);
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
              // Update the card name in PostgreSQL
              await getPool().query(
                `UPDATE cards SET name = $1, updated_at = NOW() WHERE product_id = $2`,
                [newName, card.product_id]
              );
              
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

