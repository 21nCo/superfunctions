"""Namespace management utilities."""

from typing import Optional

from .types import NamespaceConfig


class NamespaceManager:
    """Manages table namespacing for multi-tenant schemas."""

    def __init__(self, config: Optional[NamespaceConfig] = None):
        """Initialize namespace manager."""
        self.config = config or NamespaceConfig()
        self._known_namespaces = set(self.config.known_namespaces or [])

    def get_table_name(self, model: str, namespace: Optional[str] = None) -> str:
        """Get the namespaced table name."""
        ns = namespace or self.config.default_namespace
        self._known_namespaces.add(ns)

        if self.config.use_schema:
            return f"{ns}.{model}"
        else:
            if ns == self.config.default_namespace:
                return model
            return f"{ns}{self.config.separator}{model}"

    def parse_table_name(self, table_name: str) -> tuple[str, str]:
        """Parse a namespaced table name into namespace and model."""
        if self.config.use_schema:
            if "." in table_name:
                ns, model = table_name.split(".", 1)
                return ns, model
            return self.config.default_namespace, table_name
        else:
            if self.config.separator in table_name:
                candidate_namespace, model = table_name.split(self.config.separator, 1)
                if candidate_namespace in self._known_namespaces:
                    return candidate_namespace, model
            return self.config.default_namespace, table_name

    def get_schema(self, namespace: Optional[str] = None) -> Optional[str]:
        """Get the database schema name for a namespace."""
        if not self.config.use_schema:
            return None
        return namespace or self.config.default_namespace


def create_namespace_manager(
    separator: str = "_",
    use_schema: bool = False,
    default_namespace: str = "default",
    known_namespaces: Optional[set[str]] = None,
) -> NamespaceManager:
    """Create a namespace manager with the given configuration."""
    config = NamespaceConfig(
        separator=separator,
        use_schema=use_schema,
        default_namespace=default_namespace,
        known_namespaces=known_namespaces,
    )
    return NamespaceManager(config)
