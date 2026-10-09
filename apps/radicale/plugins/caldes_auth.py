"""
caldes_auth: plugin di autenticazione di Radicale 3.7.8 per Caldes Calendar.

Fase F1 del passaggio del calendario a Radicale (docs/calendar-radicale/
piano.md, attività 2). Contratto vincolante: docs/calendar-radicale/contracts/
control-plane.md §1.2, §5.3-§5.4 e §9; design §3.3.

Radicale 3.7.8 rende `BaseAuth.login()` @final: il plugin implementa
`_login_ext(login, password, context)`, che restituisce l'utente Radicale,
`""` per credenziali non valide (Radicale risponde 401 dopo il proprio delay)
oppure solleva un'eccezione (Radicale risponde 500 senza delay: il client
riprova senza considerare la password sbagliata).

Utenti di servizio (ogni login con prefisso `caldes-`, senza distinguere
maiuscole e minuscole, è riservato e non entra MAI nel ramo device):
  - `caldes-svc`   accettato solo se il peer TCP (`context.remote_addr`) è in
                   CALDES_SVC_CIDR, la rete interna caldav-int;
  - `caldes-probe` anche da 127.0.0.1, per l'healthcheck dentro il container;
  - password verificata con lo sha256 in env e confronto a tempo costante;
  - qualsiasi altro `caldes-*`, peer non ammesso o password errata → 401.
Il peer si legge solo dal socket, mai da un header: il traffico pubblicato su
127.0.0.1:3011 arriva dal gateway di app-net, che non è mai in CALDES_SVC_CIDR.

Device (ogni altro login):
  1. cache in memoria (60 s dall'ultima conferma del backend) → principal;
  2. POST ${CALDAV_BACKEND_URL}/verify-credentials (Bearer, X-Forwarded-For da
     X-Remote-Addr, timeout complessivo di 1 s):
       200 {ok: true}  → RADICALE_PRINCIPAL qualunque sia lo username;
       401 {ok: false} → negazione esplicita: la voce esce da entrambe le cache;
       altro           → errore del backend:
  3.     voce valida nella cache persistita (HMAC, 24 h) → principal (stale-if-error);
  4.     altrimenti eccezione → 500.
La chiave delle cache lega ogni voce a `credential_epoch` della policy: quando
l'epoch cambia il plugin svuota la cache in memoria e riscrive authcache.json
vuoto; con la policy assente o invalida l'epoch è sconosciuto e nessuna voce
è utilizzabile (le cache restano intatte).

Configurazione solo da env (contratto §1.2): RADICALE_PRINCIPAL,
CALDAV_BACKEND_URL, CALDAV_SERVICE_TOKEN, CALDES_SVC_CIDR,
CALDES_SVC_PASSWORD_SHA256, CALDES_PROBE_PASSWORD_SHA256, CALDES_AUTHCACHE_KEY
obbligatorie; CALDES_AUTHCACHE_DIR (default /var/lib/caldes-auth) e
CALDES_POLICY_FILE (default /control/policy.json) facoltative. Una variabile
obbligatoria assente o malformata fa fallire il caricamento: Radicale non parte.
Della config di Radicale si legge solo `[rights] caldes_policy_file`, per
verificare che auth e rights leggano la stessa policy; `Configuration.get()`
di Radicale 3.7.8 non ha `fallback=`, quindi l'opzione assente si intercetta
come KeyError.

Eventi (contratto §9.7): una riga `caldes_event {json}` a livello WARNING
(ERROR per backend_error e config_error); mai password, chiavi di cache o
segreti. Solo libreria standard.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import socket
import stat
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, NamedTuple, Optional, Tuple, Union
from urllib.parse import urlsplit

from radicale import auth
from radicale.log import logger

# ─── Costanti del contratto ───────────────────────────────

PLUGIN_NAME = "caldes_auth"
EVENT_PREFIX = "caldes_event"

#: Prefisso degli username riservati agli utenti di servizio (contratto §9.1).
RESERVED_PREFIX = "caldes-"
SERVICE_USER = "caldes-svc"
PROBE_USER = "caldes-probe"

#: Durata della cache in memoria dall'ultima conferma del backend (s).
MEMORY_TTL_SECONDS = 60.0
MEMORY_MAX_ENTRIES = 1024
#: Durata della cache persistita dall'ultima conferma del backend (s).
PERSISTED_TTL_SECONDS = 86_400
PERSISTED_MAX_ENTRIES = 256
#: Una voce persistita già presente si riscrive solo se confermata da più di 1 h.
PERSISTED_REFRESH_SECONDS = 3_600
#: Timeout complessivo della chiamata a verify-credentials (s).
BACKEND_TIMEOUT_SECONDS = 1.0
#: Corpo massimo accettato dalla risposta di verify-credentials.
BACKEND_MAX_RESPONSE_BYTES = 65_536
#: La policy si ricontrolla al massimo una volta al secondo.
POLICY_RELOAD_INTERVAL_SECONDS = 1.0
#: Dimensione massima di policy.json (contratto §5.3).
CONTROL_FILE_MAX_BYTES = 65_536
#: Dimensione massima accettata per authcache.json (256 voci stanno in ~30 KiB).
AUTHCACHE_MAX_BYTES = 1_048_576
AUTHCACHE_FILENAME = "authcache.json"
AUTHCACHE_SCHEMA = 1
#: Eventi ripetibili (X-Remote-Addr mancante, errori di scrittura della cache): al massimo uno al minuto.
EVENT_RATE_LIMIT_SECONDS = 60.0
#: Lunghezze massime dei campi di verify-credentials (verify-credentials.schema.json).
LOGIN_MAX_BYTES = 255
PASSWORD_MAX_CHARS = 1024
MIN_AUTHCACHE_KEY_CHARS = 32
MAX_INT32 = 2_147_483_647

DEFAULT_AUTHCACHE_DIR = "/var/lib/caldes-auth"
DEFAULT_POLICY_FILE = "/control/policy.json"
#: Tipo del plugin dei rights che legge `[rights] caldes_policy_file`.
RIGHTS_PLUGIN_TYPE = "caldes_rights"

CONTROL_PLANE_SCHEMA = 1
BACKEND_MODES = ("postgres", "cutover", "radicale", "rollback", "finalized")
POLICY_MODES = ("shadow", "live", "frozen")

_AUTHCACHE_KEY_DOMAIN = b"caldes-authcache/v1\0"
_AUTHCACHE_KEY_ID_DOMAIN = b"caldes-authcache/key-id"

_LOOPBACK_V4 = ipaddress.IPv4Address("127.0.0.1")

# Espressioni regolari solo ASCII e confrontate con fullmatch: in Python `\d`
# accetta cifre Unicode e `$` accetta un a capo finale.
_PRINCIPAL_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}", re.ASCII)
_SHA256_HEX_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)
_CACHE_KEY_RE = re.compile(r"[0-9a-f]{64}", re.ASCII)
_KEY_ID_RE = re.compile(r"[0-9a-f]{16}", re.ASCII)
_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", re.ASCII)
_TOKEN_RE = re.compile(r"[\x21-\x7e]+", re.ASCII)
_TIMESTAMP_RE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]{1,9})?(Z|([+-])([0-9]{2}):([0-9]{2}))",
    re.ASCII,
)
# '/', '\', controlli C0, DEL e C1: stessi intervalli della 162 e di types.ts.
_FORBIDDEN_SEGMENT_RE = re.compile("[/\\\\\x00-\x1f\x7f-\x9f]")
_CONTROL_CHARS_RE = re.compile("[\x00-\x1f\x7f-\x9f]")


# ─── Orologi ───────────────────────────────
# Funzioni di modulo (e non riferimenti diretti a time.*) perché i test le
# sostituiscono per provare TTL e intervalli senza attese reali. La scadenza
# della chiamata HTTP usa invece sempre time.monotonic: è un tempo reale.


def _wall_time() -> float:
    """Secondi Unix correnti (cache persistita, expires_at)."""
    return time.time()


def _monotonic() -> float:
    """Orologio monotono (cache in memoria, ricarica della policy, rate limit dei log)."""
    return time.monotonic()


# ─── Eventi di log ───────────────────────────────


def _event(name: str, level: int = logging.WARNING, **fields: Any) -> None:
    """Riga `caldes_event {json}` del contratto §9.7 (mai segreti nei campi)."""
    payload: Dict[str, Any] = {"event": name, "plugin": PLUGIN_NAME}
    payload.update(fields)
    logger.log(level, "%s %s", EVENT_PREFIX, json.dumps(payload, ensure_ascii=True, separators=(",", ":"), default=str))


def _loggable_login(login: str) -> str:
    """Login per i log: troncato (json.dumps ne esegue l'escape dei controlli)."""
    return login[:LOGIN_MAX_BYTES]


# ─── Validazioni condivise con types.ts ───────────────────────────────


class PolicyError(ValueError):
    """policy.json assente dal contratto (§5.3-§5.4): epoch sconosciuto."""


def _as_int(value: Any) -> Optional[int]:
    """
    Intero JSON con la semantica di Number.isInteger in TS: un float integrale
    (1.0, 1e0) vale come intero, un booleano no.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def _int_in_range(value: Any, minimum: int, maximum: int = MAX_INT32) -> Optional[int]:
    number = _as_int(value)
    if number is None or number < minimum or number > maximum:
        return None
    return number


def is_reserved_login(login: str) -> bool:
    """Username riservato agli utenti di servizio (prefisso caldes-, case-insensitive)."""
    return login.lower().startswith(RESERVED_PREFIX)


def is_valid_principal(name: Any) -> bool:
    """Principal canonico: minuscole, cifre, '-' e '_' (1-64), mai riservato."""
    return isinstance(name, str) and _PRINCIPAL_RE.fullmatch(name) is not None and not is_reserved_login(name)


def _utf8_length(text: str) -> Optional[int]:
    try:
        return len(text.encode("utf-8"))
    except UnicodeEncodeError:
        # Surrogati isolati (possibili solo da escape JSON): fail-closed.
        return None


def is_valid_path_segment(name: Any) -> bool:
    """
    Segmento di path delle liste readonly/hidden della policy: 1-255 byte
    UTF-8, niente '/', '\\' né controlli, non inizia con '.'; '_' ammesso.
    """
    if not isinstance(name, str) or not name:
        return False
    if _FORBIDDEN_SEGMENT_RE.search(name) or name.startswith("."):
        return False
    length = _utf8_length(name)
    return length is not None and 1 <= length <= 255


def parse_contract_timestamp(value: Any) -> float:
    """
    Timestamp del contratto (§5.4): YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|±HH:MM) con
    data e ora reali. `datetime.fromisoformat` non basta: accetta orari senza
    fuso. Restituisce i secondi Unix; lancia ValueError.
    """
    if not isinstance(value, str):
        raise ValueError("timestamp non stringa")
    match = _TIMESTAMP_RE.fullmatch(value)
    if match is None:
        raise ValueError("timestamp non valido")
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    # Come parseTimestamp in TS, dove Date.UTC sposta gli anni 0-99 al 1900.
    if year < 100:
        raise ValueError("timestamp non valido")
    fraction = match.group(7)
    micro = int((fraction[1:] + "000000")[:6]) if fraction else 0
    if match.group(8) == "Z":
        tz = timezone.utc
    else:
        off_h, off_m = int(match.group(10)), int(match.group(11))
        if off_h > 23 or off_m > 59:
            raise ValueError("timestamp non valido")
        delta = timedelta(hours=off_h, minutes=off_m)
        tz = timezone(delta if match.group(9) == "+" else -delta)
    try:
        moment = datetime(year, month, day, hour, minute, second, micro, tzinfo=tz)
    except ValueError as err:  # 31 settembre, ore 24, secondi 60...
        raise ValueError("timestamp non valido") from err
    return moment.timestamp()


def _reject_constant(name: str) -> Any:
    # NaN e Infinity non sono JSON: JSON.parse in TS li rifiuta.
    raise ValueError("costante JSON non ammessa: %s" % name)


def _decode_json(data: bytes) -> Any:
    """Bytes UTF-8 stretti → valore JSON; lancia ValueError."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as err:
        raise ValueError("non UTF-8") from err
    try:
        return json.loads(text, parse_constant=_reject_constant)
    except RecursionError as err:
        raise ValueError("JSON troppo annidato") from err
    except ValueError as err:
        raise ValueError("JSON non valido") from err


