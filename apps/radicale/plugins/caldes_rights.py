"""
Plugin rights di Radicale 3.7.8 per Caldes (fase F1 del passaggio del
calendario a Radicale).

Fonte normativa: docs/calendar-radicale/contracts/control-plane.md (§4
identità del volume, §5 policy, §7 heartbeat, §8 permessi) e i casi condivisi
in docs/calendar-radicale/contracts/fixtures/. Lo specchio TypeScript è
apps/api/src/lib/calendar/radicale/types.ts (policyFromState, parsePolicy,
parseHeartbeat, effectiveDeviceMode, expectedRadicaleRights): una modifica va
fatta prima nel contratto, poi lì e qui, con i casi condivisi aggiornati.

Cosa decide, a ogni chiamata di authorization(user, path):

- la modalità effettiva dei device (shadow, live, frozen) da `policy.json` e
  `heartbeat.json`, che l'API scrive sul volume caldes_control (montato qui in
  sola lettura). Policy assente o invalida → shadow con l'identità e le liste
  dell'ultima policy valida vista dal processo; senza alcuna policy valida
  dall'avvio nessun permesso sotto il principal. Heartbeat assente, invalido,
  più vecchio di 10 minuti, nel futuro di oltre 60 s, di un altro epoch o (con
  policy live) di un backend non radicale → frozen. L'età del heartbeat si
  misura con l'orologio corrente a ogni chiamata;
- l'identità del volume: le dead prop `{urn:calicchia:caldes}volume-id` ed
  `epoch` nel `.Radicale.props` del principal devono coincidere con quelle
  della policy; altrimenti i device non hanno alcun permesso sotto il principal
  (resta R sulla root). Senza W sul principal Radicale non lo crea al login:
  su un volume vuoto la PROPFIND risponde 403 e non nasce nessuna directory;
- la matrice del contratto §8: nessun W su principal diversi da quello
  canonico (niente /iphone/ né /caldes-svc/), `_canary` scrivibile solo dal
  probe in live, collezioni `readonly` in sola lettura, `hidden` e `_*` senza
  permessi (non elencate), mai `D` ai device (con permit_delete_collection =
  False la DELETE di una collezione risponde 403), sempre e solo R sul
  principal (anche in live: il marker lo scrive solo caldes-svc). `caldes-svc` ha R sulla
  root, RW sul principal e rwD sulle collezioni senza controlli di modalità o
  identità: serve all'inizializzazione (MKCOL e PROPPATCH del marker).

I file si ricontrollano al massimo una volta al secondo e si rileggono solo se
cambiano inode, dimensione, mtime o ctime; la valutazione è thread-safe (il
server di Radicale serve le richieste in parallelo). Un errore inatteso nella
valutazione vale come "nessun permesso sotto il principal" (fail-closed).

Configurazione ([rights] di Radicale; `Configuration.get` non ha fallback=,
quindi un'opzione assente arriva come KeyError e vale il default):

    [rights]
    type = caldes_rights
    caldes_policy_file = /control/policy.json        (default)
    caldes_heartbeat_file = /control/heartbeat.json  (default)
    # solo per i test: intervallo minimo fra due controlli dei file (default 1 s)
    caldes_reload_interval = 1

Ambiente: RADICALE_PRINCIPAL (obbligatoria, es. `federico`). Le props del
principal si leggono da `<[storage] filesystem_folder>/collection-root/
<principal>/.Radicale.props`.

Il costruttore applica e verifica anche la patch di fedeltà di vobject
(caldes_vobject_fix): se non funziona Radicale non parte, così nessuna
scrittura di un device passa da un vobject non corretto (invariante 3 del
design, §1). Configurazione invalida → eccezione al caricamento (Radicale non
parte e il container resta unhealthy).

Solo libreria standard + Radicale.
"""

from __future__ import annotations

import calendar
import datetime
import json
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Sequence, Tuple

from radicale import rights
from radicale.log import logger

# ─── Costanti del contratto (control-plane.md, types.ts) ──────

#: Versione del formato di policy.json e heartbeat.json.
CONTROL_PLANE_SCHEMA = 1
#: Namespace XML delle dead prop dell'applicazione.
CALDES_NAMESPACE = "urn:calicchia:caldes"
#: Dead prop del marker d'identità sul principal (notazione Clark, valori stringa).
DEAD_PROP_VOLUME_ID = "{urn:calicchia:caldes}volume-id"
DEAD_PROP_EPOCH = "{urn:calicchia:caldes}epoch"

#: Default delle opzioni [rights] (volume caldes_control montato in /control).
DEFAULT_POLICY_FILE = "/control/policy.json"
DEFAULT_HEARTBEAT_FILE = "/control/heartbeat.json"
#: Sottocartella delle collezioni dentro filesystem_folder e file delle props.
RADICALE_COLLECTION_ROOT = "collection-root"
RADICALE_PROPS_FILE = ".Radicale.props"

