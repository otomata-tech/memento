"""Micro-service NER Memento — FastAPI.

Appelé par la Edge Function `apply()` (Deno) en async après l'apply, pour
extraire les entités NER d'une page. Service interne (réseau otomata-0) :
protégé par un bearer partagé (env NER_API_KEY).

Contrat :
  GET  /health                          -> {status, model, types}
  POST /extract       {text, threshold?} -> {entities: [...]}
  POST /extract_batch {texts, threshold?} -> {results: [[...], ...]}

Entité = {text, type, score, start, end}. La résolution (normalise/match) se fait
côté Deno/Postgres (cf. ner.py).
"""
from __future__ import annotations
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from ner import NER_TYPES, MODEL_NAME, extract, extract_batch, warmup

API_KEY = os.environ.get("NER_API_KEY")  # requis en prod ; si absent → service ouvert (dev only)


def _auth(authorization: str | None) -> None:
    if not API_KEY:
        return  # dev : pas de clé configurée
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="bad or missing bearer")


@asynccontextmanager
async def lifespan(app: FastAPI):
    warmup()  # charge le modèle au démarrage (évite le 1er appel à 36 s)
    yield


app = FastAPI(title="memento-ner", version="0.1.0", lifespan=lifespan)


class ExtractIn(BaseModel):
    text: str
    threshold: float = Field(0.5, ge=0.0, le=1.0)


class BatchIn(BaseModel):
    texts: list[str] = Field(..., max_length=64)
    threshold: float = Field(0.5, ge=0.0, le=1.0)


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "types": NER_TYPES}


@app.post("/extract")
def extract_one(body: ExtractIn, authorization: str | None = Header(default=None)):
    _auth(authorization)
    return {"entities": extract(body.text, body.threshold)}


@app.post("/extract_batch")
def extract_many(body: BatchIn, authorization: str | None = Header(default=None)):
    _auth(authorization)
    return {"results": extract_batch(body.texts, body.threshold)}
