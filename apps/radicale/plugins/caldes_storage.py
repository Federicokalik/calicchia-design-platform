"""
Caldes Storage plugin per Radicale 3.x.

Backend HTTP: Postgres resta l'unica fonte di verità, Radicale è un thin
client che proxya le operazioni CalDAV verso l'API interna
`/api/caldav-backend/*` (auth Bearer CALDAV_SERVICE_TOKEN). Nessuno stato
persistente lato Radicale — niente file, niente volume dati.

Mappatura path Radicale → backend:
    /                                  → root virtuale (principal root)
    /<user>                            → principal collection (figlia di root)
    /<user>/<slug>                     → calendario (GET /collections/<slug>)
    /<user>/<slug>/<uid>.ics           → risorsa VEVENT (GET /collections/<slug>/items/<uid>)

Mono-utente: il principal è derivato dall'auth (username dell'app-password),
ma lo scoping è ininfluente — l'API ritorna tutti i calendari visibili al
service token. Il principal serve solo a soddisfare il modello path Radicale.

Env:
    CALDAV_BACKEND_URL   — es. http://api:3001/api/caldav-backend
    CALDAV_SERVICE_TOKEN — Bearer secret condiviso con l'API
"""

import json
import urllib.error
import urllib.request
from email.utils import formatdate
from typing import Dict, Iterable, List, Mapping, Optional, Tuple

import vobject
from radicale import item as radicale_item
from radicale import types
from radicale.log import logger
from radicale.storage import (
    BaseCollection,
    BaseStorage,
    ComponentNotFoundError,
)


# ─── HTTP client ─────────────────────────────────────────────────────────


def _cfg(storage: "Storage", key: str, fallback_env: str) -> str:
    val = storage.configuration.get("storage", key, fallback=None)
    if not val:
        import os
        val = os.environ.get(fallback_env)
    if not val:
        raise RuntimeError(
            f"[caldes_storage] {fallback_env} non impostato "
            f"(config storage.{key} o env {fallback_env})"
        )
    return val.rstrip("/")


def _request(
    storage: "Storage",
    method: str,
    path: str,
    body: Optional[bytes] = None,
    headers_extra: Optional[Dict[str, str]] = None,
    timeout: int = 15,
) -> Tuple[int, bytes, Dict[str, str]]:
    url = f"{_cfg(storage, 'caldes_backend_url', 'CALDAV_BACKEND_URL')}{path}"
    headers: Dict[str, str] = {
        "Authorization": f"Bearer {_cfg(storage, 'caldes_service_token', 'CALDAV_SERVICE_TOKEN')}",
    }
    if body is not None:
        headers["Content-Type"] = "text/calendar; charset=utf-8"
    if headers_extra:
        headers.update(headers_extra)
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers.items())
    except urllib.error.HTTPError as e:
        return e.code, e.read() or b"", dict(e.headers.items()) if e.headers else {}


# ─── Path helpers ─────────────────────────────────────────────────────────


def _split_path(path: str) -> Tuple[str, str, str]:
    """Sanitizza e spezza `path` in (principal, slug, item_href).

    path es. "" → ("", "", "")
    path es. "federico" → ("federico", "", "")
    path es. "federico/lavoro" → ("federico", "lavoro", "")
    path es. "federico/lavoro/abc.ics" → ("federico", "lavoro", "abc.ics")
    """
    p = path.strip("/")
    if not p:
        return ("", "", "")
    parts = p.split("/")
    if len(parts) == 1:
        return (parts[0], "", "")
    if len(parts) == 2:
        return (parts[0], parts[1], "")
    # 3+ segmenti: principal/slug/href (href potrebbe contenere /, raro)
    return (parts[0], parts[1], "/".join(parts[2:]))


# ─── Collection (calendar o principal o root) ────────────────────────────


