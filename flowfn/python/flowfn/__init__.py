"""
FlowFn - Distributed job queues, event streams, and workflow orchestration for Python.
"""

from importlib.metadata import PackageNotFoundError, version

from flowfn.core.flow import FlowFn, FlowFnConfig, create_flow

try:
    __version__ = version("flowfn")
except PackageNotFoundError:
    __version__ = "0+unknown"
__all__ = ["FlowFn", "create_flow", "FlowFnConfig"]