def validate_policy(doc: Any, principal: str) -> int:
    """
    Regole dei lettori della policy (contratto §5.4, specchio di parsePolicy in
    types.ts): campi richiesti e tipi rigorosi, campi sconosciuti ignorati,
    principal uguale a quello configurato. Restituisce credential_epoch;
    lancia PolicyError col motivo.
    """
    if not isinstance(doc, dict):
        raise PolicyError("non è un oggetto JSON")
    if _as_int(doc.get("schema")) != CONTROL_PLANE_SCHEMA:
        raise PolicyError("schema non supportato: %s" % json.dumps(doc.get("schema"), default=str)[:32])
    if _int_in_range(doc.get("version"), 1) is None:
        raise PolicyError("version non valida")
    try:
        parse_contract_timestamp(doc.get("generated_at"))
    except ValueError as err:
        raise PolicyError("generated_at non valido") from err
    if doc.get("backend_mode") not in BACKEND_MODES:
        raise PolicyError("backend_mode non valido")
    mode = doc.get("mode")
    if mode not in POLICY_MODES:
        raise PolicyError("mode non valido")
    reasons = doc.get("reasons")
    if not isinstance(reasons, list) or not all(isinstance(r, str) for r in reasons):
        raise PolicyError("reasons non valido")
    policy_principal = doc.get("principal")
    if not is_valid_principal(policy_principal):
        raise PolicyError("principal non valido")
    if policy_principal != principal:
        raise PolicyError("principal diverso da quello configurato")
    volume_id = doc.get("volume_id")
    if not (volume_id is None or (isinstance(volume_id, str) and _UUID_RE.fullmatch(volume_id))):
        raise PolicyError("volume_id non valido")
    epoch = _int_in_range(doc.get("epoch"), 0)
    if epoch is None:
        raise PolicyError("epoch non valido")
    if (volume_id is None) != (epoch == 0):
        raise PolicyError("volume_id ed epoch incoerenti")
    if mode == "live" and volume_id is None:
        raise PolicyError("live senza volume")
    credential_epoch = _int_in_range(doc.get("credential_epoch"), 0)
    if credential_epoch is None:
        raise PolicyError("credential_epoch non valido")
    for field in ("readonly", "hidden"):
        names = doc.get(field)
        if not isinstance(names, list) or not all(is_valid_path_segment(n) for n in names):
            raise PolicyError("%s non valido" % field)
    return credential_epoch


