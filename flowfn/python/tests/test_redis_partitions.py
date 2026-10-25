"""Owned standalone Redis partition protocol, including actual TS interoperation."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest
from redis.exceptions import ResponseError

from flowfn.adapters.redis import RedisAdapter
from flowfn.stream.partition import partition_for
from flowfn.stream.stream import Stream
from flowfn.stream.types import ConsumerOptions, Message, PublishOptions, TrimStrategy


@pytest.fixture(scope="module")
def redis_url(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    executable = shutil.which("redis-server")
    if executable is None:
        pytest.skip("Native redis-server required")
    directory = tmp_path_factory.mktemp("partition-redis")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with (directory / "server.log").open("wb") as log:
        process = subprocess.Popen(
            [
                executable,
                "--bind",
                "127.0.0.1",
                "--port",
                str(port),
                "--save",
                "",
                "--appendonly",
                "no",
                "--dir",
                str(directory),
            ],
            stdout=log,
            stderr=log,
        )
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError("Owned Redis exited during startup")
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.05):
                        break
                except OSError:
                    time.sleep(0.02)
            else:
                raise RuntimeError("Owned Redis startup timed out")
            yield f"redis://127.0.0.1:{port}"
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@pytest.fixture
async def pair(redis_url: str) -> AsyncIterator[tuple[RedisAdapter, RedisAdapter]]:
    namespace = "native:/分%" + uuid.uuid4().hex
    a, b = (RedisAdapter(redis_url, namespace=namespace, reclaim_after_ms=100) for _ in range(2))
    try:
        yield a, b
    finally:
        await a.cleanup()
        await b.cleanup()


def message(value: int, partition: int = 0) -> Message:
    return Message(
        id=str(uuid.uuid4()),
        stream="orders",
        data={"value": value},
        timestamp=123,
        partition=partition,
    )


def options(group: str = "workers", **extra: Any) -> ConsumerOptions:
    return ConsumerOptions(
        group_id=group, from_beginning=True, max_in_flight=2, visibility_timeout=250, **extra
    )


async def test_public_routing_detachment_and_immutable_legacy_policy(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    stream = Stream("orders", a, {"partitions": 3})
    identity = await stream.publish({"value": 1}, PublishOptions(key="same-分"))
    saved = (await b.get_stream_messages("orders"))[0]
    assert saved.id == identity and saved.partition == partition_for(3, identity, "same-分", None)
    assert saved.stream == "orders"
    assert (await b.get_stream_info("orders")).partitions == 3
    with pytest.raises(ResponseError, match="immutable"):
        await b.configure_stream("orders", 4)
    await a.publish("legacy", Message(id="legacy", stream="legacy", data={}, timestamp=1))
    with pytest.raises(ResponseError, match="immutable|migration"):
        await b.configure_stream("legacy", 2)
    with pytest.raises(ValueError, match="Explicit partition"):
        await a.publish("other", message(1))
    # Empty groups also fix legacy policy; no silent reinterpretation on restart.
    sub = await a.consume("empty", "group", "reader", lambda item: asyncio.sleep(0), options())
    await sub.unsubscribe()
    with pytest.raises(ResponseError, match="immutable|migration"):
        await b.configure_stream("empty", 2)
    await stream.close()


async def test_two_workers_partition_exclusion_nack_and_fenced_receipts(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    await a.configure_stream("orders", 2)
    first = await a.publish("orders", message(1))
    second = await a.publish("orders", message(2))
    other = await a.publish("orders", message(3, 1))
    entered, other_seen, release, complete = (asyncio.Event() for _ in range(4))
    seen: list[str] = []
    held: list[Message] = []

    async def handler(item: Message) -> None:
        seen.append(item.id)
        if item.id == first:
            held.append(item)
            entered.set()
            await release.wait()
            await item.ack()
        elif item.id == other:
            other_seen.set()
            await item.ack()
        else:
            await item.ack()
            complete.set()

    one = await a.consume("orders", "workers", "a", handler, options())
    two = await b.consume("orders", "workers", "b", handler, options())
    try:
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.wait_for(other_seen.wait(), 3)
        await asyncio.sleep(0.35)
        assert seen.count(first) == 1 and second not in seen
        release.set()
        await asyncio.wait_for(complete.wait(), 3)
        assert (await a.get_stream_info("orders")).lag == 0
    finally:
        release.set()
        await one.unsubscribe()
        await two.unsubscribe()
    with pytest.raises(RuntimeError, match="ownership"):
        await held[0].ack()
    retry_id = await a.publish("orders", message(4))
    attempts: list[str] = []
    done = asyncio.Event()

    async def retry(item: Message) -> None:
        attempts.append(item.id)
        if len(attempts) == 1:
            await item.nack(True)
        else:
            await item.ack()
            done.set()

    sub = await b.consume("orders", "workers", "retry", retry, options())
    try:
        await asyncio.wait_for(done.wait(), 3)
        assert attempts == [retry_id, retry_id]
    finally:
        await sub.unsubscribe()


async def test_manual_return_expiry_and_old_token_cannot_ack_successor(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    await a.configure_stream("orders", 1)
    identity = await a.publish("orders", message(1))
    old: list[Message] = []
    arrived = asyncio.Event()

    async def forgotten(item: Message) -> None:
        old.append(item)
        arrived.set()

    one = await a.consume("orders", "workers", "forget", forgotten, options())
    await asyncio.wait_for(arrived.wait(), 3)
    await one.pause()
    done = asyncio.Event()

    async def recovered(item: Message) -> None:
        assert item.id == identity
        with pytest.raises(RuntimeError, match="ownership"):
            await old[0].ack()
        await item.ack()
        done.set()

    two = await b.consume("orders", "workers", "recover", recovered, options())
    try:
        await asyncio.wait_for(done.wait(), 3)
    finally:
        await one.unsubscribe()
        await two.unsubscribe()


async def test_retention_keeps_active_barrier_until_callback_cancellation_join(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    await a.configure_stream("orders", 1)
    first = await a.publish("orders", message(1))
    entered, cancelled, joined, next_seen = (asyncio.Event() for _ in range(4))

    async def hold(item: Message) -> None:
        assert item.id == first
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            await joined.wait()
            raise

    one = await a.consume("orders", "workers", "held", hold, options())
    await asyncio.wait_for(entered.wait(), 3)
    assert await b.trim_stream("orders", TrimStrategy(max_length=0)) == 1
    second = await b.publish("orders", message(2))

    async def successor(item: Message) -> None:
        assert item.id == second
        await item.ack()
        next_seen.set()

    two = await b.consume("orders", "workers", "next", successor, options())
    try:
        await asyncio.wait_for(cancelled.wait(), 3)
        assert not next_seen.is_set()
        joined.set()
        await asyncio.wait_for(next_seen.wait(), 3)
    finally:
        joined.set()
        await one.unsubscribe()
        await two.unsubscribe()


async def test_encoded_names_distinct_and_reopen_policy(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    for name in ("a/b", "a%2Fb", "a:b", "a{b}", "分", '["x","y"]'):
        await a.configure_stream(name, 2)
        await a.publish(name, message(1, 1))
        rows = await b.get_stream_messages(name)
        assert len(rows) == 1 and rows[0].stream == name and rows[0].partition == 1
        assert a._partitions.history(name) == a.prefix + ":stream:" + quote(name, safe="")
        assert await b.configure_stream(name) == 2


async def test_actual_typescript_python_shared_policy_delivery_and_killed_owner(
    pair: tuple[RedisAdapter, RedisAdapter], redis_url: str
) -> None:
    a, b = pair
    module = Path(
        os.environ.get(
            "FLOWFN_TS_REDIS_MODULE",
            str(Path(__file__).resolve().parents[2] / "typescript/dist/adapters/redis.mjs"),
        )
    )
    node = shutil.which("node")
    if node is None or not module.exists():
        pytest.skip("Built actual TypeScript Redis adapter and Node required")
    name = "orders:/分%"
    await a.configure_stream(name, 2)
    source = """
