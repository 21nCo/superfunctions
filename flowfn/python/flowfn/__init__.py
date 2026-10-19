"""
FlowFn - Distributed job queues, event streams, and workflow orchestration for Python.
"""

from flowfn.core.flow import FlowFn, create_flow, FlowFnConfig

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("flowfn")
except PackageNotFoundError:
    __version__ = "0+unknown"
__all__ = ["FlowFn", "create_flow", "FlowFnConfig"]
