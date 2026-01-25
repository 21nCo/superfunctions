"""Device token manager for push notifications."""

from datetime import datetime
from typing import Optional
from uuid import uuid4

from superfunctions.db import Adapter

from ..models import DeviceToken, Platform, RegisterDeviceParams


class DeviceTokenManager:
    """Manager for device token registration and retrieval."""

    def __init__(self, db: Adapter) -> None:
        """Initialize device token manager.

        Args:
            db: Database adapter
        """
        self.db = db

    async def register_device(self, params: RegisterDeviceParams) -> DeviceToken:
        """Register or update a device token.

        Args:
            params: Device registration parameters

        Returns:
            Device token record
        """
        now = datetime.now()

        # Check if device already exists (userId + token + platform)
        # Using find to check for existing token
        from ..database.helpers import find_device_token

        existing = await find_device_token(
            self.db,
            user_id=params.user_id,
            token=params.token,
            platform=params.platform,
        )

        if existing:
            # Update existing device
            from ..database.helpers import update_device_token

            return await update_device_token(
                self.db,
                device_id=str(existing.id),
                is_active=True,
                last_used_at=now,
                app_version=params.app_version,
                device_info=params.device_info,
            )
        else:
            # Create new device token
            from ..database.helpers import create_device_token

            return await create_device_token(
                self.db,
                id=uuid4(),
                user_id=params.user_id,
                token=params.token,
                platform=params.platform,
                app_version=params.app_version,
                device_info=params.device_info,
                is_active=True,
                last_used_at=now,
                created_at=now,
                updated_at=now,
            )

    async def get_active_devices(
        self, user_id: str, platform: Optional[Platform] = None
    ) -> list[DeviceToken]:
        """Get active device tokens for a user.

        Args:
            user_id: User ID
            platform: Optional platform filter

        Returns:
            List of active device tokens
        """
        from ..database.helpers import find_device_tokens

        return await find_device_tokens(
            self.db,
            user_id=user_id,
            platform=platform,
            is_active=True,
        )

    async def deactivate_tokens(self, tokens: list[str]) -> None:
        """Deactivate device tokens (e.g., when they're invalid).

        Args:
            tokens: List of device tokens to deactivate
        """
        from ..database.helpers import deactivate_device_tokens

        await deactivate_device_tokens(self.db, tokens=tokens)

    async def delete_device(self, device_id: str) -> None:
        """Delete a device token.

        Args:
            device_id: Device token ID
        """
        from ..database.helpers import delete_device_token

        await delete_device_token(self.db, device_id=device_id)
