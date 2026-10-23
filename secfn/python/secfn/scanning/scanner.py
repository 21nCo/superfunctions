"""Secret scanner for detecting hardcoded secrets in code."""

import os
import re
import time
from pathlib import Path
from typing import List, Optional

from ..storage.file_storage import FileStorage
from ..types import SecretPattern, SecretScanResult
from ..utils.helpers import calculate_entropy, generate_id, redact_secret
from .patterns import DEFAULT_PATTERNS


class SecretScannerConfig:
    """Configuration for secret scanner."""

    def __init__(
        self,
        storage: FileStorage,
        patterns: Optional[List[SecretPattern]] = None,
        exclude_paths: Optional[List[str]] = None,
        min_entropy: float = 3.5,
        max_file_size: int = 1024 * 1024,  # 1MB
    ):
        """Initialize scanner config.
        
        Args:
            storage: Storage backend
            patterns: Secret patterns to use (defaults to DEFAULT_PATTERNS)
            exclude_paths: Paths to exclude from scanning
            min_entropy: Minimum entropy for matches
            max_file_size: Maximum file size to scan (bytes)
        """
        self.storage = storage
        self.patterns = patterns or DEFAULT_PATTERNS
        self.exclude_paths = exclude_paths or []
        self.min_entropy = min_entropy
        self.max_file_size = max_file_size


class SecretScanner:
    """Scanner for detecting hardcoded secrets in files."""

    def __init__(self, config: SecretScannerConfig):
        """Initialize secret scanner.
        
        Args:
            config: Scanner configuration
        """
        self.storage = config.storage
        self.patterns = config.patterns
        self.exclude_paths = config.exclude_paths
        self.min_entropy = config.min_entropy
        self.max_file_size = config.max_file_size

        # Compile regex patterns
        self.compiled_patterns = [
            (p, re.compile(p.pattern)) for p in self.patterns
        ]

    async def scan_file(self, file_path: str) -> List[SecretScanResult]:
        """Scan a single file for secrets.
        
        Args:
            file_path: Path to file to scan
            
        Returns:
            List of scan results
        """
        results = []
        path = Path(file_path)

        # Check file size
        if path.stat().st_size > self.max_file_size:
            return results

        # Read file content
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except Exception:
            return results

        # Scan with each pattern
        for pattern_def, compiled_pattern in self.compiled_patterns:
            matches = compiled_pattern.finditer(content)

            for match in matches:
                match_text = match.group(0)

                # Calculate entropy
                entropy = calculate_entropy(match_text)

                # Check minimum entropy if specified
                if pattern_def.entropy and entropy < self.min_entropy:
                    continue

                # Get line and column
                line_num = content[: match.start()].count("\n") + 1
                col_num = match.start() - content[: match.start()].rfind("\n")

                # Extract context (surrounding lines)
                context = self._extract_context(content, line_num)

                result = SecretScanResult(
                    id=generate_id("scan"),
                    timestamp=int(time.time() * 1000),
                    file=str(path),
                    line=line_num,
                    column=col_num,
                    pattern=pattern_def.name,
                    match=match_text,
                    redactedMatch=redact_secret(match_text),
                    severity=pattern_def.severity,
                    entropy=entropy,
                    context=context,
                    resolved=False,
                    falsePositive=False,
                )

                results.append(result)

        return results

    async def scan_directory(
        self, directory: str, recursive: bool = True
    ) -> List[SecretScanResult]:
        """Scan a directory for secrets.
        
        Args:
            directory: Directory path to scan
            recursive: Whether to scan recursively
            
        Returns:
            List of all scan results
        """
        results = []
        dir_path = Path(directory)

        if not dir_path.is_dir():
            return results

        # Get all files
        if recursive:
            files = dir_path.rglob("*")
        else:
            files = dir_path.glob("*")

        for file_path in files:
            if not file_path.is_file():
                continue

            # Check if excluded
            if self._is_excluded(str(file_path)):
                continue

            # Scan file
            file_results = await self.scan_file(str(file_path))
            results.extend(file_results)

        return results

    def _extract_context(self, content: str, line_num: int, context_lines: int = 2) -> str:
        """Extract context around a line.
        
        Args:
            content: File content
            line_num: Line number (1-indexed)
            context_lines: Number of lines before/after to include
            
        Returns:
            Context string
        """
        lines = content.split("\n")
        start = max(0, line_num - context_lines - 1)
        end = min(len(lines), line_num + context_lines)

        context_lines_list = lines[start:end]
        return "\n".join(context_lines_list)

    def _is_excluded(self, path: str) -> bool:
        """Check if path should be excluded.
        
        Args:
            path: File path
            
        Returns:
            True if excluded
        """
        for exclude_pattern in self.exclude_paths:
            if exclude_pattern in path:
                return True

            # Simple glob-like matching
            if "*" in exclude_pattern:
                pattern = exclude_pattern.replace("*", ".*")
                if re.match(pattern, path):
                    return True

        return False
