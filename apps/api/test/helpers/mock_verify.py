#!/usr/bin/env python3
"""
Mock di POST /api/caldav-backend/verify-credentials per i test dei plugin
Radicale (fase F0, harness per F1: docs/calendar-radicale/design.md §3.3 e §15).

Riproduce il contratto HTTP della route reale (apps/api/src/routes/calendar/
caldav-backend.ts con il middleware caldav-service-auth.ts) così un plugin di
autenticazione si prova senza l'API:

  POST <qualsiasi prefisso>/verify-credentials
    Authorization: Bearer <CALDAV_SERVICE_TOKEN>
    X-Forwarded-For: <IP del device> (facoltativo, registrato)
    {"username": "...", "password": "..."}

  Bearer assente o errato       401 {"error": "Unauthorized"}
  credenziali valide            200 {"ok": true, "principal": "<principal>"}
                                (più "expires_at" se l'utente lo definisce)
  credenziali non valide        401 {"ok": false}
  corpo non JSON o campi non stringa: come credenziali vuote (401 {"ok": false})

Il principal restituito dipende da `principal_mode`:
  - "canonical" (default, contratto di F1): sempre `principal` (federico),
    qualunque sia lo username dell'app-password;
  - "username": lo username stesso, come l'API di oggi.
Un utente può avere un principal proprio e una scadenza `expires_at` (stringa
ISO 8601 o null): solo se l'utente la definisce la risposta 200 contiene
"expires_at", come la route di F1 (contratto control-plane §9.4); senza, la
risposta resta {"ok": true, "principal": ...}. Con `reject_reserved` (default) gli
username con prefisso "caldes-" sono rifiutati con 401: sono riservati agli
utenti di servizio e non devono mai finire nel ramo device.

Guasti simulabili (`mode`), per i casi di cache, stale-if-error e timeout:
  ok            risposta normale
  deny          401 {"ok": false} a qualsiasi credenziale
  error         500 {"error": "..."}
  unavailable   503 {"error": "..."} (API giù dietro il proxy)
  rate_limited  429 con il testo della route reale (dopo il controllo del Bearer)
  slow          attende `delay_ms` e poi risponde normalmente (timeout del plugin)
  garbage       200 con un corpo non JSON
  drop          chiude la connessione senza risposta

Endpoint di controllo (nessuna autenticazione: il mock ascolta solo su loopback):
  GET    /__mock/health   {"ok": true}
  GET    /__mock/state    stato corrente (solo gli username, mai le password)
  POST   /__mock/state    patch dello stato: mode, delay_ms, token, principal,
                          principal_mode, reject_reserved, users
                          (users: [{"username", "password", "principal"?,
                          "expires_at"?}], sostituisce l'elenco)
  GET    /__mock/calls    chiamate ricevute a verify-credentials, in ordine
  DELETE /__mock/calls    azzera le chiamate

Delle chiamate si registrano username, sha256 della password (mai la password
in chiaro), validità del Bearer, X-Forwarded-For, X-Remote-Addr, User-Agent,
modalità e status della risposta.

Avvio: python3 -I mock_verify.py [--host 127.0.0.1] [--port 0] [--state JSON]
Lo stato iniziale arriva da --state o dalla variabile MOCK_VERIFY_STATE (JSON).
Con --port 0 sceglie il sistema; appena pronto stampa su stdout una riga JSON
{"event": "ready", "host": ..., "port": N, "url": ...}. SIGTERM e SIGINT lo
fermano in modo pulito. Solo libreria standard (Python 3.9+).
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

MODES = ("ok", "deny", "error", "unavailable", "rate_limited", "slow", "garbage", "drop")
PRINCIPAL_MODES = ("canonical", "username")
RESERVED_PREFIX = "caldes-"
MAX_BODY_BYTES = 64 * 1024
MAX_CALLS = 1000

# Testi delle risposte della route reale (caldav-service-auth.ts, rate-limit.ts).
UNAUTHORIZED_BODY = {"error": "Unauthorized"}
RATE_LIMIT_BODY = {"error": "Troppi tentativi. Riprova tra qualche minuto."}

# Segnaposto per "expires_at non definito" (diverso da null, che è un valore valido).
NO_EXPIRY = object()

# username -> (password, principal o None, expires_at: stringa, None o NO_EXPIRY)
UserEntry = Tuple[str, Optional[str], Any]


class MockState:
    """Stato condiviso fra i thread del server (protetto da un lock)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.mode = "ok"
        self.delay_ms = 0
        self.token = os.environ.get("CALDAV_SERVICE_TOKEN", "")
        self.principal = "federico"
        self.principal_mode = "canonical"
        self.reject_reserved = True
        self.users: Dict[str, UserEntry] = {}
        self.calls: List[Dict[str, Any]] = []

    def apply(self, patch: Dict[str, Any]) -> None:
        """Applica una patch validata; lancia ValueError sui valori non ammessi."""
        if not isinstance(patch, dict):
            raise ValueError("lo stato deve essere un oggetto JSON")
        unknown = set(patch) - {"mode", "delay_ms", "token", "principal", "principal_mode", "reject_reserved", "users"}
        if unknown:
            raise ValueError("chiavi sconosciute: %s" % ", ".join(sorted(unknown)))
        with self.lock:
            if "mode" in patch:
                if patch["mode"] not in MODES:
                    raise ValueError("mode non valido: %r (ammessi: %s)" % (patch["mode"], ", ".join(MODES)))
                self.mode = patch["mode"]
            if "delay_ms" in patch:
                delay = patch["delay_ms"]
                if not isinstance(delay, (int, float)) or isinstance(delay, bool) or delay < 0:
                    raise ValueError("delay_ms deve essere un numero >= 0")
                self.delay_ms = int(delay)
            if "token" in patch:
                if not isinstance(patch["token"], str):
                    raise ValueError("token deve essere una stringa")
                self.token = patch["token"]
            if "principal" in patch:
                if not isinstance(patch["principal"], str) or not patch["principal"]:
                    raise ValueError("principal deve essere una stringa non vuota")
                self.principal = patch["principal"]
            if "principal_mode" in patch:
                if patch["principal_mode"] not in PRINCIPAL_MODES:
                    raise ValueError("principal_mode non valido: %r" % (patch["principal_mode"],))
                self.principal_mode = patch["principal_mode"]
            if "reject_reserved" in patch:
                if not isinstance(patch["reject_reserved"], bool):
                    raise ValueError("reject_reserved deve essere booleano")
                self.reject_reserved = patch["reject_reserved"]
            if "users" in patch:
                self.users = parse_users(patch["users"])

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "mode": self.mode,
                "delay_ms": self.delay_ms,
                "token": self.token,
                "principal": self.principal,
                "principal_mode": self.principal_mode,
                "reject_reserved": self.reject_reserved,
                "usernames": sorted(self.users),
            }

    def record(self, call: Dict[str, Any]) -> None:
        with self.lock:
            self.calls.append(call)
            if len(self.calls) > MAX_CALLS:
                del self.calls[: len(self.calls) - MAX_CALLS]


