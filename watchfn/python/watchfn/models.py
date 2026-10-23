from datetime import datetime
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field

class WatchFnConfig(BaseModel):
    name: str
    project_id: Optional[str] = None
    storage: str = "memory"
    apm_enabled: bool = True
    errors_enabled: bool = True
    trace_enabled: bool = True

class Event(BaseModel):
    type: str
    name: Optional[str] = None
    properties: Dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    context: Dict[str, Any] = Field(default_factory=dict)
