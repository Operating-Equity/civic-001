import time
import hashlib
import json
import threading
from typing import Dict, Any, Optional, Tuple

class ResponseCache:
    """Simple in-memory cache for API responses with TTL"""
    
    def __init__(self, ttl_seconds: int = 3600):
        """
        Initialize cache with a time-to-live value
        
        Args:
            ttl_seconds: How long cache entries remain valid (default: 1 hour)
        """
        self._cache: Dict[str, Tuple[Any, float]] = {}
        self._ttl_seconds = ttl_seconds
        self._lock = threading.RLock()
        
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
                if time.time() - timestamp < self._ttl_seconds:
                    return value
                else:
                    # Remove expired entry
                    del self._cache[key]
        
        return None
    
    def set(self, value: Any, *args, **kwargs) -> None:
        """
        Store a response in the cache
        
        Args:
            value: The response to cache
        """
        key = self._generate_key(*args, **kwargs)
        
        with self._lock:
            self._cache[key] = (value, time.time())
    
    def clear(self) -> None:
        """Clear all cached entries"""
        with self._lock:
            self._cache.clear()
    
    def remove(self, *args, **kwargs) -> None:
        """Remove a specific cached entry"""
        key = self._generate_key(*args, **kwargs)
        
        with self._lock:
            if key in self._cache:
                del self._cache[key]

# Create global instance
response_cache = ResponseCache()