def parse_users(raw: Any) -> Dict[str, UserEntry]:
    if not isinstance(raw, list):
        raise ValueError("users deve essere una lista")
    users: Dict[str, UserEntry] = {}
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("ogni utente deve essere un oggetto")
        username, password, principal = item.get("username"), item.get("password"), item.get("principal")
        if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
            raise ValueError("username e password devono essere stringhe non vuote")
        if principal is not None and (not isinstance(principal, str) or not principal):
            raise ValueError("principal deve essere una stringa non vuota")
        expires_at = item.get("expires_at", NO_EXPIRY)
        if expires_at is not NO_EXPIRY and expires_at is not None and not isinstance(expires_at, str):
            raise ValueError("expires_at deve essere una stringa o null")
        users[username] = (password, principal, expires_at)
    return users


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def safe_equal(a: str, b: str) -> bool:
    """Confronto a tempo costante, come timingSafeEqual nella route reale."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


STATE = MockState()


class Handler(BaseHTTPRequestHandler):
    server_version = "caldes-mock-verify/1"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ─── Utilità ───────────────────────────────

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (firma di BaseHTTPRequestHandler)
        if os.environ.get("MOCK_VERIFY_VERBOSE"):
            sys.stderr.write("[mock-verify] %s %s\n" % (self.address_string(), format % args))

    def end_headers(self) -> None:
        # Come Node (@hono/node-server): a una richiesta con "Connection: close"
        # la risposta porta lo stesso header. http.client del plugin passa
        # allora il socket alla risposta e lo chiude appena letto il corpo:
        # senza questo header il mock nasconderebbe proprio quel percorso.
        request_headers = getattr(self, "headers", None)  # assente se la richiesta non si è letta
        if request_headers is not None and (request_headers.get("Connection") or "").strip().lower() == "close":
            self.send_header("Connection", "close")
        super().end_headers()

    def send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_empty(self, status: int) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("corpo troppo grande")
        return self.rfile.read(length) if length else b""

    # ─── Routing ───────────────────────────────

    def do_GET(self) -> None:  # noqa: N802 (nome imposto da BaseHTTPRequestHandler)
        if self.path == "/__mock/health":
            self.send_json(200, {"ok": True})
        elif self.path == "/__mock/state":
            self.send_json(200, STATE.snapshot())
        elif self.path == "/__mock/calls":
            with STATE.lock:
                calls = list(STATE.calls)
            self.send_json(200, calls)
        else:
            self.send_json(404, {"error": "Not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        if self.path == "/__mock/calls":
            with STATE.lock:
                STATE.calls.clear()
            self.send_empty(204)
        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/__mock/state":
            try:
                STATE.apply(json.loads(self.read_body() or b"{}"))
            except (ValueError, json.JSONDecodeError) as err:
                self.send_json(400, {"error": str(err)})
                return
            self.send_json(200, STATE.snapshot())
        elif self.path.split("?", 1)[0].endswith("/verify-credentials"):
            self.verify_credentials()
        else:
            self.send_json(404, {"error": "Not found"})

    # ─── verify-credentials ───────────────────────────────

    def verify_credentials(self) -> None:
        try:
            raw = self.read_body()
        except ValueError:
            self.send_json(413, {"error": "Payload too large"})
            return
        try:
            body = json.loads(raw or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            body = {}
        if not isinstance(body, dict):
            body = {}
        username = body.get("username") if isinstance(body.get("username"), str) else ""
        password = body.get("password") if isinstance(body.get("password"), str) else ""

        with STATE.lock:
            mode, delay_ms, token = STATE.mode, STATE.delay_ms, STATE.token
            users = dict(STATE.users)
            principal_mode, canonical, reject_reserved = STATE.principal_mode, STATE.principal, STATE.reject_reserved

        header = self.headers.get("Authorization") or ""
        bearer = header[7:].strip() if header.startswith("Bearer ") else ""
        authorization_valid = bool(token) and bool(bearer) and safe_equal(bearer, token)

        call: Dict[str, Any] = {
            "ts": time.time(),
            "method": self.command,
            "path": self.path,
            "mode": mode,
            "status": None,
            "username": username or None,
            "password_sha256": sha256_hex(password) if password else None,
            "authorization_valid": authorization_valid,
            "x_forwarded_for": self.headers.get("X-Forwarded-For"),
            "x_remote_addr": self.headers.get("X-Remote-Addr"),
            "user_agent": self.headers.get("User-Agent"),
            "content_type": self.headers.get("Content-Type"),
        }

        def respond(status: Optional[int], payload: Any = None, raw_body: Optional[bytes] = None) -> None:
            call["status"] = status
            STATE.record(call)
            if status is None:
                return
            if raw_body is not None:
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(raw_body)))
                self.end_headers()
                self.wfile.write(raw_body)
            else:
                self.send_json(status, payload)

        # Guasti dell'infrastruttura: prima di qualsiasi controllo, come un
        # proxy o un'API che non risponde.
        if mode == "drop":
            respond(None)
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            return
        if mode == "unavailable":
            respond(503, {"error": "Service Unavailable (mock)"})
            return
        if mode == "error":
            respond(500, {"error": "Internal Server Error (mock)"})
            return
        if mode == "garbage":
            respond(200, raw_body=b"<html><body>502 Bad Gateway</body></html>")
            return
        if mode == "slow" and delay_ms > 0:
            time.sleep(delay_ms / 1000.0)

        # Middleware caldav-service-auth: Bearer obbligatorio.
        if not authorization_valid:
            respond(401, UNAUTHORIZED_BODY)
            return
        # Rate limit della route (dopo l'autenticazione del servizio).
        if mode == "rate_limited":
            respond(429, RATE_LIMIT_BODY)
            return
        if mode == "deny" or not username or not password:
            respond(401, {"ok": False})
            return
        if reject_reserved and username.lower().startswith(RESERVED_PREFIX):
            respond(401, {"ok": False})
            return

        entry = users.get(username)
        if entry is None or not safe_equal(password, entry[0]):
            respond(401, {"ok": False})
            return
        own_principal = entry[1]
        principal = own_principal or (canonical if principal_mode == "canonical" else username)
        payload: Dict[str, Any] = {"ok": True, "principal": principal}
        if entry[2] is not NO_EXPIRY:
            payload["expires_at"] = entry[2]
        respond(200, payload)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Mock di verify-credentials per i test dei plugin Radicale")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--state", default=None, help="stato iniziale JSON (altrimenti MOCK_VERIFY_STATE)")
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "::1", "localhost"):
        # Gli endpoint di controllo non hanno autenticazione: solo loopback.
        parser.error("il mock ascolta solo su loopback")

    raw_state = args.state if args.state is not None else os.environ.get("MOCK_VERIFY_STATE")
    if raw_state:
        try:
            STATE.apply(json.loads(raw_state))
        except (ValueError, json.JSONDecodeError) as err:
            print("Stato iniziale non valido: %s" % err, file=sys.stderr)
            return 2

    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    host, port = server.server_address[0], server.server_address[1]

    def shutdown(_signum: int, _frame: Any) -> None:
        # shutdown() aspetta il loop di serve_forever: va chiamato da un altro thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    url = "http://%s:%d" % (host if ":" not in host else "[%s]" % host, port)
    print(json.dumps({"event": "ready", "host": host, "port": port, "url": url}), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