#: Oltre questa dimensione policy.json e heartbeat.json sono invalidi.
CONTROL_FILE_MAX_BYTES = 65_536
#: Limite di sicurezza per le props del principal (poche centinaia di byte).
PROPS_FILE_MAX_BYTES = 1_048_576
#: Heartbeat più vecchio di così → frozen (estremo incluso: 600 s esatti valgono ancora).
HEARTBEAT_STALE_AFTER_MS = 600_000
#: Tolleranza per un heartbeat con ts nel futuro (stesso host, stesso orologio).
HEARTBEAT_MAX_FUTURE_SKEW_MS = 60_000
#: Intervallo minimo fra due controlli dei file del control-plane.
CONTROL_RELOAD_MIN_INTERVAL_S = 1.0
#: Limite dell'opzione caldes_reload_interval.
CONTROL_RELOAD_MAX_INTERVAL_S = 60.0

RESERVED_USERNAME_PREFIX = "caldes-"
SERVICE_USER = "caldes-svc"
PROBE_USER = "caldes-probe"
CANARY_COLLECTION = "_canary"
SYSTEM_COLLECTION_PREFIX = "_"

BACKEND_MODES = ("postgres", "cutover", "radicale", "rollback", "finalized")
POLICY_MODES = ("shadow", "live", "frozen")
#: Condizioni che forzano la policy a frozen (contratto §6.2), nell'ordine fisso.
POLICY_REASONS = (
    "write_freeze",
    "restore_guard",
    "rebuild_required",
    "identity_uninitialized",
    "identity_mismatch",
    "identity_unverified",
)
#: Motivi della modalità effettiva diversa da quella della policy (contratto §7.3), nell'ordine fisso.
EFFECTIVE_MODE_REASONS = (
    "policy_missing",
    "policy_invalid",
    "heartbeat_missing",
    "heartbeat_invalid",
    "heartbeat_stale",
    "heartbeat_future",
    "heartbeat_epoch_mismatch",
    "heartbeat_mode_mismatch",
)
#: Modalità del backend compatibili con una policy live (contratto §7.3).
LIVE_BACKEND_MODES = ("radicale", "finalized")

MAX_INT32 = 2_147_483_647

# Espressioni regolari: sempre fullmatch (in Python '$' accetta anche un a capo
# finale) e solo cifre ASCII ('\d' accetterebbe le cifre Unicode).
_UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_PRINCIPAL_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
# '/', '\', controlli C0 (U+0000-U+001F), DEL e C1 (U+007F-U+009F): stessi intervalli della 162.
_FORBIDDEN_SEGMENT_CHARS_RE = re.compile("[/\\\\\u0000-\u001f\u007f-\u009f]")
_TIMESTAMP_RE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})"
    r"(?:\.([0-9]{1,9}))?(Z|([+-])([0-9]{2}):([0-9]{2}))"
)
_API_VERSION_RE = re.compile(r"[\x21-\x7e]{1,64}")
_MARKER_EPOCH_RE = re.compile(r"[1-9][0-9]{0,9}")


class ControlFileError(ValueError):
    """Formato non valido di un file o di un valore del control-plane."""


class CaldesRightsConfigError(RuntimeError):
    """Configurazione del plugin non valida: Radicale non deve partire."""


# ─── Eventi di log (contratto §9.7) ───────────────────────────


def log_event(event: str, level: str = "warning", **fields: Any) -> None:
    """
    Una riga `caldes_event {json}`: mai password né dati personali. Il campo
    `plugin` distingue gli eventi dei due plugin (caldes_auth registra anche
    policy_invalid/policy_valid) per chi li inoltra a Telegram e Bugsink.
    """
    payload: Dict[str, Any] = {"event": event, "plugin": "caldes_rights"}
    payload.update(fields)
    getattr(logger, level)("caldes_event %s", json.dumps(payload, ensure_ascii=False, sort_keys=False))


# ─── Validazione dei valori ───────────────────────────────────


