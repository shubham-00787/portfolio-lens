"""Thin client for Groww's public mutual-fund / stock endpoints.

Privacy: nothing is written to disk. Responses are kept in a small in-process memory cache
(public market data only, keyed by the lookup) so repeated lookups are fast; it vanishes when
the server stops. Holdings are published monthly, so a few hours of caching is plenty.
"""
from __future__ import annotations

import re
import time
from collections import OrderedDict

import httpx

SEARCH_URL = "https://groww.in/v1/api/search/v3/query/global/st_query"
SCHEME_URL = "https://groww.in/v1/api/data/mf/web/v4/scheme/search/{search_id}"
HEADERS = {"User-Agent": "Mozilla/5.0 (portfolio-lens)", "Accept": "application/json"}

CACHE_TTL = 6 * 3600
CACHE_MAX = 3000
_cache: "OrderedDict[tuple[str, str], tuple[float, object]]" = OrderedDict()

_client = httpx.AsyncClient(headers=HEADERS, timeout=20.0, follow_redirects=True)


def _read_cache(kind: str, key: str):
    hit = _cache.get((kind, key))
    if hit and time.time() - hit[0] < CACHE_TTL:
        _cache.move_to_end((kind, key))
        return hit[1]
    return None


def _write_cache(kind: str, key: str, value) -> None:
    _cache[(kind, key)] = (time.time(), value)
    _cache.move_to_end((kind, key))
    while len(_cache) > CACHE_MAX:
        _cache.popitem(last=False)


async def close() -> None:
    await _client.aclose()


def cached_schemes() -> list[dict]:
    """Fund portfolios currently in memory (used to give direct stocks the same sector labels)."""
    return [v for (kind, _), (_, v) in list(_cache.items()) if kind == "scheme"]


async def search_schemes(query: str, size: int = 10) -> list[dict]:
    key = f"{query.lower().strip()}_{size}"
    if (hit := _read_cache("search", key)) is not None:
        return hit
    r = await _client.get(
        SEARCH_URL,
        params={"query": query, "entity_type": "scheme", "page": 0, "size": size},
    )
    r.raise_for_status()
    content = (r.json().get("data") or {}).get("content") or []
    out = [
        {"title": c["title"], "search_id": c["search_id"], "scheme_code": c.get("scheme_code")}
        for c in content
        if c.get("entity_type") == "Scheme" and c.get("search_id")
    ]
    _write_cache("search", key, out)
    return out


def _asset_class(nature: str | None) -> str:
    n = (nature or "").upper()
    if n == "EQUITY":
        return "Equity"
    if n == "DEBT":
        return "Debt"
    if n == "CASH":
        return "Cash & Equivalents"
    if n in ("REALEST", "REIT", "INVIT"):
        return "REITs & InvITs"
    if n == "MF":
        return "Mutual Fund Units"
    if n in ("GOLD", "COMMODITY", "SILVER"):
        return "Commodities"
    return "Other"


def _norm_key(name: str) -> str:
    s = name.lower()
    s = re.sub(r"\b(ltd|limited|corp|corporation|co|inc|the)\b\.?", " ", s)
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


async def get_scheme(search_id: str) -> dict:
    if (hit := _read_cache("scheme", search_id)) is not None:
        return hit
    r = await _client.get(SCHEME_URL.format(search_id=search_id))
    r.raise_for_status()
    d = r.json()

    holdings = []
    portfolio_date = None
    for h in d.get("holdings") or []:
        weight = h.get("corpus_per")
        if weight is None:
            continue
        portfolio_date = portfolio_date or h.get("portfolio_date")
        asset = _asset_class(h.get("nature_name"))
        sector = h.get("sector_name") or "Unspecified"
        if asset != "Equity":
            # Debt issuer "sector" is misleading next to equity sectors; bucket by asset class.
            sector = asset
        name = h.get("company_name") or "Unknown"
        holdings.append(
            {
                "key": h.get("stock_search_id") or _norm_key(name),
                "name": name,
                "sector": sector,
                "asset_class": asset,
                "instrument": h.get("instrument_name"),
                "weight": float(weight),  # % of fund corpus
            }
        )

    scheme = {
        "search_id": search_id,
        "name": d.get("scheme_name") or d.get("fund_name"),
        "fund_house": d.get("fund_house"),
        "category": d.get("category"),
        "sub_category": d.get("sub_category"),
        "plan_type": d.get("plan_type"),
        "aum_cr": d.get("aum"),
        "expense_ratio": d.get("expense_ratio"),
        "nav": d.get("nav"),
        "nav_date": d.get("nav_date"),
        "regular_search_id": d.get("regular_search_id"),
        "portfolio_date": portfolio_date,
        "holdings": sorted(holdings, key=lambda x: -x["weight"]),
    }
    _write_cache("scheme", search_id, scheme)
    return scheme


AMFI_SEARCH_URL = "https://api.mfapi.in/mf/search"


async def amfi_search(query: str) -> list[dict]:
    key = query.lower().strip()
    if (hit := _read_cache("amfi", key)) is not None:
        return hit
    r = await _client.get(AMFI_SEARCH_URL, params={"q": query})
    r.raise_for_status()
    out = r.json() or []
    _write_cache("amfi", key, out)
    return out


STOCK_INFO_URL = "https://groww.in/v1/api/stocks_data/v1/company/search_id/{search_id}"


async def search_stocks(query: str, size: int = 6) -> list[dict]:
    key = f"{query.lower().strip()}_{size}"
    if (hit := _read_cache("stocksearch", key)) is not None:
        return hit
    r = await _client.get(SEARCH_URL, params={"query": query, "entity_type": "stocks", "page": 0, "size": size})
    r.raise_for_status()
    content = (r.json().get("data") or {}).get("content") or []
    out = [{"title": c["title"], "search_id": c["search_id"], "isin": c.get("isin"),
            "symbol": c.get("nse_scrip_code") or c.get("bse_scrip_code")}
           for c in content if c.get("entity_type") == "Stocks" and c.get("search_id")]
    _write_cache("stocksearch", key, out)
    return out


async def get_stock_info(search_id: str) -> dict:
    if (hit := _read_cache("stock", search_id)) is not None:
        return hit
    r = await _client.get(STOCK_INFO_URL.format(search_id=search_id))
    r.raise_for_status()
    h = (r.json() or {}).get("header") or {}
    out = {"name": h.get("displayName") or h.get("shortName"), "isin": h.get("isin"), "industry": h.get("industryName")}
    _write_cache("stock", search_id, out)
    return out
