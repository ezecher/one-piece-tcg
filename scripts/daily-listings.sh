#!/bin/bash
set -e

echo "🚀 Starting LISTINGS update at $(date)"
echo "   Database: PostgreSQL (no file sync needed!)"
echo "   Timeout: 120 minutes max"

cd /app

# Run the scraper with a 120-minute timeout
# --headless for Docker environment
# --workers 3 for parallel processing (~3x faster)
# Proxy enabled by default (PROXY_SERVER env var) - needed for Railway IP
echo "📋 Refreshing listings..."
timeout 7200 node dist/index.js refresh-listings --headless --workers 3 2>&1 || {
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo "⚠️  Job timed out after 120 minutes"
    else
        echo "⚠️  Job exited with code $EXIT_CODE"
    fi
}

echo ""
echo "✅ Listings update completed at $(date)"
