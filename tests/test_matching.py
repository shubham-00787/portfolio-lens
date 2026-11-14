"""Offline tests for the name-cleaning and scoring logic (no network)."""
from app.matching import _score, canon, clean_statement_noise, normalise, wants_regular
from app.stocks import clean_security_name, sector_from_industry


def test_strips_rta_codes_and_former_names():
    assert clean_statement_noise("SCDG - Axis Small Cap Fund Direct Growth") == "Axis Small Cap Fund Direct Growth"
    assert clean_statement_noise("9656 - ICICI Prudential NASDAQ 100 Index Fund").startswith("ICICI")
    assert "formerly" not in clean_statement_noise("Mirae Asset Large and Midcap Fund (formerly Mirae Asset Emerging Bluechip Fund)")
    # a fund house name before the dash is not a code
    assert clean_statement_noise("UTI - Nifty 50 Index Fund").startswith("UTI")


def test_aliases_and_renames():
    assert "parag parikh" in normalise("ppfas flexi")
    assert "large cap" in normalise("icici bluechip")
    assert "mid cap" in normalise("hdfc midcap opportunities")
    assert "large mid cap" in normalise("mirae emerging bluechip")


def test_canon_is_symmetric_for_compounds_and_plan_words():
    assert canon("Axis Midcap Direct Plan-Growth") == canon("axis mid cap fund")


def test_score_prefers_exact_fund_over_superset_names():
    q = canon(normalise("axis mid cap fund direct growth"))
    assert _score(q, "Axis Midcap Direct Plan-Growth", 1) > _score(q, "Axis Large & Mid Cap Fund", 0)
    q = canon(normalise("nippon india index fund bse sensex plan"))
    assert _score(q, "Nippon India Index Fund - BSE Sensex Plan", 3) > _score(q, "Nippon India BSE Sensex Next 30 Index Fund", 0)
    q = canon(normalise("mirae asset large and midcap fund"))
    assert _score(q, "Mirae Asset Large & Midcap Fund", 1) > _score(q, "Mirae Asset Large Cap Fund", 0)


def test_plan_detection():
    assert wants_regular("hdfc mid cap reg") and not wants_regular("hdfc mid cap direct")


def test_security_name_cleanup():
    assert clean_security_name("INE002A01018 RELIANCE INDUSTRIES LIMITED#EQUITY SHARES WITH FACE VALUE RS.10/-") == "RELIANCE INDUSTRIES"
    assert clean_security_name("THE TATA POWER COMPANY LIMITED-NEW EQUITY SHARES OF RE.1/-") == "THE TATA POWER COMPANY"
    assert clean_security_name("bls intl") == "bls international"


def test_industry_to_sector():
    assert sector_from_industry("Electrical Equipment") == "Industrials"
    assert sector_from_industry("Rating Agencies") == "Financial"
    assert sector_from_industry("Pharmaceuticals") == "Healthcare"
    assert sector_from_industry("Professional Services") == "Industrials"
    assert sector_from_industry(None) == "Other"
