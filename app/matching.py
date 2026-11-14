"""Map loosely-typed fund names ("ppfas flexi", "axis blue chip reg") to real schemes.

Pipeline: normalise + expand aliases -> query Groww search with a few variants ->
re-rank the union of candidates with rapidfuzz -> return best + alternatives.
"""
from __future__ import annotations

import asyncio
import re

from rapidfuzz import fuzz

from . import groww

# Fund-house nicknames and renamed categories people still type.
ALIASES = {
    # SEBI-recategorisation renames (old name -> current name). Must run before generic aliases.
    r"\bmid ?cap opportunities\b": "mid cap",
    r"\bemerging blue ?chip\b": "large midcap",
    r"\blong term equity\b": "elss tax saver",
    r"\bhdfc top 100\b": "hdfc large cap",
    r"\bkotak emerging equity\b": "kotak midcap",
    r"\bkotak standard multicap\b": "kotak flexi cap",
    r"\bcanara robeco emerging equities\b": "canara robeco large and mid cap",
    r"\bdsp equity opportunities\b": "dsp large & mid cap",
    r"\binvesco india growth opportunities\b": "invesco india large & mid cap",
    r"\bnippon india growth\b(?! mid)": "nippon india growth mid cap",
    r"\bppfas long term value\b": "parag parikh flexi cap",
    r"\bppfas\b": "parag parikh",
    r"\bppfcf\b": "parag parikh flexi cap",
    r"\bsbi mf\b": "sbi",
    r"\bicici pru\b": "icici prudential",
    r"\bicici\b(?! prudential)": "icici prudential",
    r"\breliance\b": "nippon india",
    r"\bnippon\b(?! india)": "nippon india",
    r"\baditya birla\b(?! sun life)": "aditya birla sun life",
    r"\babsl\b": "aditya birla sun life",
    r"\bmirae\b(?! asset)": "mirae asset",
    r"\bmotilal\b(?! oswal)": "motilal oswal",
    r"\bkotak mahindra\b": "kotak",
    r"\bfranklin\b(?! india)": "franklin india",
    r"\bl ?& ?t\b": "hsbc",
    r"\bdsp ?blackrock\b": "dsp",
    r"\buti mf\b": "uti",
    r"\bblue ?chip\b": "large cap",
    r"\bfocused equity\b": "focused",
    r"\bsmallcap\b": "small cap",
    r"\bmidcap\b": "mid cap",
    r"\blargecap\b": "large cap",
    r"\bflexicap\b": "flexi cap",
    r"\bmulticap\b": "multi cap",
    r"\bmid ?& ?small\b": "mid small",
    r"\blarge ?& ?mid\b": "large mid",
    r"\belss\b(?! tax saver)": "elss tax saver",
    r"(?<!elss )\btax saver\b": "elss tax saver",
    r"\bn50\b": "nifty 50",
    r"\bnifty50\b": "nifty 50",
}

# Words that describe the plan/option, not the fund; stripped before searching.
PLAN_WORDS = r"\b(direct|regular|reg|dir|plan|growth|gr|idcw|dividend|payout|reinvestment|option|fund|mf)\b"


AMC_WORDS = {
    "sbi", "uti", "dsp", "hdfc", "icici", "axis", "kotak", "nippon", "quant", "hsbc", "idfc", "bandhan", "lic",
    "pgim", "jm", "tata", "bank", "boi", "baroda", "canara", "edelweiss", "invesco", "itc", "mirae", "motilal",
    "navi", "groww", "zerodha", "helios", "whiteoak", "samco", "sundaram", "taurus", "union", "mahindra", "iti",
    "trust", "nj", "old", "bajaj", "abakkus", "unifi", "360", "franklin", "parag", "ppfas", "absl", "aditya",
}


