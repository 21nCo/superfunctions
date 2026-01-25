# MemoryFn Python SDK

> Self-hostable AI memory system for agents and applications

## Installation

```bash
pip install memoryfn
```

## Usage

```python
import asyncio
from memoryfn import MemoryFn, Config

async def main():
    memory = MemoryFn(Config(
        storage_url="postgresql://user:pass@localhost:5432/memoryfn",
        openai_api_key="sk-..."
    ))

    # Add memory
    await memory.add(
        content="User prefers dark mode",
        container_tags=["user:alice"],
        type="profile_static"
    )

    # Search
    results = await memory.search(
        q="preferences",
        container_tags=["user:alice"]
    )
    
    print(results)

if __name__ == "__main__":
    asyncio.run(main())
```