def _as_int(value: Any, minimum: int, maximum: int = MAX_INT32) -> Optional[int]:
    """
    Intero nel contratto come lo vede JSON.parse in TS: un numero intero
    (anche scritto 1.0 o 1e0) nell'intervallo; mai un booleano.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, float) and math.isfinite(value) and value.is_integer():
        number = int(value)
    else:
        return None
    return number if minimum <= number <= maximum else None


def is_reserved_username(username: str) -> bool:
    """Prefisso `caldes-` (senza distinguere maiuscole e minuscole): riservato ai servizi."""
    return username.lower().startswith(RESERVED_USERNAME_PREFIX)


def is_valid_principal(name: Any) -> bool:
    """Principal canonico: minuscole, cifre, '-' e '_', 1-64 caratteri, mai riservato."""
    return isinstance(name, str) and _PRINCIPAL_RE.fullmatch(name) is not None and not is_reserved_username(name)


def is_valid_path_segment(name: Any) -> bool:
    """
    Segmento di path ammesso nelle liste della policy: 1-255 byte UTF-8,
    niente '/', '\\' né caratteri di controllo, non inizia con '.'. Il
    prefisso '_' è ammesso (collezioni di sistema).
    """
    if not isinstance(name, str) or not name or name.startswith("."):
        return False
    if _FORBIDDEN_SEGMENT_CHARS_RE.search(name):
        return False
    try:
        size = len(name.encode("utf-8"))
    except UnicodeEncodeError:  # surrogati isolati: mai un nome reale
        return False
    return 1 <= size <= 255


def is_valid_collection_name(name: Any) -> bool:
    """Nome di collezione del sidecar: come is_valid_path_segment ma senza il prefisso '_'."""
    return is_valid_path_segment(name) and not name.startswith(SYSTEM_COLLECTION_PREFIX)


def parse_timestamp_ms(value: Any) -> int:
    """
    Timestamp del contratto (`YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|±HH:MM)`) con data
    e ora reali → millisecondi dall'epoch, con le cifre oltre il millisecondo
    troncate come Date.parse in TS. Rifiuta anche gli anni 0000-0099, che
    parseTimestamp() in TS non accetta (Date.UTC li sposta al 1900-1999).
    `datetime.fromisoformat` non basta: accetta orari senza fuso.
    """
    if not isinstance(value, str):
        raise ControlFileError("timestamp non valido")
    match = _TIMESTAMP_RE.fullmatch(value)
    if match is None:
        raise ControlFileError("timestamp non valido")
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    if year < 100 or hour > 23 or minute > 59 or second > 59:
        raise ControlFileError("timestamp non valido")
    try:
        datetime.date(year, month, day)
    except ValueError as exc:
        raise ControlFileError("timestamp non valido") from exc
    offset_minutes = 0
    if match.group(8) != "Z":
        offset_hours, offset_mins = int(match.group(10)), int(match.group(11))
        if offset_hours > 23 or offset_mins > 59:
            raise ControlFileError("timestamp non valido")
        offset_minutes = (offset_hours * 60 + offset_mins) * (1 if match.group(9) == "+" else -1)
    fraction = match.group(7) or ""
    millis = int((fraction + "000")[:3])
    seconds = calendar.timegm((year, month, day, hour, minute, second, 0, 0, 0))
    return seconds * 1000 + millis - offset_minutes * 60_000


def decode_control_file(data: bytes, max_bytes: int = CONTROL_FILE_MAX_BYTES) -> Any:
    """Byte di un file del control-plane → valore JSON (limite di dimensione, UTF-8, JSON rigoroso)."""
    if len(data) > max_bytes:
        raise ControlFileError("oltre %d byte" % max_bytes)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ControlFileError("non è UTF-8") from exc

    def _reject_constant(name: str) -> Any:
        # NaN, Infinity e -Infinity non sono JSON (JSON.parse in TS li rifiuta).
        raise ControlFileError("costante JSON non ammessa: %s" % name)

    try:
        return json.loads(text, parse_constant=_reject_constant)
    except ControlFileError:
        raise
    except (ValueError, RecursionError) as exc:
        # RecursionError: annidamento patologico ("[[[[...]]]]"), non un errore del plugin.
        raise ControlFileError("JSON non valido") from exc


# ─── Policy, heartbeat e marker ───────────────────────────────


@dataclass(frozen=True)
class Policy:
    """policy.json validata (contratto §5.4): volume_id minuscolo, liste come insiemi."""

    version: int
    generated_at: str
    backend_mode: str
    mode: str
    reasons: Tuple[str, ...]
    principal: str
    volume_id: Optional[str]
    epoch: int
    credential_epoch: int
    readonly: FrozenSet[str]
    hidden: FrozenSet[str]


@dataclass(frozen=True)
class Heartbeat:
    """heartbeat.json validato (contratto §7.2); `ts_ms` per misurarne l'età."""

    api_version: str
    mode: str
    epoch: int
    ts: str
    ts_ms: int


@dataclass(frozen=True)
class VolumeMarker:
    """Marker d'identità del principal (contratto §4.1)."""

    volume_id: str
    epoch: int


@dataclass(frozen=True)
class FileRead:
    """Esito della lettura di un file: state 'ok' (value), 'missing' o 'invalid' (error)."""

    state: str
    value: Any = None
    error: str = ""


MISSING = FileRead("missing")


def _name_list(value: Any, what: str) -> FrozenSet[str]:
    if not isinstance(value, list):
        raise ControlFileError("%s non è un array" % what)
    for item in value:
        if not is_valid_path_segment(item):
            raise ControlFileError("%s: nome di collezione non valido: %r" % (what, item))
    return frozenset(value)


