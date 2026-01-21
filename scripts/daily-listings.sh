#!/bin/bash
set -e

echo "🚀 Starting LISTINGS update at $(date)"
echo "   Database: PostgreSQL (no file sync needed!)"
echo "   Timeout: 60 minutes max"

cd /app

# Run the scraper with a 60-minute timeout
# --headless for Docker environment
# --workers 1 for stability (avoids rate limiting)
# Proxy enabled by default (PROXY_SERVER env var) - needed for Railway IP
echo "📋 Refreshing listings..."
timeout 3600 node dist/index.js refresh-listings --headless --workers 1 2>&1 || {
    EXIT_CODE=$?
    if [ $EXIT_CODE -eq 124 ]; then
        echo "⚠️  Job timed out after 60 minutes"
    else
        echo "⚠️  Job exited with code $EXIT_CODE"
    fi
}

echo ""
echo "✅ Listings update completed at $(date)"
