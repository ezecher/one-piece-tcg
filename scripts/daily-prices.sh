#!/bin/bash
set -e

echo "🚀 Starting PRICES update at $(date)"
echo "   Database: PostgreSQL"
echo "   Expected time: ~30-60 minutes"

cd /app

# Run discover-by-price to update market prices
# --headless for Docker environment
# --min-price 9 stops when prices drop below $9
# --max-pages 100 safety limit
# This updates prices for existing cards (doesn't mess with names)
echo "💰 Discovering and updating market prices..."
timeout 3600 node dist/index.js discover-by-price --headless --min-price 9 --max-pages 100 2>&1 || {
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo "⚠️  Job timed out after 60 minutes"
    else
        echo "⚠️  Job exited with code $EXIT_CODE"
    fi
}

echo ""
echo "✅ Prices update completed at $(date)"
