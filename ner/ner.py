"""Extraction d'entités NER pour Memento (famille « entités NER », ADR 0002).

0 LLM : GLiNER = encodeur (famille BERT), zero-shot typé. Famille NER seulement —
personne · entreprise · outil. Les « entités logiques » (décision…) sont posées
par l'agent via `propose_changes`, PAS ici.

Ce module fait UNIQUEMENT l'extraction (texte → spans typés). La résolution
(normalise → exact-match → trigram + Jaro-Winkler) reste côté Deno/Postgres
(source unique de la normalisation = la fn SQL `normalise_name`). On ne renvoie
donc pas de clé normalisée ici, pour éviter deux implémentations qui divergent.
"""
from __future__ import annotations
from functools import lru_cache

# 3 types verrouillés (ADR 0002 / D1). Élargissement = sur preuve d'usage.
NER_TYPES = ["personne", "entreprise", "outil"]
MODEL_NAME = "urchade/gliner_multi-v2.1"


@lru_cache(maxsize=1)
def _model():
    """Charge le modèle une seule fois (gardé chaud par le service, cf. app.py)."""
    from gliner import GLiNER
    return GLiNER.from_pretrained(MODEL_NAME)


def warmup() -> None:
    """Force le chargement (appelé au démarrage du service pour éviter le 1er appel lent)."""
    _model()


def _shape(e: dict) -> dict:
    return {
        "text": e["text"],
        "type": e["label"],
        "score": round(float(e["score"]), 3),
        "start": e.get("start"),
        "end": e.get("end"),
    }


def extract(text: str, threshold: float = 0.5) -> list[dict]:
    """Entités NER d'un texte, triées par score décroissant."""
    ents = _model().predict_entities(text, NER_TYPES, threshold=threshold)
    return sorted((_shape(e) for e in ents), key=lambda x: -x["score"])


def extract_batch(texts: list[str], threshold: float = 0.5) -> list[list[dict]]:
    """Plusieurs textes en un appel (un seul modèle chaud). Préserve l'ordre."""
    m = _model()
    out = []
    for t in texts:
        ents = m.predict_entities(t, NER_TYPES, threshold=threshold)
        out.append(sorted((_shape(e) for e in ents), key=lambda x: -x["score"]))
    return out
