# logfn-python

Structured logging for Python with pluggable pipelines and transports.

## Features

- **Structured Logging**: JSON-based log events with consistent schema
- **Log Levels**: trace, debug, info, warn, error, fatal
- **Child Loggers**: Create scoped loggers with inherited context
- **Pipeline Stages**: Pluggable event processing (redaction, enrichment, sampling)
- **Multiple Sinks**: Console (pretty/JSON), HTTP (batched with retry)
- **Type Hints**: Fully typed with Python type hints

## Installation

```bash
pip install logfn
```

## Quick Start

```python
from logfn import dev_logger

logger = dev_logger("my-app")

logger.info("Application started", version="1.0.0")
logger.warn("Deprecated API used", api="/old-endpoint")
logger.error("Request failed", status_code=500, path="/api/users")
```

## Basic Usage

### Creating a Logger

```python
from logfn import create_logger, SinkConsole

logger = create_logger(
    name="my-service",
    level="info",
    sinks=[SinkConsole(json=True)],
)

logger.info("User logged in", user_id="123", email="user@example.com")
```
