"""HTTP API package for sendfn.

This package provides HTTP API endpoints using superfunctions.http abstractions.
Routes are framework-agnostic and can be used with any HTTP framework via adapters.
"""

from .fastapi import create_sendfn_router
from .routes import create_sendfn_routes

__all__ = ["create_sendfn_routes", "create_sendfn_router"]