def parse_policy_bytes(data: bytes, principal: str) -> int:
    """Contenuto di policy.json → credential_epoch; lancia PolicyError."""
    if len(data) > CONTROL_FILE_MAX_BYTES:
        raise PolicyError("oltre %d byte" % CONTROL_FILE_MAX_BYTES)
    try:
        doc = _decode_json(data)
    except ValueError as err:
        raise PolicyError(str(err)) from err
    return validate_policy(doc, principal)


# ─── Configurazione ───────────────────────────────


class ConfigError(Exception):
    """Variabile assente o malformata: il plugin non si carica."""

    def __init__(self, option: str, reason: str) -> None:
        super().__init__("%s: %s" % (option, reason))
        self.option = option
        self.reason = reason


IPNetwork = Union[ipaddress.IPv4Network, ipaddress.IPv6Network]
IPAddress = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]


class BackendEndpoint(NamedTuple):
    scheme: str
    host: str
    port: int
    path: str

    @property
    def display(self) -> str:
        host = "[%s]" % self.host if ":" in self.host else self.host
        return "%s://%s:%d%s" % (self.scheme, host, self.port, self.path)


class Settings(NamedTuple):
    principal: str
    endpoint: BackendEndpoint
    service_token: str
    svc_networks: Tuple[IPNetwork, ...]
    svc_password_sha256: str
    probe_password_sha256: str
    authcache_key: bytes
    authcache_dir: str
    policy_file: str


def _required(environ: Mapping[str, str], name: str) -> str:
    value = environ.get(name)
    if value is None or value == "":
        raise ConfigError(name, "variabile obbligatoria assente")
    return value


def _parse_endpoint(raw: str) -> BackendEndpoint:
    name = "CALDAV_BACKEND_URL"
    if raw != raw.strip() or _CONTROL_CHARS_RE.search(raw):
        raise ConfigError(name, "spazi o caratteri di controllo")
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError as err:
        raise ConfigError(name, "URL non valido (%s)" % err) from None
    if parts.scheme not in ("http", "https"):
        raise ConfigError(name, "schema diverso da http/https")
    if not parts.hostname:
        raise ConfigError(name, "host assente")
    if parts.username is not None or parts.password is not None:
        raise ConfigError(name, "credenziali nell'URL non ammesse")
    if parts.query or parts.fragment:
        raise ConfigError(name, "query o fragment non ammessi")
    if port is None:
        port = 443 if parts.scheme == "https" else 80
    path = parts.path.rstrip("/") + "/verify-credentials"
    return BackendEndpoint(parts.scheme, parts.hostname, port, path)


def _parse_networks(raw: str) -> Tuple[IPNetwork, ...]:
    name = "CALDES_SVC_CIDR"
    networks: List[IPNetwork] = []
    for piece in raw.split(","):
        text = piece.strip()
        if not text:
            raise ConfigError(name, "rete vuota nell'elenco")
        try:
            network = ipaddress.ip_network(text, strict=True)
        except ValueError as err:
            raise ConfigError(name, "rete non valida %r (%s)" % (text, err)) from None
        if network.prefixlen == 0:
            raise ConfigError(name, "rete %s: accetterebbe qualsiasi peer" % network)
        # 127.0.0.1 vale solo per il probe (healthcheck): se fosse nella rete di
        # servizio, caldes-svc sarebbe accettato anche da loopback.
        loopbacks = (_LOOPBACK_V4,) if network.version == 4 else (
            ipaddress.IPv6Address("::1"),
            ipaddress.IPv6Address("::ffff:127.0.0.1"),
        )
        if any(addr in network for addr in loopbacks):
            raise ConfigError(name, "rete %s: contiene il loopback, riservato al probe" % network)
        networks.append(network)
    return tuple(networks)


