"""Time-series database for metric storage."""

from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass
import time
import gzip
import json


@dataclass
class TimeSeriesPoint:
    timestamp: float
    value: float
    tags: Optional[Dict[str, str]] = None


@dataclass
class TimeSeriesMetadata:
    metric: str
    interval: str
    aggregation: str
    first_timestamp: float
    last_timestamp: float
    count: int
    compressed: bool


@dataclass
class TimeSeriesBucket:
    metadata: TimeSeriesMetadata
    points: List[TimeSeriesPoint]
    compressed_data: Optional[bytes] = None


class TimeSeriesDatabase:
    """Time-series database with compression and efficient querying."""
    
    def __init__(
        self,
        compression_enabled: bool = True,
        compression_threshold: int = 100
    ):
        self.buckets: Dict[str, TimeSeriesBucket] = {}
        self.compression_enabled = compression_enabled
        self.compression_threshold = compression_threshold
    
    async def write(self, metric: str, point: TimeSeriesPoint) -> None:
        """Write a time series point."""
        key = self._get_bucket_key(metric, point.timestamp, point.tags)
        
        if key not in self.buckets:
            self.buckets[key] = TimeSeriesBucket(
                metadata=TimeSeriesMetadata(
                    metric=metric,
                    interval=self._get_interval(point.timestamp),
                    aggregation="raw",
                    first_timestamp=point.timestamp,
                    last_timestamp=point.timestamp,
                    count=0,
                    compressed=False
                ),
                points=[]
            )
        
        bucket = self.buckets[key]
        
        # Decompress if needed
        if bucket.metadata.compressed and bucket.compressed_data:
            bucket.points = self._decompress(bucket.compressed_data)
            bucket.metadata.compressed = False
            bucket.compressed_data = None
        
        bucket.points.append(point)
        bucket.metadata.last_timestamp = point.timestamp
        bucket.metadata.count += 1
        
        # Compress if threshold reached
        if self.compression_enabled and len(bucket.points) >= self.compression_threshold:
            await self._compress_bucket(bucket)
    
    async def read(
        self,
        metric: str,
        from_time: float,
        to_time: float,
        tags: Optional[Dict[str, str]] = None
    ) -> List[TimeSeriesPoint]:
        """Read time series data for a time range."""
        results: List[TimeSeriesPoint] = []
        
        for bucket in self.buckets.values():
            if not self._matches_bucket(bucket, metric, from_time, to_time, tags):
                continue
            
            points = bucket.points
            if bucket.metadata.compressed and bucket.compressed_data:
                points = self._decompress(bucket.compressed_data)
            
            for point in points:
                if from_time <= point.timestamp <= to_time:
                    results.append(point)
        
        return sorted(results, key=lambda p: p.timestamp)
    
    async def prune(self, retention_ms: float) -> int:
        """Delete old data based on retention."""
        cutoff = time.time() * 1000 - retention_ms
        deleted = 0
        
        for key in list(self.buckets.keys()):
            bucket = self.buckets[key]
            
            if bucket.metadata.last_timestamp < cutoff:
                del self.buckets[key]
                deleted += 1
            elif bucket.metadata.first_timestamp < cutoff:
                # Partial bucket deletion
                points = bucket.points
                if bucket.metadata.compressed and bucket.compressed_data:
                    points = self._decompress(bucket.compressed_data)
                
                filtered = [p for p in points if p.timestamp >= cutoff]
                bucket.points = filtered
                bucket.metadata.count = len(filtered)
                if filtered:
                    bucket.metadata.first_timestamp = filtered[0].timestamp
                
                if bucket.metadata.compressed:
                    await self._compress_bucket(bucket)
        
        return deleted
    
    def get_stats(self) -> Dict[str, int]:
        """Get storage statistics."""
        total_points = 0
        compressed_buckets = 0
        uncompressed_buckets = 0
        
        for bucket in self.buckets.values():
            total_points += bucket.metadata.count
            if bucket.metadata.compressed:
                compressed_buckets += 1
            else:
                uncompressed_buckets += 1
        
        return {
            "buckets": len(self.buckets),
            "total_points": total_points,
            "compressed_buckets": compressed_buckets,
            "uncompressed_buckets": uncompressed_buckets,
        }
    
    async def _compress_bucket(self, bucket: TimeSeriesBucket) -> None:
        """Compress bucket data."""
        data = json.dumps([vars(p) for p in bucket.points]).encode('utf-8')
        bucket.compressed_data = gzip.compress(data)
        bucket.points = []
        bucket.metadata.compressed = True
    
    def _decompress(self, compressed_data: bytes) -> List[TimeSeriesPoint]:
        """Decompress bucket data."""
        data = gzip.decompress(compressed_data).decode('utf-8')
        points_data = json.loads(data)
        return [TimeSeriesPoint(**p) for p in points_data]
    
    def _matches_bucket(
        self,
        bucket: TimeSeriesBucket,
        metric: str,
        from_time: float,
        to_time: float,
        tags: Optional[Dict[str, str]]
    ) -> bool:
        """Check if bucket matches query criteria."""
        if bucket.metadata.metric != metric:
            return False
        
        if bucket.metadata.last_timestamp < from_time or bucket.metadata.first_timestamp > to_time:
            return False
        
        if tags and bucket.points:
            first_point_tags = bucket.points[0].tags or {}
            for key, value in tags.items():
                if first_point_tags.get(key) != value:
                    return False
        
        return True
    
    def _get_bucket_key(
        self,
        metric: str,
        timestamp: float,
        tags: Optional[Dict[str, str]]
    ) -> str:
        """Get bucket key for metric, timestamp, and tags."""
        interval = self._get_interval(timestamp)
        tag_str = json.dumps(tags, sort_keys=True) if tags else ""
        return f"{metric}:{interval}:{tag_str}"
    
    def _get_interval(self, timestamp: float) -> str:
        """Get interval bucket for timestamp (bucket by hour)."""
        hour = int(timestamp / (60 * 60 * 1000)) * (60 * 60 * 1000)
        return str(hour)