def parse_policy(value: Any, expected_principal: Optional[str] = None) -> Policy:
    """
    Valida una policy già decodificata da JSON con le regole dei lettori
    (contratto §5.4, come parsePolicy() in TS): campi richiesti e tipi
    rigorosi, campi sconosciuti ignorati, reasons sconosciuti scartati.
    Lancia ControlFileError.
    """
    if not isinstance(value, dict):
        raise ControlFileError("non è un oggetto JSON")
    if _as_int(value.get("schema"), CONTROL_PLANE_SCHEMA, CONTROL_PLANE_SCHEMA) is None:
        raise ControlFileError("schema non supportato: %r" % (value.get("schema"),))
    version = _as_int(value.get("version"), 1)
    if version is None:
        raise ControlFileError("version non valida")
    parse_timestamp_ms(value.get("generated_at"))
    backend_mode = value.get("backend_mode")
    if backend_mode not in BACKEND_MODES:
        raise ControlFileError("backend_mode non valido")
    mode = value.get("mode")
    if mode not in POLICY_MODES:
        raise ControlFileError("mode non valido")
    reasons = value.get("reasons")
    if not isinstance(reasons, list) or not all(isinstance(r, str) for r in reasons):
        raise ControlFileError("reasons non valido")
    principal = value.get("principal")
    if not is_valid_principal(principal):
        raise ControlFileError("principal non valido")
    if expected_principal is not None and principal != expected_principal:
        raise ControlFileError("principal %r diverso da quello configurato" % (principal,))
    volume_id = value.get("volume_id")
    if not (volume_id is None or (isinstance(volume_id, str) and _UUID_RE.fullmatch(volume_id))):
        raise ControlFileError("volume_id non valido")
    epoch = _as_int(value.get("epoch"), 0)
    if epoch is None:
        raise ControlFileError("epoch non valido")
    if (volume_id is None) != (epoch == 0):
        raise ControlFileError("volume_id ed epoch incoerenti")
    if mode == "live" and volume_id is None:
        raise ControlFileError("live senza volume")
    credential_epoch = _as_int(value.get("credential_epoch"), 0)
    if credential_epoch is None:
        raise ControlFileError("credential_epoch non valido")
    readonly = _name_list(value.get("readonly"), "readonly")
    hidden = _name_list(value.get("hidden"), "hidden")
    return Policy(
        version=version,
        generated_at=value["generated_at"],
        backend_mode=backend_mode,
        mode=mode,
        reasons=tuple(r for r in POLICY_REASONS if r in reasons),
        principal=principal,
        volume_id=None if volume_id is None else volume_id.lower(),
        epoch=epoch,
        credential_epoch=credential_epoch,
        readonly=readonly,
        hidden=hidden,
    )


def parse_heartbeat(value: Any) -> Heartbeat:
    """
    Valida un heartbeat già decodificato da JSON (contratto §7.2, come
    parseHeartbeat() in TS). L'età non si valuta qui ma a ogni richiesta.
    Lancia ControlFileError.
    """
    if not isinstance(value, dict):
        raise ControlFileError("non è un oggetto JSON")
    if _as_int(value.get("schema"), CONTROL_PLANE_SCHEMA, CONTROL_PLANE_SCHEMA) is None:
        raise ControlFileError("schema non supportato: %r" % (value.get("schema"),))
    api_version = value.get("api_version")
    if not isinstance(api_version, str) or _API_VERSION_RE.fullmatch(api_version) is None:
        raise ControlFileError("api_version non valida")
    mode = value.get("mode")
    if mode not in BACKEND_MODES:
        raise ControlFileError("mode non valido")
    epoch = _as_int(value.get("epoch"), 0)
    if epoch is None:
        raise ControlFileError("epoch non valido")
    ts = value.get("ts")
    ts_ms = parse_timestamp_ms(ts)
    return Heartbeat(api_version=api_version, mode=mode, epoch=epoch, ts=ts, ts_ms=ts_ms)


def volume_marker_from_props(props: Any) -> Optional[VolumeMarker]:
    """
    Marker d'identità dalle props del principal (`.Radicale.props` decodificato):
    None se manca o non è nel formato del contratto §4.1 (vale come assente).
    """
    if not isinstance(props, dict):
        return None
    volume_id = props.get(DEAD_PROP_VOLUME_ID)
    epoch = props.get(DEAD_PROP_EPOCH)
    if not isinstance(volume_id, str) or _UUID_RE.fullmatch(volume_id) is None:
        return None
    if not isinstance(epoch, str) or _MARKER_EPOCH_RE.fullmatch(epoch) is None:
        return None
    number = int(epoch)
    if number > MAX_INT32:
        return None
    return VolumeMarker(volume_id=volume_id.lower(), epoch=number)


def identity_matches(volume_id: Optional[str], epoch: int, marker: Optional[VolumeMarker]) -> bool:
    """
    identity_ok del contratto §4.3: identità di riferimento con volume ed epoch
    ≥ 1, marker valido, stesso volume (senza distinguere maiuscole e minuscole)
    e stesso epoch.
    """
    return (
        volume_id is not None
        and epoch >= 1
        and marker is not None
        and marker.volume_id == volume_id.lower()
        and marker.epoch == epoch
    )


