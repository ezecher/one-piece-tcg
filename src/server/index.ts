/**
 * Dashboard Server
 * 
 * Simple Express server to serve the dashboard and API
 */

import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  initializeDb,
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
  Card,
} from '../db/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3456;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Initialize database
initializeDb();

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