class Collection(BaseCollection):
    """Una collection Radicale backed da un calendario Postgres.

    Per principal/root collection (slug vuoto) funge da contenitore virtuale:
    tag None, nessun item.
    """

    def __init__(self, storage: "Storage", path: str, meta: Optional[Dict[str, str]] = None,
                 calendar_dto: Optional[Dict] = None):
        self._storage = storage
        self._path = path.strip("/")
        self._meta = meta or {}
        self._calendar_dto = calendar_dto  # cache del DTO dal backend

    # ─── proprietà base ──────────────────────────────────────────────────

    @property
    def path(self) -> str:
        return self._path

    @property
    def owner(self) -> str:
        return self._path.split("/", maxsplit=1)[0] if self._path else ""

    @property
    def is_principal(self) -> bool:
        return bool(self._path) and "/" not in self._path

    @property
    def last_modified(self) -> str:
        # HTTP-datetime; usiamo updated_at del calendario se disponibile,
        # altrimenti epoch. I client usano questo per If-Modified-Since.
        if self._calendar_dto and self._calendar_dto.get("updated_at"):
            #updated_at è ISO; parsiamo e formattiamo come HTTP date.
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(
                    self._calendar_dto["updated_at"].replace("Z", "+00:00")
                )
                return formatdate(dt.timestamp(), usegmt=True)
            except (ValueError, TypeError):
                pass
        return formatdate(0, usegmt=True)

    # ─── meta ────────────────────────────────────────────────────────────

    def get_meta(self, key: Optional[str] = None):
        if key is None:
            return dict(self._meta)
        return self._meta.get(key)

    def set_meta(self, props: Mapping[str, str]) -> None:
        # Le collection sono gestite dall'admin API (calendars table).
        # Radicale non deve scrivere meta qui. No-op silenzioso per non
        # rompere client che mandano PROPPATCH su displayname/color.
        logger.debug("[caldes_storage] set_meta ignored for %r: %r", self._path, dict(props))

    # ─── items ───────────────────────────────────────────────────────────

    def _slug(self) -> str:
        _, slug, _ = _split_path(self._path)
        return slug

    def _list_items(self) -> List[Dict]:
        slug = self._slug()
        if not slug:
            return []
        status, body, _ = _request(self._storage, "GET", f"/collections/{slug}/items")
        if status != 200:
            return []
        try:
            payload = json.loads(body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return []
        return payload.get("items", [])

    def get_all(self) -> Iterable["radicale_item.Item"]:
        for it in self._list_items():
            item = self.get(it["href"])
            if item is not None:
                yield item

    def get_multi(self, hrefs: Iterable[str]) -> Iterable[Tuple[str, Optional["radicale_item.Item"]]]:
        for href in hrefs:
            yield href, self.get(href)

    def get(self, href: str) -> Optional["radicale_item.Item"]:
        slug = self._slug()
        if not slug or not href:
            return None
        uid = href.removesuffix(".ics")
        status, body, headers = _request(
            self._storage, "GET", f"/collections/{slug}/items/{uid}"
        )
        if status != 200:
            return None
        ics = body.decode("utf-8")
        etag = headers.get("ETag") or headers.get("Etag") or ""
        return self._build_item(href, ics, etag)

    def upload(self, href: str, item: "radicale_item.Item") -> Tuple["radicale_item.Item", Optional["radicale_item.Item"]]:
        slug = self._slug()
        if not slug:
            raise ComponentNotFoundError(self._path)
        uid = href.removesuffix(".ics")
        # vecchio item (per ritornarlo come old_item)
        old = self.get(href)
        ics = item.serialize()
        status, _, headers = _request(
            self._storage, "PUT", f"/collections/{slug}/items/{uid}",
            body=ics.encode("utf-8"),
        )
        if status not in (200, 201, 204):
            raise IOError(f"[caldes_storage] PUT fallito: HTTP {status}")
        etag = headers.get("ETag") or headers.get("Etag") or ""
        new_item = self._build_item(href, ics, etag)
        return new_item, old

    def delete(self, href: Optional[str] = None) -> None:
        slug = self._slug()
        if not slug:
            # delete della collection — non supportato (i calendari si
            # gestiscono dall'admin). Silent no-op.
            return
        if href is None:
            return
        uid = href.removesuffix(".ics")
        status, _, _ = _request(self._storage, "DELETE", f"/collections/{slug}/items/{uid}")
        if status not in (200, 204):
            if status == 404:
                raise ComponentNotFoundError(f"{self._path}/{href}")
            raise IOError(f"[caldes_storage] DELETE fallito: HTTP {status}")

    # ─── utility ─────────────────────────────────────────────────────────

    def _build_item(self, href: str, ics: str, etag: str) -> "radicale_item.Item":
        components = list(vobject.readComponents(ics))
        if not components:
            raise ValueError("ICS senza componenti VCALENDAR")
        vcal = components[0]
        # Item vuole: collection (parent BaseCollection), href, vobject_item, etag.
        # vobject_item è il VCALENDAR intero; Radicale estrae UID/component_name
        # da sé (property lazy).
        return radicale_item.Item(
            collection=self, href=href, vobject_item=vcal, etag=etag or None
        )


# ─── Storage ──────────────────────────────────────────────────────────────


class Storage(BaseStorage):
    _is_collision_free = True
    _supports_unicode = True

    # ─── discover ────────────────────────────────────────────────────────

    def discover(
        self,
        path: str,
        depth: str = "0",
        child_context_manager=None,
        user_groups=None,
    ) -> Iterable["types.CollectionOrItem"]:
        user_groups = user_groups or set()
        principal, slug, item_href = _split_path(path)

        # Root "/" → collection virtuale
        if not principal:
            root = Collection(self, "", meta={"tag": ""})
            yield root
            if depth != "0":
                # figli = principals. Mono-utente → ritorniamo solo il
                # principal dell'utente autenticato. Ma discover non ha
                # contesto auth qui; i rights module filtra dopo.
                # Ritorniamo un principal generico "federico" — i rights
                # owner_only bloccheranno se l'utente non matcha.
                for p in self._list_principals():
                    yield Collection(self, p, meta={"tag": ""})
            return

        # Principal "/<user>" → collection principal
        if principal and not slug:
            coll = Collection(self, principal, meta={"tag": ""})
            yield coll
            if depth != "0":
                for cal in self._list_calendars():
                    yield self._calendar_collection(principal, cal)
            return

        # Calendar "/<user>/<slug>"
        if principal and slug and not item_href:
            cal = self._get_calendar(slug)
            if cal is None:
                return
            coll = self._calendar_collection(principal, cal)
            yield coll
            if depth != "0":
                for it in coll._list_items():  # type: ignore[attr-defined]
                    item = coll.get(it["href"])  # type: ignore[attr-defined]
                    if item is not None:
                        yield item
            return

        # Item "/<user>/<slug>/<href>"
        if principal and slug and item_href:
            cal = self._get_calendar(slug)
            if cal is None:
                return
            coll = self._calendar_collection(principal, cal)
            item = coll.get(item_href)  # type: ignore[attr-defined]
            if item is None:
                return
            yield item
            return

    # ─── create / move / lock ────────────────────────────────────────────

    def create_collection(
        self,
        href: str,
        items: Optional[Iterable["radicale_item.Item"]] = None,
        props: Optional[Mapping[str, str]] = None,
    ) -> Tuple[BaseCollection, Dict[str, "radicale_item.Item"], List[str]]:
        # Le collection (= calendari) si creano dall'admin API, non da
        # Radicale. Se esiste già, ritorniamola; altrimenti errore.
        principal, slug, _ = _split_path(href)
        if not slug:
            coll = Collection(self, href, meta={"tag": ""})
            return coll, {}, []
        cal = self._get_calendar(slug)
        if cal is None:
            raise ComponentNotFoundError(href)
        coll = self._calendar_collection(principal, cal)
        return coll, {}, []

    def move(self, item: "radicale_item.Item", to_collection: BaseCollection, to_href: str) -> None:
        # PUT a nuova href + DELETE vecchia
        new_item, _ = to_collection.upload(to_href, item)
        try:
            old_coll = item.collection
            if old_coll is not None and item.href:
                old_coll.delete(item.href)
        except Exception as e:  # noqa: BLE001
            logger.warning("[caldes_storage] move: delete old failed: %s", e)

    @types.contextmanager
    def acquire_lock(self, mode: str, user: str = "", *args, **kwargs):
        # No-op: la concorrenza è gestita dal backend Postgres.
        yield

    def verify(self) -> bool:
        # Health check: GET /collections
        status, _, _ = _request(self, "GET", "/collections")
        return status == 200

    # ─── helpers backend ─────────────────────────────────────────────────

    def _list_principals(self) -> List[str]:
        # Mono-utente: un solo principal. Potremmo leggerlo da config, ma
        # per ora hardcodiamo "federico" — i rights owner_only filtrano.
        # In futuro l'admin API può esporre la lista utenti CalDAV.
        return ["federico"]

    def _list_calendars(self) -> List[Dict]:
        status, body, _ = _request(self, "GET", "/collections")
        if status != 200:
            return []
        try:
            return json.loads(body.decode("utf-8") or "{}").get("collections", [])
        except json.JSONDecodeError:
            return []

    def _get_calendar(self, slug: str) -> Optional[Dict]:
        status, body, _ = _request(self, "GET", f"/collections/{slug}")
        if status != 200:
            return None
        try:
            return json.loads(body.decode("utf-8") or "{}").get("collection")
        except json.JSONDecodeError:
            return None

    def _calendar_collection(self, principal: str, cal: Dict) -> "Collection":
        meta = {
            "tag": "VCALENDAR",
            "D:displayname": cal.get("displayName") or cal.get("slug") or "Calendar",
            "C:calendar-description": cal.get("description") or "",
            "ICAL:calendar-color": cal.get("color") or "#7c3aed",
            "C:calendar-timezone": "",  # il backend gestisce TZ per-event
        }
        path = f"{principal}/{cal['slug']}" if principal else cal["slug"]
        return Collection(self, path, meta=meta, calendar_dto=cal)
