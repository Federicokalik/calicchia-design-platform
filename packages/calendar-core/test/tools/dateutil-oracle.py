"""Oracolo python-dateutil per i test del motore RRULE di calendar-core.

Legge da stdin una lista JSON di casi {rule, start: {year..second}, limit, max}
(limit in ms dell'orologio senza fuso, come RuleIterator) e scrive su stdout,
per ogni caso, la lista degli istanti in ms o la stringa "ERR:<tipo>".
dateutil è l'algoritmo di riferimento: rrule.js (motore del codice legacy) ne
è un port e Radicale lo usa via vobject. Nessun accesso alla rete né ai file.
"""
import datetime
import json
import sys

from dateutil.rrule import rrulestr

EPOCH = datetime.datetime(1970, 1, 1)


def run(case):
    s = case["start"]
    dt = datetime.datetime(s["year"], s["month"], s["day"], s["hour"], s["minute"], s["second"])
    rule = rrulestr(case["rule"], dtstart=dt)
    limit = EPOCH + datetime.timedelta(milliseconds=case["limit"])
    out = []
    for x in rule:
        if x > limit:
            break
        out.append(int((x - EPOCH).total_seconds() * 1000))
        if len(out) >= case.get("max", 2000):
            break
    return out


def main():
    cases = json.load(sys.stdin)
    results = []
    for case in cases:
        try:
            results.append(run(case))
        except Exception as exc:  # noqa: BLE001 - l'esito dell'errore è il dato del test
            results.append("ERR:" + type(exc).__name__)
    json.dump(results, sys.stdout)


if __name__ == "__main__":
    main()
