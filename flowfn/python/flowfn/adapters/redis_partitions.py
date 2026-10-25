"""Redis partition policy, receipts and retention using the native TS protocol."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from flowfn.adapters import redis_partition_scripts as scripts
from flowfn.stream.partition import PARTITION_ROUTING, partition_for, validate_partitions
from flowfn.stream.types import Message, StreamInfo, TrimStrategy

if TYPE_CHECKING:
    from flowfn.adapters.redis import RedisAdapter


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


class RedisPartitions:
    def __init__(self, adapter: RedisAdapter) -> None:
        self.adapter = adapter

    def key(self, kind: str, name: str) -> str:
        return self.adapter.prefix + ":" + kind + ":" + name

    def name(self, stream: str) -> str:
        return quote(stream, safe="")

    def policy(self, stream: str) -> str:
        return self.key("partition-policy", self.name(stream))

    def history(self, stream: str) -> str:
        return self.key("stream", self.name(stream))

    def indices(self, stream: str) -> str:
        return self.key("partition-indices", self.name(stream))

    def index_prefix(self, stream: str) -> str:
        return self.key("partition-history", encode([self.name(stream)])) + ":"

    def groups(self, stream: str) -> str:
        return self.key("partition-groups", self.name(stream))

    def cursors(self, stream: str, group: str) -> str:
        return self.key("partition-cursors", encode([self.name(stream), group]))

    def barriers(self, stream: str, group: str) -> str:
        return self.key("partition-barriers", encode([self.name(stream), group]))

    async def execute(self, script: str, keys: list[str], *args: Any) -> Any:
        from flowfn.adapters.redis import _eval

        self.adapter._check_open()
        return await _eval(self.adapter.client, script, len(keys), *keys, *args)

    def decode_policy(self, raw: str | None) -> int | None:
        if raw is None or raw == "legacy":
            return None
        prefix = PARTITION_ROUTING + ":"
        if not raw.startswith(prefix):
            raise ValueError("Unsupported stream partition routing version")
        suffix = raw[len(prefix) :]
        try:
            count = int(suffix)
        except ValueError:
            raise ValueError("Invalid stream partition policy") from None
        validate_partitions(count)
        if str(count) != suffix:
            raise ValueError("Invalid stream partition policy")
        return count

    async def configure(self, stream: str, count: int | None = None) -> int | None:
        self.adapter._check_open()
        if count is None:
            raw = await self.adapter.client.get(self.policy(stream))
        else:
            validate_partitions(count)
            raw = await self.execute(
                scripts.CONFIGURE,
                [self.policy(stream), self.history(stream), self.groups(stream)],
                PARTITION_ROUTING + ":" + str(count),
            )
        return self.decode_policy(raw)

    async def publish(self, stream: str, message: Message) -> str:
        snapshot = message.model_copy(deep=True)
        count = await self.configure(stream)
        if count is None:
            if snapshot.partition is not None:
                raise ValueError("Explicit partition requires configured stream partitioning")
            # Fence concurrent configuration before admitting legacy-format rows.
            await self.execute(
                """
local current=redis.call('GET',KEYS[1])
if current and current~='legacy' then return redis.error_reply('Stream partition policy changed before publication') end
redis.call('SET',KEYS[1],'legacy')
return redis.call('XADD',KEYS[2],'*','payload',ARGV[1])
""",
                [self.policy(stream), self.history(stream)],
                snapshot.model_dump_json(),
            )
            return snapshot.id
        partition = partition_for(count, snapshot.id, snapshot.key, snapshot.partition)
        metadata: dict[str, Any] = {"partition": partition, "timestamp": snapshot.timestamp}
        if snapshot.key is not None:
            metadata["key"] = snapshot.key
        result = await self.execute(
            scripts.PUBLISH,
            [
                self.policy(stream),
                self.history(stream),
                self.indices(stream),
                self.index_prefix(stream) + str(partition),
            ],
            PARTITION_ROUTING + ":" + str(count),
            encode(snapshot.data),
            encode(snapshot.headers or {}),
            encode(metadata),
            str(partition),
        )
        return str(result)

    async def ensure_group(self, stream: str, group: str, beginning: bool) -> int | None:
        if not group:
            raise ValueError("Consumer group requires identity")
        raw = await self.execute(
            scripts.GROUP,
            [self.policy(stream), self.history(stream), self.groups(stream)],
            group,
            "1" if beginning else "0",
            self.cursors(stream, group),
            self.barriers(stream, group),
            PARTITION_ROUTING + ":",
        )
        return self.decode_policy(raw)

    async def claim(
        self, stream: str, group: str, duration: int, attempt: str
    ) -> list[tuple[str, dict[str, str], str, str]]:
        rows = await self.execute(
            scripts.CLAIM,
            [
                self.history(stream),
                self.indices(stream),
                self.groups(stream),
                self.cursors(stream, group),
                self.barriers(stream, group),
            ],
            group,
            1,
            duration,
            attempt,
            self.index_prefix(stream),
        )
        return [
            (str(row[0]), dict(zip(row[1][::2], row[1][1::2])), str(row[2]), str(row[3]))
            for row in rows
        ]

    async def renew(
        self, stream: str, group: str, partition: str, identity: str, token: str, duration: int
    ) -> bool:
        return bool(
            await self.execute(
                scripts.RENEW,
                [self.history(stream), self.barriers(stream, group)],
                partition,
                identity,
                token,
                duration,
            )
        )

    async def settle(
        self, stream: str, group: str, partition: str, identity: str, token: str, requeue: bool
    ) -> bool:
        from flowfn.adapters.redis import _eval

        # Adapter shutdown closes public admission before joining subscriptions.
        # Their already-owned receipts must still settle while the client drains.
        return bool(
            await _eval(
                self.adapter.client,
                scripts.SETTLE,
                2,
                self.history(stream),
                self.barriers(stream, group),
                partition,
                identity,
                token,
                "1" if requeue else "0",
            )
        )

    async def trim(self, stream: str, strategy: TrimStrategy) -> int:
        result = await self.execute(
            scripts.TRIM,
            [self.history(stream), self.indices(stream)],
            strategy.max_length if strategy.max_length is not None else "",
            strategy.max_age_seconds if strategy.max_age_seconds is not None else "",
            self.index_prefix(stream),
        )
        return int(result)

    async def info(self, stream: str, count: int) -> StreamInfo:
        values = await self.execute(
            scripts.INFO,
            [self.history(stream), self.indices(stream), self.groups(stream)],
            self.index_prefix(stream),
        )
        return StreamInfo(
            name=stream,
            partitions=count,
            length=int(values[0]),
            groups=int(values[1]),
            lag=int(values[2]),
        )


def decode_message(stream: str, identity: str, fields: dict[str, Any]) -> Message:
    metadata = json.loads(fields.get("metadata", "{}"))
    if not isinstance(metadata, dict) or set(metadata) - {"partition", "key", "timestamp"}:
        raise ValueError("Invalid partition message metadata")
    partition = metadata.get("partition")
    if type(partition) is not int or partition < 0:
        raise ValueError("Invalid partition message identity")
    return Message(
        id=identity,
        stream=stream,
        data=json.loads(fields["data"]),
        headers=json.loads(fields.get("headers", "{}")),
        timestamp=metadata.get("timestamp", int(identity.split("-")[0])),
        partition=partition,
        key=metadata.get("key"),
    )
