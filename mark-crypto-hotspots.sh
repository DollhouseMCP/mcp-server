#!/bin/bash
# Mark 9 remaining production hotspots: weak-cryptography and weak-hash
# All are non-security uses of Math.random() and MD5
# Analysis date: October 1, 2025

set -e

TOKEN="$SONARQUBE_TOKEN"
MARKED=0
FAILED=0

mark_hotspot() {
    local key="$1"
    local comment="$2"
    
    result=$(curl -s -w "%{http_code}" -X POST "https://sonarcloud.io/api/hotspots/change_status" \
        -H "Authorization: Bearer $TOKEN" \
        -d "hotspot=$key" \
        -d "status=REVIEWED" \
        -d "resolution=SAFE" \
        -d "comment=$comment" \
        -o /dev/null)
    
    if [ "$result" = "204" ]; then
        echo "  ✓ $key"
        ((MARKED++))
    else
        echo "  ✗ $key (HTTP $result)"
        ((FAILED++))
    fi
}

echo "=== Marking 9 Production Weak-Crypto Hotspots ==="
echo ""

# CollectionIndexManager.ts - Jitter timing
echo "CollectionIndexManager.ts (jitter timing)..."
mark_hotspot "AZmIpHKO-9Qg1ZEE01kO" \
    "SAFE: Math.random() used for retry jitter timing, not security. Adds randomness to delay calculations to prevent thundering herd. No cryptographic requirements."

# ElementInstaller.ts - Temp filename
echo "ElementInstaller.ts (temp filename)..."
mark_hotspot "AZmIpHJ_-9Qg1ZEE01kF" \
    "SAFE: Math.random() used for temporary filename generation (collision avoidance), not security. Combined with Date.now() timestamp. Not used for tokens, keys, or authentication."

# Agent.ts - Goal ID generation (2 instances)
echo "Agent.ts (goal/decision IDs)..."
mark_hotspot "AZmIpHPJ-9Qg1ZEE01om" \
    "SAFE: Math.random() used for internal goal ID generation, not security. Combined with Date.now() timestamp for uniqueness. Not used for authentication or access control."

mark_hotspot "AZmIpHPJ-9Qg1ZEE01oo" \
    "SAFE: Math.random() used for internal decision ID generation, not security. Combined with Date.now() timestamp for uniqueness. Not used for authentication or access control."

# memories/utils.ts - Memory name generation
echo "memories/utils.ts (memory name)..."
mark_hotspot "AZmIpHPx-9Qg1ZEE01pR" \
    "SAFE: Math.random() used for memory filename generation, not security. Combined with timestamp for uniqueness. Not used for authentication, encryption keys, or access tokens."

# filesystem.ts - Anonymous ID generation (3 instances)
echo "filesystem.ts (anonymous IDs)..."
mark_hotspot "AZmIpHOR-9Qg1ZEE01nk" \
    "SAFE: Math.random() used for anonymous user ID generation (anon-witty-lion-21mm style), not security. User-friendly display names only, not authentication tokens."

mark_hotspot "AZmIpHOR-9Qg1ZEE01nl" \
    "SAFE: Math.random() used for anonymous user ID generation (anon-witty-lion-21mm style), not security. User-friendly display names only, not authentication tokens."

mark_hotspot "AZmIpHOR-9Qg1ZEE01nm" \
    "SAFE: Math.random() used for anonymous user ID generation (anon-witty-lion-21mm style), not security. User-friendly display names only, not authentication tokens."

# memories/utils.ts - MD5 shard calculation
echo "memories/utils.ts (MD5 shard key)..."
mark_hotspot "AZmIpHPx-9Qg1ZEE01pT" \
    "SAFE: MD5 used for non-cryptographic shard key calculation (distribution hashing), not security. Determines which folder to store memory files in (hashInt % shardCount). Not used for passwords, authentication, or data integrity verification."

echo ""
echo "==================================="
echo "Summary: ✓$MARKED ✗$FAILED"
echo "==================================="
