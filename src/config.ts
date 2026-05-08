/**
 * TCGplayer One Piece Scraper Configuration
 * 
 * Contains all URLs, templates, and constants for scraping
 */

// Minimum market price to track - ignore cheap cards under $10
export const MIN_MARKET_PRICE = 10;

// Delay between requests (ms) to be respectful
export const REQUEST_DELAY_MS = 1000;

// Max pages to scrape per search (safety limit)
export const MAX_PAGES_PER_SEARCH = 100;

// Product types we care about
export type ProductMode = 'singles' | 'sealed' | 'all';

// Base URL for TCGplayer search
export const TCGPLAYER_BASE_URL = 'https://www.tcgplayer.com';

// Search URL templates
export const SEARCH_URL_TEMPLATES = {
  // All One Piece products
  all: `${TCGPLAYER_BASE_URL}/search/one-piece-card-game/product?productLineName=one-piece-card-game&view=grid&page={page}`,
  
  // Singles only
  singles: `${TCGPLAYER_BASE_URL}/search/one-piece-card-game/product?productLineName=one-piece-card-game&ProductTypeName=Singles&view=grid&page={page}`,
  
  // Sealed products only
  sealed: `${TCGPLAYER_BASE_URL}/search/one-piece-card-game/product?productLineName=one-piece-card-game&ProductTypeName=Sealed+Products&view=grid&page={page}`,
  
  // By set (sorted by price high to low)
  bySet: `${TCGPLAYER_BASE_URL}/search/one-piece-card-game/{setSlug}?productLineName=one-piece-card-game&setName={setSlug}&view=grid&page={page}`,
} as const;

// Build search URL with optional set filter
export function buildSearchUrl(mode: ProductMode, page: number, setSlug?: string): string {
  let url = SEARCH_URL_TEMPLATES[mode].replace('{page}', String(page));
  
  if (setSlug) {
    // Add set filter
    url += `&setName=${encodeURIComponent(setSlug)}`;
  }
  
  return url;
}

// Build search URL for a specific set, sorted by price high to low
export function buildSetSearchUrl(setSlug: string, page: number): string {
  // Note: TCGplayer uses client-side sorting, but we can still navigate directly
  return `${TCGPLAYER_BASE_URL}/search/one-piece-card-game/${setSlug}?productLineName=one-piece-card-game&setName=${setSlug}&view=grid&page=${page}`;
}

// All One Piece sets with their URL slugs
// Format: { name: display name, slug: URL slug, count: approximate product count }
export const ONE_PIECE_SETS = [
  // Main Booster Sets (high priority)
  { name: 'Carrying On His Will', slug: 'carrying-on-his-will', count: 181 },
  { name: 'Emperors in the New World', slug: 'emperors-in-the-new-world', count: 169 },
  { name: 'A Fist of Divine Speed', slug: 'a-fist-of-divine-speed', count: 166 },
  { name: 'Kingdoms of Intrigue', slug: 'kingdoms-of-intrigue', count: 166 },
  { name: 'Legacy of the Master', slug: 'legacy-of-the-master', count: 165 },
  { name: 'Awakening of the New Era', slug: 'awakening-of-the-new-era', count: 165 },
  { name: 'Romance Dawn', slug: 'romance-dawn', count: 163 },
  { name: 'Paramount War', slug: 'paramount-war', count: 162 },
  { name: '500 Years in the Future', slug: '500-years-in-the-future', count: 162 },
  { name: 'Wings of the Captain', slug: 'wings-of-the-captain', count: 162 },
  { name: 'Two Legends', slug: 'two-legends', count: 162 },
  { name: 'Pillars of Strength', slug: 'pillars-of-strength', count: 159 },
  { name: 'Royal Blood', slug: 'royal-blood', count: 156 },
  
  // Premium/Extra Boosters
  { name: 'Premium Booster -The Best- Vol. 2', slug: 'premium-booster-the-best-vol-2', count: 380 },
  { name: 'Premium Booster -The Best-', slug: 'premium-booster-the-best', count: 329 },
  { name: 'Extra Booster: Anime 25th Collection', slug: 'extra-booster-anime-25th-collection', count: 108 },
  { name: 'Extra Booster: Memorial Collection', slug: 'extra-booster-memorial-collection', count: 83 },
  
  // Promotion Cards
  { name: 'One Piece Promotion Cards', slug: 'one-piece-promotion-cards', count: 1119 },
  
  // Tournament/Pre-Release Cards
  { name: 'Carrying On His Will: 3rd Anniversary Tournament Cards', slug: 'carrying-on-his-will-3rd-anniversary-tournament-cards', count: 81 },
  { name: 'Emperors in the New World: 2nd Anniversary Tournament Cards', slug: 'emperors-in-the-new-world-2nd-anniversary-tournament-cards', count: 76 },
  { name: 'Awakening of the New Era: 1st Anniversary Tournament Cards', slug: 'awakening-of-the-new-era-1st-anniversary-tournament-cards', count: 76 },
  
  // Starter/Ultra Decks (lower priority but include for sealed products)
  { name: 'Ultra Deck: The Three Brothers', slug: 'ultra-deck-the-three-brothers', count: 38 },
  { name: 'Ultra Deck: The Three Captains', slug: 'ultra-deck-the-three-captains', count: 21 },
  { name: 'Learn Together Deck Set', slug: 'learn-together-deck-set', count: 53 },
  { name: 'Starter Deck EX: Gear 5', slug: 'starter-deck-ex-gear-5', count: 36 },
];