import {RedisAdapter} from MODULE;
const a=new RedisAdapter({connection:{host:'127.0.0.1',port:Number(process.env.PORT)},prefix:process.env.PREFIX});
const stream=process.env.STREAM;
await a.configureStream(stream,2);
if(process.env.MODE==='publish') {
 console.log(await a.publish(stream,{id:'ts-producer',data:{from:'typescript'},timestamp:123,partition:1}));
 await a.cleanup();
} else {
 const sub=await a.consume(stream,'shared','typescript',async m=>{
  console.log(JSON.stringify({id:m.id,data:m.data}));
  if(process.env.MODE==='ack'){await m.ack();await sub.unsubscribe();await a.cleanup();}
  else await new Promise(()=>{});
 },{fromBeginning:true,autoCommit:false,visibilityTimeout:250,maxInFlight:1});
}
""".replace(
        "MODULE", json.dumps(module.as_uri())
    )
    env = dict(
        os.environ,
        PORT=redis_url.rsplit(":", 1)[1],
        PREFIX=a.prefix + ":",
        STREAM=quote(name, safe=""),
        MODE="publish",
    )
    child = await asyncio.create_subprocess_exec(
        node,
        "--input-type=module",
        "-e",
        source,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, error = await asyncio.wait_for(child.communicate(), 5)
        assert child.returncode == 0, error.decode()
        ts_id = output.decode().strip()
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
    assert (await b.get_stream_messages(name))[0].id == ts_id
    # A real killed TS process leaves a durable barrier, then Python takes it over.
    env["MODE"] = "hold"
    child = await asyncio.create_subprocess_exec(
        node,
        "--input-type=module",
        "-e",
        source,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert child.stdout is not None
        first = json.loads(await asyncio.wait_for(child.stdout.readline(), 5))
        assert first["id"] == ts_id
        child.kill()
        await child.wait()
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
    done = asyncio.Event()

    async def handle(item: Message) -> None:
        assert item.id == ts_id and item.stream == name and item.data == {"from": "typescript"}
        await item.ack()
        done.set()

    sub = await b.consume(name, "shared", "python", handle, options("shared"))
    try:
        await asyncio.wait_for(done.wait(), 3)
    finally:
        await sub.unsubscribe()
    assert (await a.get_stream_info(name)).lag == 0
    py_id = await a.publish(name, message(2, 0))
    env["MODE"] = "ack"
    child = await asyncio.create_subprocess_exec(
        node,
        "--input-type=module",
        "-e",
        source,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        output, error = await asyncio.wait_for(child.communicate(), 5)
        assert child.returncode == 0, error.decode()
        assert json.loads(output)["id"] == py_id
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
    assert (await b.get_stream_info(name)).lag == 0


async def test_storage_token_expiry_tail_cutoff_and_age_retention(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    await a.configure_stream("orders", 2)
    first = await a.publish("orders", message(1))
    await a._partitions.ensure_group("orders", "raw", True)
    claimed = await a._partitions.claim("orders", "raw", 80, "first-owner")
    assert claimed[0][0] == first
    old_token = claimed[0][2]
    await asyncio.sleep(0.1)
    replacement = await b._partitions.claim("orders", "raw", 250, "replacement")
    assert replacement[0][0] == first and replacement[0][2] != old_token
    assert not await a._partitions.renew("orders", "raw", "0", first, old_token, 250)
    assert not await a._partitions.settle("orders", "raw", "0", first, old_token, False)
    assert await b._partitions.settle("orders", "raw", "0", first, replacement[0][2], False)
    await a._partitions.ensure_group("orders", "tail", False)
    assert await b._partitions.claim("orders", "tail", 250, "tail-empty") == []
    second = await b.publish("orders", message(2, 1))
    assert (await a._partitions.claim("orders", "tail", 250, "tail-next"))[0][0] == second
    await asyncio.sleep(0.03)
    assert await b.trim_stream("orders", TrimStrategy(max_age_seconds=0.01)) == 2
    assert await a.get_stream_messages("orders") == []
    assert (await a.get_stream_info("orders")).lag == 0


async def test_preexisting_unversioned_stream_and_group_require_migration(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    await a.client.xadd(a._stream("old-rows"), {"payload": message(1).model_dump_json()})
    with pytest.raises(ResponseError, match="migration"):
        await b.configure_stream("old-rows", 2)
    await a.client.xgroup_create(a._stream("old-group"), "legacy", mkstream=True)
    with pytest.raises(ResponseError, match="migration"):
        await b.configure_stream("old-group", 2)
    await a.client.set(a._partitions.policy("invalid"), "sha256-utf8-u32be-v1:01")
    with pytest.raises(ValueError, match="policy"):
        await b.configure_stream("invalid")


async def test_adapter_close_joins_callback_and_releases_owned_receipt_immediately(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    await a.configure_stream("orders", 1)
    identity = await a.publish("orders", message(1))
    entered, cancelled = asyncio.Event(), asyncio.Event()
    captured: list[Message] = []

    async def hold(item: Message) -> None:
        captured.append(item)
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    await a.consume(
        "orders",
        "workers",
        "held",
        hold,
        ConsumerOptions(
            group_id="workers", from_beginning=True, max_in_flight=1, visibility_timeout=5000
        ),
    )
    await asyncio.wait_for(entered.wait(), 3)
    await a.cleanup()
    assert cancelled.is_set()
    claimed = await b._partitions.claim("orders", "workers", 5000, "after-close")
    assert claimed and claimed[0][0] == identity
    with pytest.raises(RuntimeError, match="ownership"):
        await captured[0].ack()
    with pytest.raises(RuntimeError, match="closed"):
        await a.configure_stream("orders")


async def test_legacy_retention_removes_pending_unread_and_fences_callback(
    pair: tuple[RedisAdapter, RedisAdapter], redis_url: str,
) -> None:
    a, b = pair
    received: asyncio.Queue[Message] = asyncio.Queue()
    cancelled = asyncio.Event()

    async def hold(message: Message) -> None:
        received.put_nowait(message)
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    await a.publish('legacy-retention', Message(id='held', stream='legacy-retention', data='held', timestamp=0))
    await a.publish('legacy-retention', Message(id='unread', stream='legacy-retention', data='unread', timestamp=0))
    subscription = await a.consume('legacy-retention', 'group', 'first', hold, ConsumerOptions(
        group_id='group', from_beginning=True, max_in_flight=1, auto_commit=False,
    ))
    held = await asyncio.wait_for(received.get(), 1)
    assert await b.trim_stream('legacy-retention', TrimStrategy(max_length=0)) == 2
    assert (await b.get_stream_info('legacy-retention')).length == 0
    assert await b.get_stream_messages('legacy-retention') == []
    await asyncio.wait_for(cancelled.wait(), 1)
    await subscription.unsubscribe()
    for requeue in (False, True):
        with pytest.raises(RuntimeError, match='ownership changed'):
            if requeue:
                await held.nack(True)
            else:
                await held.ack()
    execute: Callable[..., Awaitable[Any]] = a.client.execute_command
    assert not await execute('HGETALL', subscription._owners_key)
    # A separately reopened owner must not replay deleted pending or unread data.
    reopened = RedisAdapter(redis_url, namespace=a.namespace, reclaim_after_ms=100)
    try:
        resumed = await reopened.consume('legacy-retention', 'group', 'reopened', hold, ConsumerOptions(
            group_id='group', from_beginning=True, max_in_flight=1,
        ))
        await asyncio.sleep(.12)
        assert received.empty()
        assert await reopened.get_stream_messages('legacy-retention') == []
        await resumed.unsubscribe()
    finally:
        await reopened.cleanup()


async def test_legacy_retention_fractional_age_uses_redis_clock(
    pair: tuple[RedisAdapter, RedisAdapter],
) -> None:
    a, b = pair
    key = a._stream('legacy-age')
    seconds, micros = await a.client.time()
    now = seconds * 1000 + micros // 1000
    await a.client.xadd(key, {'payload': Message(id='old', stream='legacy-age', data=1, timestamp=0).model_dump_json()}, id=f'{now - 1000}-0')
    await a.client.xadd(key, {'payload': Message(id='fresh', stream='legacy-age', data=2, timestamp=0).model_dump_json()})
    await a.client.xgroup_create(key, 'unread', id='0-0')
    assert await b.trim_stream('legacy-age', TrimStrategy(max_age_seconds=.5)) == 1
    assert [message.data for message in await b.get_stream_messages('legacy-age')] == [2]
    assert await b.trim_stream('legacy-age', TrimStrategy(max_length=0)) == 1
    assert await b.trim_stream('missing', TrimStrategy(max_length=0)) == 0
