"""Secrets vault for encrypted secret storage and management."""

import time
from typing import List, Optional

from ..storage.file_storage import FileStorage
from ..types import Environment, Secret, SecretAccess, SecretNotFoundError, SetSecretOptions
from ..utils.helpers import generate_id, is_expired
from .encryption import SecretEncryption


class SecretsVaultConfig:
    """Configuration for secrets vault."""

    def __init__(
        self,
        storage: FileStorage,
        master_key: str,
        rotation_check_interval: Optional[int] = None,
        rotation_notify_before: Optional[int] = None,
    ):
        """Initialize vault config.
        
        Args:
            storage: Storage backend
            master_key: Master encryption key
            rotation_check_interval: Interval for checking rotation needs (ms)
            rotation_notify_before: Notify before rotation deadline (ms)
        """
        self.storage = storage
        self.master_key = master_key
        self.rotation_check_interval = rotation_check_interval
        self.rotation_notify_before = rotation_notify_before or 7 * 24 * 60 * 60 * 1000


class SecretsVault:
    """Encrypted secrets vault with rotation and access logging."""

    def __init__(self, config: SecretsVaultConfig):
        """Initialize secrets vault.
        
        Args:
            config: Vault configuration
        """
        self.storage = config.storage
        self.master_key = config.master_key
        self.encryption = SecretEncryption()
        self.rotation_check_interval = config.rotation_check_interval
        self.rotation_notify_before = config.rotation_notify_before

    async def set(
        self, key: str, value: str, options: Optional[SetSecretOptions] = None
    ) -> str:
        """Store an encrypted secret.
        
        Args:
            key: Secret key/name
            value: Secret value to encrypt
            options: Additional options
            
        Returns:
            Secret ID
        """
        opts = options or SetSecretOptions()
        existing = await self.storage.get_secret_by_key(key)
        now = int(time.time() * 1000)

        # Encrypt the value
        encrypted_value = await self.encryption.encrypt(value, self.master_key)

        secret = Secret(
            id=existing.id if existing else generate_id("secret"),
            key=key,
            value=encrypted_value,
            encrypted=True,
            version=existing.version + 1 if existing else 1,
            tags=opts.tags or [],
            environment=opts.environment,
            expiresAt=opts.expires_at,
            rotateEvery=opts.rotate_every,
            lastRotated=now,
            lastAccessed=None,
            accessCount=0,
            createdBy=opts.created_by or "system",
            createdAt=existing.created_at if existing else now,
            updatedAt=now,
        )

        await self.storage.save_secret(secret)
        await self._log_access(secret.id, opts.created_by or "system", "write")

        return secret.id

    async def get(self, key: str, user_id: str = "system") -> Optional[str]:
        """Retrieve and decrypt a secret.
        
        Args:
            key: Secret key/name
            user_id: User accessing the secret
            
        Returns:
            Decrypted secret value or None if not found
            
        Raises:
            SecretNotFoundError: If secret expired
        """
        secret = await self.storage.get_secret_by_key(key)

        if not secret:
            return None

        if is_expired(secret.expires_at):
            raise SecretNotFoundError(f"Secret '{key}' has expired")

        # Decrypt the value
        decrypted_value = await self.encryption.decrypt(secret.value, self.master_key)

        # Update access tracking
        secret.last_accessed = int(time.time() * 1000)
        secret.access_count += 1
        await self.storage.save_secret(secret)

        await self._log_access(secret.id, user_id, "read")

        return decrypted_value

    async def list(
        self, filter: Optional[dict] = None
    ) -> List[dict]:
        """List secrets (without values).
        
        Args:
            filter: Optional filter dict with 'environment' or 'tags'
            
        Returns:
            List of secret metadata (without values)
        """
        secrets = await self.storage.list_secrets(filter)

        # Return without the encrypted value
        return [
            {
                "id": s.id,
                "key": s.key,
                "version": s.version,
                "tags": s.tags,
                "environment": s.environment,
                "expiresAt": s.expires_at,
                "rotateEvery": s.rotate_every,
                "lastRotated": s.last_rotated,
                "lastAccessed": s.last_accessed,
                "accessCount": s.access_count,
                "createdBy": s.created_by,
                "createdAt": s.created_at,
                "updatedAt": s.updated_at,
            }
            for s in secrets
        ]

    async def rotate(self, key: str, new_value: str, user_id: str = "system") -> None:
        """Rotate a secret to a new value.
        
        Args:
            key: Secret key/name
            new_value: New secret value
            user_id: User performing rotation
            
        Raises:
            SecretNotFoundError: If secret not found
        """
        secret = await self.storage.get_secret_by_key(key)

        if not secret:
            raise SecretNotFoundError(f"Secret '{key}' not found")

        # Encrypt new value
        encrypted_value = await self.encryption.encrypt(new_value, self.master_key)

        secret.value = encrypted_value
        secret.version += 1
        secret.last_rotated = int(time.time() * 1000)
        secret.updated_at = int(time.time() * 1000)

        await self.storage.save_secret(secret)
        await self._log_access(secret.id, user_id, "rotate")

    async def delete(self, key: str, user_id: str = "system") -> None:
        """Delete a secret.
        
        Args:
            key: Secret key/name
            user_id: User deleting the secret
            
        Raises:
            SecretNotFoundError: If secret not found
        """
        secret = await self.storage.get_secret_by_key(key)

        if not secret:
            raise SecretNotFoundError(f"Secret '{key}' not found")

        await self.storage.delete_secret(secret.id)
        await self._log_access(secret.id, user_id, "delete")

    async def get_access_log(self, key: str, limit: int = 100) -> List[SecretAccess]:
        """Get access log for a secret.
        
        Args:
            key: Secret key/name
            limit: Maximum number of log entries
            
        Returns:
            List of access log entries
            
        Raises:
            SecretNotFoundError: If secret not found
        """
        secret = await self.storage.get_secret_by_key(key)

        if not secret:
            raise SecretNotFoundError(f"Secret '{key}' not found")

        return await self.storage.get_secret_access_log(secret.id, limit)

    async def get_secrets_needing_rotation(
        self, before_ms: int = 7 * 24 * 60 * 60 * 1000
    ) -> List[Secret]:
        """Find secrets that need rotation.
        
        Args:
            before_ms: Notify if rotation needed within this time (ms)
            
        Returns:
            List of secrets needing rotation
        """
        all_secrets = await self.storage.list_secrets()
        now = int(time.time() * 1000)
        threshold = now + before_ms

        needing_rotation = []
        for secret in all_secrets:
            if secret.rotate_every and secret.last_rotated:
                next_rotation = secret.last_rotated + secret.rotate_every
                if next_rotation <= threshold:
                    needing_rotation.append(secret)

        return needing_rotation

    async def get_expired_secrets(self) -> List[Secret]:
        """Find expired secrets.
        
        Returns:
            List of expired secrets
        """
        all_secrets = await self.storage.list_secrets()
        return [s for s in all_secrets if is_expired(s.expires_at)]

    async def _log_access(
        self, secret_id: str, user_id: str, action: str
    ) -> None:
        """Log secret access.
        
        Args:
            secret_id: Secret ID
            user_id: User ID
            action: Action performed
        """
        access_log = SecretAccess(
            id=generate_id("access"),
            secretId=secret_id,
            userId=user_id,
            action=action,  # type: ignore
            timestamp=int(time.time() * 1000),
        )

        await self.storage.log_secret_access(access_log)
