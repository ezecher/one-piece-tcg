#!/bin/bash
set -e

echo "🚀 Starting daily scrape at $(date)"

cd /app

# Update sales for tracked cards (uses the slower but reliable method)
echo "📊 Updating sales data..."
node dist/index.js update-sales --collection 2>&1 || echo "Sales update completed with some errors"

# Refresh listings with 3 workers
echo "📋 Refreshing listings..."
node dist/index.js refresh-listings --workers 3 2>&1 || echo "Listings refresh completed with some errors"

echo "✅ Daily scrape completed at $(date)"

