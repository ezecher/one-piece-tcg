/**
 * Dashboard Server
 * 
 * Simple Express server to serve the dashboard and API
 */

import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
// No longer need fs or DB_PATH - all data in PostgreSQL
import {
  initPostgres,
  getPool,
  createUser,
  getUserByEmail,
  deleteUser,
  getUserCollection,
  addToUserCollection,
  removeFromUserCollection,
  setUserCollectionQty,
  getUserCollectionProductIds,
  getUserWatchlist,
  addToUserWatchlist,
  removeFromUserWatchlist,
  updateUserWatchlistItem,
  // New PostgreSQL card/sales functions
  pgGetAllCards,
  pgGetCardByProductId,
  pgCountCards,
  pgCountSales,
  pgGetSalesForProduct,
  pgGetRecentRuns,
  pgGetPotentialDeals,
  PgCard,
} from '../db/postgres.js';
import {
  hashPassword,
  verifyPassword,
  generateToken,
  requireAuth,
  optionalAuth,
  isValidEmail,
  isValidPassword,
} from '../auth/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3456;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Legal pages — clean URLs for App Store Connect
app.get('/privacy', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'legal', 'privacy.html'));
});
app.get('/support', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'legal', 'support.html'));
});

// Initialize PostgreSQL (required - all data now in PostgreSQL)
if (process.env.DATABASE_URL) {
  initPostgres().catch(err => {
    console.error('Failed to initialize PostgreSQL:', err);
    process.exit(1);
  });
} else {
  console.error('DATABASE_URL is required! PostgreSQL is now the primary database.');
  process.exit(1);
}

// ============ Auth Routes ============

