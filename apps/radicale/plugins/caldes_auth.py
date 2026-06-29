"""
Caldes Auth plugin per Radicale 3.x.

Valida le credenziali Basic auth del device (username:app-password) chiamando
l'endpoint interno `POST /api/caldav-backend/verify-credentials` dell'API.
L'app-password è un token random ad alta entropia hashato sha256 lato DB
(tabella `caldav_app_passwords`): non è la password admin.

I client CalDAV (DAVx5/iOS/macOS/Thunderbird) reinviano Basic a ogni richiesta,
quindi cache-LRU in memoria (TTL 60s) per non floodare l'API. Cache negativa
sempre 60s (anti-bruteforce passivo).

Config (radicale.ini):
    [auth]
    type = caldes_auth

Env:
    CALDAV_BACKEND_URL   — base URL interno, es. http://api:3001/api/caldav-backend
    CALDAV_SERVICE_TOKEN — Bearer secret condiviso con l'API (CALDAV_SERVICE_TOKEN)
"""

import json
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from typing import Optional

from radicale.auth import BaseAuth

# Cache LRU (cap 256, TTL 60s): (username, password) -> principal|None
_CACHE: "OrderedDict[tuple[str, str], tuple[Optional[str], float]]" = OrderedDict()
_CACHE_CAP = 256
_CACHE_TTL = 60.0


def _cached(key: tuple[str, str]) -> Optional[object]:
    if key in _CACHE:
        principal, exp = _CACHE[key]
        if time.monotonic() < exp:
            _CACHE.move_to_end(key)
            return ("hit", principal)
        del _CACHE[key]
    return None


def _store(key: tuple[str, str], principal: Optional[str]) -> None:
    _CACHE[key] = (principal, time.monotonic() + _CACHE_TTL)
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_CAP:
        _CACHE.popitem(last=False)


class Auth(BaseAuth):
    def _backend_url(self) -> str:
        url = self.configuration.get("auth", "caldes_backend_url", fallback=None)
        if url:
            return url.rstrip("/")
        # fallback a env diretto (utile se config non ha la chiave custom)
        import os
        env = os.environ.get("CALDAV_BACKEND_URL")
        if not env:
            raise RuntimeError(
                "[caldes_auth] CALDAV_BACKEND_URL non impostato "
                "(config auth.caldes_backend_url o env CALDAV_BACKEND_URL)"
            )
        return env.rstrip("/")

    def _service_token(self) -> str:
        import os
        tok = self.configuration.get("auth", "caldes_service_token", fallback=None)
        if not tok:
            tok = os.environ.get("CALDAV_SERVICE_TOKEN")
        if not tok:
            raise RuntimeError(
                "[caldes_auth] CALDAV_SERVICE_TOKEN non impostato "
                "(config auth.caldes_service_token o env CALDAV_SERVICE_TOKEN)"
            )
        return tok

    def login(self, login: str, password: str) -> Optional[str]:
        if not login or not password:
            return None
        key = (login, password)
        hit = _cached(key)
        if hit is not None:
            return hit[1]  # type: ignore[index]

        url = f"{self._backend_url()}/verify-credentials"
        body = json.dumps({"username": login, "password": password}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._service_token()}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status != 200:
                    _store(key, None)
                    return None
                payload = json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            # 401 = credenziali invalide → cache negativa; 5xx = non cache
            if e.code == 401:
                _store(key, None)
            return None
        except (urllib.error.URLError, TimeoutError, OSError):
            # Backend down: non cache (potrebbe essere un blip)
            return None

        principal = payload.get("principal") if payload.get("ok") else None
        _store(key, principal)
        return principal
