"""
Plugin di autenticazione DI PROVA per Radicale 3.7.x, usato solo dai test di
integrazione (test/integration/radicale-smoke.test.ts) per verificare la
catena device → Radicale → POST verify-credentials → principal con il mock
helpers/mock_verify.py. NON è il plugin di produzione: caldes_auth.py verrà
riscritto in F1 (design §3.3) con cache, utenti di servizio e peer interno.

Implementa il minimo del contratto di F1:
  - override di `_login_ext(login, password, context)` (la firma che Radicale
    3.7 chiama tramite BaseAuth.login; il plugin attuale sovrascrive `login`
    con due argomenti e va in TypeError);
  - POST <CALDAV_BACKEND_URL>/verify-credentials con Bearer
    CALDAV_SERVICE_TOKEN, X-Forwarded-For dal context (X-Remote-Addr del
    proxy, altrimenti il peer TCP) e timeout di CALDES_TEST_AUTH_TIMEOUT
    secondi (default 1);
  - 200 {"ok": true, "principal": P} → utente Radicale P (principal canonico);
  - 401 → credenziali non valide (stringa vuota: Radicale risponde 401);
  - qualsiasi altro esito (5xx, 429, timeout, rete, corpo non valido) →
    eccezione: Radicale risponde 500 e il client riprova senza considerare
    la password sbagliata.
"""

import json
import os
import urllib.error
import urllib.request

from radicale import auth


class Auth(auth.BaseAuth):
    def __init__(self, configuration):
        super().__init__(configuration)
        base = os.environ.get("CALDAV_BACKEND_URL", "").rstrip("/")
        token = os.environ.get("CALDAV_SERVICE_TOKEN", "")
        if not base or not token:
            raise RuntimeError("[caldes_test_auth] CALDAV_BACKEND_URL e CALDAV_SERVICE_TOKEN sono obbligatorie")
        self._url = base + "/verify-credentials"
        self._token = token
        self._timeout = float(os.environ.get("CALDES_TEST_AUTH_TIMEOUT", "1"))

    def _login_ext(self, login, password, context):
        if not login or not password:
            return ""
        forwarded = getattr(context, "x_remote_addr", None) or getattr(context, "remote_addr", None) or ""
        request = urllib.request.Request(
            self._url,
            data=json.dumps({"username": login, "password": password}).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self._token,
                "X-Forwarded-For": forwarded,
                "User-Agent": "caldes-test-auth/1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                payload = json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as err:
            if err.code == 401:
                return ""
            raise RuntimeError("[caldes_test_auth] verify-credentials HTTP %d" % err.code) from err
        except ValueError as err:
            raise RuntimeError("[caldes_test_auth] risposta di verify-credentials non JSON") from err
        principal = payload.get("principal") if isinstance(payload, dict) and payload.get("ok") is True else None
        if not isinstance(principal, str) or not principal:
            raise RuntimeError("[caldes_test_auth] risposta di verify-credentials senza principal")
        return principal
