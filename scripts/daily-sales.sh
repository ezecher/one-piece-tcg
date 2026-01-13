#!/bin/bash
set -e

echo "🚀 Starting SALES update at $(date)"
echo "   Database: PostgreSQL (no file sync needed!)"

cd /app

# Just run the scraper - it writes directly to PostgreSQL
echo "📊 Updating sales data..."
node dist/index.js update-sales --headless 2>&1 || echo "Sales update completed with some errors"

echo ""
echo "✅ Sales update completed at $(date)"
