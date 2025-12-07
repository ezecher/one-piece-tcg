# TCGplayer One Piece Sales Tracker

A personal tool to track prices, sales, and listings for One Piece TCG products on TCGplayer.

## Features

- **Product Discovery**: Scrapes top cards from each One Piece set (sorted by price)
- **Sales Tracking**: Fetches recent sales history via API
- **Listings Tracking**: Monitors current English Near Mint listings with market stats
- **Hybrid Verification**: Fast API refresh + UI scraping to verify actual deals (bypasses stale cache)
- **Smart Filtering**: Filters out Japanese/Korean listings, tracks only $5+ cards
- **Web Dashboard**: Visual interface to browse cards, see deals, and view by set
- **SQLite Storage**: Simple local database for all data

## Quick Start

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Initialize the database
npm run db:init

# Start the dashboard
npm run dashboard
# Open http://localhost:3456 in your browser

# Scrape a set (with listings)
npm run dev scrape-set -- --set "Carrying On His Will" --with-listings --visible

# Update sales data
npm run dev update-sales -- --visible

# Refresh all listings (fast API method)
npm run dev refresh-listings -- --visible
```

## CLI Commands

### Database

```bash
# Initialize database (run once, or after schema changes)
npm run db:init

# Check database status
npm run dev db:status

# Remove cards under a price threshold
npm run dev db:cleanup -- --min-price 5

# Fix generic card names by scraping actual names
npm run dev db:fix-names -- --limit 50 --visible
```

### Scraping Sets (Recommended Method)

```bash
# Scrape top cards from a specific set
npm run dev scrape-set -- --set "Carrying On His Will" --visible

# Scrape set AND get listings in one pass
npm run dev scrape-set -- --set "Carrying On His Will" --with-listings --visible

# Scrape top cards from ALL sets
npm run dev scrape-top-cards -- --visible

# With listings for all sets
npm run dev scrape-top-cards -- --with-listings --visible
```

**Available Sets:**
- Romance Dawn
- Paramount War
- Pillars of Strength
- Kingdoms of Intrigue
- Awakening of the New Era
- Wings of the Captain
- 500 Years in the Future
- Two Legends
- Emperors in the New World
- A Fist of Divine Speed
- Royal Blood
- Legacy of the Master
- Carrying On His Will

### Sales Updates

```bash
# Update sales for ALL tracked products (uses API - fast!)
npm run dev update-sales -- --visible

# Update sales for a specific set only
npm run dev update-sales -- --set "Carrying On His Will" --visible

# Limit to first N products
npm run dev update-sales -- --limit 50 --visible
```

### Listings Updates

```bash
# Fast refresh of all listings (API method, ~3 products/sec)
npm run dev refresh-listings -- --visible

# Refresh listings for a specific set
npm run dev refresh-listings -- --set "Romance Dawn" --visible

# Limit to N products
npm run dev refresh-listings -- --limit 100 --visible
```

### Dashboard

```bash
# Start the web dashboard
npm run dashboard

# Then open http://localhost:3456 in your browser
```

**Dashboard Features:**
- **All Cards**: View all tracked cards with prices, sales, and listings
- **My Collection**: Track specific cards you own or want to monitor
- **Price Stats**: See 7-day and 30-day price statistics
- **🔥 Deals**: Find cards listed below their last sale price (real deals!)
- **By Set**: Browse cards organized by set (click to filter)
- **TCGplayer Links**: Click ↗ to go directly to TCGplayer page
- **Sortable Columns**: Click any column header to sort
- **Add to Collection**: Click ⭐ next to any card to track it
- **Dual Value Display**: See both Market Value and Last Sale Value (more accurate)

### Collection / Watchlist

Track specific cards you own or want to monitor:

```bash
# View your collection
npm run dev collection

# Search for cards to add
npm run dev collection-search -- "Luffy"

# Add a card by product ID
npm run dev collection-add -- 628353

# Remove a card from collection
npm run dev collection-remove -- 628353

# Refresh listings for just your collection (fast!)
npm run dev collection-refresh -- --visible
```

You can also add/remove cards from the collection directly on the dashboard by clicking the ⭐ button.

### Queries & Analytics

```bash
# List all tracked cards
npm run dev list-cards

# Show sales for a specific product ID
npm run dev card-sales 628353

# Find potential deals
npm run dev deals

# Verify deals with UI scraping (accurate prices)
npm run dev verify-deals -- --visible

# Verify deals with custom thresholds
npm run dev verify-deals -- --min-sales 5 --discount 15 --visible
```

### Login (Manual)

If you need to log in to TCGplayer (for some features):

```bash
# Opens browser for manual login - session is saved
npm run dev login
```

## Typical Workflow

### Adding a New Set

```bash
# 1. Scrape the set with listings
npm run dev scrape-set -- --set "New Set Name" --with-listings --visible

