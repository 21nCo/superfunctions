"""Called by the TypeScript acceptance script against its closed SQLite database."""
import asyncio
import json
import sys
from pathlib import Path

from sqlalchemy import create_engine
from superfunctions_sqlalchemy import SQLAlchemyAdapter

from catchfn import BugReportEvent, CatchFnService


async def main():
    expected_path = Path(sys.argv[2])
    expected = json.loads(expected_path.read_text())
    engine = create_engine("sqlite:///" + sys.argv[1])
    try:
        service = CatchFnService(SQLAlchemyAdapter(engine), app="shop", now=lambda: 0)
        value = await service.get_bug("typescript")
        assert value is not None
        assert value.model_dump(mode="json", exclude_none=True) == expected
        assert (await service.create_bug(value)).model_dump(mode="json", exclude_none=True) == expected
        assert [row.id for row in await service.list_bugs(tags=["ui_%"])] == ["typescript"]
        assert await service.list_bugs(tags=["ui"]) == []
        other = CatchFnService(SQLAlchemyAdapter(engine), app="other")
        assert await other.get_bug("typescript") is None
        payload = {**expected, "id": "python", "timestamp": 2345.5}
        saved = await service.create_bug(BugReportEvent.model_validate(payload))
        expected_path.with_suffix(".json.python").write_text(
            json.dumps(saved.model_dump(mode="json", exclude_none=True), ensure_ascii=False)
        )
    finally:
        engine.dispose()
    print("Python read and idempotently accepted TypeScript payload, then persisted canonical Python payload")


if __name__ == "__main__":
    asyncio.run(main())
