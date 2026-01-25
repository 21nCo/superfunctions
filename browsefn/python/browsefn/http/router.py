"""BrowseFn HTTP Router."""

from typing import List, Any
from superfunctions.http import Route, HttpMethod, Response, Request

def create_browsefn_router(browse_fn: Any) -> List[Route]:
    """Create a list of generic routes for BrowseFn.
    
    Args:
        browse_fn: BrowseFn instance
        
    Returns:
        List of Route objects
    """
    
    async def get_page(request: Request, context: Any) -> Response:
        try:
            body = await request.json()
            url = body.get("url")
            options = body.get("options", {})

            if not url:
                return Response(status=400, body={"error": "Missing url"})

            page = await browse_fn.web.get_page(url, options)
            
            # Handle screenshot bytes - similar logic to TS/previous implementation
            if hasattr(page, "screenshot") and isinstance(page.screenshot, bytes):
                # Basic handling/conversion could go here
                pass

            return Response(status=200, body={"success": True, "page": page})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})

    async def get_multiple_metadata(request: Request, context: Any) -> Response:
        try:
            body = await request.json()
            urls = body.get("urls")
            options = body.get("options", {})

            if not urls or not isinstance(urls, list):
                return Response(status=400, body={"error": "Missing or invalid urls array"})

            results = await browse_fn.web.get_multiple_metadata(urls, options)
            return Response(status=200, body={"success": True, "results": results})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})

    async def search_images(request: Request, context: Any) -> Response:
        try:
            q = context.query.get("q")
            if not q:
                return Response(status=400, body={"error": "Missing q (query) parameter"})

            # context.query is dict-like
            options = {
                "provider": context.query.get("provider"),
                "page": int(context.query.get("page")) if context.query.get("page") else None,
                "perPage": int(context.query.get("perPage")) if context.query.get("perPage") else None,
                "orientation": context.query.get("orientation"),
                "color": context.query.get("color"),
                "orderBy": context.query.get("orderBy"),
            }
            # Filter None
            options = {k: v for k, v in options.items() if v is not None}

            result = await browse_fn.images.search(q, options)
            return Response(status=200, body={"success": True, "result": result})
        except Exception as e:
             return Response(status=500, body={"error": str(e)})

    async def download_image(request: Request, context: Any) -> Response:
        try:
            body = await request.json()
            url = body.get("url")
            options = body.get("options", {})

            if not url:
                return Response(status=400, body={"error": "Missing url"})

            result = await browse_fn.images.download(url, options)
            return Response(status=200, body={"success": True, "result": result})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})

    async def reverse_geocode(request: Request, context: Any) -> Response:
        try:
            lat_str = context.query.get("lat")
            lng_str = context.query.get("lng")
            provider = context.query.get("provider")

            if not lat_str or not lng_str:
                 return Response(status=400, body={"error": "Invalid lat/lng parameters"})

            lat = float(lat_str)
            lng = float(lng_str)

            result = await browse_fn.geo.reverse_geocode(
                {"lat": lat, "lng": lng}, provider
            )
            return Response(status=200, body={"success": True, "result": result})
        except ValueError:
             return Response(status=400, body={"error": "Invalid lat/lng parameters"})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})

    async def geocode(request: Request, context: Any) -> Response:
        try:
            address = context.query.get("address")
            if not address:
                return Response(status=400, body={"error": "Missing address parameter"})

            provider = context.query.get("provider")
            limit = int(context.query.get("limit")) if context.query.get("limit") else None

            results = await browse_fn.geo.geocode(address, {"provider": provider, "limit": limit})
            return Response(status=200, body={"success": True, "results": results})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})

    async def geo_search(request: Request, context: Any) -> Response:
        try:
            q = context.query.get("q")
            if not q:
               return Response(status=400, body={"error": "Missing q (query) parameter"})

            lat_str = context.query.get("lat")
            lng_str = context.query.get("lng")
            radius = float(context.query.get("radius")) if context.query.get("radius") else None
            provider = context.query.get("provider")
            limit = int(context.query.get("limit")) if context.query.get("limit") else None

            options = {
                "query": q,
                "provider": provider,
                "radius": radius,
                "limit": limit,
            }
            
            if lat_str and lng_str:
                options["center"] = {"lat": float(lat_str), "lng": float(lng_str)}

            results = await browse_fn.geo.search(options)
            return Response(status=200, body={"success": True, "results": results})
        except ValueError: # float conversion error
             return Response(status=400, body={"error": "Invalid numerical parameters"})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})

    async def get_place_details(request: Request, context: Any) -> Response:
        try:
            place_id = context.params.get("place_id") # extracted from path /geo/places/:place_id
            provider = context.query.get("provider")
            fields_str = context.query.get("fields")
            fields_list = fields_str.split(",") if fields_str else None

            result = await browse_fn.geo.get_place_details(
                place_id, {"provider": provider, "fields": fields_list}
            )
            return Response(status=200, body={"success": True, "result": result})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})

    async def get_metrics(request: Request, context: Any) -> Response:
        try:
            time_range = context.query.get("timeRange")
            group_by = context.query.get("groupBy")

            metrics = await browse_fn.get_metrics(
                {"timeRange": time_range, "groupBy": group_by}
            )
            return Response(status=200, body={"success": True, "metrics": metrics})
        except Exception as e:
            return Response(status=500, body={"error": str(e)})


    return [
        Route(method=HttpMethod.POST, path="/web/page", handler=get_page),
        Route(method=HttpMethod.POST, path="/web/metadata", handler=get_multiple_metadata),
        Route(method=HttpMethod.GET, path="/images/search", handler=search_images),
        Route(method=HttpMethod.POST, path="/images/download", handler=download_image),
        Route(method=HttpMethod.GET, path="/geo/reverse", handler=reverse_geocode),
        Route(method=HttpMethod.GET, path="/geo/geocode", handler=geocode),
        Route(method=HttpMethod.GET, path="/geo/search", handler=geo_search),
        Route(method=HttpMethod.GET, path="/geo/places/:place_id", handler=get_place_details),
        Route(method=HttpMethod.GET, path="/metrics", handler=get_metrics),
    ]
