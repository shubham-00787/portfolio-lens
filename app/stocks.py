"""Match directly-held shares (from a demat/CAS statement or typed) to Groww stock ids.

Groww stock search_ids are the same ids MF holdings use (`stock_search_id`), so a direct holding of
Adani Power lines up with the Adani Power inside your funds. Sector comes from MF holdings when any
cached fund holds the stock (same taxonomy), else from Groww's industry name mapped to those sectors.
"""
from __future__ import annotations

import asyncio
import re

from rapidfuzz import fuzz

from . import groww

ISIN_RE = re.compile(r"\bIN[EF][0-9A-Z]{9}\b", re.I)

# Groww industry name -> the broad sector names used in MF holdings. First keyword hit wins.
INDUSTRY_TO_SECTOR = [
    (("real estate", "realty", "reit"), "Real Estate"),
    (("bank", "finance", "nbfc", "insurance", "capital market", "exchange", "depositor", "asset manag",
      "broking", "rating", "fintech", "investment", "housing finance", "financial"), "Financial"),
    (("pharma", "health", "hospital", "diagnostic", "biotech", "medical", "drug"), "Healthcare"),
    (("software", "it services", "it -", "technology", "telecom", "internet", "computer", "semiconductor",
      "data processing", "e-commerce"), "Technology"),
    (("power", "utilit", "oil", "gas", "energy", "coal", "petroleum", "refiner"), "Energy & Utilities"),
    (("cement", "metal", "steel", "chemical", "mining", "paper", "fertili", "aluminium", "alumin", "copper",
      "zinc", "iron", "glass", "plastic", "packaging", "agrochem"), "Materials"),
    (("fmcg", "food", "beverage", "tobacco", "personal care", "household", "sugar", "tea", "dairy",
      "consumer staples", "agri"), "Consumer Staples"),
    (("auto", "retail", "textile", "apparel", "consumer durable", "hotel", "media", "entertainment",
      "leisure", "jewel", "footwear", "restaurant", "travel", "education", "tyre", "consumer"),
     "Consumer Discretionary"),
    (("electrical", "engineering", "capital goods", "construction", "infra", "industrial", "defence",
      "aerospace", "logistic", "shipping", "airline", "transport", "business services", "commercial services",
      "machinery", "equipment", "cable", "railway", "outsourc", "staffing", "professional services"), "Industrials"),
]


def sector_from_industry(industry: str | None) -> str:
    s = (industry or "").lower()
    for keys, sector in INDUSTRY_TO_SECTOR:
        if any(k in s for k in keys):
            return sector
    return "Other"


async def _fund_sector_index() -> dict[str, str]:
    """stock key -> sector in the MF-holdings taxonomy. The Nifty 500 portfolio is loaded first so the
    500 largest companies always get the same label regardless of which funds happen to be in memory."""
    from . import benchmarks  # local import: benchmarks imports groww too
    idx: dict[str, str] = {}
    try:
        for h in (await benchmarks.get_index("nifty500"))["holdings"]:
            idx[h["key"]] = h["sector"]
    except Exception:
        pass
    for scheme in groww.cached_schemes():
        for h in scheme.get("holdings", []):
            if h.get("asset_class") == "Equity" and h.get("sector") not in (None, "Unspecified"):
                idx.setdefault(h["key"], h["sector"])
    return idx


def clean_security_name(raw: str) -> str:
    """'ADANI POWER LIMITED#NEW EQUITY SHARES WITH FACE VALUE RS.2/- AFTER SUB-DIVISION' -> 'ADANI POWER'."""
    s = ISIN_RE.sub(" ", raw)
    s = re.split(r"#|\s-\s*(?:new\s+)?equity|\bnew equity\b|\bequity shares\b", s, flags=re.I)[0]
    s = re.sub(r"\b(limited|ltd\.?)\b", " ", s, flags=re.I)
    for short, full in ((r"\bintl\b", "international"), (r"\bind\b", "india"), (r"\bcorp\b", "corporation"),
                        (r"\btech\b", "technologies"), (r"\bfin\b", "finance"), (r"\bsvcs?\b", "services")):
        s = re.sub(short, full, s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip(" -,")


async def match_stock(raw: str) -> dict:
    isin = (m.group(0).upper() if (m := ISIN_RE.search(raw)) else None)
    name = clean_security_name(raw)
    results = []
    if isin:
        results = await groww.search_stocks(isin, size=3)
    if not results and name:
        results = await groww.search_stocks(name, size=6)
    best = results[0] if results else None
    confidence = "none"
    if best:
        if isin and best.get("isin") == isin:
            confidence = "high"  # exact ISIN match
        else:
            # Name match only (no ISIN, or the ISIN wasn't found): judge by how close the names are.
            sc = fuzz.token_set_ratio(name.lower(), clean_security_name(best["title"]).lower())
            confidence = "high" if sc >= 90 else "medium" if sc >= 70 else "low"
            if sc < 60:
                best, confidence = None, "none"  # never silently add an unrelated stock
    if best:
        idx = await _fund_sector_index()
        for c in results:
            if c["search_id"] in idx:
                c["sector"], c["sector_source"] = idx[c["search_id"]], "funds"
        if "sector" not in best:
            try:
                info = await groww.get_stock_info(best["search_id"])
                best["industry"] = info.get("industry")
                best["sector"], best["sector_source"] = sector_from_industry(info.get("industry")), "industry"
            except Exception:
                best["sector"], best["sector_source"] = "Other", "unknown"
    return {"query": raw, "cleaned": name, "isin": isin, "best": best, "confidence": confidence,
            "alternatives": results}


async def match_many(raws: list[str]) -> list[dict]:
    """One result per input, in order. A failed lookup yields an empty match rather than failing the batch."""
    res = await asyncio.gather(*(match_stock(r) for r in raws), return_exceptions=True)
    return [r if not isinstance(r, Exception) else {"query": q, "best": None, "confidence": "none", "alternatives": []}
            for q, r in zip(raws, res)]
