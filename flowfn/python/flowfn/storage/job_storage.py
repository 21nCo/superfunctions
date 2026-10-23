"""Job storage abstraction."""

from typing import Optional, Protocol
from flowfn.queue.types import Job, JobStatus
from dataclasses import dataclass, field


@dataclass
class ListOptions:
    """List query options."""
    status: Optional[JobStatus] = None
    limit: int = 100
    offset: int = 0


@dataclass  
class CleanupOptions:
    """Cleanup options."""
    older_than: int  # Timestamp in ms
    status: Optional[JobStatus] = None


class JobStorage(Protocol):
    """Job storage interface."""
    
    async def save(self, job: Job) -> None:
        """Save a job."""
        ...
    
    async def get(self, job_id: str) -> Optional[Job]:
        """Get a job by ID."""
        ...
    
    async def list(self, opts: Optional[ListOptions] = None) -> list[Job]:
        """List jobs with filtering."""
        ...
    
    async def delete(self, job_id: str) -> None:
        """Delete a job."""
        ...
    
    async def cleanup(self, opts: CleanupOptions) -> int:
        """Cleanup old jobs."""
        ...


class MemoryJobStorage:
    """In-memory job storage."""
    
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
    
    async def save(self, job: Job) -> None:
        """Save a job."""
        self._jobs[job.id] = job
    
    async def get(self, job_id: str) -> Optional[Job]:
        """Get a job by ID."""
        return self._jobs.get(job_id)
    
    async def list(self, opts: Optional[ListOptions] = None) -> list[Job]:
        """List jobs with filtering."""
        options = opts or ListOptions()
        
        jobs = list(self._jobs.values())
        
        # Filter by status
        if options.status:
            jobs = [j for j in jobs if j.state == options.status]
        
        # Sort by timestamp
        jobs.sort(key=lambda j: j.timestamp, reverse=True)
        
        # Apply pagination
        start = options.offset
        end = start + options.limit
        return jobs[start:end]
    
    async def delete(self, job_id: str) -> None:
        """Delete a job."""
        self._jobs.pop(job_id, None)
    
    async def cleanup(self, opts: CleanupOptions) -> int:
        """Cleanup old jobs."""
        to_delete = []
        
        for job_id, job in self._jobs.items():
            # Check age
            if job.timestamp < opts.older_than:
                # Check status filter
                if opts.status is None or job.state == opts.status:
                    to_delete.append(job_id)
        
        for job_id in to_delete:
            del self._jobs[job_id]
        
        return len(to_delete)
    
    def clear(self) -> None:
        """Clear all jobs."""
        self._jobs.clear()
