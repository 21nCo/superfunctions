def fnv1a_hash(s: str) -> int:
    """
    Simple FNV-1a hash implementation for deterministic bucketing.
    Match strict 32-bit unsigned integer wrapping behavior of TypeScript/JS.
    """
    hash_val = 0x811c9dc5
    
    # 32-bit mask
    mask = 0xFFFFFFFF

    # Match JS charCodeAt exactly, including surrogate pairs and lone surrogates.
    encoded = s.encode("utf-16-le", errors="surrogatepass")
    for offset in range(0, len(encoded), 2):
        code_unit = encoded[offset] | (encoded[offset + 1] << 8)
        hash_val ^= code_unit
        hash_val = (hash_val * 0x01000193) & mask

    # return hash >>> 0 (unsigned right shift)
    # in Python, the mask already ensures we are within 32-bit range, 
    # but we treat it as unsigned.
    return hash_val

def get_bucket(key: str, context_id: str, total_buckets: int = 100) -> int:
    combined = f"{key}:{context_id}"
    h = fnv1a_hash(combined)
    return h % total_buckets