# 2. Get sales data for the new cards
npm run dev update-sales -- --set "New Set Name" --visible

# 3. View in dashboard
npm run dashboard
```

### Daily Update

```bash
# Refresh listings for all cards (~2-3 min for 500 cards)
npm run dev refresh-listings -- --visible

# Update recent sales
npm run dev update-sales -- --visible
```

### Hybrid Approach: Best of Both Worlds 🚀

The API is fast but sometimes has stale cached data. UI scraping is accurate but slow. Use **both**:

```bash
# 1. Fast API refresh for all cards (~3 products/sec)
npm run dev refresh-listings

# 2. Find potential deals
npm run dev deals

# 3. Verify deals with UI scraping (bypasses API cache)
npm run dev verify-deals -- --visible

# Optional: Only verify top deals
npm run dev verify-deals -- --limit 5 --visible
```

**Why this works:**
- ✅ Fast bulk updates via API for the majority of cards
- ✅ Accurate UI scraping for the deals that actually matter
- ✅ `verify-deals` marks which listings have been verified
- ✅ Now you know which deals are real vs. stale data

**Example Output:**
```
[1/5] 🔍 Shanks (Championship 2024) [Two Legends]
   Expected: Market $199.99 → Avg $92.05 (54.0% below)
       Found 8 English Near Mint listings
       Lowest: $199.99
   ❌ NOT A DEAL: $199.99 (0.0% ABOVE market)

[2/5] 🔍 Luffy (SP) [Romance Dawn]
   Expected: Market $85.00 → Avg $68.50 (19.4% below)
       Found 12 English Near Mint listings
       Lowest: $68.00
   ✅ VERIFIED DEAL: $68.00 (20.0% below market)
```

## Configuration

Edit `src/config.ts` to customize:

```typescript
// Minimum market price to track (ignore cheap cards)
export const MIN_MARKET_PRICE = 5;

// Delay between requests (be respectful)
export const REQUEST_DELAY_MS = 1000;

// Pages to scrape per set (24 cards per page)
export const PAGES_PER_SET = 2;
```

## Database Schema

### Tables

- **card**: One row per TCGplayer product
  - product_id, name, set_name, product_type, market_price
  - lowest_listing, listing_count, current_quantity, current_sellers
  - tcg_url, created_at, updated_at

- **sale_event**: One row per sale
  - card_id, sold_at, price, condition, quantity

- **scrape_run**: Tracking for scrape jobs

### Data Tracked

| Column | Description |
|--------|-------------|
| market_price | TCGplayer's calculated market price |
| lowest_listing | Lowest English Near Mint listing |
| listing_count | Number of English NM listings |
| current_quantity | Total cards available on market |
| current_sellers | Number of unique sellers |
| last_sale_price | Most recent sale price |
| last_sale_date | When the last sale occurred |

## Project Structure

```
tcg-onepiece-sales/
├── package.json
├── tsconfig.json
├── tcg_sales.db              # SQLite database
├── .browser-data/            # Saved browser session
└── src/
    ├── index.ts              # CLI entry point
    ├── config.ts             # Configuration
    ├── db/
    │   ├── schema.sql        # Database schema
    │   ├── client.ts         # Database operations
    │   └── init.ts           # DB initialization
    ├── tcg/
    │   ├── scrapeSearchPage.ts
    │   ├── scrapeProductSales.ts
    │   └── scrapeListings.ts
    ├── jobs/
    │   ├── scrapeTopCards.ts
    │   ├── updateSales.ts
    │   ├── updateListings.ts
    │   ├── updateListingsQuick.ts
    │   └── fixCardNames.ts
    └── server/
        ├── index.ts          # Dashboard API server
        └── public/
            └── index.html    # Dashboard UI
```

## Filtering Logic

The scraper filters listings to show only relevant English cards:

- ✅ **Included**: English, Near Mint or Unopened condition
- ❌ **Excluded**: Japanese, Korean, Damaged, Lightly Played

Filtering checks multiple fields including seller's custom listing title for language indicators.

## Rate Limiting & ToS

This tool is for **personal use only**. Please:

- Respect TCGplayer's Terms of Service
- Keep delays between requests (default 1 second)
- Don't hammer their servers
- Run sparingly (a few times daily is plenty)

## Troubleshooting

### "No products found"
- Make sure you're using the exact set name from the Available Sets list
- Try running with `--visible` to see what's happening

### Japanese listings still showing
- Run `npm run dev refresh-listings` to re-filter with improved detection
- The scraper checks `customData.title` for Japanese/Korean indicators

### Browser won't open
- Make sure Playwright is installed: `npx playwright install chromium`
- Try without `--chrome` flag to use Playwright's browser instead

### Database errors
- Run `npm run db:init` to apply latest schema migrations