def _parse_sha256(environ: Mapping[str, str], name: str) -> str:
    value = _required(environ, name)
    if _SHA256_HEX_RE.fullmatch(value) is None:
        raise ConfigError(name, "atteso sha256 esadecimale minuscolo (64 caratteri)")
    return value


def _absolute_path(environ: Mapping[str, str], name: str, default: str) -> str:
    value = environ.get(name) or default
    if not os.path.isabs(value) or _CONTROL_CHARS_RE.search(value):
        raise ConfigError(name, "atteso un percorso assoluto")
    return os.path.normpath(value)


def _config_option(configuration: Any, section: str, option: str) -> Optional[Any]:
    """Opzione della config di Radicale o None: get() di 3.7.8 non ha fallback=."""
    try:
        return configuration.get(section, option)
    except KeyError:
        return None


def load_settings(environ: Mapping[str, str], configuration: Any) -> Settings:
    """Legge e valida le variabili del contratto §1.2; lancia ConfigError."""
    principal = _required(environ, "RADICALE_PRINCIPAL")
    if not is_valid_principal(principal):
        raise ConfigError("RADICALE_PRINCIPAL", "atteso ^[a-z0-9][a-z0-9_-]{0,63}$ senza prefisso caldes-")

    endpoint = _parse_endpoint(_required(environ, "CALDAV_BACKEND_URL"))

    token = _required(environ, "CALDAV_SERVICE_TOKEN")
    if _TOKEN_RE.fullmatch(token) is None:
        raise ConfigError("CALDAV_SERVICE_TOKEN", "ammessi solo caratteri ASCII visibili (niente spazi)")

    networks = _parse_networks(_required(environ, "CALDES_SVC_CIDR"))
    svc_sha = _parse_sha256(environ, "CALDES_SVC_PASSWORD_SHA256")
    probe_sha = _parse_sha256(environ, "CALDES_PROBE_PASSWORD_SHA256")

    key = _required(environ, "CALDES_AUTHCACHE_KEY")
    if len(key) < MIN_AUTHCACHE_KEY_CHARS:
        raise ConfigError("CALDES_AUTHCACHE_KEY", "servono almeno %d caratteri" % MIN_AUTHCACHE_KEY_CHARS)

    authcache_dir = _absolute_path(environ, "CALDES_AUTHCACHE_DIR", DEFAULT_AUTHCACHE_DIR)

    # La policy di auth (credential_epoch) e quella dei rights DEVONO coincidere.
    rights_type = _config_option(configuration, "rights", "type")
    rights_policy = _config_option(configuration, "rights", "caldes_policy_file")
    if rights_policy is not None and (not isinstance(rights_policy, str) or not os.path.isabs(rights_policy)):
        raise ConfigError("[rights] caldes_policy_file", "atteso un percorso assoluto")
    if environ.get("CALDES_POLICY_FILE"):
        policy_file = _absolute_path(environ, "CALDES_POLICY_FILE", DEFAULT_POLICY_FILE)
    elif rights_policy is not None:
        policy_file = os.path.normpath(rights_policy)
    else:
        policy_file = DEFAULT_POLICY_FILE
    if rights_type == RIGHTS_PLUGIN_TYPE:
        rights_file = os.path.normpath(rights_policy) if rights_policy is not None else DEFAULT_POLICY_FILE
        if rights_file != policy_file:
            raise ConfigError(
                "CALDES_POLICY_FILE",
                "diverso da [rights] caldes_policy_file (%s): auth e rights devono leggere la stessa policy" % rights_file,
            )

    return Settings(
        principal=principal,
        endpoint=endpoint,
        service_token=token,
        svc_networks=networks,
        svc_password_sha256=svc_sha,
        probe_password_sha256=probe_sha,
        authcache_key=key.encode("utf-8"),
        authcache_dir=authcache_dir,
        policy_file=policy_file,
    )


# ─── Policy: credential_epoch ───────────────────────────────


class PolicyWatcher:
    """
    Legge credential_epoch da policy.json (contratto §5.3, §9.6): ricontrolla
    il file al massimo una volta al secondo e lo rilegge solo se cambiano
    device, inode, dimensione o mtime. Policy assente o invalida → None
    (epoch sconosciuto). Ogni passaggio fra valido e invalido si registra una
    volta con il motivo.
    """

    def __init__(self, path: str, principal: str) -> None:
        self.path = path
        self._principal = principal
        self._lock = threading.Lock()
        self._checked_at: Optional[float] = None
        self._signature: Optional[Tuple[int, int, int, int]] = None
        self._epoch: Optional[int] = None
        #: None finché la policy non è mai stata valutata.
        self._valid: Optional[bool] = None
        self.reason = "non ancora letta"

    def credential_epoch(self) -> Optional[int]:
        with self._lock:
            now = _monotonic()
            if self._checked_at is None or now - self._checked_at >= POLICY_RELOAD_INTERVAL_SECONDS:
                self._checked_at = now
                self._refresh_locked()
            return self._epoch

    def _refresh_locked(self) -> None:
        try:
            # stat prima di open: una FIFO al posto della policy bloccherebbe open().
            if not stat.S_ISREG(os.stat(self.path).st_mode):
                self._signature = None
                self._set_invalid("non è un file regolare")
                return
            with open(self.path, "rb") as handle:
                st = os.fstat(handle.fileno())
                signature = (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)
                if signature == self._signature:
                    return
                data = handle.read(CONTROL_FILE_MAX_BYTES + 1)
        except FileNotFoundError:
            self._signature = None
            self._set_invalid("assente")
            return
        except OSError as err:
            self._signature = None
            self._set_invalid("illeggibile (%s)" % (err.strerror or err.__class__.__name__))
            return
        self._signature = signature
        try:
            epoch = parse_policy_bytes(data, self._principal)
        except PolicyError as err:
            self._set_invalid(str(err))
            return
        self._set_valid(epoch)

    def _set_invalid(self, reason: str) -> None:
        self._epoch = None
        self.reason = reason
        if self._valid is not False:
            _event("policy_invalid", reason=reason, path=self.path)
        self._valid = False

    def _set_valid(self, epoch: int) -> None:
        self._epoch = epoch
        self.reason = "valida"
        if self._valid is False:
            _event("policy_valid", reason="valida", credential_epoch=epoch)
        elif self._valid is None:
            logger.info("caldes_auth: policy %s valida (credential_epoch %d)", self.path, epoch)
        self._valid = True