# ─── Modalità effettiva (contratto §7.3) ──────────────────────


@dataclass(frozen=True)
class EffectiveMode:
    """Specchio di effectiveDeviceMode() in TS."""

    mode: str
    reasons: Tuple[str, ...]
    #: Identità di riferimento (None: nessun permesso dei device sotto il principal).
    volume_id: Optional[str]
    epoch: int
    readonly: FrozenSet[str]
    hidden: FrozenSet[str]


def effective_device_mode(
    policy: FileRead,
    heartbeat: FileRead,
    last_known_good: Optional[Policy],
    now_ms: int,
) -> EffectiveMode:
    """
    Modalità effettiva dei device:

        rif   = policy valida ?? ultima policy valida del processo ?? nessuna
        base  = policy valida ? policy.mode : 'shadow'
        frozen se il heartbeat manca, è invalido, è più vecchio di 600 s, è nel
        futuro di oltre 60 s, non c'è rif o ha un epoch diverso da rif, oppure
        base è live e il suo mode non è radicale/finalized.
    """
    reasons: List[str] = []
    valid: Optional[Policy] = policy.value if policy.state == "ok" else None
    if policy.state == "missing":
        reasons.append("policy_missing")
    elif policy.state == "invalid":
        reasons.append("policy_invalid")

    reference = valid if valid is not None else last_known_good
    base = valid.mode if valid is not None else "shadow"
    epoch = reference.epoch if reference is not None else 0

    if heartbeat.state == "missing":
        reasons.append("heartbeat_missing")
    elif heartbeat.state != "ok":
        reasons.append("heartbeat_invalid")
    else:
        beat: Heartbeat = heartbeat.value
        age = now_ms - beat.ts_ms
        if age > HEARTBEAT_STALE_AFTER_MS:
            reasons.append("heartbeat_stale")
        if -age > HEARTBEAT_MAX_FUTURE_SKEW_MS:
            reasons.append("heartbeat_future")
        if reference is None or beat.epoch != epoch:
            reasons.append("heartbeat_epoch_mismatch")
        if base == "live" and beat.mode not in LIVE_BACKEND_MODES:
            reasons.append("heartbeat_mode_mismatch")

    heartbeat_ok = not any(r.startswith("heartbeat_") for r in reasons)
    return EffectiveMode(
        mode=base if heartbeat_ok else "frozen",
        reasons=tuple(reasons),
        volume_id=reference.volume_id if reference is not None else None,
        epoch=epoch,
        readonly=reference.readonly if reference is not None else frozenset(),
        hidden=(reference.hidden if reference is not None else frozenset()) | {CANARY_COLLECTION},
    )


# ─── Permessi (contratto §8) ──────────────────────────────────


def path_segments(path: Any) -> Optional[List[str]]:
    """
    Segmenti di un path di Radicale ('/federico/f/', 'federico/f', '' per la
    root). None per un path non sicuro ('.' o '..': Radicale li ha già tolti,
    qui valgono come "nessun permesso").
    """
    if not isinstance(path, str):
        return None
    segments = [s for s in path.split("/") if s]
    if any(s in (".", "..") for s in segments):
        return None
    return segments


def service_rights(segments: Sequence[str], principal: str) -> str:
    """caldes-svc: R sulla root, RW sul principal, rwD sulle collezioni, nient'altro."""
    depth = len(segments)
    if depth == 0:
        return "R"
    if segments[0] != principal:
        return ""
    if depth == 1:
        return "RW"
    return "rwD" if depth == 2 else ""


def compute_rights(
    user: str,
    segments: Sequence[str],
    principal: str,
    mode: str,
    identity_ok: bool,
    readonly: FrozenSet[str],
    hidden: FrozenSet[str],
) -> str:
    """
    Permessi di `user` sul path (segmenti) per la valutazione data, con le
    lettere di Radicale 3.7.8: specchio di expectedRadicaleRights() in TS.
    `hidden` deve già contenere `_canary` (effective_device_mode lo aggiunge).
    """
    if user == SERVICE_USER:
        return service_rights(segments, principal)
    is_probe = user == PROBE_USER
    if not is_probe and user != principal:
        return ""
    depth = len(segments)
    if depth == 0:
        return "R"
    if segments[0] != principal or not identity_ok:
        return ""
    live = mode == "live"
    if depth == 1:
        # Sempre e solo R, anche in live: il marker d'identità e le altre dead
        # prop del principal li scrive solo caldes-svc (contratto §4.2). Con W
        # un device potrebbe riscrivere o togliere volume-id/epoch (nessun
        # permesso per tutti, facade in sola lettura: DoS e falsa identità).
        # MKCALENDAR di una collezione nuova resta ammessa in live: Radicale
        # controlla la `w` del path nuovo, non la W del principal.
        return "R"
    if depth > 2:
        return ""
    name = segments[1]
    if name == CANARY_COLLECTION:
        return "rw" if is_probe and live else ""
    if name.startswith(SYSTEM_COLLECTION_PREFIX) or name in hidden:
        return ""
    if name in readonly:
        return "r"
    return "rw" if live else "r"


