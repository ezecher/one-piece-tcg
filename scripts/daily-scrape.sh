#!/bin/bash
set -e

echo "🚀 Starting daily scrape at $(date)"

cd /app

# Configuration
API_URL="https://one-piece-tcg-production.up.railway.app"
DB_FILE="/app/data/tcg_sales.db"

# Step 1: Download current database from main service
echo "📥 Downloading current database..."
curl -s "${API_URL}/api/db/download?key=${DB_UPLOAD_KEY}" -o "$DB_FILE"
echo "   Downloaded database: $(ls -lh $DB_FILE | awk '{print $5}')"

# Step 2: Update sales for ALL cards (headless mode for server)
echo "📊 Updating sales data (all cards - this takes ~30-60 min)..."
node dist/index.js update-sales --headless 2>&1 || echo "Sales update completed with some errors"

# Step 3: Refresh listings with 3 workers (headless mode for server)
echo "📋 Refreshing listings..."
node dist/index.js refresh-listings --workers 3 --headless 2>&1 || echo "Listings refresh completed with some errors"

# Step 4: Upload updated database back to main service
echo "📤 Uploading updated database..."
curl -X POST -H "Content-Type: application/octet-stream" \
  --data-binary "@$DB_FILE" \
  "${API_URL}/api/db/upload?key=${DB_UPLOAD_KEY}"

echo ""
echo "✅ Daily scrape completed at $(date)"
