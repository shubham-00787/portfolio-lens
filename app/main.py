from __future__ import annotations

import asyncio
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import benchmarks, groww, matching, stocks

ROOT = Path(__file__).resolve().parent.parent
MAX_ITEMS = 100        # a large CAS can list many funds / folios
MAX_ITEM_LEN = 300     # one statement row
SEARCH_ID_RE = re.compile(r"^[a-z0-9][a-z0-9'-]{1,150}$")  # Groww slugs, e.g. icici-prudential-children's-fund-...


@asynccontextmanager
async def lifespan(_app):
    yield
    await groww.close()


app = FastAPI(title="Portfolio Lens", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.middleware("http")
async def cache_headers(request, call_next):
    """API responses describe the user's portfolio lookups: tell the browser not to keep them."""
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    elif path == "/" or path.startswith("/static/"):
        # always revalidate the app's own files so an update is never hidden behind a stale cached copy
        resp.headers["Cache-Control"] = "no-cache"
    return resp


class MatchRequest(BaseModel):
    names: list[str]


@app.get("/api/search")
async def search(q: str = Query(..., min_length=2)):
    return await matching.match(q, limit=8)


@app.post("/api/match")
async def match_many(req: MatchRequest):
    names = [n.strip()[:MAX_ITEM_LEN] for n in req.names][:MAX_ITEMS]
    # one result per input (order preserved); a failed lookup becomes an empty match instead of failing the batch
    async def one(n: str):
        return await matching.match(n) if n else {"query": n, "best": None, "confidence": "none", "alternatives": []}
    res = await asyncio.gather(*(one(n) for n in names), return_exceptions=True)
    return [r if not isinstance(r, Exception) else {"query": n, "best": None, "confidence": "none", "alternatives": []}
            for n, r in zip(names, res)]


class StockMatchRequest(BaseModel):
    items: list[str]


@app.post("/api/stocks/match")
async def stocks_match(req: StockMatchRequest):
    items = [s.strip()[:MAX_ITEM_LEN] for s in req.items][:MAX_ITEMS]
    return await stocks.match_many(items)


@app.get("/api/indices")
async def indices():
    return benchmarks.list_indices()


@app.get("/api/index/{key}")
async def get_index(key: str):
    if key not in benchmarks.BY_KEY:
        raise HTTPException(404, "Unknown index")
    try:
        return await benchmarks.get_index(key)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Upstream error: {e}")


@app.get("/api/size-buckets")
async def size_buckets():
    try:
        return await benchmarks.size_buckets()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Upstream error: {e}")


@app.get("/api/scheme/{search_id}")
async def scheme(search_id: str, plan: str = "direct"):
    if not SEARCH_ID_RE.match(search_id):
        raise HTTPException(400, "Invalid fund id")
    try:
        data = await groww.get_scheme(search_id)
        # Holdings are identical across Direct/Regular; this only changes the label/ER shown.
        if plan == "regular" and data.get("regular_search_id") and data["regular_search_id"] != search_id:
            try:
                data = await groww.get_scheme(data["regular_search_id"])
            except httpx.HTTPError:
                pass
        return data
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"Could not fetch scheme {search_id}")
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Upstream error: {e}")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
async def home():
    return FileResponse(ROOT / "static" / "index.html")
