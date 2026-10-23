"""Tests for SecretEncryption class."""

import pytest

from secfn.secrets.encryption import SecretEncryption
from secfn.types import EncryptionError


@pytest.mark.asyncio
async def test_encrypt_decrypt_roundtrip(master_key):
    """Test encryption and decryption roundtrip."""
    encryption = SecretEncryption()
    plaintext = "my-secret-value"

    # Encrypt
    ciphertext = await encryption.encrypt(plaintext, master_key)
    assert ciphertext != plaintext
    assert "nonce" in ciphertext
    assert "ciphertext" in ciphertext

    # Decrypt
    decrypted = await encryption.decrypt(ciphertext, master_key)
    assert decrypted == plaintext


@pytest.mark.asyncio
async def test_different_keys_produce_different_ciphertexts(master_key):
    """Test that different master keys produce different ciphertexts."""
    encryption = SecretEncryption()
    plaintext = "my-secret-value"

    ciphertext1 = await encryption.encrypt(plaintext, master_key)
    ciphertext2 = await encryption.encrypt(plaintext, "different-key")

    assert ciphertext1 != ciphertext2


@pytest.mark.asyncio
async def test_wrong_key_fails_decryption(master_key):
    """Test that wrong key fails decryption."""
    encryption = SecretEncryption()
    plaintext = "my-secret-value"

    ciphertext = await encryption.encrypt(plaintext, master_key)

    with pytest.raises(EncryptionError):
        await encryption.decrypt(ciphertext, "wrong-key")


@pytest.mark.asyncio
async def test_tampered_ciphertext_fails_decryption(master_key):
    """Test that tampered ciphertext fails decryption."""
    encryption = SecretEncryption()
    plaintext = "my-secret-value"

    ciphertext = await encryption.encrypt(plaintext, master_key)

    # Tamper with ciphertext
    tampered = ciphertext.replace("a", "b", 1)

    with pytest.raises(EncryptionError):
        await encryption.decrypt(tampered, master_key)
