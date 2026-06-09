#!/bin/bash
# Install and configure Redis on Ubuntu/Debian VPS
# Run this script on the VPS: sudo bash install_redis.sh

set -e

echo "🔧 Installing Redis..."

# Update package list
apt-get update

# Install Redis
apt-get install -y redis-server

# Configure Redis for production
echo "📝 Configuring Redis..."

# Backup original config
cp /etc/redis/redis.conf /etc/redis/redis.conf.backup

# Set memory limit (256MB should be plenty for caching)
sed -i 's/# maxmemory <bytes>/maxmemory 256mb/' /etc/redis/redis.conf

# Set eviction policy (remove least recently used keys when memory is full)
sed -i 's/# maxmemory-policy noeviction/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf

# Bind to localhost only (security)
sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf

# Disable protected mode (we're only binding to localhost anyway)
sed -i 's/^protected-mode yes/protected-mode no/' /etc/redis/redis.conf

# Enable persistence (RDB snapshots)
# Default settings are usually fine for caching

# Start and enable Redis
echo "🚀 Starting Redis..."
systemctl enable redis-server
systemctl restart redis-server

# Wait for Redis to start
sleep 2

# Test Redis
echo "🧪 Testing Redis..."
if redis-cli ping | grep -q "PONG"; then
    echo "✅ Redis is running and responding!"
    redis-cli INFO server | grep -E "redis_version|uptime"
else
    echo "❌ Redis failed to start properly"
    exit 1
fi

# Show memory info
echo ""
echo "📊 Redis Memory Configuration:"
redis-cli CONFIG GET maxmemory
redis-cli CONFIG GET maxmemory-policy

echo ""
echo "🎉 Redis installation complete!"
echo "   Host: 127.0.0.1"
echo "   Port: 6379"
echo "   Max Memory: 256MB"
echo "   Eviction: LRU (Least Recently Used)"