# ─── Cache persistita ───────────────────────────────


class PersistedEntry(NamedTuple):
    #: Scadenza in secondi Unix: min(refreshed + 24 h, expires_at).
    exp: int
    #: Ultima conferma positiva del backend, in secondi Unix.
    refreshed: int


class AuthCacheStore:
    """
    Cache persistita di authcache.json (contratto §9.5, authcache.schema.json).
    Il file si legge solo all'avvio; il plugin lavora sulla copia in memoria e
    la riscrive in modo atomico quando cambia. Un errore di scrittura non
    blocca l'autenticazione: la copia in memoria resta valida per il processo
    e il file si riscrive alla modifica successiva. Non è thread-safe da solo:
    lo protegge il lock del plugin.
    """

    def __init__(self, directory: str, key: bytes) -> None:
        self.directory = directory
        self.path = os.path.join(directory, AUTHCACHE_FILENAME)
        self.key_id = hmac.new(key, _AUTHCACHE_KEY_ID_DOMAIN, hashlib.sha256).hexdigest()[:16]
        #: credential_epoch delle voci (None: nessun file valido e nessun epoch ancora visto).
        self.epoch: Optional[int] = None
        self.entries: Dict[str, PersistedEntry] = {}
        #: La copia in memoria non è ancora sul disco (scrittura fallita).
        self.dirty = False
        self._last_error_at: Optional[float] = None

    # ── avvio ──

    def prepare_directory(self) -> None:
        """Crea la cartella (0700) se manca; i problemi si registrano e non sono fatali."""
        try:
            os.makedirs(self.directory, mode=0o700, exist_ok=True)
        except OSError as err:
            self._report_error("cartella non creabile (%s)" % (err.strerror or err.__class__.__name__), force=True)
            return
        if not os.path.isdir(self.directory):
            self._report_error("non è una cartella", force=True)
        elif not os.access(self.directory, os.W_OK | os.X_OK):
            self._report_error("cartella non scrivibile: cache persistita disattivata", force=True)

    def load(self, now: float) -> None:
        """Carica il file; illeggibile, di schema diverso o con key_id diverso → cache vuota."""
        self.epoch, self.entries = None, {}
        try:
            if not stat.S_ISREG(os.stat(self.path).st_mode):
                logger.warning("caldes_auth: %s non è un file regolare, cache persistita vuota", self.path)
                return
            with open(self.path, "rb") as handle:
                data = handle.read(AUTHCACHE_MAX_BYTES + 1)
        except FileNotFoundError:
            return
        except OSError as err:
            logger.warning("caldes_auth: %s illeggibile (%s), cache persistita vuota", self.path, err.strerror)
            return
        try:
            epoch, entries = self._parse(data)
        except ValueError as err:
            logger.warning("caldes_auth: %s ignorato (%s), cache persistita vuota", self.path, err)
            return
        self.epoch = epoch
        self.entries = {k: e for k, e in entries.items() if e.exp > now}
        logger.info("caldes_auth: cache persistita caricata (%d voci, credential_epoch %d)", len(self.entries), epoch)

    def _parse(self, data: bytes) -> Tuple[int, Dict[str, PersistedEntry]]:
        if len(data) > AUTHCACHE_MAX_BYTES:
            raise ValueError("file troppo grande")
        doc = _decode_json(data)
        if not isinstance(doc, dict):
            raise ValueError("non è un oggetto JSON")
        if _as_int(doc.get("schema")) != AUTHCACHE_SCHEMA:
            raise ValueError("schema diverso da %d" % AUTHCACHE_SCHEMA)
        key_id = doc.get("key_id")
        if not isinstance(key_id, str) or _KEY_ID_RE.fullmatch(key_id) is None:
            raise ValueError("key_id non valido")
        if not hmac.compare_digest(key_id, self.key_id):
            raise ValueError("key_id diverso: chiave ruotata")
        epoch = _int_in_range(doc.get("credential_epoch"), 0)
        if epoch is None:
            raise ValueError("credential_epoch non valido")
        raw_entries = doc.get("entries")
        if not isinstance(raw_entries, dict) or len(raw_entries) > PERSISTED_MAX_ENTRIES:
            raise ValueError("entries non valido")
        entries: Dict[str, PersistedEntry] = {}
        for key, value in raw_entries.items():
            if not isinstance(key, str) or _CACHE_KEY_RE.fullmatch(key) is None:
                raise ValueError("chiave di voce non valida")
            if not isinstance(value, dict) or set(value) != {"exp", "refreshed"}:
                raise ValueError("voce non valida")
            exp = _int_in_range(value.get("exp"), 0, 2**53)
            refreshed = _int_in_range(value.get("refreshed"), 0, 2**53)
            if exp is None or refreshed is None:
                raise ValueError("voce non valida")
            entries[key] = PersistedEntry(exp, refreshed)
        return epoch, entries

    # ── modifiche (sotto il lock del plugin) ──

    def reset(self, epoch: int) -> None:
        self.epoch, self.entries = epoch, {}

    def prune(self, now: float) -> None:
        """Toglie le voci scadute e, oltre il limite, quelle confermate da più tempo."""
        live = {k: e for k, e in self.entries.items() if e.exp > now}
        if len(live) > PERSISTED_MAX_ENTRIES:
            newest = sorted(live.items(), key=lambda item: (item[1].refreshed, item[0]), reverse=True)
            live = dict(newest[:PERSISTED_MAX_ENTRIES])
        self.entries = live

    def save(self) -> bool:
        """Scrittura atomica: temporaneo 0600 nella stessa cartella, fsync, rename, fsync della cartella."""
        if self.epoch is None:
            return False
        doc = {
            "schema": AUTHCACHE_SCHEMA,
            "key_id": self.key_id,
            "credential_epoch": self.epoch,
            "entries": {k: {"exp": e.exp, "refreshed": e.refreshed} for k, e in sorted(self.entries.items())},
        }
        data = (json.dumps(doc, separators=(",", ":")) + "\n").encode("ascii")
        tmp = os.path.join(self.directory, ".%s.%d.%s.tmp" % (AUTHCACHE_FILENAME, os.getpid(), secrets.token_hex(6)))
        try:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0), 0o600)
            try:
                os.fchmod(fd, 0o600)
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, self.path)
        except OSError as err:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            self.dirty = True
            self._report_error("scrittura di %s fallita (%s)" % (AUTHCACHE_FILENAME, err.strerror or err.__class__.__name__))
            return False
        self._fsync_directory()
        self.dirty = False
        return True

    def _fsync_directory(self) -> None:
        # Best effort: rende durevole il rename (non tutti i filesystem lo permettono).
        try:
            fd = os.open(self.directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        except OSError:
            return
        try:
            os.fsync(fd)
        except OSError:
            pass
        finally:
            os.close(fd)

    def _report_error(self, reason: str, force: bool = False) -> None:
        now = _monotonic()
        if not force and self._last_error_at is not None and now - self._last_error_at < EVENT_RATE_LIMIT_SECONDS:
            return
        self._last_error_at = now
        _event("config_error", logging.ERROR, option="CALDES_AUTHCACHE_DIR", reason=reason, path=self.directory)


# ─── Chiamata a verify-credentials ───────────────────────────────


class BackendUnavailableError(RuntimeError):
    """
    verify-credentials non ha dato un esito esplicito e non c'è una credenziale
    valida in cache: Radicale risponde 500 senza delay e il client riprova.
    """


class VerifyOutcome(NamedTuple):
    #: "ok", "denied" oppure "error".
    kind: str
    status: Optional[int] = None
    error: Optional[str] = None
    backend_principal: Optional[str] = None
    #: Scadenza dell'app-password (secondi Unix) se il backend la comunica.
    expires_at: Optional[float] = None
    #: False se expires_at è presente ma fuori formato: la voce non si persiste.
    expires_known: bool = True


OK, DENIED, ERROR = "ok", "denied", "error"

# Dalla 3.10 socket.timeout è un alias deprecato di TimeoutError: si solleva
# TimeoutError e si riconoscono entrambi (fino alla 3.9 erano classi diverse).
_TIMEOUT_ERRORS: Tuple[type, ...] = tuple({TimeoutError, getattr(socket, "timeout", TimeoutError)})


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError("timeout di verify-credentials")
    return left


def _resolve(host: str, port: int, deadline: float) -> List[Tuple[Any, ...]]:
    """
    getaddrinfo con scadenza: la risoluzione bloccante gira in un thread
    daemon, così un DNS lento (es. alias api-int con l'API ferma) non supera
    il timeout complessivo.
    """
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if address.version == 4:
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (host, port))]
        return [(socket.AF_INET6, socket.SOCK_STREAM, 0, "", (host, port, 0, 0))]

    result: Dict[str, Any] = {}
    done = threading.Event()

    def worker() -> None:
        try:
            result["value"] = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        except BaseException as err:  # noqa: BLE001 (riportato al chiamante)
            result["error"] = err
        finally:
            done.set()

    threading.Thread(target=worker, name="caldes-auth-dns", daemon=True).start()
    if not done.wait(_remaining(deadline)):
        raise TimeoutError("risoluzione di %s oltre il timeout" % host)
    if "error" in result:
        raise result["error"]
    return result["value"]


