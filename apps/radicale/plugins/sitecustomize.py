"""
sitecustomize dell'immagine Radicale di Caldes (fase F1, design §3.3).

Python importa `sitecustomize` all'avvio di ogni interprete se lo trova nel
sys.path: nell'immagine /app/plugins è in PYTHONPATH, quindi la patch di
fedeltà di vobject (caldes_vobject_fix) è attiva prima che Radicale legga o
scriva qualsiasi item, senza toccare il codice di Radicale.

Python stampa e poi ignora un'eccezione sollevata da sitecustomize: per questo
caldes_rights reimporta la patch ed esegue il self-test nel proprio costruttore
e rifiuta di partire se fallisce (fail-closed). Qui un interprete senza vobject
(per esempio un python di sistema con lo stesso PYTHONPATH) non è un errore: la
patch serve solo dove c'è vobject.
"""

import sys

try:
    import vobject  # noqa: F401  (solo per sapere se la patch serve)
except ImportError:
    vobject = None  # type: ignore[assignment]

if vobject is not None:
    try:
        import caldes_vobject_fix  # noqa: F401  (applica la patch all'import)
    except Exception as exc:  # noqa: BLE001 - mai bloccare l'avvio dell'interprete da qui
        sys.stderr.write(
            "caldes sitecustomize: patch di fedeltà vobject NON applicata: %r "
            "(caldes_rights impedirà l'avvio di Radicale)\n" % (exc,)
        )
