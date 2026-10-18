"""
Healthcheck del container Radicale di Caldes (fase F1, design §3.1,
contratto control-plane §11).

PROPFIND Depth:0 sulla root `/` di Radicale come `caldes-probe`, da
127.0.0.1 dentro il container: sano solo con 207 e un multistatus XML. La
richiesta passa per caldes_auth (ramo degli utenti di servizio, peer di
loopback ammesso solo per il probe) e per caldes_rights (R sulla root senza
dipendere da policy né identità), quindi un plugin rotto rende il container
unhealthy; funziona anche prima dell'inizializzazione del principal, quando
`/federico/` risponderebbe ancora 403.

Uso (Dockerfile): `/venv/bin/python -I /app/plugins/caldes_healthcheck.py`.
Exit 0 = sano, 1 = non sano (con una riga di motivo su stdout, che Docker
conserva nello stato dell'healthcheck; mai la password).

Ambiente:
- CALDES_PROBE_PASSWORD (obbligatoria): password in chiaro di caldes-probe,
  la stessa il cui sha256 è in CALDES_PROBE_PASSWORD_SHA256;
- CALDES_HEALTHCHECK_URL (facoltativa, solo per i test): default
  http://127.0.0.1:5232/;
- CALDES_HEALTHCHECK_TIMEOUT (facoltativa): secondi, default 4 (l'HEALTHCHECK
  del Dockerfile ha timeout 5 s).

Solo libreria standard.
"""

from __future__ import annotations

import base64
import http.client
import os
import socket
import sys
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Optional, Tuple

PROBE_USER = "caldes-probe"
DEFAULT_URL = "http://127.0.0.1:5232/"
DEFAULT_TIMEOUT_S = 4.0
#: Oltre questa dimensione la risposta non è quella di una PROPFIND Depth:0.
MAX_RESPONSE_BYTES = 1_048_576

PROPFIND_BODY = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>'
).encode("utf-8")


def _target(url: str) -> Tuple[str, int, str]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "http" or not parsed.hostname:
        raise ValueError("URL non supportato (serve http://host:porta/): %r" % url)
    return parsed.hostname, parsed.port or 80, parsed.path or "/"


def check(url: str, password: str, timeout: float) -> Optional[str]:
    """None se sano, altrimenti il motivo."""
    host, port, path = _target(url)
    token = base64.b64encode(("%s:%s" % (PROBE_USER, password)).encode("utf-8")).decode("ascii")
    connection = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        connection.request(
            "PROPFIND",
            path,
            body=PROPFIND_BODY,
            headers={
                "Authorization": "Basic " + token,
                "Depth": "0",
                "Content-Type": "application/xml; charset=utf-8",
                "User-Agent": "caldes-healthcheck",
            },
        )
        response = connection.getresponse()
        body = response.read(MAX_RESPONSE_BYTES + 1)
    except (OSError, socket.timeout, http.client.HTTPException) as exc:
        return "richiesta non riuscita: %s" % (exc.__class__.__name__,)
    finally:
        connection.close()
    if response.status != 207:
        return "PROPFIND / ha risposto %d invece di 207" % response.status
    if len(body) > MAX_RESPONSE_BYTES:
        return "risposta oltre %d byte" % MAX_RESPONSE_BYTES
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return "207 senza un XML valido"
    if root.tag != "{DAV:}multistatus":
        return "207 senza multistatus"
    return None


def main() -> int:
    password = os.environ.get("CALDES_PROBE_PASSWORD", "")
    if not password:
        print("unhealthy: CALDES_PROBE_PASSWORD non impostata")
        return 1
    url = os.environ.get("CALDES_HEALTHCHECK_URL", "").strip() or DEFAULT_URL
    try:
        timeout = float(os.environ.get("CALDES_HEALTHCHECK_TIMEOUT", "") or DEFAULT_TIMEOUT_S)
        if not 0 < timeout <= 60:
            raise ValueError
    except ValueError:
        print("unhealthy: CALDES_HEALTHCHECK_TIMEOUT non valido")
        return 1
    try:
        reason = check(url, password, timeout)
    except ValueError as exc:
        print("unhealthy: %s" % exc)
        return 1
    if reason is not None:
        print("unhealthy: %s" % reason)
        return 1
    print("healthy: PROPFIND / come %s → 207" % PROBE_USER)
    return 0


if __name__ == "__main__":
    sys.exit(main())
