#!/bin/bash
set -e

echo "🚀 Starting PRICES update at $(date)"
echo "   Database: PostgreSQL"
echo "   Expected time: ~2-3 minutes"

cd /app

# Run the price refresh with a 10-minute timeout
# --headless for Docker environment
# --pages 80 covers all products (24 per page × 80 = 1920 products, with room to grow)
echo "💰 Refreshing market prices..."
timeout 600 node dist/index.js refresh-prices --headless --pages 80 2>&1 || {
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo "⚠️  Job timed out after 10 minutes"
    else
        echo "⚠️  Job exited with code $EXIT_CODE"
    fi
}

echo ""
echo "✅ Prices update completed at $(date)"
