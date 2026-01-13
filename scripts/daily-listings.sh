#!/bin/bash
set -e

echo "🚀 Starting LISTINGS update at $(date)"
echo "   Database: PostgreSQL (no file sync needed!)"

cd /app

# Just run the scraper - it writes directly to PostgreSQL
echo "📋 Refreshing listings..."
node dist/index.js refresh-listings --headless --workers 3 2>&1 || echo "Listings refresh completed with some errors"

echo ""
echo "✅ Listings update completed at $(date)"
