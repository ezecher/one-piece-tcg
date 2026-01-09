#!/bin/bash
set -e

echo "🚀 Starting LISTINGS update at $(date)"

cd /app

# Configuration
API_URL="https://one-piece-tcg-production.up.railway.app"
DB_FILE="/app/data/tcg_sales.db"

# Step 1: Download current database
echo "📥 Downloading current database..."
curl -s "${API_URL}/api/db/download?key=${DB_UPLOAD_KEY}" -o "$DB_FILE"
echo "   Downloaded database: $(ls -lh $DB_FILE | awk '{print $5}')"

# Step 2: Wait a bit to avoid immediate rate limiting
echo "⏳ Waiting 2 minutes before starting (rate limit cooldown)..."
sleep 120

# Step 3: Refresh listings with 1 worker (slower but more reliable)
echo "📋 Refreshing listings..."
node dist/index.js refresh-listings --workers 1 --headless 2>&1 || echo "Listings refresh completed with some errors"

# Step 3: Upload updated database
echo "📤 Uploading database..."
curl -X POST -H "Content-Type: application/octet-stream" \
  --data-binary "@$DB_FILE" \
  "${API_URL}/api/db/upload?key=${DB_UPLOAD_KEY}"

echo ""
echo "✅ Listings update completed at $(date)"

