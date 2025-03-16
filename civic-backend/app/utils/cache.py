import time
import hashlib
import json
import threading
from typing import Dict, Any, Optional, Tuple, Set
import logging

logger = logging.getLogger(__name__)

class ResponseCache:
    """Enhanced in-memory cache for API responses with TTL and size limits"""
    
    def __init__(self, ttl_seconds: int = 3600, max_entries: int = 1000):
        """
        Initialize cache with a time-to-live value and maximum entries
        
        Args:
            ttl_seconds: How long cache entries remain valid (default: 1 hour)
            max_entries: Maximum number of entries to store (default: 1000)
        """
        self._cache: Dict[str, Tuple[Any, float]] = {}
        self._ttl_seconds = ttl_seconds
        self._max_entries = max_entries
        self._lock = threading.RLock()
        self._hit_count = 0
        self._miss_count = 0
        self._eviction_count = 0
        self._access_times: Dict[str, float] = {}  # Track last access time for LRU
        
    def _generate_key(self, *args, **kwargs) -> str:
        """
        Generate a unique cache key based on arguments
        
        Returns:
            str: A unique hash key
        """
        # Create a string containing all relevant parameters
        key_parts = list(args)
        
        # Add any additional parameters that affect the response
        if kwargs:
            for k, v in sorted(kwargs.items()):
                key_parts.append(f"{k}:{v}")
        
        # Join and hash to create a fixed-length key
        key_string = json.dumps(key_parts, sort_keys=True)
        return hashlib.md5(key_string.encode('utf-8')).hexdigest()
    
    def get(self, *args, **kwargs) -> Optional[Any]:
        """
        Retrieve a cached response if available and not expired
        
        Returns:
            The cached response or None if not found/expired
        """
        key = self._generate_key(*args, **kwargs)
        
        with self._lock:
            if key in self._cache:
                value, timestamp = self._cache[key]
                current_time = time.time()
                
                # Check if entry is still valid
                if current_time - timestamp < self._ttl_seconds:
                    # Update statistics and access time
                    self._hit_count += 1
                    self._access_times[key] = current_time
                    
                    # Log cache hit (for debugging)
                    if self._hit_count % 100 == 0:  # Log only every 100 hits to avoid log spam
                        logger.debug(f"Cache hit #{self._hit_count}. Current hit rate: {self.hit_rate():.2f}%")
                        
                    return value
                else:
                    # Remove expired entry
                    del self._cache[key]
                    if key in self._access_times:
                        del self._access_times[key]
            
            # Track cache misses
            self._miss_count += 1
            
            # Log cache miss (for debugging)
            if self._miss_count % 20 == 0:  # Log only every 20 misses
                logger.debug(f"Cache miss #{self._miss_count}. Current hit rate: {self.hit_rate():.2f}%")
                
        return None
    
    def set(self, value: Any, *args, **kwargs) -> None:
        """
        Store a response in the cache
        
        Args:
            value: The response to cache
        """
        key = self._generate_key(*args, **kwargs)
        current_time = time.time()
        
        with self._lock:
            # If we've reached the max entries, remove the least recently used entry
            if len(self._cache) >= self._max_entries and key not in self._cache:
                self._evict_lru()
                
            # Store the value with its timestamp
            self._cache[key] = (value, current_time)
            self._access_times[key] = current_time
    
    def clear(self) -> None:
        """Clear all cached entries"""
        with self._lock:
            self._cache.clear()
            self._access_times.clear()
            logger.info(f"Cache cleared. Previous hit rate: {self.hit_rate():.2f}%")
            self._hit_count = 0
            self._miss_count = 0
            self._eviction_count = 0
    
    def remove(self, *args, **kwargs) -> None:
        """Remove a specific cached entry"""
        key = self._generate_key(*args, **kwargs)
        
        with self._lock:
            if key in self._cache:
                del self._cache[key]
                if key in self._access_times:
                    del self._access_times[key]
    
    def _evict_lru(self) -> None:
        """Evict the least recently used cache entry"""
        if not self._access_times:
            return
            
        # Find the least recently accessed key
        lru_key = min(self._access_times.items(), key=lambda x: x[1])[0]
        
        # Remove it from both dictionaries
        if lru_key in self._cache:
            del self._cache[lru_key]
        del self._access_times[lru_key]
        
        self._eviction_count += 1
        if self._eviction_count % 10 == 0:  # Log every 10 evictions
            logger.debug(f"Cache eviction #{self._eviction_count}. Current size: {len(self._cache)}")
    
    def hit_rate(self) -> float:
        """Calculate the cache hit rate as a percentage"""
        total_requests = self._hit_count + self._miss_count
        if total_requests == 0:
            return 0.0
        return (self._hit_count / total_requests) * 100
    
    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        with self._lock:
            return {
                "size": len(self._cache),
                "max_size": self._max_entries,
                "ttl_seconds": self._ttl_seconds,
                "hits": self._hit_count,
                "misses": self._miss_count,
                "evictions": self._eviction_count,
                "hit_rate": self.hit_rate()
            }
    
    def prune_expired(self) -> int:
        """
        Remove all expired entries from the cache
        
        Returns:
            int: Number of entries removed
        """
        current_time = time.time()
        removed_count = 0
        
        with self._lock:
            # Find all expired keys
            expired_keys = [
                key for key, (_, timestamp) in self._cache.items() 
                if current_time - timestamp >= self._ttl_seconds
            ]
            
            # Remove all expired entries
            for key in expired_keys:
                del self._cache[key]
                if key in self._access_times:
                    del self._access_times[key]
                removed_count += 1
        
        if removed_count > 0:
            logger.info(f"Pruned {removed_count} expired cache entries. Current size: {len(self._cache)}")
            
        return removed_count
    
    def set_ttl(self, ttl_seconds: int) -> None:
        """Update the TTL for the cache"""
        with self._lock:
            self._ttl_seconds = ttl_seconds
            logger.info(f"Cache TTL updated to {ttl_seconds} seconds")

# Create global instance
response_cache = ResponseCache(ttl_seconds=3600, max_entries=1000)

# Set up a background thread to periodically prune expired entries
def _prune_cache_periodically():
    """Periodically clean up expired cache entries"""
    while True:
        time.sleep(300)  # Run every 5 minutes
        try:
            response_cache.prune_expired()
        except Exception as e:
            logger.error(f"Error pruning cache: {str(e)}")

# Start the background pruning thread
pruning_thread = threading.Thread(target=_prune_cache_periodically, daemon=True)
pruning_thread.start()