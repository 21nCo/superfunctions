"""BrowseFn HTTP router using the shared Python HTTP abstractions."""

from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional
from uuid import uuid4

from superfunctions.http import HttpMethod, Request, Response, Route, RouteContext

from browsefn.core.errors import BrowseFnError, create_error_envelope, create_success_envelope
from browsefn.core.types import GeocodeOptions, GeoLocation, GeoSearchOptions, GetPageOptions, ImageDownloadOptions, ImageSearchOptions, MetadataOptions


def _request_id(request: Request) -> str:
    return request.headers.get("x-request-id", f"req-{uuid4().hex[:12]}")


def _error_status(error: BrowseFnError) -> int:
    if error.code in {"INVALID_ARGUMENT", "INVALID_URL", "UNSUPPORTED_PROVIDER", "UNSUPPORTED_PROVIDER_CAPABILITY"}:
        return 400
    if error.code == "UPSTREAM_NOT_FOUND":
        return 404
    if error.code == "DOWNLOAD_EXISTS":
        return 409
    if error.code == "SECURITY_POLICY_BLOCKED":
        return 403
    if error.code == "RATE_LIMITED":
        return 429
    if error.code == "UPSTREAM_TIMEOUT":
        return 504
    if error.code == "PROVIDER_UNAVAILABLE":
        return 503
    if error.code in {"PROVIDER_ERROR", "CACHE_ERROR"}:
        return 502
    return 500


def _serialize_data(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        data = value.model_dump()
    elif isinstance(value, list):
        return [_serialize_data(item) for item in value]
    elif isinstance(value, dict):
        return {key: _serialize_data(item) for key, item in value.items()}
    else:
        return value

    if isinstance(data, dict) and isinstance(data.get("screenshot"), (bytes, bytearray)):
        data["screenshot"] = base64.b64encode(data["screenshot"]).decode("ascii")
    return {key: _serialize_data(item) for key, item in data.items()}


def _query_value(context: RouteContext, key: str) -> Optional[Any]:
    return context.query.get(key)


def _int_query(context: RouteContext, key: str) -> Optional[int]:
    value = _query_value(context, key)
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise BrowseFnError("INVALID_ARGUMENT", f"{key} must be an integer.") from exc


def _float_query(context: RouteContext, key: str, *, message: str) -> Optional[float]:
    value = _query_value(context, key)
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise BrowseFnError("INVALID_ARGUMENT", message) from exc


def _response_from_error(error: Exception, request_id: str) -> Response:
    browse_error = error if isinstance(error, BrowseFnError) else BrowseFnError("INTERNAL_ERROR", str(error))
    return Response(status=_error_status(browse_error), body=create_error_envelope(browse_error, request_id))


def create_browsefn_router(browse_fn: Any) -> List[Route]:
    async def get_page(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            body = await request.json()
            if "url" not in body:
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: url")
            options = GetPageOptions(**body.get("options", {}))
            page = await browse_fn.web.get_page(body["url"], options)
            meta = {
                "requestId": request_id,
                "provider": page.provider,
            }
            if page.cached is not None:
                meta["cached"] = page.cached
            if page.duration is not None:
                meta["durationMs"] = page.duration
            return Response(status=200, body=create_success_envelope(_serialize_data(page), meta))
        except Exception as error:
            return _response_from_error(error, request_id)

    async def get_multiple_metadata(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            body = await request.json()
            urls = body.get("urls")
            if not isinstance(urls, list):
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: urls")
            options = MetadataOptions(**body.get("options", {}))
            results = await browse_fn.web.get_multiple_metadata(urls, options)
            return Response(
                status=200,
                body=create_success_envelope({"results": _serialize_data(results)}, {"requestId": request_id}),
            )
        except Exception as error:
            return _response_from_error(error, request_id)

    async def search_images(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            query = _query_value(context, "q")
            if not query:
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: q")
            options = ImageSearchOptions(
                provider=_query_value(context, "provider"),
                page=_int_query(context, "page"),
                perPage=_int_query(context, "perPage"),
                orientation=_query_value(context, "orientation"),
                color=_query_value(context, "color"),
                orderBy=_query_value(context, "orderBy"),
            )
            result = await browse_fn.images.search(query, options)
            return Response(
                status=200,
                body=create_success_envelope(_serialize_data(result), {"requestId": request_id, "provider": result.provider}),
            )
        except Exception as error:
            return _response_from_error(error, request_id)

    async def download_image(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            body = await request.json()
            if "url" not in body:
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: url")
            options = ImageDownloadOptions(**body.get("options", {}))
            result = await browse_fn.images.download(body["url"], options)
            return Response(status=200, body=create_success_envelope(_serialize_data(result), {"requestId": request_id}))
        except Exception as error:
            return _response_from_error(error, request_id)

    async def reverse_geocode(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            lat = _float_query(context, "lat", message="lat must be a number.")
            lng = _float_query(context, "lng", message="lng must be a number.")
            if lat is None or lng is None:
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required fields: lat and lng")
            location = GeoLocation(lat=lat, lng=lng)
            result = await browse_fn.geo.reverse_geocode(location, _query_value(context, "provider"))
            return Response(
                status=200,
                body=create_success_envelope(_serialize_data(result), {"requestId": request_id, "provider": result.provider}),
            )
        except Exception as error:
            return _response_from_error(error, request_id)

    async def geocode(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            address = _query_value(context, "address")
            if not address:
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: address")
            options = GeocodeOptions(provider=_query_value(context, "provider"), limit=_int_query(context, "limit"))
            results = await browse_fn.geo.geocode(address, options)
            provider = results[0].provider if results else options.provider
            return Response(
                status=200,
                body=create_success_envelope({"results": _serialize_data(results)}, {"requestId": request_id, "provider": provider}),
            )
        except Exception as error:
            return _response_from_error(error, request_id)

    async def geo_search(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            query = _query_value(context, "q")
            if not query:
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: q")
            lat = _float_query(context, "lat", message="lat must be a number.")
            lng = _float_query(context, "lng", message="lng must be a number.")
            center = GeoLocation(lat=lat, lng=lng) if lat is not None and lng is not None else None
            options = GeoSearchOptions(
                query=query,
                provider=_query_value(context, "provider"),
                center=center,
                radius=_float_query(context, "radius", message="radius must be a number."),
                limit=_int_query(context, "limit"),
            )
            results = await browse_fn.geo.search(options)
            provider = results[0].provider if results else options.provider
            return Response(
                status=200,
                body=create_success_envelope({"results": _serialize_data(results)}, {"requestId": request_id, "provider": provider}),
            )
        except Exception as error:
            return _response_from_error(error, request_id)

    async def get_place_details(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            place_id = context.params.get("place_id")
            if not place_id:
                raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: place_id")
            fields = _query_value(context, "fields")
            result = await browse_fn.geo.get_place_details(
                place_id,
                _query_value(context, "provider"),
                fields.split(",") if isinstance(fields, str) and fields else None,
            )
            return Response(
                status=200,
                body=create_success_envelope(_serialize_data(result), {"requestId": request_id, "provider": result.provider}),
            )
        except Exception as error:
            return _response_from_error(error, request_id)

    async def get_metrics(request: Request, context: RouteContext) -> Response:
        request_id = _request_id(request)
        try:
            metrics = await browse_fn.get_metrics(
                {"timeRange": _query_value(context, "timeRange"), "groupBy": _query_value(context, "groupBy")}
            )
            return Response(status=200, body=create_success_envelope(_serialize_data(metrics), {"requestId": request_id}))
        except Exception as error:
            return _response_from_error(error, request_id)

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