# ─── Lettura dei file ─────────────────────────────────────────


def _stat_key(st: os.stat_result) -> Tuple[int, int, int, int, int]:
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


class _WatchedFile:
    """
    File riletto solo quando cambiano inode, dimensione, mtime o ctime (la
    scrittura atomica dell'API con rename cambia sempre l'inode). Non
    thread-safe: lo protegge il lock di ControlPlane.
    """

    def __init__(self, path: str, parse: Callable[[bytes], Any], max_bytes: int) -> None:
        self.path = path
        self._parse = parse
        self._max_bytes = max_bytes
        self._key: Optional[Tuple[int, int, int, int, int]] = None
        self._result: Optional[FileRead] = None

    def read(self) -> FileRead:
        try:
            key = _stat_key(os.stat(self.path))
        except (FileNotFoundError, NotADirectoryError):
            self._key, self._result = None, MISSING
            return MISSING
        except OSError as exc:
            self._key, self._result = None, FileRead("invalid", error="stat non riuscito: %s" % exc.strerror)
            return self._result
        if self._result is not None and key == self._key:
            return self._result
        try:
            with open(self.path, "rb") as handle:
                key = _stat_key(os.fstat(handle.fileno()))
                data = handle.read(self._max_bytes + 1)
        except (FileNotFoundError, NotADirectoryError):
            self._key, self._result = None, MISSING
            return MISSING
        except OSError as exc:
            self._key, self._result = None, FileRead("invalid", error="lettura non riuscita: %s" % exc.strerror)
            return self._result
        try:
            result = FileRead("ok", value=self._parse(data))
        except ControlFileError as exc:
            result = FileRead("invalid", error=str(exc))
        except Exception as exc:  # noqa: BLE001 - un file strano non deve mai far fallire la valutazione
            result = FileRead("invalid", error="formato non gestito: %s" % exc.__class__.__name__)
        self._key, self._result = key, result
        return result


def _parse_props(data: bytes) -> Optional[VolumeMarker]:
    return volume_marker_from_props(decode_control_file(data, PROPS_FILE_MAX_BYTES))


@dataclass(frozen=True)
class Evaluation:
    """Valutazione completa per authorization(): modalità effettiva e identità."""

    effective: EffectiveMode
    identity_ok: bool
    marker: Optional[VolumeMarker]


@dataclass(frozen=True)
class _Snapshot:
    policy: FileRead
    heartbeat: FileRead
    marker: Optional[VolumeMarker]
    marker_state: str
    last_valid: Optional[Policy]