def clean_statement_noise(raw: str) -> str:
    """Strip things CAS/RTA statements add around the scheme name."""
    s = raw.strip()
    # "(formerly Mirae Asset Emerging Bluechip Fund)" — the old name only confuses search.
    s = re.sub(r"\((?:formerly|erstwhile|earlier|previously|old name)[^)]*\)", " ", s, flags=re.I)
    # Leading RTA scheme code: "SCDG - ", "9656 - ", "001ZG - ", "ACG1G - " (but not "UTI - ...").
    m = re.match(r"^\s*([A-Za-z0-9]{2,8})\s*[-–:]\s+", s)
    if m and (re.search(r"\d", m.group(1)) or m.group(1).lower() not in AMC_WORDS):
        s = s[m.end():]
    # Trailing ISIN / folio fragments if someone pasted a whole row.
    s = re.sub(r"\bINF[0-9A-Z]{9}\b.*$", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def normalise(raw: str) -> str:
    s = clean_statement_noise(raw).lower().replace("&", " & ")
    s = re.sub(r"\band\b", "&", s)
    s = re.sub(r"[()\[\],./]", " ", s)
    for pat, rep in ALIASES.items():
        s = re.sub(pat, rep, s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def wants_regular(raw: str) -> bool:
    return bool(re.search(r"\b(regular|reg)\b", raw.lower()))


_COMPOUNDS = [(r"\bmidcap\b", "mid cap"), (r"\bsmallcap\b", "small cap"), (r"\blargecap\b", "large cap"),
              (r"\bflexicap\b", "flexi cap"), (r"\bmulticap\b", "multi cap"), (r"\bmidsmallcap\b", "mid small cap")]
_NEUTRAL = {"fund", "plan", "direct", "growth", "regular", "option", "the", "of", "and", "india", "scheme", "dir", "reg", "gr"}


def canon(text: str) -> str:
    """Same canonical form for queries and titles so they compare like-for-like."""
    s = text.lower()
    for pat, rep in _COMPOUNDS:
        s = re.sub(pat, rep, s)
    s = re.sub(r"[&()\[\],./:\-–]", " ", s)
    s = re.sub(r"\band\b", " ", s)
    s = re.sub(PLAN_WORDS, " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _score(query: str, title: str, rank: int) -> float:
    q, t = canon(query), canon(title)
    s = (
        0.45 * fuzz.token_set_ratio(q, t)
        + 0.35 * fuzz.token_sort_ratio(q, t)
        + 0.20 * fuzz.partial_ratio(q, t)
    )
    s += max(0.0, 8.0 - 2.0 * rank)  # search engine's own ranking is a useful prior
    for extra in ("index", "etf", "fof", "nifty", "sensex", "arbitrage", "liquid"):
        if extra in t and extra not in q:
            s -= 6
    # token_set_ratio treats a subset as a perfect match, so penalise distinguishing words on either side:
    # title words the user didn't type ("Axis *Large* Mid Cap", "Sensex *Next 30*") and
    # typed words the title lacks ("mirae large *mid* cap" vs "Mirae Large Cap").
    qt, tt = set(q.split()) - _NEUTRAL, set(t.split()) - _NEUTRAL
    s -= min(15.0, 5.0 * len(tt - qt))
    s -= min(15.0, 5.0 * len(qt - tt))
    return round(max(0.0, min(s, 100.0)), 1)


MIN_AUTO_SCORE = 50.0  # below this, a candidate is offered but never auto-selected


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


async def amfi_candidates(core: str, plan: str) -> list[dict]:
    """Fallback: official AMFI scheme list (via mfapi.in). Groww search misses some funds
    (e.g. ICICI NASDAQ 100, Nippon Index Fund - Sensex Plan), but its URL slug is predictable."""
    try:
        rows = await groww.amfi_search(core)
    except Exception:
        return []
    out, seen = [], set()
    for r in rows:
        name = r["schemeName"]
        low = name.lower()
        if plan not in low or "growth" not in low or re.search(r"idcw|dividend|bonus|payout", low):
            continue
        base = re.split(r"\s*[-–]?\s*\b(direct|regular)\b", name, flags=re.I)[0].strip(" -–")
        sid = f"{_slug(base)}-{plan}-growth"
        if sid in seen:
            continue
        seen.add(sid)
        out.append({"title": base, "search_id": sid, "scheme_code": str(r["schemeCode"]), "source": "amfi"})
    return out[:6]


async def match(raw: str, limit: int = 6) -> dict:
    norm = normalise(raw)
    core = canon(norm) or norm
    plan = "regular" if wants_regular(raw) else "direct"
    variants = list(dict.fromkeys([core, norm, clean_statement_noise(raw)]))

    results = await asyncio.gather(
        *(groww.search_schemes(v, size=8) for v in variants), amfi_candidates(core, plan), return_exceptions=True
    )
    candidates: dict[str, dict] = {}
    for res in results:
        if isinstance(res, Exception):
            continue
        for rank, c in enumerate(res):
            sc = _score(core, c["title"], rank if c.get("source") != "amfi" else 4)
            key = canon(c["title"])  # dedupe Groww vs AMFI entries for the same fund
            prev = candidates.get(key)
            if prev is None or sc > prev["score"] or (sc == prev["score"] and prev.get("source") == "amfi"):
                candidates[key] = {**c, "score": sc}

    ranked = sorted(candidates.values(), key=lambda c: -c["score"])
    # AMFI-derived slugs are guesses: verify the top ones actually resolve on Groww before offering them.
    verified: list[dict] = []
    for c in ranked:
        if len(verified) >= limit:
            break
        if c.get("source") == "amfi":
            try:
                await groww.get_scheme(c["search_id"])
            except Exception:
                continue
        verified.append(c)

    best = verified[0] if verified else None
    confidence = "none"
    if best:
        gap = best["score"] - (verified[1]["score"] if len(verified) > 1 else 0)
        confidence = "high" if best["score"] >= 80 and gap >= 4 else "medium" if best["score"] >= 60 else "low"
        if best["score"] < MIN_AUTO_SCORE:
            # Too weak to trust: don't silently add a random fund to someone's portfolio. Offer the list instead.
            best, confidence = None, "none"
    return {"query": raw, "normalised": core, "plan": plan, "best": best,
            "confidence": confidence, "alternatives": verified}
