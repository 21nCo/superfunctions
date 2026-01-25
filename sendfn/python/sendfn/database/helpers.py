"""Database helper functions for sendfn operations.

This module provides convenience functions that wrap superfunctions.db calls
with sendfn-specific logic.
"""

from datetime import datetime
from typing import Optional
from uuid import uuid4

from superfunctions.db import (
    Adapter,
    CreateParams,
    DeleteParams,
    FindManyParams,
    FindOneParams,
    UpdateParams,
    WhereClause,
)

from ..models import (
    CommunicationEvent,
    DeviceToken,
    EmailTransaction,
    Platform,
    PushNotification,
    SmsTransaction,
    SuppressionList,
)


# --- Email Transaction Helpers ---


async def create_email_transaction(db: Adapter, data: dict) -> EmailTransaction:
    """Create an email transaction."""
    result = await db.create(
        CreateParams(
            model="email_transactions",
            data={
                **data,
                "id": data.get("id", str(uuid4())),
                "createdAt": datetime.utcnow(),
                "updatedAt": datetime.utcnow(),
            },
        )
    )
    return EmailTransaction.model_validate(result)


async def update_email_transaction(db: Adapter, id: str, data: dict) -> EmailTransaction:
    """Update an email transaction."""
    result = await db.update(
        UpdateParams(
            model="email_transactions",
            where=[WhereClause(field="id", operator="eq", value=id)],
            data={**data, "updatedAt": datetime.utcnow()},
        )
    )
    return EmailTransaction.model_validate(result)


async def get_email_transaction(db: Adapter, id: str) -> Optional[EmailTransaction]:
    """Get an email transaction by ID."""
    result = await db.find_one(
        FindOneParams(
            model="email_transactions",
            where=[WhereClause(field="id", operator="eq", value=id)],
        )
    )
    return EmailTransaction.model_validate(result) if result else None


# --- Event Helpers ---


async def record_event(db: Adapter, data: dict) -> CommunicationEvent:
    """Record a communication event."""
    result = await db.create(
        CreateParams(
            model="communication_events",
            data={
                **data,
                "id": str(uuid4()),
                "createdAt": datetime.utcnow(),
            },
        )
    )
    return CommunicationEvent.model_validate(result)


async def get_events_by_reference(
    db: Adapter, reference_id: str, reference_type: str
) -> list[CommunicationEvent]:
    """Get events for a specific reference."""
    results = await db.find_many(
        FindManyParams(
            model="communication_events",
            where=[
                WhereClause(field="referenceId", operator="eq", value=reference_id),
                WhereClause(field="referenceType", operator="eq", value=reference_type),
            ],
            order_by=[{"field": "eventTimestamp", "direction": "asc"}],
        )
    )
    return [CommunicationEvent.model_validate(r) for r in results]


async def find_events(db: Adapter, params: dict) -> list[CommunicationEvent]:
    """Find communication events matching criteria."""
    where = []
    if params.get("reference_id"):
        where.append(WhereClause(field="referenceId", operator="eq", value=params["reference_id"]))
    if params.get("reference_type"):
        where.append(WhereClause(field="referenceType", operator="eq", value=params["reference_type"]))
    if params.get("event_type"):
        where.append(WhereClause(field="eventType", operator="eq", value=params["event_type"]))

    results = await db.find_many(
        FindManyParams(
            model="communication_events",
            where=where if where else None,
            limit=params.get("limit"),
            offset=params.get("offset"),
        )
    )
    return [CommunicationEvent.model_validate(r) for r in results]


# --- Suppression List Helpers ---


async def is_email_suppressed(db: Adapter, email: str) -> bool:
    """Check if an email is suppressed."""
    entry = await get_suppression_list_entry(db, email)
    return entry is not None


async def get_suppression_list_entry(db: Adapter, email: str) -> Optional[SuppressionList]:
    """Get a suppression list entry by email."""
    result = await db.find_one(
        FindOneParams(
            model="suppression_list",
            where=[WhereClause(field="email", operator="eq", value=email)],
        )
    )
    return SuppressionList.model_validate(result) if result else None


async def add_to_suppression_list(db: Adapter, data: dict) -> SuppressionList:
    """Add an email to the suppression list."""
    # Check if already exists
    existing = await get_suppression_list_entry(db, data["email"])
    if existing:
        return existing

    result = await db.create(
        CreateParams(
            model="suppression_list",
            data={**data, "id": str(uuid4()), "createdAt": datetime.utcnow()},
        )
    )
    return SuppressionList.model_validate(result)


async def remove_from_suppression_list(db: Adapter, email: str) -> None:
    """Remove an email from the suppression list."""
    entry = await get_suppression_list_entry(db, email)
    if entry:
        await db.delete(
            DeleteParams(
                model="suppression_list",
                where=[WhereClause(field="id", operator="eq", value=str(entry.id))],
            )
        )


async def find_suppression_list(db: Adapter, params: dict) -> list[SuppressionList]:
    """Find suppression list entries matching criteria."""
    where = []
    if params.get("reason"):
        where.append(WhereClause(field="reason", operator="eq", value=params["reason"]))

    results = await db.find_many(
        FindManyParams(
            model="suppression_list",
            where=where if where else None,
            limit=params.get("limit"),
            offset=params.get("offset"),
        )
    )
    return [SuppressionList.model_validate(r) for r in results]