class ControlPlane:
    """
    Stato del control-plane visto dai rights: policy, heartbeat e marker del
    principal, ricontrollati al massimo ogni `reload_interval` secondi, più
    l'ultima policy valida vista dal processo (solo in memoria).
    """

    def __init__(
        self,
        *,
        policy_file: str,
        heartbeat_file: str,
        props_file: str,
        principal: str,
        reload_interval: float = CONTROL_RELOAD_MIN_INTERVAL_S,
        monotonic: Callable[[], float] = time.monotonic,
        now_ms: Callable[[], int] = lambda: time.time_ns() // 1_000_000,
    ) -> None:
        if not is_valid_principal(principal):
            raise CaldesRightsConfigError("principal non valido: %r" % (principal,))
        self.principal = principal
        self.reload_interval = reload_interval
        self._monotonic = monotonic
        self._now_ms = now_ms
        self._policy = _WatchedFile(
            policy_file,
            lambda data: parse_policy(decode_control_file(data), principal),
            CONTROL_FILE_MAX_BYTES,
        )
        self._heartbeat = _WatchedFile(
            heartbeat_file,
            lambda data: parse_heartbeat(decode_control_file(data)),
            CONTROL_FILE_MAX_BYTES,
        )
        self._props = _WatchedFile(props_file, _parse_props, PROPS_FILE_MAX_BYTES)
        self._lock = threading.Lock()
        self._log_lock = threading.Lock()
        self._last_check: Optional[float] = None
        self._snapshot = _Snapshot(MISSING, MISSING, None, "missing", None)
        self._logged_policy: Optional[Tuple[str, str]] = None
        self._logged_effective: Optional[Tuple[str, Tuple[str, ...], bool]] = None

    @property
    def policy_file(self) -> str:
        return self._policy.path

    @property
    def heartbeat_file(self) -> str:
        return self._heartbeat.path

    @property
    def props_file(self) -> str:
        return self._props.path

    def refresh(self, force: bool = False) -> None:
        """
        Ricontrolla i file se è passato almeno `reload_interval` dall'ultimo
        controllo (sempre con force). Un thread che trova un controllo in corso
        usa lo stato precedente invece di attendere.
        """
        if not force and self._last_check is not None and self._monotonic() - self._last_check < self.reload_interval:
            return
        if not self._lock.acquire(blocking=force):
            return
        try:
            if not force and self._last_check is not None and self._monotonic() - self._last_check < self.reload_interval:
                return
            policy = self._policy.read()
            heartbeat = self._heartbeat.read()
            props = self._props.read()
            last_valid = policy.value if policy.state == "ok" else self._snapshot.last_valid
            marker = props.value if props.state == "ok" else None
            marker_state = props.state if props.state != "ok" else ("ok" if marker is not None else "malformed")
            self._snapshot = _Snapshot(policy, heartbeat, marker, marker_state, last_valid)
            self._last_check = self._monotonic()
            self._log_policy_transition(policy)
        finally:
            self._lock.release()

    def _log_policy_transition(self, policy: FileRead) -> None:
        status = ("valid", "") if policy.state == "ok" else ("invalid", policy.error or policy.state)
        previous = self._logged_policy
        if previous is not None and previous[0] == status[0]:
            return
        self._logged_policy = status
        if status[0] == "valid":
            # Al primo caricamento basta un'informazione; il ritorno a valida è un evento.
            log_event("policy_valid", "info" if previous is None else "warning",
                      reason="caricata" if previous is None else "di nuovo valida",
                      version=policy.value.version, mode=policy.value.mode)
        else:
            log_event("policy_invalid", reason=status[1])

    def evaluate(self, now_ms: Optional[int] = None) -> Evaluation:
        """Modalità effettiva e identità all'istante `now_ms` (default: adesso)."""
        self.refresh()
        snap = self._snapshot
        effective = effective_device_mode(
            snap.policy,
            snap.heartbeat,
            snap.last_valid,
            self._now_ms() if now_ms is None else now_ms,
        )
        identity_ok = identity_matches(effective.volume_id, effective.epoch, snap.marker)
        evaluation = Evaluation(effective=effective, identity_ok=identity_ok, marker=snap.marker)
        self._log_effective_transition(evaluation, snap.marker_state)
        return evaluation

    def _log_effective_transition(self, evaluation: Evaluation, marker_state: str) -> None:
        current = (evaluation.effective.mode, evaluation.effective.reasons, evaluation.identity_ok)
        if current == self._logged_effective:
            return
        with self._log_lock:
            if current == self._logged_effective:
                return
            self._logged_effective = current
        log_event(
            "effective_mode_changed",
            mode=evaluation.effective.mode,
            reasons=list(evaluation.effective.reasons),
            identity_ok=evaluation.identity_ok,
            marker=marker_state,
            epoch=evaluation.effective.epoch,
        )


# ─── Plugin ───────────────────────────────────────────────────

# Radicale istanzia il plugin due volte (Application e modulo di sharing): le
# istanze con gli stessi file condividono lo stesso ControlPlane, quindi la
# stessa "ultima policy valida vista dal processo" e un solo log delle transizioni.
_CONTROL_PLANES: dict = {}
_CONTROL_PLANES_LOCK = threading.Lock()


def _shared_control_plane(
    policy_file: str, heartbeat_file: str, props_file: str, principal: str, reload_interval: float
) -> ControlPlane:
    key = (policy_file, heartbeat_file, props_file, principal, reload_interval)
    with _CONTROL_PLANES_LOCK:
        control = _CONTROL_PLANES.get(key)
        if control is None:
            control = ControlPlane(
                policy_file=policy_file,
                heartbeat_file=heartbeat_file,
                props_file=props_file,
                principal=principal,
                reload_interval=reload_interval,
            )
            _CONTROL_PLANES[key] = control
        return control


class _ServicePrincipalLogFilter(logging.Filter):
    """
    A ogni richiesta di un utente senza principal su disco Radicale prova a
    crearlo e, senza W, registra a WARNING "Access to principal path ... denied
    by rights backend". Per caldes-svc e caldes-probe è voluto (contratto §8:
    niente /caldes-svc/ né /caldes-probe/), e con le richieste dell'API e
    l'healthcheck ogni 30 s riempirebbe il log: la riga scende a DEBUG. Per i
    device resta un WARNING, perché segnala un'identità del volume assente.
    """

    _MESSAGE = "Access to principal path %r denied by rights backend"
    _PATHS = frozenset("/%s/" % user for user in (SERVICE_USER, PROBE_USER))

    def filter(self, record: logging.LogRecord) -> bool:
        if (
            record.levelno == logging.WARNING
            and record.msg == self._MESSAGE
            and isinstance(record.args, tuple)
            and record.args
            and record.args[0] in self._PATHS
        ):
            # I handler di Radicale non hanno un livello proprio (decide quello
            # del logger, già superato): la riga passa solo se il log è a debug.
            record.levelno = logging.DEBUG
            record.levelname = logging.getLevelName(logging.DEBUG)
            return logger.isEnabledFor(logging.DEBUG)
        return True


_LOG_FILTER = _ServicePrincipalLogFilter()


