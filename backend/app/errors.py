"""Plain-word reasons for failed network calls, judged by exception type (never raw repr)."""
import socket
import ssl
import urllib.error

try:  # AI providers use httpx; prices use urllib
    import httpx
except ImportError:  # pragma: no cover
    httpx = None


def _root(exc):
    """Walk wrappers (URLError.reason, __cause__) down to the real failure."""
    seen = 0
    while seen < 5:
        seen += 1
        if isinstance(exc, urllib.error.URLError) and not isinstance(exc, urllib.error.HTTPError) \
                and isinstance(exc.reason, BaseException):
            exc = exc.reason
        elif (exc.__cause__ or exc.__context__) is not None and not isinstance(exc, (OSError, TimeoutError)):
            exc = exc.__cause__ or exc.__context__  # libraries chain either way
        else:
            break
    return exc


def network_reason(exc, service="the service"):
    """Short reason if exc is a network failure, else None."""
    if isinstance(exc, urllib.error.HTTPError):
        code = exc.code
    elif httpx is not None and isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
    else:
        code = None
    if code is not None:
        if code == 429:
            return f"{service} is busy right now"
        if code == 404:
            return f"not available on {service}"
        if code >= 500:
            return f"{service} is having problems"
        return f"{service} refused the request (HTTP {code})"
    if httpx is not None and isinstance(exc, httpx.TimeoutException):
        return f"{service} timed out"
    err = _root(exc)
    if httpx is not None:
        if isinstance(err, httpx.TimeoutException):
            return f"{service} timed out"
        if isinstance(err, httpx.ConnectError):
            return f"couldn't connect to {service}"
        if isinstance(err, httpx.HTTPError):
            return f"connection to {service} dropped"
    if isinstance(err, ssl.SSLError):
        return f"secure connection to {service} failed"
    if isinstance(err, (socket.timeout, TimeoutError)):
        return f"{service} timed out"
    if isinstance(err, socket.gaierror):
        return "no internet connection"
    if isinstance(err, ssl.SSLError):
        return f"secure connection to {service} failed"
    if isinstance(err, ConnectionRefusedError):
        return f"{service} refused the connection"
    if isinstance(err, OSError):
        return "network connection problem"
    if httpx is not None and isinstance(exc, httpx.TransportError):
        return f"connection to {service} dropped"
    return None


def describe_error(exc, service="the service"):
    """Network failures in plain words; other errors keep their own message."""
    reason = network_reason(exc, service)
    if reason:
        return reason
    if isinstance(exc, (ValueError, KeyError, TypeError)) and not str(exc).strip():
        return f"{service} sent an unreadable reply"
    return str(exc) or f"{service} unavailable"
