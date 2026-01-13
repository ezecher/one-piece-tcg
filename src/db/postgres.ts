/**
 * PostgreSQL Database Client for User Authentication
 * 
 * Separate from SQLite (which stores card data)
 * PostgreSQL handles: users, sessions, user collections
 */

import pg from 'pg';
const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
    }
    
    pool = new Pool({
      connectionString,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    
    console.log('PostgreSQL pool created');
  }
  return pool;
}

export async function initPostgres(): Promise<void> {
  const client = await getPool().connect();
  
  try {
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    // Create user_collection table (links users to product_ids)
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_collection (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1,
        notes TEXT,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, product_id)
      )
    `);
    
    // Create index for faster lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_collection_user_id ON user_collection(user_id)
    `);
    
    // Create user_watchlist table for price alerts
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_watchlist (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER NOT NULL,
        target_price DECIMAL(10, 2),
        alerts_enabled BOOLEAN DEFAULT true,
        added_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, product_id)
      )
    `);
    
    // Create index for watchlist lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_user_watchlist_user_id ON user_watchlist(user_id)
    `);
    
    console.log('PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

// ============ User Operations ============

export interface User {
  id: number;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserPublic {
  id: number;
  email: string;
  display_name: string | null;
  created_at: Date;
}

export async function createUser(email: string, passwordHash: string, displayName?: string): Promise<User> {
  const result = await getPool().query<User>(
    `INSERT INTO users (email, password_hash, display_name) 
     VALUES ($1, $2, $3) 
     RETURNING *`,
    [email.toLowerCase(), passwordHash, displayName || null]
  );
  return result.rows[0];
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await getPool().query<User>(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase()]
  );
  return result.rows[0] || null;
}

export async function getUserById(id: number): Promise<User | null> {
  const result = await getPool().query<User>(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

// ============ User Collection Operations ============

export interface UserCollectionItem {
  id: number;
  user_id: number;
  product_id: number;
  quantity: number;
  notes: string | null;
  added_at: Date;
}

export async function addToUserCollection(userId: number, productId: number, quantity: number = 1): Promise<UserCollectionItem> {
  const result = await getPool().query<UserCollectionItem>(
    `INSERT INTO user_collection (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id) 
     DO UPDATE SET quantity = user_collection.quantity + $3
     RETURNING *`,
    [userId, productId, quantity]
  );
  return result.rows[0];
}

export async function removeFromUserCollection(userId: number, productId: number): Promise<boolean> {
  const result = await getPool().query(
    'DELETE FROM user_collection WHERE user_id = $1 AND product_id = $2',
    [userId, productId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setUserCollectionQty(userId: number, productId: number, quantity: number): Promise<boolean> {
  if (quantity <= 0) {
    return removeFromUserCollection(userId, productId);
  }
  
  const result = await getPool().query(
    `INSERT INTO user_collection (user_id, product_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id) 
     DO UPDATE SET quantity = $3
     RETURNING *`,
    [userId, productId, quantity]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getUserCollection(userId: number): Promise<UserCollectionItem[]> {
  const result = await getPool().query<UserCollectionItem>(
    'SELECT * FROM user_collection WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return result.rows;
}

export async function getUserCollectionProductIds(userId: number): Promise<number[]> {
  const result = await getPool().query<{ product_id: number }>(
    'SELECT product_id FROM user_collection WHERE user_id = $1',
    [userId]
  );
  return result.rows.map(r => r.product_id);
}

// ============ User Watchlist Operations ============

export interface UserWatchlistItem {
  id: number;
  user_id: number;
  product_id: number;
  target_price: number | null;
  alerts_enabled: boolean;
  added_at: Date;
}

export async function addToUserWatchlist(
  userId: number, 
  productId: number, 
  targetPrice?: number
): Promise<UserWatchlistItem> {
  const result = await getPool().query<UserWatchlistItem>(
    `INSERT INTO user_watchlist (user_id, product_id, target_price)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, product_id) 
     DO UPDATE SET target_price = COALESCE($3, user_watchlist.target_price)
     RETURNING *`,
    [userId, productId, targetPrice || null]
  );
  return result.rows[0];
}

export async function removeFromUserWatchlist(userId: number, productId: number): Promise<boolean> {
  const result = await getPool().query(
    'DELETE FROM user_watchlist WHERE user_id = $1 AND product_id = $2',
    [userId, productId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateUserWatchlistItem(
  userId: number, 
  productId: number, 
  data: { target_price?: number; alerts_enabled?: boolean }
): Promise<boolean> {
  const updates: string[] = [];
  const values: any[] = [userId, productId];
  let paramIndex = 3;
  
  if (data.target_price !== undefined) {
    updates.push(`target_price = $${paramIndex++}`);
    values.push(data.target_price);
  }
  if (data.alerts_enabled !== undefined) {
    updates.push(`alerts_enabled = $${paramIndex++}`);
    values.push(data.alerts_enabled);
  }
  
  if (updates.length === 0) return false;
  
  const result = await getPool().query(
    `UPDATE user_watchlist SET ${updates.join(', ')} WHERE user_id = $1 AND product_id = $2`,
    values
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getUserWatchlist(userId: number): Promise<UserWatchlistItem[]> {
  const result = await getPool().query<UserWatchlistItem>(
    'SELECT * FROM user_watchlist WHERE user_id = $1 ORDER BY added_at DESC',
    [userId]
  );
  return result.rows;
}

export async function getUserWatchlistProductIds(userId: number): Promise<number[]> {
  const result = await getPool().query<{ product_id: number }>(
    'SELECT product_id FROM user_watchlist WHERE user_id = $1',
    [userId]
  );
  return result.rows.map(r => r.product_id);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