def _install_log_filter() -> None:
    if _LOG_FILTER not in logger.filters:
        logger.addFilter(_LOG_FILTER)


def _rights_option(configuration: Any, option: str, default: Any) -> Any:
    """Opzione di [rights]; assente → default (Configuration.get non ha fallback=)."""
    try:
        value = configuration.get("rights", option)
    except KeyError:
        return default
    return default if value is None or (isinstance(value, str) and not value.strip()) else value


def _config_error(option: str, reason: str) -> CaldesRightsConfigError:
    log_event("config_error", "error", option=option, reason=reason)
    return CaldesRightsConfigError("caldes_rights: %s: %s" % (option, reason))


def _ensure_vobject_fix() -> str:
    """
    Applica (se sitecustomize non l'ha già fatto) e verifica la patch di
    fedeltà di vobject: senza, Radicale non deve servire scritture dei device.
    """
    try:
        import caldes_vobject_fix  # noqa: WPS433 - import locale voluto: patch prima di servire

        caldes_vobject_fix.apply()
        caldes_vobject_fix.self_test()
        return caldes_vobject_fix.describe() or ""
    except Exception as exc:  # noqa: BLE001 - qualsiasi problema blocca l'avvio
        raise _config_error("caldes_vobject_fix", "patch di fedeltà non attiva o self-test fallito: %s" % exc) from exc


class Rights(rights.BaseRights):
    """Plugin rights `caldes_rights` (vedi la docstring del modulo)."""

    def __init__(self, configuration: Any) -> None:
        super().__init__(configuration)
        principal = (os.environ.get("RADICALE_PRINCIPAL") or "").strip()
        if not principal:
            raise _config_error("RADICALE_PRINCIPAL", "variabile obbligatoria assente")
        if not is_valid_principal(principal):
            raise _config_error("RADICALE_PRINCIPAL", "valore non valido: %r" % principal)

        policy_file = str(_rights_option(configuration, "caldes_policy_file", DEFAULT_POLICY_FILE)).strip()
        heartbeat_file = str(_rights_option(configuration, "caldes_heartbeat_file", DEFAULT_HEARTBEAT_FILE)).strip()
        for option, value in (("caldes_policy_file", policy_file), ("caldes_heartbeat_file", heartbeat_file)):
            if not os.path.isabs(value):
                raise _config_error(option, "serve un percorso assoluto: %r" % value)

        raw_interval = _rights_option(configuration, "caldes_reload_interval", CONTROL_RELOAD_MIN_INTERVAL_S)
        try:
            reload_interval = float(raw_interval)
        except (TypeError, ValueError):
            raise _config_error("caldes_reload_interval", "non è un numero: %r" % (raw_interval,)) from None
        if not (math.isfinite(reload_interval) and 0 <= reload_interval <= CONTROL_RELOAD_MAX_INTERVAL_S):
            raise _config_error(
                "caldes_reload_interval", "fuori da 0..%g: %r" % (CONTROL_RELOAD_MAX_INTERVAL_S, raw_interval)
            )

        try:
            folder = configuration.get("storage", "filesystem_folder")
        except KeyError:
            raise _config_error("storage.filesystem_folder", "assente") from None
        if not folder:
            raise _config_error("storage.filesystem_folder", "vuota")
        props_file = os.path.join(folder, RADICALE_COLLECTION_ROOT, principal, RADICALE_PROPS_FILE)

        vobject_state = _ensure_vobject_fix()
        _install_log_filter()

        self._principal = principal
        self._control = _shared_control_plane(policy_file, heartbeat_file, props_file, principal, reload_interval)
        logger.info(
            "caldes_rights: principal %r, policy %r, heartbeat %r, props %r, ricontrollo ogni %gs; %s",
            principal, policy_file, heartbeat_file, props_file, reload_interval, vobject_state,
        )
        self._control.refresh(force=True)
        self._control.evaluate()

    @property
    def principal(self) -> str:
        return self._principal

    @property
    def control(self) -> ControlPlane:
        """Stato del control-plane (per la salute e per i test)."""
        return self._control

    def authorization(self, user: str, path: str) -> str:
        user = user or ""
        segments = path_segments(path)
        if segments is None:
            return ""
        if user == SERVICE_USER:
            return service_rights(segments, self._principal)
        if user != self._principal and user != PROBE_USER:
            return ""
        if not segments:
            # La root non dipende da policy né identità: l'healthcheck del
            # probe risponde 207 anche su un volume non inizializzato.
            return "R"
        try:
            evaluation = self._control.evaluate()
            effective = evaluation.effective
            return compute_rights(
                user,
                segments,
                self._principal,
                effective.mode,
                evaluation.identity_ok,
                effective.readonly,
                effective.hidden,
            )
        except Exception as exc:  # noqa: BLE001 - fail-closed: nessun permesso sotto il principal
            logger.error("caldes_rights: valutazione fallita per %r su %r: %r", user, path, exc, exc_info=True)
            return ""
