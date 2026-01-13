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

// Admin: List all users (protected by secret key)
app.get('/api/admin/users', async (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== process.env.DB_UPLOAD_KEY) {
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
    // Simplified stats from PostgreSQL
    const cards = await pgGetAllCards();
    const stats = cards.map(card => ({
      ...card,
      avg_price: card.last_sale_price || card.market_price,
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

// Set collection quantity (PostgreSQL)
app.post('/api/collection/:productId/qty', async (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const quantity = parseInt(req.body?.quantity) || 0;
    
    const result = await getPool().query(
      `UPDATE cards 
       SET collection_qty = $2, 
           in_collection = $2 > 0
       WHERE product_id = $1 
       RETURNING *`,
      [productId, quantity]
    );
    
    if (result.rowCount && result.rowCount > 0) {
      res.json({ success: true, quantity });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    console.error('Set collection qty error:', error);
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