def _connect(host: str, port: int, deadline: float) -> socket.socket:
    last_error: Optional[BaseException] = None
    for family, socktype, proto, _canonname, address in _resolve(host, port, deadline):
        sock = socket.socket(family, socktype, proto)
        try:
            sock.settimeout(_remaining(deadline))
            sock.connect(address)
            return sock
        except OSError as err:
            sock.close()
            last_error = err
            if isinstance(err, _TIMEOUT_ERRORS):
                break
    if last_error is not None:
        raise last_error
    raise OSError("nessun indirizzo per %s" % host)


_ssl_context: Any = None


def _tls_context() -> Any:
    global _ssl_context
    if _ssl_context is None:
        import ssl  # solo con CALDAV_BACKEND_URL https

        _ssl_context = ssl.create_default_context()
    return _ssl_context


def post_verify_credentials(
    endpoint: BackendEndpoint, body: bytes, headers: Dict[str, str], timeout: float = BACKEND_TIMEOUT_SECONDS
) -> Tuple[int, bytes]:
    """
    POST con timeout complessivo (risoluzione, connessione, invio, intestazioni
    e corpo); nessun proxy da env, nessun redirect. Restituisce (status, corpo);
    lancia OSError, http.client.HTTPException o ValueError.
    """
    deadline = time.monotonic() + timeout
    sock = _connect(endpoint.host, endpoint.port, deadline)
    conn: Optional[http.client.HTTPConnection] = None
    try:
        if endpoint.scheme == "https":
            sock = _tls_context().wrap_socket(sock, server_hostname=endpoint.host)
            conn = http.client.HTTPSConnection(endpoint.host, endpoint.port, timeout=timeout)
        else:
            conn = http.client.HTTPConnection(endpoint.host, endpoint.port, timeout=timeout)
        # Socket già connesso: http.client non riapre la connessione.
        conn.sock = sock
        sock.settimeout(_remaining(deadline))
        conn.request("POST", endpoint.path, body=body, headers=headers)
        sock.settimeout(_remaining(deadline))
        response = conn.getresponse()
        _remaining(deadline)
        chunks = bytearray()
        # Con "Connection: close" nella risposta (Node la manda perché la
        # richiesta la chiede) http.client affida il socket alla risposta, che
        # lo chiude appena letto l'ultimo byte del Content-Length: il giro
        # successivo non deve più toccare il socket (settimeout darebbe EBADF).
        while not response.isclosed():
            sock.settimeout(_remaining(deadline))
            chunk = response.read1(8192)
            if not chunk:
                break
            chunks += chunk
            if len(chunks) > BACKEND_MAX_RESPONSE_BYTES:
                raise ValueError("risposta oltre %d byte" % BACKEND_MAX_RESPONSE_BYTES)
        return response.status, bytes(chunks)
    finally:
        if conn is not None:
            conn.close()
        sock.close()