// Just the main booster sets (for quick testing)
export const MAIN_BOOSTER_SETS = ONE_PIECE_SETS.filter(s => 
  s.count >= 150 && !s.name.includes('Promotion') && !s.name.includes('Premium')
);

// Pages to scrape per set when sorting by price high to low
// 3 pages = ~72 products = all the high value cards
export const PAGES_PER_SET = 2;

// Price guide URLs (alternative source for product discovery)
export const PRICE_GUIDE_BASE_URL = `${TCGPLAYER_BASE_URL}/categories/trading-and-collectible-card-games/one-piece-card-game/price-guides`;

// Build price guide URL for a set
export function buildPriceGuideUrl(setSlug: string): string {
  return `${PRICE_GUIDE_BASE_URL}/${setSlug}`;
}

// API headers for direct API calls (if we use them later)
export const API_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'origin': TCGPLAYER_BASE_URL,
  'referer': `${TCGPLAYER_BASE_URL}/`,
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Sales endpoint template (captured from DevTools - uses POST request)
export const SALES_ENDPOINT_TEMPLATE = 
  'https://mpapi.tcgplayer.com/v2/product/{productId}/latestsales?mpfev=4528';

// Sales endpoint uses POST method
export const SALES_ENDPOINT_METHOD = 'POST' as const;

// Selectors for scraping (adjust based on actual DOM inspection)
export const SELECTORS = {
  // Search page selectors
  productGrid: '[class*="search-result"]',
  productCard: '[class*="product-card"]',
  productLink: 'a[href*="/product/"]',
  productName: '[class*="product-card__name"], [class*="product-name"]',
  productSet: '[class*="product-card__set"], [class*="set-name"]',
  marketPrice: '[class*="market-price"], [class*="product-card__market-price"]',
  noResults: '[class*="no-results"], [class*="empty-state"]',
  pagination: '[class*="pagination"]',
  nextPage: '[class*="pagination"] [class*="next"], a[aria-label="Next page"]',
  
  // Product page selectors (for sales)
  salesTab: '[data-testid="sales-tab"], button:has-text("Sales"), a:has-text("See all TCGplayer sales")',
  salesTable: '[class*="sales-table"], table[class*="sales"]',
  salesRow: '[class*="sales-row"], tbody tr',
  saleDate: '[class*="sale-date"], td:nth-child(1)',
  salePrice: '[class*="sale-price"], td:nth-child(2)',
  saleCondition: '[class*="condition"], td:nth-child(3)',
  saleQuantity: '[class*="quantity"], td:nth-child(4)',
  
  // Loading states
  loading: '[class*="loading"], [class*="spinner"]',
};

