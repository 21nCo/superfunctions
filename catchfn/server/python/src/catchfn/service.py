from typing import List, Optional
from datetime import datetime
from superfunctions.db import Adapter, CreateParams, FindManyParams, WhereClause, Operator
from .types import BugReportEvent

class CatchFnService:
    def __init__(self, db: Adapter, table_name: str = "catchfn_bugs"):
        self.db = db
        self.table_name = table_name

    async def create_bug(self, report: BugReportEvent) -> BugReportEvent:
        # report.receivedAt = datetime.now().timestamp() * 1000
        data = report.model_dump()
        data['receivedAt'] = datetime.now().timestamp() * 1000
        
        # Depending on the DB adapter, complex types (lists, dicts) might need JSON serialization
        # Assuming the adapter handles it or we are using a document store
        
        await self.db.create(
            CreateParams(
                model=self.table_name,
                data=data
            )
        )
        return report

    async def get_bug(self, bug_id: str) -> Optional[BugReportEvent]:
        result = await self.db.find_one(
            model=self.table_name,
            where=[WhereClause(field="id", operator=Operator.EQ, value=bug_id)]
        )
        if result:
            return BugReportEvent(**result)
        return None

    async def list_bugs(self, limit: int = 50, offset: int = 0) -> List[BugReportEvent]:
        results = await self.db.find_many(
            FindManyParams(
                model=self.table_name,
                limit=limit,
                offset=offset,
                order_by={"timestamp": "desc"}
            )
        )
        return [BugReportEvent(**r) for r in results]
