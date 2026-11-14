"""Indian equity indices, each represented by an index fund that tracks it.

Using a tracking fund's monthly portfolio gives constituents + weights in exactly the same
sector taxonomy and stock ids as the user's own funds, so comparisons are like-for-like.
Tracking error is tiny for these (they hold the index), and cash is excluded before normalising.
"""
from __future__ import annotations

import asyncio

from . import groww

INDICES = [
    # key, label, group, proxy fund search_id
    ("nifty50", "Nifty 50", "Large cap", "uti-nifty-fund-direct-growth"),
    ("sensex", "BSE Sensex", "Large cap", "hdfc-bse-sensex-index-fund-direct-growth"),
    ("next50", "Nifty Next 50", "Large cap", "uti-nifty-next-50-index-fund-direct-growth"),
    ("nifty100", "Nifty 100", "Large cap", "axis-nifty-100-index-fund-direct-growth"),
    ("largemid250", "Nifty LargeMidcap 250", "Broad", "icici-prudential-nifty-largemidcap-250-index-fund-direct-growth"),
    ("nifty500", "Nifty 500", "Broad", "sbi-nifty-500-index-fund-direct-growth"),
    ("midsmall400", "Nifty MidSmallcap 400", "Mid & small", "navi-nifty-midsmallcap-400-index-fund-direct-growth"),
    ("mid150", "Nifty Midcap 150", "Mid & small", "motilal-oswal-nifty-midcap-150-index-fund-direct-growth"),
    ("small250", "Nifty Smallcap 250", "Mid & small", "motilal-oswal-nifty-smallcap-250-index-fund-direct-growth"),
]
BY_KEY = {k: (label, group, sid) for k, label, group, sid in INDICES}


def list_indices() -> list[dict]:
    return [{"key": k, "label": label, "group": group} for k, label, group, _ in INDICES]


async def get_index(key: str) -> dict:
    label, group, sid = BY_KEY[key]
    s = await groww.get_scheme(sid)
    eq = [h for h in s["holdings"] if h["asset_class"] == "Equity"]
    tot = sum(h["weight"] for h in eq) or 1.0
    merged: dict[str, dict] = {}
    for h in eq:
        m = merged.setdefault(h["key"], {"key": h["key"], "name": h["name"], "sector": h["sector"], "weight": 0.0})
        m["weight"] += h["weight"] / tot * 100
    return {"key": key, "label": label, "group": group, "proxy": s["name"], "as_of": s.get("portfolio_date"),
            "holdings": sorted(merged.values(), key=lambda x: -x["weight"])}


async def size_buckets() -> dict:
    """stock key -> 'Large' | 'Mid' | 'Small' by index membership: Nifty 100 / Midcap 150 / Smallcap 250.
    These indices are rebuilt from AMFI's semi-annual market-cap list, i.e. SEBI's large/mid/small definition.
    (Ranking by Nifty 500 weight would be wrong: those weights are free-float, so promoter-heavy large caps
    rank too low.)"""
    large, mid, small = await asyncio.gather(get_index("nifty100"), get_index("mid150"), get_index("small250"))
    out: dict[str, str] = {}
    for label, idx in (("Small", small), ("Mid", mid), ("Large", large)):  # later wins on overlap
        for h in idx["holdings"]:
            out[h["key"]] = label
    return {"as_of": large["as_of"], "buckets": out}