def classify_response(status: int, body: bytes) -> VerifyOutcome:
    """
    Esito di verify-credentials (contratto §9.4): negazione SOLO con 401 e
    corpo {ok: false}; successo solo con 200 e {ok: true}; il resto è errore
    del backend (compreso il 401 del middleware del Bearer).
    """
    try:
        doc = _decode_json(body)
    except ValueError:
        doc = None
    if status == 200 and isinstance(doc, dict) and doc.get("ok") is True:
        principal = doc.get("principal")
        raw_expiry = doc.get("expires_at")
        expires_at: Optional[float] = None
        known = True
        if raw_expiry is not None:
            try:
                expires_at = parse_contract_timestamp(raw_expiry)
            except ValueError:
                known = False
        return VerifyOutcome(
            OK,
            status=status,
            backend_principal=principal if isinstance(principal, str) else None,
            expires_at=expires_at,
            expires_known=known,
        )
    if status == 401 and isinstance(doc, dict) and doc.get("ok") is False:
        return VerifyOutcome(DENIED, status=status)
    if status == 401:
        return VerifyOutcome(ERROR, status=status, error="bearer_rejected")
    if 200 <= status < 300:
        return VerifyOutcome(ERROR, status=status, error="out_of_contract")
    return VerifyOutcome(ERROR, status=status)


def _describe_exception(err: BaseException) -> str:
    if isinstance(err, _TIMEOUT_ERRORS):
        return "timeout"
    if isinstance(err, ConnectionRefusedError):
        return "connection_refused"
    if isinstance(err, (http.client.RemoteDisconnected, ConnectionResetError, BrokenPipeError)):
        return "connection_closed"
    if isinstance(err, socket.gaierror):
        return "dns_error"
    return err.__class__.__name__


# ─── Plugin ───────────────────────────────


