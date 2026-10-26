"""PostgreSQL partition receipts on the existing Python storage namespace."""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from flowfn.stream.partition import PARTITION_ROUTING, partition_for, validate_partitions
from flowfn.stream.types import Message

if TYPE_CHECKING:
    from flowfn.adapters.postgres import PostgresAdapter

SCHEMA_V2 = '''
CREATE TABLE IF NOT EXISTS flowfn_py_stream_policies(namespace TEXT NOT NULL, stream TEXT NOT NULL, partitions INTEGER CHECK(partitions>0), routing TEXT, PRIMARY KEY(namespace,stream));
CREATE TABLE IF NOT EXISTS flowfn_py_partition_progress(namespace TEXT NOT NULL, stream TEXT NOT NULL, group_name TEXT NOT NULL, partition INTEGER NOT NULL, cursor BIGINT NOT NULL, PRIMARY KEY(namespace,stream,group_name,partition));
CREATE TABLE IF NOT EXISTS flowfn_py_partition_barriers(namespace TEXT NOT NULL, stream TEXT NOT NULL, group_name TEXT NOT NULL, partition INTEGER NOT NULL, event_id BIGINT NOT NULL, token TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(namespace,stream,group_name,partition));
CREATE INDEX IF NOT EXISTS flowfn_py_events_partition ON flowfn_py_events(namespace,stream,(payload->>'partition'),id);
ALTER TABLE flowfn_py_pending DROP CONSTRAINT flowfn_py_pending_event_id_fkey;
ALTER TABLE flowfn_py_pending ADD CONSTRAINT flowfn_py_pending_event_id_fkey FOREIGN KEY(event_id) REFERENCES flowfn_py_events(id) ON DELETE CASCADE;
INSERT INTO flowfn_py_stream_policies(namespace,stream,partitions,routing)
SELECT namespace,stream,NULL,NULL FROM (SELECT namespace,stream FROM flowfn_py_events UNION SELECT namespace,stream FROM flowfn_py_groups) old ON CONFLICT DO NOTHING;
INSERT INTO flowfn_py_meta(version) VALUES(2) ON CONFLICT DO NOTHING;
'''


