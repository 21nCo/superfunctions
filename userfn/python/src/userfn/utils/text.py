def utf16_units(value: str) -> str:
    """Represent JS UTF-16 code units, preserving paired and lone surrogates."""
    encoded = value.encode('utf-16-le', errors='surrogatepass')
    return ''.join(chr(encoded[offset] | (encoded[offset + 1] << 8))
                   for offset in range(0, len(encoded), 2))
