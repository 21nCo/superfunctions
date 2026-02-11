from superfunctions.http import create_router, Request, RouteContext, Response
from .service import CatchFnService
from .types import BugReportEvent

def create_catchfn_router(service: CatchFnService):
    async def create_bug(req: Request, ctx: RouteContext) -> Response:
        try:
            data = await ctx.json()
            report = BugReportEvent(**data)
            await service.create_bug(report)
            return Response.json(report.model_dump(), status=201)
        except Exception as e:
            # In production, proper error handling
            print(f"Error creating bug: {e}")
            return Response.json({"error": str(e)}, status=400)

    async def get_bug(req: Request, ctx: RouteContext) -> Response:
        bug_id = ctx.params.get("id")
        bug = await service.get_bug(bug_id)
        if not bug:
            return Response.json({"error": "Bug not found"}, status=404)
        return Response.json(bug.model_dump())

    async def list_bugs(req: Request, ctx: RouteContext) -> Response:
        limit = int(ctx.query.get("limit", 50))
        offset = int(ctx.query.get("offset", 0))
        bugs = await service.list_bugs(limit, offset)
        return Response.json([b.model_dump() for b in bugs])

    return create_router(
        routes=[
            {
                "method": "POST",
                "path": "/bugs",
                "handler": create_bug
            },
            {
                "method": "GET",
                "path": "/bugs/:id",
                "handler": get_bug
            },
            {
                "method": "GET",
                "path": "/bugs",
                "handler": list_bugs
            }
        ]
    )