class PostgresPartitions:
    def __init__(self, adapter: PostgresAdapter) -> None:
        self.adapter = adapter

    async def policy(self, connection: Any, stream: str) -> int | None:
        row = await connection.fetchrow('SELECT partitions,routing FROM flowfn_py_stream_policies WHERE namespace=$1 AND stream=$2', self.adapter.namespace, stream)
        if row is None:
            return None
        count = row['partitions']
        if count is None:
            if row['routing'] is not None:
                raise ValueError('Invalid legacy partition policy')
            return None
        validate_partitions(count)
        if row['routing'] != PARTITION_ROUTING:
            raise ValueError('Unsupported stream partition routing version')
        return int(count)

    async def configure(self, stream: str, count: int | None = None) -> int | None:
        pool = await self.adapter._database()
        if count is None:
            return await self.policy(pool, stream)
        validate_partitions(count)
        async with pool.acquire() as connection, connection.transaction():
            await self.adapter._lock_stream(connection, stream)
            exists = await connection.fetchval('SELECT 1 FROM flowfn_py_stream_policies WHERE namespace=$1 AND stream=$2', self.adapter.namespace, stream)
            if exists:
                current = await self.policy(connection, stream)
                if current != count:
                    raise ValueError('Stream partition policy is immutable; migration required')
                return current
            populated = await connection.fetchval('SELECT EXISTS(SELECT 1 FROM flowfn_py_events WHERE namespace=$1 AND stream=$2) OR EXISTS(SELECT 1 FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2)', self.adapter.namespace, stream)
            if populated:
                raise ValueError('Legacy stream requires migration before partition configuration')
            await connection.execute('INSERT INTO flowfn_py_stream_policies VALUES($1,$2,$3,$4)', self.adapter.namespace, stream, count, PARTITION_ROUTING)
            return count

    async def mark_legacy(self, connection: Any, stream: str) -> None:
        await connection.execute('INSERT INTO flowfn_py_stream_policies VALUES($1,$2,NULL,NULL) ON CONFLICT DO NOTHING', self.adapter.namespace, stream)

    async def publish(self, stream: str, message: Message) -> str:
        snapshot = message.model_copy(deep=True)
        pool = await self.adapter._database()
        async with pool.acquire() as connection, connection.transaction():
            await self.adapter._lock_stream(connection, stream)
            count = await self.policy(connection, stream)
            if count is None and snapshot.partition is not None:
                raise ValueError('Explicit partition requires configured stream partitioning')
            if count is not None:
                snapshot.partition = partition_for(count, snapshot.id, snapshot.key, snapshot.partition)
            await self.mark_legacy(connection, stream)
            await connection.execute('INSERT INTO flowfn_py_events(namespace,stream,payload) VALUES($1,$2,$3)', self.adapter.namespace, stream, snapshot.model_dump_json())
        return snapshot.id

    async def claim(self, stream: str, group: str, duration: int, token: str) -> Any:
        pool = await self.adapter._database()
        namespace = self.adapter.namespace
        async with pool.acquire() as connection, connection.transaction():
            await self.adapter._lock_stream(connection, stream)
            cursor = await connection.fetchval('SELECT cursor FROM flowfn_py_groups WHERE namespace=$1 AND stream=$2 AND name=$3 FOR UPDATE', namespace, stream, group)
            if cursor is None:
                raise RuntimeError('Consumer group does not exist')
            row = await connection.fetchrow('''SELECT e.id,e.payload FROM flowfn_py_pending p JOIN flowfn_py_events e ON e.id=p.event_id
                WHERE p.namespace=$1 AND p.stream=$2 AND p.group_name=$3 AND p.expires_at<=clock_timestamp()
                AND NOT EXISTS(SELECT 1 FROM flowfn_py_partition_barriers b WHERE b.namespace=$1 AND b.stream=$2 AND b.group_name=$3 AND b.partition::text=e.payload->>'partition' AND b.expires_at>clock_timestamp())
                ORDER BY e.id LIMIT 1 FOR UPDATE OF p''', namespace, stream, group)
            if row is None:
                row = await connection.fetchrow('''SELECT e.id,e.payload FROM flowfn_py_events e
                    LEFT JOIN flowfn_py_partition_progress p ON p.namespace=e.namespace AND p.stream=e.stream AND p.group_name=$3 AND p.partition::text=e.payload->>'partition'
                    WHERE e.namespace=$1 AND e.stream=$2 AND e.id>COALESCE(p.cursor,$4)
                    AND NOT EXISTS(SELECT 1 FROM flowfn_py_partition_barriers b WHERE b.namespace=$1 AND b.stream=$2 AND b.group_name=$3 AND b.partition=(e.payload->>'partition')::integer AND b.expires_at>clock_timestamp())
                    AND NOT EXISTS(SELECT 1 FROM flowfn_py_pending held JOIN flowfn_py_events h ON h.id=held.event_id WHERE held.namespace=$1 AND held.stream=$2 AND held.group_name=$3 AND h.payload->>'partition'=e.payload->>'partition')
                    ORDER BY e.id LIMIT 1''', namespace, stream, group, cursor)
                if row is None:
                    return None
                partition = json.loads(row['payload'])['partition']
                await connection.execute('INSERT INTO flowfn_py_partition_progress VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,stream,group_name,partition) DO UPDATE SET cursor=EXCLUDED.cursor', namespace, stream, group, partition, row['id'])
            partition = json.loads(row['payload'])['partition']
            await connection.execute("INSERT INTO flowfn_py_pending VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 millisecond') ON CONFLICT(namespace,stream,group_name,event_id) DO UPDATE SET consumer=EXCLUDED.consumer,expires_at=EXCLUDED.expires_at", namespace, stream, group, row['id'], token, duration)
            await connection.execute("INSERT INTO flowfn_py_partition_barriers VALUES($1,$2,$3,$4,$5,$6,(SELECT expires_at FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$5)) ON CONFLICT(namespace,stream,group_name,partition) DO UPDATE SET event_id=EXCLUDED.event_id,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at", namespace, stream, group, partition, row['id'], token)
            return row

    async def renew(self, stream: str, group: str, identity: int, token: str, duration: int) -> bool:
        pool = await self.adapter._database()
        namespace = self.adapter.namespace
        async with pool.acquire() as connection, connection.transaction():
            await self.adapter._lock_stream(connection, stream)
            owned = await connection.fetchval('SELECT 1 FROM flowfn_py_partition_barriers WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND token=$5 AND expires_at>clock_timestamp() FOR UPDATE', namespace, stream, group, identity, token)
            if not owned:
                return False
            changed = await connection.fetchval("UPDATE flowfn_py_pending SET expires_at=clock_timestamp()+$6*interval '1 millisecond' WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND consumer=$5 AND expires_at>clock_timestamp() RETURNING event_id", namespace, stream, group, identity, token, duration)
            if changed is None:
                return False
            await connection.execute("UPDATE flowfn_py_partition_barriers SET expires_at=(SELECT expires_at FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4) WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND token=$5", namespace, stream, group, identity, token)
            return True

    async def settle(self, stream: str, group: str, identity: int, token: str, requeue: bool) -> bool:
        pool = await self.adapter._database(allow_draining=True)
        namespace = self.adapter.namespace
        async with pool.acquire() as connection, connection.transaction():
            await self.adapter._lock_stream(connection, stream)
            owned = await connection.fetchval('SELECT 1 FROM flowfn_py_partition_barriers WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND token=$5 AND expires_at>clock_timestamp() FOR UPDATE', namespace, stream, group, identity, token)
            if not owned:
                return False
            pending = await connection.fetchrow('SELECT consumer,expires_at>clock_timestamp() AS live FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 FOR UPDATE', namespace, stream, group, identity)
            if pending is not None and (pending['consumer'] != token or not pending['live']):
                return False
            if requeue:
                await connection.execute("UPDATE flowfn_py_pending SET expires_at=clock_timestamp() WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND consumer=$5", namespace, stream, group, identity, token)
            else:
                await connection.execute('DELETE FROM flowfn_py_pending WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND consumer=$5', namespace, stream, group, identity, token)
            await connection.execute('DELETE FROM flowfn_py_partition_barriers WHERE namespace=$1 AND stream=$2 AND group_name=$3 AND event_id=$4 AND token=$5', namespace, stream, group, identity, token)
            return True
