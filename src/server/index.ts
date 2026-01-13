/**
 * Dashboard Server
 * 
 * Simple Express server to serve the dashboard and API
 */

import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync } from 'fs';
import { DB_PATH } from '../config.js';
import {
  initializeDb,
  closeDb,
  getAllCards,
  getAllCardsWithLastSale,
  getCardStats,
  getPotentialDeals,
  getSalesForProduct,
  getTopVolume24h,
  getRecentRuns,
  countCards,
  countSales,
  getCollectionCards,
  getCollectionCount,
  addToCollection,
  removeFromCollection,
  setCollectionQty,
  Card,
  getCardByProductId,
} from '../db/client.js';
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

// Initialize databases
initializeDb();

// Initialize PostgreSQL for users (if DATABASE_URL is set)
if (process.env.DATABASE_URL) {
  initPostgres().catch(err => {
    console.error('Failed to initialize PostgreSQL:', err);
  });
} else {
  console.log('PostgreSQL not configured (DATABASE_URL not set) - auth disabled');
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
    
    // Get card details for each item
    const cards = collectionItems.map(item => {
      const card = getCardByProductId(item.product_id);
      return {
        ...card,
        quantity: item.quantity,
        notes: item.notes,
        added_at: item.added_at,
      };
    }).filter(c => c !== null);
    
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

// Get user's watchlist with card details
app.get('/api/user/watchlist', requireAuth, async (req, res) => {
  try {
    const userId = req.userId!;
    const watchlistItems = await getUserWatchlist(userId);
    
    // Get full card details for each watchlist item
    const items = watchlistItems.map(item => {
      const card = getCardByProductId(item.product_id);
      return card ? {
        ...card,
        target_price: item.target_price,
        alerts_enabled: item.alerts_enabled,
      } : null;
    }).filter(Boolean);
    
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

// Get dashboard summary
app.get('/api/summary', (req, res) => {
  try {
    const cardCount = countCards();
    const salesCount = countSales();
    const recentRuns = getRecentRuns(5);
    
    res.json({
      cards: cardCount,
      sales: salesCount,
      recentRuns,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get all cards with last sale info
app.get('/api/cards', (req, res) => {
  try {
    const cards = getAllCardsWithLastSale();
    res.json(cards);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get card stats with averages
app.get('/api/stats', (req, res) => {
  try {
    const minSales = parseInt(req.query.minSales as string) || 0;
    const stats = getCardStats(minSales);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get potential deals
app.get('/api/deals', (req, res) => {
  try {
    const minSales = parseInt(req.query.minSales as string) || 3;
    const discount = parseInt(req.query.discount as string) || 10;
    const deals = getPotentialDeals(minSales, discount);
    res.json(deals);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get sales for a specific product
app.get('/api/sales/:productId', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const limit = parseInt(req.query.limit as string) || 50;
    const sales = getSalesForProduct(productId, limit);
    res.json(sales);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get top volume cards
app.get('/api/volume', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const volume = getTopVolume24h(limit);
    res.json(volume);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Get cards by set
app.get('/api/sets', (req, res) => {
  try {
    const cards = getAllCards();
    const sets = new Map<string, Card[]>();
    
    cards.forEach(card => {
      const setName = card.set_name || 'Unknown';
      if (!sets.has(setName)) {
        sets.set(setName, []);
      }
      sets.get(setName)!.push(card);
    });
    
    const result = Array.from(sets.entries()).map(([name, cards]) => ({
      name,
      count: cards.length,
      totalMarketValue: cards.reduce((sum, c) => sum + (c.market_price || 0), 0),
    })).sort((a, b) => b.totalMarketValue - a.totalMarketValue);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============ Collection API Routes ============

// Get collection cards
app.get('/api/collection', (req, res) => {
  try {
    const cards = getCollectionCards();
    const totalValue = cards.reduce((sum, c) => sum + (c.market_price || 0), 0);
    res.json({
      cards,
      count: cards.length,
      totalValue,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Add to collection
app.post('/api/collection/:productId', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const success = addToCollection(productId);
    if (success) {
      res.json({ success: true, message: 'Added to collection' });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Remove from collection
app.delete('/api/collection/:productId', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const success = removeFromCollection(productId);
    if (success) {
      res.json({ success: true, message: 'Removed from collection' });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Set collection quantity
app.post('/api/collection/:productId/qty', (req, res) => {
  try {
    const productId = parseInt(req.params.productId);
    const quantity = parseInt(req.body?.quantity) || 0;
    const success = setCollectionQty(productId, quantity);
    if (success) {
      res.json({ success: true, quantity });
    } else {
      res.status(404).json({ success: false, message: 'Card not found' });
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// ============ Database Sync API ============

// Upload database (for syncing local DB to Railway)
// Usage: curl -X POST -H "Content-Type: application/octet-stream" --data-binary @tcg_sales.db https://your-app.railway.app/api/db/upload?key=YOUR_SECRET
app.post('/api/db/upload', (req, res) => {
  const uploadKey = process.env.DB_UPLOAD_KEY || 'dev-upload-key';
  const providedKey = req.query.key as string;
  
  if (providedKey !== uploadKey) {
    return res.status(403).json({ error: 'Invalid upload key' });
  }
  
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const dbBuffer = Buffer.concat(chunks);
      
      // Close existing database connection
      closeDb();
      
      // Write the new database file
      writeFileSync(DB_PATH, dbBuffer);
      
      // Reinitialize with the new database
      initializeDb();
      
      const cardCount = countCards();
      const salesCount = countSales();
      
      res.json({ 
        success: true, 
        message: 'Database uploaded and reloaded successfully',
        size: dbBuffer.length,
        path: DB_PATH,
        cards: cardCount,
        sales: salesCount
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });
});

// Download database (for backup)
app.get('/api/db/download', (req, res) => {
  const uploadKey = process.env.DB_UPLOAD_KEY || 'dev-upload-key';
  const providedKey = req.query.key as string;
  
  if (providedKey !== uploadKey) {
    return res.status(403).json({ error: 'Invalid key' });
  }
  
  try {
    const dbBuffer = readFileSync(DB_PATH);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename=tcg_sales.db');
    res.send(dbBuffer);
  } catch (error) {
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

