"""Secret encryption using AES-256-GCM."""

import json
import os
from typing import Dict

from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from ..types import EncryptionError


class SecretEncryption:
    """Handles encryption and decryption of secrets using AES-256-GCM."""

    def __init__(self) -> None:
        """Initialize encryption handler."""
        self.algorithm = "aes-256-gcm"
        self.key_length = 32  # 256 bits
        self.nonce_length = 12  # 96 bits (recommended for GCM)
        self.salt = b"secfn-salt-v1"  # Static salt for key derivation
        self.iterations = 100000

    async def encrypt(self, plaintext: str, master_key: str) -> str:
        """Encrypt plaintext using AES-256-GCM.
        
        Args:
            plaintext: Text to encrypt
            master_key: Master key for encryption
            
        Returns:
            JSON string containing nonce, ciphertext, and tag
            
        Raises:
            EncryptionError: If encryption fails
        """
        try:
            # Derive encryption key from master key
            key = self._derive_key(master_key)

            # Generate random nonce
            nonce = os.urandom(self.nonce_length)

            # Create AESGCM cipher
            aesgcm = AESGCM(key)

            # Encrypt (returns ciphertext + tag)
            ciphertext = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)

            # Return as JSON with nonce and ciphertext
            return json.dumps(
                {
                    "nonce": nonce.hex(),
                    "ciphertext": ciphertext.hex(),
                }
            )
        except Exception as e:
            raise EncryptionError(f"Encryption failed: {e}") from e

    async def decrypt(self, ciphertext_json: str, master_key: str) -> str:
        """Decrypt ciphertext using AES-256-GCM.
        
        Args:
            ciphertext_json: JSON string from encrypt()
            master_key: Master key for decryption
            
        Returns:
            Decrypted plaintext
            
        Raises:
            EncryptionError: If decryption fails or authentication fails
        """
        try:
            # Parse JSON
            data: Dict[str, str] = json.loads(ciphertext_json)
            nonce = bytes.fromhex(data["nonce"])
            ciphertext = bytes.fromhex(data["ciphertext"])

            # Derive encryption key from master key
            key = self._derive_key(master_key)

            # Create AESGCM cipher
            aesgcm = AESGCM(key)

            # Decrypt and verify authentication tag
            plaintext_bytes = aesgcm.decrypt(nonce, ciphertext, None)

            return plaintext_bytes.decode("utf-8")
        except Exception as e:
            raise EncryptionError(f"Decryption failed: {e}") from e

    def _derive_key(self, master_key: str) -> bytes:
        """Derive encryption key from master key using PBKDF2.
        
        Args:
            master_key: Master key string
            
        Returns:
            Derived key bytes
        """
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=self.key_length,
            salt=self.salt,
            iterations=self.iterations,
            backend=default_backend(),
        )
        return kdf.derive(master_key.encode("utf-8"))
