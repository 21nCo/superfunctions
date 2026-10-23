from uuid import uuid4
from datetime import datetime
from typing import Any, Dict, List, Optional, Union, Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator, PrivateAttr

class HttpAuthConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, arbitrary_types_allowed=True)
    enabled: Optional[bool] = Field(None, strict=True)
    api_key: Optional[str] = Field(None, alias="apiKey", strict=True)
    provider: Any = None

    @model_validator(mode="after")
    def validate_configuration(self):
        if self.provider is not None and not callable(getattr(self.provider, "authenticate", None)):
            raise ValueError("Invalid auth provider")
        if self.api_key is not None and not self.api_key.strip():
            raise ValueError("API key must not be empty")
        if self.enabled is False and (self.provider is not None or self.api_key is not None):
            raise ValueError("Configured authentication cannot be disabled")
        if self.enabled is True and self.provider is None and self.api_key is None:
            raise ValueError("Enabled authentication requires credentials")
        return self


class WatchFnConfig(BaseModel):
    name: str
    auth: Optional[HttpAuthConfig] = None
    project_id: Optional[str] = None
    storage: Literal["memory", "database"] = "memory"
    apm_enabled: bool = True
    errors_enabled: bool = True
    trace_enabled: bool = True

class Event(BaseModel):
    _storage_id: str = PrivateAttr(default_factory=lambda: str(uuid4()))
    _storage_payload: Optional[str] = PrivateAttr(default=None)
    type: str
    name: Optional[str] = None
    properties: Dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    context: Dict[str, Any] = Field(default_factory=dict)
