"""Dati fissi fornitore e configurazione brand."""

from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = ROOT_DIR / "templates"
ASSETS_DIR = ROOT_DIR / "assets"
OUTPUT_DIR = ROOT_DIR / "output"

FORNITORE = {
    "ragione_sociale": "Calicchia Design di Federico Calicchia",
    "indirizzo": "Via Scifelli 74, 03023 Ceccano (FR)",
    "piva": "03160480608",
    "legale_rappresentante": "Federico Calicchia",
    "telefono": "351 777 3467",
    "email": "info@calicchia.design",
    "banca": "Revolut Bank UAB",
    "iban": "LT84 3250 0216 2701 8744",
    "bic": "REVOLT21",
}

BRAND = {
    "colore_primario": "#f57f44",
    "colore_successo": "#16a34a",
    "colore_errore": "#dc2626",
    "colore_info": "#2563eb",
    "font": "Inter, Arial, sans-serif",
    "logo_path": str(ASSETS_DIR / "logo.png"),
}

REGIME_FISCALE = {
    "tipo": "forfettario",
    "nota_iva": (
        "Regime forfettario ai sensi dell'art. 1, commi 54–89, L. 190/2014 "
        "e successive modifiche. Operazione senza applicazione IVA ex art. 1, "
        "comma 58, L. 190/2014. Ritenuta d'acconto non applicata ai sensi "
        "dell'art. 1, comma 67, L. 190/2014."
    ),
    "marca_bollo": (
        "Su importi superiori a € 77,47 verrà applicata marca da bollo "
        "da € 2,00 come previsto dalla normativa vigente."
    ),
    "soglia_bollo": 77.47,
    "importo_bollo": 2.00,
}

CONTRATTO = {
    "foro_competente": "Tribunale di Frosinone",
    "durata_standard_mesi": 12,
    "clausole_vessatorie": [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
}
