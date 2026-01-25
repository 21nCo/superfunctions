"""Main SecFn class for creating security modules."""

from typing import Dict, List, Optional

from .access_control import AccessControl, AccessControlConfig
from .monitoring import MonitoringConfig, SecurityMonitor
from .rate_limiting import RateLimiter, RateLimiterConfig
from .scanning import SecretScanner, SecretScannerConfig
from .secrets import SecretsVault, SecretsVaultConfig
from .storage.file_storage import FileStorage
from .types import RateLimitRule


class SecFnConfig:
    """Configuration for SecFn."""

    def __init__(
        self,
        master_key: Optional[str] = None,
        storage_path: str = ".secfn",
    ):
        """Initialize SecFn config.
        
        Args:
            master_key: Master key for encryption (required for secrets vault)
            storage_path: Path for file storage
        """
        self.master_key = master_key
        self.storage_path = storage_path


class SecFn:
    """Main SecFn class for creating security modules."""

    def __init__(self, config: Optional[SecFnConfig] = None):
        """Initialize SecFn.
        
        Args:
            config: SecFn configuration
        """
        self.config = config or SecFnConfig()
        self.storage = FileStorage(self.config.storage_path)

    def create_secrets_vault(
        self,
        master_key: Optional[str] = None,
        rotation_check_interval: Optional[int] = None,
        rotation_notify_before: Optional[int] = None,
    ) -> SecretsVault:
        """Create a secrets vault instance.
        
        Args:
            master_key: Master encryption key (uses config if not provided)
            rotation_check_interval: Rotation check interval (ms)
            rotation_notify_before: Rotation notification threshold (ms)
            
        Returns:
            SecretsVault instance
            
        Raises:
            ValueError: If no master key provided
        """
        key = master_key or self.config.master_key
        if not key:
            raise ValueError("Master key is required for secrets vault")

        vault_config = SecretsVaultConfig(
            storage=self.storage,
            master_key=key,
            rotation_check_interval=rotation_check_interval,
            rotation_notify_before=rotation_notify_before,
        )

        return SecretsVault(vault_config)

    def create_access_control(
        self,
        cache_ttl: int = 300000,
        cache_max_size: int = 1000,
    ) -> AccessControl:
        """Create an access control instance.
        
        Args:
            cache_ttl: Cache TTL in milliseconds
            cache_max_size: Maximum cache size
            
        Returns:
            AccessControl instance
        """
        ac_config = AccessControlConfig(
            storage=self.storage,
            cache_ttl=cache_ttl,
            cache_max_size=cache_max_size,
        )

        return AccessControl(ac_config)

    def create_rate_limiter(
        self,
        rules: Dict[str, RateLimitRule],
        on_limit_exceeded: Optional[callable] = None,
    ) -> RateLimiter:
        """Create a rate limiter instance.
        
        Args:
            rules: Rate limit rules
            on_limit_exceeded: Callback for violations
            
        Returns:
            RateLimiter instance
        """
        limiter_config = RateLimiterConfig(
            storage=self.storage,
            rules=rules,
            on_limit_exceeded=on_limit_exceeded,
        )

        return RateLimiter(limiter_config)

    def create_monitoring(
        self,
        retention: Optional[int] = None,
        anomaly_detection_enabled: bool = False,
        anomaly_sensitivity: float = 0.8,
    ) -> SecurityMonitor:
        """Create a security monitor instance.
        
        Args:
            retention: Event retention period (ms)
            anomaly_detection_enabled: Enable anomaly detection
            anomaly_sensitivity: Anomaly sensitivity (0-1)
            
        Returns:
            SecurityMonitor instance
        """
        monitor_config = MonitoringConfig(
            storage=self.storage,
            retention=retention,
            anomaly_detection_enabled=anomaly_detection_enabled,
            anomaly_sensitivity=anomaly_sensitivity,
        )

        return SecurityMonitor(monitor_config)

    def create_secret_scanner(
        self,
        patterns: Optional[List] = None,
        exclude_paths: Optional[List[str]] = None,
        min_entropy: float = 3.5,
        max_file_size: int = 1024 * 1024,
    ) -> SecretScanner:
        """Create a secret scanner instance.
        
        Args:
            patterns: Secret patterns to use
            exclude_paths: Paths to exclude
            min_entropy: Minimum entropy threshold
            max_file_size: Maximum file size (bytes)
            
        Returns:
            SecretScanner instance
        """
        scanner_config = SecretScannerConfig(
            storage=self.storage,
            patterns=patterns,
            exclude_paths=exclude_paths,
            min_entropy=min_entropy,
            max_file_size=max_file_size,
        )

        return SecretScanner(scanner_config)


def create_secfn(config: Optional[SecFnConfig] = None) -> SecFn:
    """Create a SecFn instance.
    
    Args:
        config: SecFn configuration
        
    Returns:
        SecFn instance
    """
    return SecFn(config)
