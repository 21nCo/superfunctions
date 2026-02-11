def fnv1a_hash(s: str) -> int:
    """
    Simple FNV-1a hash implementation for deterministic bucketing.
    Match strict 32-bit unsigned integer wrapping behavior of TypeScript/JS.
    """
    hash_val = 0x811c9dc5
    
    # 32-bit mask
    mask = 0xFFFFFFFF

    for char in s:
        # JS charCodeAt works on UTF-16 code units. 
        # For standard ASCII/BMP, ord(char) corresponds well.
        # Strict bitwise operations are needed to match JS behaviour.
        
        # hash ^= str.charCodeAt(i)
        hash_val ^= ord(char)
        hash_val &= mask
        
        # hash = Math.imul(hash, 0x01000193)
        # Math.imul performs C-like 32-bit multiplication
        hash_val = (hash_val * 0x01000193) & mask

    # return hash >>> 0 (unsigned right shift)
    # in Python, the mask already ensures we are within 32-bit range, 
    # but we treat it as unsigned.
    return hash_val

def get_bucket(key: str, context_id: str, total_buckets: int = 100) -> int:
    combined = f"{key}:{context_id}"
    h = fnv1a_hash(combined)
    return h % total_buckets