# --- Device Token Helpers ---


async def create_device_token(db: Adapter, **data) -> DeviceToken:
    """Create a device token."""
    result = await db.create(
        CreateParams(
            model="device_tokens",
            data=data,
        )
    )
    return DeviceToken.model_validate(result)


async def update_device_token(db: Adapter, device_id: str, **data) -> DeviceToken:
    """Update a device token."""
    result = await db.update(
        UpdateParams(
            model="device_tokens",
            where=[WhereClause(field="id", operator="eq", value=device_id)],
            data={**data, "updatedAt": datetime.utcnow()},
        )
    )
    return DeviceToken.model_validate(result)


async def find_device_token(
    db: Adapter,
    user_id: str,
    token: str,
    platform: Platform,
) -> Optional[DeviceToken]:
    """Find a device token by user, token, and platform."""
    result = await db.find_one(
        FindOneParams(
            model="device_tokens",
            where=[
                WhereClause(field="userId", operator="eq", value=user_id),
                WhereClause(field="token", operator="eq", value=token),
                WhereClause(field="platform", operator="eq", value=platform),
            ],
        )
    )
    return DeviceToken.model_validate(result) if result else None


async def find_device_tokens(
    db: Adapter,
    user_id: str,
    platform: Optional[Platform] = None,
    is_active: bool = True,
) -> list[DeviceToken]:
    """Find device tokens for a user."""
    where = [
        WhereClause(field="userId", operator="eq", value=user_id),
        WhereClause(field="isActive", operator="eq", value=is_active),
    ]

    if platform:
        where.append(WhereClause(field="platform", operator="eq", value=platform))

    results = await db.find_many(
        FindManyParams(
            model="device_tokens",
            where=where,
        )
    )
    return [DeviceToken.model_validate(r) for r in results]


async def deactivate_device_tokens(db: Adapter, tokens: list[str]) -> None:
    """Deactivate device tokens by token values."""
    for token in tokens:
        # Find all devices with this token
        devices = await db.find_many(
            FindManyParams(
                model="device_tokens",
                where=[WhereClause(field="token", operator="eq", value=token)],
            )
        )

        # Deactivate each
        for device in devices:
            await db.update(
                UpdateParams(
                    model="device_tokens",
                    where=[WhereClause(field="id", operator="eq", value=device["id"])],
                    data={"isActive": False, "updatedAt": datetime.utcnow()},
                )
            )


async def delete_device_token(db: Adapter, device_id: str) -> None:
    """Delete a device token."""
    await db.delete(
        DeleteParams(
            model="device_tokens",
            where=[WhereClause(field="id", operator="eq", value=device_id)],
        )
    )


# --- Push Notification Helpers ---


async def create_push_notification(db: Adapter, data: dict) -> PushNotification:
    """Create a push notification."""
    result = await db.create(
        CreateParams(
            model="push_notifications",
            data={
                **data,
                "id": data.get("id", str(uuid4())),
                "createdAt": datetime.utcnow(),
                "updatedAt": datetime.utcnow(),
            },
        )
    )
    return PushNotification.model_validate(result)


async def update_push_notification(
    db: Adapter, id: str, data: dict
) -> PushNotification:
    """Update a push notification."""
    result = await db.update(
        UpdateParams(
            model="push_notifications",
            where=[WhereClause(field="id", operator="eq", value=id)],
            data={**data, "updatedAt": datetime.utcnow()},
        )
    )
    return PushNotification.model_validate(result)


async def get_push_notification(db: Adapter, id: str) -> Optional[PushNotification]:
    """Get a push notification by ID."""
    result = await db.find_one(
        FindOneParams(
            model="push_notifications",
            where=[WhereClause(field="id", operator="eq", value=id)],
        )
    )
    return PushNotification.model_validate(result) if result else None


# --- SMS Transaction Helpers ---


async def create_sms_transaction(db: Adapter, data: dict) -> SmsTransaction:
    """Create an SMS transaction."""
    result = await db.create(
        CreateParams(
            model="sms_transactions",
            data={
                **data,
                "id": data.get("id", str(uuid4())),
                "createdAt": datetime.utcnow(),
                "updatedAt": datetime.utcnow(),
            },
        )
    )
    return SmsTransaction.model_validate(result)


async def update_sms_transaction(db: Adapter, id: str, data: dict) -> SmsTransaction:
    """Update an SMS transaction."""
    result = await db.update(
        UpdateParams(
            model="sms_transactions",
            where=[WhereClause(field="id", operator="eq", value=id)],
            data={**data, "updatedAt": datetime.utcnow()},
        )
    )
    return SmsTransaction.model_validate(result)


async def get_sms_transaction(db: Adapter, id: str) -> Optional[SmsTransaction]:
    """Get an SMS transaction by ID."""
    result = await db.find_one(
        FindOneParams(
            model="sms_transactions",
            where=[WhereClause(field="id", operator="eq", value=id)],
        )
    )
    return SmsTransaction.model_validate(result) if result else None