// Register new user
app.post('/api/auth/register', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ error: 'Authentication not available' });
    }
    
    const { email, password, displayName } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    const passwordCheck = isValidPassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.error });
    }
    
    // Check if user exists
    const existing = await getUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    
    // Create user
    const passwordHash = await hashPassword(password);
    const user = await createUser(email, passwordHash, displayName);
    
    // Generate token
    const token = generateToken({ userId: user.id, email: user.email });
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
      },
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(503).json({ error: 'Authentication not available' });
    }
    
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const validPassword = await verifyPassword(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = generateToken({ userId: user.id, email: user.email });
    
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

// Delete current user account (App Store guideline 5.1.1(v))
app.delete('/api/auth/me', requireAuth, async (req, res) => {
  try {
    await deleteUser(req.userId!);
    res.status(204).send();
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// Admin: List all users (protected by secret key)
app.get('/api/admin/users', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (typeof adminKey !== 'string' || adminKey !== process.env.DB_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT id, email, display_name, created_at,
        (SELECT COUNT(*) FROM user_collection WHERE user_id = users.id) as collection_count
      FROM users 
      ORDER BY created_at DESC
    `);
    
    res.json({
      count: result.rows.length,
      users: result.rows,
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ============ User Collection Routes (Authenticated) ============

// Get user's collection with card details
app.get('/api/user/collection', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const collectionItems = await getUserCollection(userId);
    
    // Get card details for each item (using PostgreSQL)
    const cardPromises = collectionItems.map(async (item) => {
      const card = await pgGetCardByProductId(item.product_id);
      if (!card) return null;
      return {
        ...card,
        quantity: item.quantity,
        notes: item.notes,
        added_at: item.added_at,
      };
    });
    
    const cardsWithNulls = await Promise.all(cardPromises);
    const cards = cardsWithNulls.filter(c => c !== null);
    
    // Calculate totals
    const totalValue = cards.reduce((sum, c) => sum + ((c?.market_price || 0) * (c?.quantity || 1)), 0);
    
    res.json({
      cards,
      count: cards.length,
      totalValue,
    });
  } catch (error) {
    console.error('Get collection error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Add to user's collection
app.post('/api/user/collection/:productId', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const productId = parseInt(req.params.productId);
    const quantity = req.body.quantity || 1;
    
    await addToUserCollection(userId, productId, quantity);
    res.json({ success: true, message: 'Added to collection' });
  } catch (error) {
    console.error('Add to collection error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Remove from user's collection
app.delete('/api/user/collection/:productId', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const productId = parseInt(req.params.productId);
    
    await removeFromUserCollection(userId, productId);
    res.json({ success: true, message: 'Removed from collection' });
  } catch (error) {
    console.error('Remove from collection error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Set quantity in user's collection
app.put('/api/user/collection/:productId', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const productId = parseInt(req.params.productId);
    const quantity = req.body.quantity || 0;
    
    await setUserCollectionQty(userId, productId, quantity);
    res.json({ success: true, quantity });
  } catch (error) {
    console.error('Set quantity error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ============ User Watchlist Routes ============

// Get user's watchlist with card details (PostgreSQL)
app.get('/api/user/watchlist', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const watchlistItems = await getUserWatchlist(userId);
    
    // Get full card details for each watchlist item (using PostgreSQL)
    const itemPromises = watchlistItems.map(async (item) => {
      const card = await pgGetCardByProductId(item.product_id);
      if (!card) return null;
      return {
        ...card,
        target_price: item.target_price,
        alerts_enabled: item.alerts_enabled,
      };
    });
    
    const itemsWithNulls = await Promise.all(itemPromises);
    const items = itemsWithNulls.filter(Boolean);
    
    res.json({ items });
  } catch (error) {
    console.error('Get watchlist error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Add to user's watchlist
app.post('/api/user/watchlist/:productId', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const productId = parseInt(req.params.productId);
    const targetPrice = req.body.target_price;
    
    await addToUserWatchlist(userId, productId, targetPrice);
    res.json({ success: true });
  } catch (error) {
    console.error('Add to watchlist error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Remove from user's watchlist
app.delete('/api/user/watchlist/:productId', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const productId = parseInt(req.params.productId);
    
    await removeFromUserWatchlist(userId, productId);
    res.json({ success: true });
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Update watchlist item (target price, alerts enabled)
app.put('/api/user/watchlist/:productId', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const productId = parseInt(req.params.productId);
    const { target_price, alerts_enabled } = req.body;
    
    await updateUserWatchlistItem(userId, productId, { target_price, alerts_enabled });
    res.json({ success: true });
  } catch (error) {
    console.error('Update watchlist error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ============ API Routes ============

// Get dashboard summary (PostgreSQL)
app.get('/api/summary', async (req, res) => {
  try {
    const cardCount = await pgCountCards();
    const salesCount = await pgCountSales();
    const recentRuns = await pgGetRecentRuns(5);
    
    res.json({
      cards: cardCount,
      sales: salesCount,
      recentRuns,
    });
  } catch (error) {
    console.error('Summary error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get all cards with last sale info (PostgreSQL)
app.get('/api/cards', async (req, res) => {
  try {
    const cards = await pgGetAllCards();
    res.json(cards);
  } catch (error) {
    console.error('Cards error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get card stats with averages (PostgreSQL)
app.get('/api/stats', async (req, res) => {
  try {
    // Get cards with 7-day sales statistics
    const result = await getPool().query(`
      SELECT 
        c.*,
        (SELECT price FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_price,
        (SELECT sold_at FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_date,
        COALESCE(s.sales_count_7d, 0) as sales_count_7d,
        COALESCE(s.avg_price_7d, 0) as avg_price_7d,
        COALESCE(s.total_sales_7d, 0) as total_sales_7d
      FROM cards c
      LEFT JOIN (
        SELECT 
          product_id,
          COUNT(*) as sales_count_7d,
          AVG(price) as avg_price_7d,
          SUM(price) as total_sales_7d
        FROM sale_events
        WHERE sold_at >= NOW() - INTERVAL '7 days'
        GROUP BY product_id
      ) s ON c.product_id = s.product_id
      ORDER BY c.market_price DESC NULLS LAST
    `);
    
    const stats = result.rows.map(row => ({
      ...row,
      market_price: row.market_price ? parseFloat(String(row.market_price)) : null,
      lowest_listing: row.lowest_listing ? parseFloat(String(row.lowest_listing)) : null,
      last_sale_price: row.last_sale_price ? parseFloat(String(row.last_sale_price)) : null,
      sales_count_7d: parseInt(String(row.sales_count_7d)) || 0,
      avg_price_7d: row.avg_price_7d ? parseFloat(String(row.avg_price_7d)) : 0,
      total_sales_7d: row.total_sales_7d ? parseFloat(String(row.total_sales_7d)) : 0,
      avg_price: row.last_sale_price ? parseFloat(String(row.last_sale_price)) : (row.market_price ? parseFloat(String(row.market_price)) : null),
    }));
    res.json(stats);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get potential deals (PostgreSQL) - uses market price, excludes suspicious listings
app.get('/api/deals', async (req, res) => {
  try {
    const discount = parseInt(req.query.discount as string) || 10;
    
    // Use the new PostgreSQL function that excludes suspicious listings
    const deals = await pgGetPotentialDeals(discount);
    
    res.json(deals);
  } catch (error) {
    console.error('Deals error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get sales for a specific product (PostgreSQL)
app.get('/api/sales/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const sales = await pgGetSalesForProduct(productId);
    res.json(sales);
  } catch (error) {
    console.error('Sales error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get top volume cards (PostgreSQL) - based on recent sales
app.get('/api/volume', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    
    // Get cards with most recent sales activity
    const result = await getPool().query(`
      SELECT c.*, COUNT(se.id) as sale_count
      FROM cards c
      LEFT JOIN sale_events se ON c.product_id = se.product_id 
        AND se.sold_at > NOW() - INTERVAL '24 hours'
      GROUP BY c.id
      ORDER BY sale_count DESC
      LIMIT $1
    `, [limit]);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Volume error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get cards by set (PostgreSQL)
app.get('/api/sets', async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT 
        COALESCE(set_name, 'Unknown') as name,
        COUNT(*) as count,
        SUM(COALESCE(market_price, 0)) as "totalMarketValue"
      FROM cards
      GROUP BY set_name
      ORDER BY SUM(COALESCE(market_price, 0)) DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Sets error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ============ Market Trends API ============

// Get daily sales aggregates for trend charts
app.get('/api/trends/sales', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const { pgGetDailySalesAggregates } = await import('../db/postgres.js');
    const salesData = await pgGetDailySalesAggregates(days);
    res.json(salesData);
  } catch (error) {
    console.error('Sales trends error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get market snapshots for trend charts
app.get('/api/trends/market', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const { pgGetMarketSnapshots } = await import('../db/postgres.js');
    const snapshots = await pgGetMarketSnapshots(days);
    res.json(snapshots);
  } catch (error) {
    console.error('Market trends error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Save a market snapshot (call after daily scrape)
app.post('/api/trends/snapshot', async (req, res) => {
  try {
    const { pgSaveMarketSnapshot } = await import('../db/postgres.js');
    const snapshot = await pgSaveMarketSnapshot();
    res.json({ success: true, snapshot });
  } catch (error) {
    console.error('Snapshot save error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Backfill sales snapshots from historical data
app.post('/api/trends/backfill', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const { pgBackfillSalesSnapshots } = await import('../db/postgres.js');
    const count = await pgBackfillSalesSnapshots(days);
    res.json({ success: true, daysBackfilled: count });
  } catch (error) {
    console.error('Backfill error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ============ Collection API Routes (PostgreSQL) ============

// Get collection cards (uses in_collection flag on cards table)
app.get('/api/collection', async (req, res) => {
  try {
    const result = await getPool().query(`
      SELECT c.*,
        (SELECT price FROM sale_events WHERE product_id = c.product_id ORDER BY sold_at DESC LIMIT 1) as last_sale_price
      FROM cards c
      WHERE c.in_collection = true
      ORDER BY c.market_price DESC NULLS LAST
    `);
    
    const cards = result.rows;
    const totalValue = cards.reduce((sum: number, c: any) => 
      sum + ((c.market_price || 0) * (c.collection_qty || 1)), 0);
    
    res.json({
      cards,
      count: cards.length,
      totalValue,
    });
  } catch (error) {
    console.error('Collection error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Add to collection (PostgreSQL)
app.post('/api/collection/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    if (isNaN(productId)) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }
    
    const result = await getPool().query(
      `UPDATE cards SET in_collection = true, collection_qty = GREATEST(collection_qty, 1) WHERE product_id = $1 RETURNING *`,
      [productId]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      res.json({ success: true, message: 'Added to collection' });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    console.error('Add to collection error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Remove from collection (PostgreSQL)
app.delete('/api/collection/:productId', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    
    const result = await getPool().query(
      `UPDATE cards SET in_collection = false, collection_qty = 0 WHERE product_id = $1 RETURNING *`,
      [productId]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      res.json({ success: true, message: 'Removed from collection' });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    console.error('Remove from collection error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Set collection quantity and/or purchase price (PostgreSQL)
app.post('/api/collection/:productId/qty', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const quantity = parseInt(req.body?.quantity) || 0;
    const purchasePrice = req.body?.purchase_price !== undefined ? parseFloat(req.body.purchase_price) : null;
    
    let query = `UPDATE cards 
       SET collection_qty = $2, 
           in_collection = $2 > 0`;
    const params: any[] = [productId, quantity];
    
    // Only update purchase_price if it was explicitly provided
    if (purchasePrice !== null && !isNaN(purchasePrice)) {
      query += `, purchase_price = $3`;
      params.push(purchasePrice);
    }
    
    query += ` WHERE product_id = $1 RETURNING *`;
    
    const result = await getPool().query(query, params);
    
    if (result.rowCount && result.rowCount > 0) {
      res.json({ success: true, quantity, purchase_price: result.rows[0].purchase_price });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    console.error('Set collection qty error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Update just the purchase price for a collection item
app.post('/api/collection/:productId/price', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const purchasePrice = req.body?.purchase_price !== undefined ? parseFloat(req.body.purchase_price) : null;
    
    // Update purchase price for any card (don't require in_collection = true)
    const result = await getPool().query(
      `UPDATE cards SET purchase_price = $2 WHERE product_id = $1 RETURNING *`,
      [productId, purchasePrice]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      res.json({ success: true, purchase_price: result.rows[0].purchase_price });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    console.error('Set purchase price error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Get collection history (calculated from historical sales data)
app.get('/api/collection/history', optionalAuth, async (req: any, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    console.log('Collection history request - userId:', req.userId);
    
    // Get collection cards - check if user is logged in
    let collectionResult;
    if (req.userId) {
      // Logged-in user: get from user_collection table
      collectionResult = await getPool().query(`
        SELECT uc.product_id, uc.quantity as collection_qty, uc.purchase_price, c.market_price
        FROM user_collection uc
        JOIN cards c ON uc.product_id = c.product_id
        WHERE uc.user_id = $1
      `, [req.userId]);
      console.log('User collection cards found:', collectionResult.rows.length);
    } else {
      // Guest: get from cards table
      collectionResult = await getPool().query(`
        SELECT product_id, collection_qty, purchase_price, market_price
        FROM cards 
        WHERE in_collection = true
      `);
    }
    
    if (collectionResult.rows.length === 0) {
      return res.json([]);
    }
    
    const productIds = collectionResult.rows.map(c => c.product_id);
    const collectionCards = new Map<number, { qty: number; cost: number; currentPrice: number }>(
      collectionResult.rows.map(c => [
        c.product_id, 
        { 
          qty: parseInt(c.collection_qty) || 1, 
          cost: parseFloat(c.purchase_price) || 0,
          currentPrice: parseFloat(c.market_price) || 0
        }
      ])
    );
    
    // Get daily average prices for collection cards from sales history
    const priceHistoryResult = await getPool().query(`
      SELECT 
        sold_at::date as sale_date,
        product_id,
        AVG(price) as avg_price
      FROM sale_events
      WHERE product_id = ANY($1)
        AND sold_at >= NOW() - INTERVAL '${days} days'
      GROUP BY sold_at::date, product_id
      ORDER BY sale_date ASC
    `, [productIds]);
    
    // Build a map of date -> product_id -> price
    const pricesByDate = new Map<string, Map<number, number>>();
    for (const row of priceHistoryResult.rows) {
      const dateStr = row.sale_date.toISOString().split('T')[0];
      if (!pricesByDate.has(dateStr)) {
        pricesByDate.set(dateStr, new Map());
      }
      pricesByDate.get(dateStr)!.set(row.product_id, parseFloat(row.avg_price));
    }
    
    // Get all unique dates and sort them
    const allDates = Array.from(pricesByDate.keys()).sort();
    
    if (allDates.length === 0) {
      return res.json([]);
    }
    
    // For each date, calculate collection value using last known price for each card
    const lastKnownPrices = new Map<number, number>();
    const history = [];
    
    for (const date of allDates) {
      const dayPrices = pricesByDate.get(date)!;
      
      // Update last known prices
      for (const [productId, price] of dayPrices) {
        lastKnownPrices.set(productId, price);
      }
      
      // Calculate collection value for this date
      let marketValue = 0;
      let totalCost = 0;
      
      for (const [productId, card] of collectionCards) {
        const price = lastKnownPrices.get(productId) || card.currentPrice;
        marketValue += price * card.qty;
        totalCost += card.cost * card.qty;
      }
      
      history.push({
        snapshot_date: date,
        total_items: collectionResult.rows.reduce((sum, c) => sum + (parseInt(c.collection_qty) || 1), 0),
        unique_cards: collectionResult.rows.length,
        total_cost: totalCost,
        market_value: marketValue,
        listing_value: marketValue, // approximation
        profit_loss: marketValue - totalCost,
      });
    }
    
    res.json(history);
  } catch (error) {
    console.error('Collection history error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Save collection snapshot (call this daily or on-demand)
app.post('/api/collection/snapshot', optionalAuth, async (req: any, res) => {
  try {
    // For now, just acknowledge - the history is calculated dynamically
    res.json({ success: true });
  } catch (error) {
    console.error('Save collection snapshot error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ============ Database Status API ============

// Get database status (PostgreSQL - no more file sync needed!)
app.get('/api/db/status', async (req, res) => {
  try {
    const cardCount = await pgCountCards();
    const salesCount = await pgCountSales();
    
    res.json({
      database: 'PostgreSQL',
      cards: cardCount,
      sales: salesCount,
      message: 'All data is in PostgreSQL now - no file sync needed!',
    });
  } catch (error) {
    console.error('DB status error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// Serve the dashboard
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║     TCGplayer Sales Dashboard                     ║
╠═══════════════════════════════════════════════════╣
║  🌐 Dashboard: http://localhost:${PORT}              ║
║  📊 API:       http://localhost:${PORT}/api          ║
╚═══════════════════════════════════════════════════╝
  `);
});