def _peer_address(raw: Any) -> Optional[IPAddress]:
    """Peer TCP (REMOTE_ADDR) normalizzato: gli IPv4 mappati in IPv6 tornano IPv4."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _in_networks(address: IPAddress, networks: Tuple[IPNetwork, ...]) -> bool:
    return any(address.version == net.version and address in net for net in networks)


def is_valid_device_login(login: str) -> bool:
    """Login device inoltrabile al backend: 1-255 byte UTF-8, niente caratteri di controllo."""
    if not login or _CONTROL_CHARS_RE.search(login):
        return False
    length = _utf8_length(login)
    return length is not None and length <= LOGIN_MAX_BYTES


def is_valid_device_password(password: str) -> bool:
    return bool(password) and len(password) <= PASSWORD_MAX_CHARS and _utf8_length(password) is not None


class Auth(auth.BaseAuth):
    """Plugin `[auth] type = caldes_auth` (vedi la docstring del modulo)."""

    def __init__(self, configuration: Any) -> None:
        super().__init__(configuration)
        try:
            settings = load_settings(os.environ, configuration)
        except ConfigError as err:
            _event("config_error", logging.ERROR, option=err.option, reason=err.reason)
            raise RuntimeError("caldes_auth: configurazione non valida: %s: %s" % (err.option, err.reason)) from None
        self._settings = settings
        #: Protegge cache in memoria, cache persistita e rate limit dei log.
        self._state_lock = threading.Lock()
        #: chiave di cache → scadenza (orologio monotono).
        self._memory: "OrderedDict[str, float]" = OrderedDict()
        self._policy = PolicyWatcher(settings.policy_file, settings.principal)
        self._store = AuthCacheStore(settings.authcache_dir, settings.authcache_key)
        self._store.prepare_directory()
        self._store.load(_wall_time())
        self._last_missing_xra_at: Optional[float] = None
        logger.info(
            "caldes_auth: principal %r, backend %s, rete di servizio %s, policy %s, cache persistita %s",
            settings.principal,
            settings.endpoint.display,
            ", ".join(str(n) for n in settings.svc_networks),
            settings.policy_file,
            self._store.path,
        )
        # Allinea subito l'epoch delle cache alla policy (e la registra se manca).
        self._sync_credential_epoch()

    # ── punto d'ingresso (chiamato da BaseAuth.login) ──

    def _login_ext(self, login: str, password: str, context: Any) -> str:
        if not login:
            return ""
        if is_reserved_login(login):
            return self._login_reserved(login, password, context)
        return self._login_device(login, password, context)

    # ── utenti di servizio ──

    def _login_reserved(self, login: str, password: str, context: Any) -> str:
        settings = self._settings
        raw_peer = getattr(context, "remote_addr", None)
        peer = _peer_address(raw_peer)
        expected: Optional[str] = None
        allowed = False
        reason = "unknown_user"
        if login == SERVICE_USER:
            expected = settings.svc_password_sha256
            allowed = peer is not None and _in_networks(peer, settings.svc_networks)
        elif login == PROBE_USER:
            expected = settings.probe_password_sha256
            allowed = peer is not None and (_in_networks(peer, settings.svc_networks) or peer == _LOOPBACK_V4)
        # Confronto sempre eseguito, anche con peer non ammesso: tempo indipendente dal peer.
        digest = hashlib.sha256(password.encode("utf-8", "surrogatepass")).hexdigest()
        password_ok = expected is not None and hmac.compare_digest(digest, expected)
        if expected is not None:
            if allowed and password_ok:
                return login
            reason = "peer" if not allowed else "password"
        _event(
            "reserved_denied",
            login=_loggable_login(login),
            peer=str(peer) if peer is not None else (raw_peer or None),
            reason=reason,
        )
        return ""

    # ── device ──

    def _login_device(self, login: str, password: str, context: Any) -> str:
        if not is_valid_device_login(login) or not is_valid_device_password(password):
            return ""
        principal = self._settings.principal
        forwarded = self._forwarded_for(context)
        epoch = self._sync_credential_epoch()
        key = self._cache_key(epoch, login, password) if epoch is not None else None

        if key is not None and self._memory_hit(key):
            return principal

        outcome = self._verify(login, password, forwarded)
        if outcome.kind == OK:
            if outcome.backend_principal != principal:
                _event("principal_mismatch", login=_loggable_login(login), backend_principal=outcome.backend_principal)
            if key is not None and epoch is not None:
                self._remember(key, epoch, outcome)
            return principal
        if outcome.kind == DENIED:
            self._forget(login, password, epoch)
            return ""

        fields: Dict[str, Any] = {"login": _loggable_login(login)}
        if outcome.status is not None:
            fields["status"] = outcome.status
        if outcome.error is not None:
            fields["error"] = outcome.error
        _event("backend_error", logging.ERROR, **fields)
        if key is not None and epoch is not None and self._stale_hit(key, epoch):
            _event("stale_if_error", login=_loggable_login(login))
            return principal
        detail = " ".join(str(part) for part in (outcome.status, outcome.error) if part is not None)
        raise BackendUnavailableError(
            "caldes_auth: verify-credentials non disponibile (%s) e nessuna credenziale valida in cache" % detail
        )

    def _forwarded_for(self, context: Any) -> Optional[str]:
        """X-Forwarded-For da X-Remote-Addr (solo se è un IP valido); altrimenti evento rate-limited."""
        raw = getattr(context, "x_remote_addr", None)
        reason = "absent"
        if isinstance(raw, str) and raw.strip():
            try:
                return str(ipaddress.ip_address(raw.strip()))
            except ValueError:
                reason = "invalid"
        now = _monotonic()
        with self._state_lock:
            if self._last_missing_xra_at is not None and now - self._last_missing_xra_at < EVENT_RATE_LIMIT_SECONDS:
                return None
            self._last_missing_xra_at = now
        _event("missing_x_remote_addr", peer=getattr(context, "remote_addr", None), reason=reason)
        return None

    def _verify(self, login: str, password: str, forwarded: Optional[str]) -> VerifyOutcome:
        settings = self._settings
        body = json.dumps({"username": login, "password": password}).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": "Bearer " + settings.service_token,
            "User-Agent": "caldes-auth/1",
            "Connection": "close",
        }
        if forwarded:
            headers["X-Forwarded-For"] = forwarded
        try:
            status, payload = post_verify_credentials(settings.endpoint, body, headers)
        except (OSError, http.client.HTTPException, ValueError) as err:
            return VerifyOutcome(ERROR, error=_describe_exception(err))
        return classify_response(status, payload)

    # ── cache ──

    def _cache_key(self, epoch: int, login: str, password: str) -> str:
        message = b"".join(
            (
                _AUTHCACHE_KEY_DOMAIN,
                str(epoch).encode("ascii"),
                b"\0",
                login.encode("utf-8"),
                b"\0",
                password.encode("utf-8"),
            )
        )
        return hmac.new(self._settings.authcache_key, message, hashlib.sha256).hexdigest()

    def _sync_credential_epoch(self) -> Optional[int]:
        """
        credential_epoch corrente (None se la policy è assente o invalida).
        Quando cambia, anche all'indietro, svuota la cache in memoria e
        riscrive authcache.json vuoto prima di rispondere alla richiesta.
        """
        epoch = self._policy.credential_epoch()
        if epoch is None:
            return None
        with self._state_lock:
            store = self._store
            if store.epoch != epoch:
                old = store.epoch
                self._memory.clear()
                store.reset(epoch)
                if old is not None:
                    _event("credential_epoch_changed", old=old, new=epoch)
                    store.save()
        return epoch

    def _memory_hit(self, key: str) -> bool:
        now = _monotonic()
        with self._state_lock:
            expires = self._memory.get(key)
            if expires is None:
                return False
            if now >= expires:
                del self._memory[key]
                return False
            self._memory.move_to_end(key)
            return True

    def _remember(self, key: str, epoch: int, outcome: VerifyOutcome) -> None:
        """Esito positivo del backend: cache in memoria e, se l'epoch è ancora quello, cache persistita."""
        now_mono = _monotonic()
        now = _wall_time()
        with self._state_lock:
            store = self._store
            if store.epoch != epoch:
                # L'epoch è cambiato durante la chiamata: l'esito appartiene al vecchio.
                return
            memory_expiry = now_mono + MEMORY_TTL_SECONDS
            if outcome.expires_at is not None:
                memory_expiry = min(memory_expiry, now_mono + (outcome.expires_at - now))
            if not outcome.expires_known:
                memory_expiry = min(memory_expiry, now_mono)
            if memory_expiry > now_mono:
                self._memory[key] = memory_expiry
                self._memory.move_to_end(key)
                while len(self._memory) > MEMORY_MAX_ENTRIES:
                    self._memory.popitem(last=False)
            else:
                self._memory.pop(key, None)

            changed = store.dirty
            if outcome.expires_known:
                now_s = int(now)
                exp = now_s + PERSISTED_TTL_SECONDS
                if outcome.expires_at is not None:
                    exp = min(exp, int(math.floor(outcome.expires_at)))
                current = store.entries.get(key)
                if exp <= now_s:
                    if current is not None:
                        del store.entries[key]
                        changed = True
                elif current is None or now_s - current.refreshed >= PERSISTED_REFRESH_SECONDS or exp < current.exp:
                    store.entries[key] = PersistedEntry(exp, now_s)
                    changed = True
            if changed:
                store.prune(now)
                store.save()

    def _forget(self, login: str, password: str, epoch: Optional[int]) -> None:
        """
        Negazione esplicita (401 {ok:false}): la voce esce da entrambe le cache.
        Con la policy illeggibile (epoch sconosciuto) si toglie la voce
        dell'ultimo epoch noto: tornerebbe utilizzabile se la policy rientrasse
        con lo stesso epoch.
        """
        with self._state_lock:
            store = self._store
            target = epoch if epoch is not None else store.epoch
            if target is None:
                return
            key = self._cache_key(target, login, password)
            self._memory.pop(key, None)
            if store.epoch == target and key in store.entries:
                del store.entries[key]
                store.save()

    def _stale_hit(self, key: str, epoch: int) -> bool:
        now = _wall_time()
        with self._state_lock:
            store = self._store
            if store.epoch != epoch:
                return False
            entry = store.entries.get(key)
            return entry is not None and entry.exp > now
