"""HTTP client for making API requests."""

from typing import Any, Dict, Optional
import httpx

from ..types import AuthType


class HttpClient:
    """HTTP client with authentication support."""

    def __init__(
        self,
        base_url: str,
        credentials: Dict[str, Any],
        auth_type: AuthType,
        logger: Any,
        timeout: int = 30,
    ):
        """Initialize HTTP client.

        Args:
            base_url: Base URL for API requests
            credentials: Authentication credentials
            auth_type: Type of authentication
            logger: Logger instance
            timeout: Request timeout in seconds
        """
        self.base_url = base_url.rstrip("/")
        self.credentials = credentials
        self.auth_type = auth_type
        self.logger = logger
        self.timeout = timeout

    def _get_auth_headers(self) -> Dict[str, str]:
        """Get authentication headers based on auth type.

        Returns:
            Headers dict
        """
        headers = {}

        if self.auth_type == AuthType.OAUTH2:
            access_token = self.credentials.get("access_token")
            if access_token:
                token_type = self.credentials.get("token_type", "Bearer")
                headers["Authorization"] = f"{token_type} {access_token}"

        elif self.auth_type == AuthType.API_KEY:
            api_key = self.credentials.get("api_key")
            header_name = self.credentials.get("header_name", "Authorization")
            prefix = self.credentials.get("prefix", "")

            if api_key:
                if prefix:
                    headers[header_name] = f"{prefix} {api_key}"
                else:
                    headers[header_name] = api_key

        elif self.auth_type == AuthType.BASIC:
            # Basic auth is handled by httpx.BasicAuth
            pass

        return headers

    async def get(
        self, path: str, params: Optional[Dict[str, Any]] = None, **kwargs: Any
    ) -> Dict[str, Any]:
        """Make a GET request.

        Args:
            path: Request path (relative to base_url)
            params: Query parameters
            **kwargs: Additional httpx parameters

        Returns:
            Response data

        Raises:
            Exception: If request fails
        """
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = self._get_auth_headers()
        headers.update(kwargs.pop("headers", {}))

        auth = None
        if self.auth_type == AuthType.BASIC:
            username = self.credentials.get("username")
            password = self.credentials.get("password")
            if username and password:
                auth = httpx.BasicAuth(username, password)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.get(
                url, params=params, headers=headers, auth=auth, **kwargs
            )

            response.raise_for_status()
            return response.json()

    async def post(
        self,
        path: str,
        data: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Make a POST request.

        Args:
            path: Request path
            data: Form data
            json: JSON data
            **kwargs: Additional httpx parameters

        Returns:
            Response data

        Raises:
            Exception: If request fails
        """
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = self._get_auth_headers()
        headers.update(kwargs.pop("headers", {}))

        auth = None
        if self.auth_type == AuthType.BASIC:
            username = self.credentials.get("username")
            password = self.credentials.get("password")
            if username and password:
                auth = httpx.BasicAuth(username, password)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                url, data=data, json=json, headers=headers, auth=auth, **kwargs
            )

            response.raise_for_status()
            
            # Some APIs return empty responses
            if response.status_code == 204 or not response.content:
                return {}
            
            return response.json()

    async def put(
        self,
        path: str,
        data: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Make a PUT request.

        Args:
            path: Request path
            data: Form data
            json: JSON data
            **kwargs: Additional httpx parameters

        Returns:
            Response data

        Raises:
            Exception: If request fails
        """
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = self._get_auth_headers()
        headers.update(kwargs.pop("headers", {}))

        auth = None
        if self.auth_type == AuthType.BASIC:
            username = self.credentials.get("username")
            password = self.credentials.get("password")
            if username and password:
                auth = httpx.BasicAuth(username, password)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.put(
                url, data=data, json=json, headers=headers, auth=auth, **kwargs
            )

            response.raise_for_status()
            
            if response.status_code == 204 or not response.content:
                return {}
            
            return response.json()

    async def patch(
        self,
        path: str,
        data: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """Make a PATCH request.

        Args:
            path: Request path
            data: Form data
            json: JSON data
            **kwargs: Additional httpx parameters

        Returns:
            Response data

        Raises:
            Exception: If request fails
        """
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = self._get_auth_headers()
        headers.update(kwargs.pop("headers", {}))

        auth = None
        if self.auth_type == AuthType.BASIC:
            username = self.credentials.get("username")
            password = self.credentials.get("password")
            if username and password:
                auth = httpx.BasicAuth(username, password)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.patch(
                url, data=data, json=json, headers=headers, auth=auth, **kwargs
            )

            response.raise_for_status()
            
            if response.status_code == 204 or not response.content:
                return {}
            
            return response.json()

    async def delete(
        self, path: str, **kwargs: Any
    ) -> Dict[str, Any]:
        """Make a DELETE request.

        Args:
            path: Request path
            **kwargs: Additional httpx parameters

        Returns:
            Response data

        Raises:
            Exception: If request fails
        """
        url = f"{self.base_url}/{path.lstrip('/')}"
        headers = self._get_auth_headers()
        headers.update(kwargs.pop("headers", {}))

        auth = None
        if self.auth_type == AuthType.BASIC:
            username = self.credentials.get("username")
            password = self.credentials.get("password")
            if username and password:
                auth = httpx.BasicAuth(username, password)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.delete(
                url, headers=headers, auth=auth, **kwargs
            )

            response.raise_for_status()
            
            if response.status_code == 204 or not response.content:
                return {}
            
            return response.json()
