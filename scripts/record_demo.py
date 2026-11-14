"""Record a ~30-35 s walkthrough of Portfolio Lens.

Usage (with the app running on http://127.0.0.1:8765, e.g. via ./run.sh):

    .venv/bin/pip install -r requirements-dev.txt
    .venv/bin/python scripts/record_demo.py            # writes docs/demo.mp4 and docs/demo.gif

Drives your installed Google Chrome (headless) with Playwright, shows a visible cursor and step
captions, and uses only sample data (well-known funds and stocks), never anyone's real portfolio.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import imageio_ffmpeg
from playwright.sync_api import Page, sync_playwright

BASE = "http://127.0.0.1:8765"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "docs"
W, H = 1280, 760

FUNDS = """ppfas flexi cap, 3L
hdfc midcap opp - 2,00,000
quant small cap 1.5L
icici bluechip, 1L
mirae emerging bluechip 1L"""
STOCKS = """INE002A01018 RELIANCE INDUSTRIES, 1,50,000
infosys 1L"""

# Visible cursor, click ripple and a caption bar (video capture doesn't include the OS cursor).
OVERLAY_JS = r"""
(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return;
    const st = document.createElement('style');
    st.textContent = `
      #__demo_cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;
        transform:translate(-3px,-2px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));transition:none}
      .__demo_ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;z-index:2147483646;
        pointer-events:none;border:3px solid rgba(79,70,229,.85);animation:__r .55s ease-out forwards}
      @keyframes __r{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}
      #__demo_caption{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483645;pointer-events:none;
        background:rgba(11,18,32,.88);color:#fff;font:600 17px/1.35 "Plus Jakarta Sans",Inter,system-ui,sans-serif;
        padding:11px 20px;border-radius:12px;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);max-width:80%;text-align:center;
        transition:opacity .25s;opacity:0;letter-spacing:-.01em}
      #__demo_caption b{color:#a5b4fc;font-weight:800;margin-right:6px}`;
    document.head.appendChild(st);
    const c = document.createElement('div'); c.id = '__demo_cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M3 2l7.5 19 2.6-7.6L21 11z" fill="#0b1220" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const cap = document.createElement('div'); cap.id = '__demo_caption'; document.body.appendChild(cap);
    addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', e => {
      const r = document.createElement('div'); r.className = '__demo_ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r); setTimeout(() => r.remove(), 600);
    }, true);
    window.__caption = (html) => { cap.style.opacity = html ? 1 : 0; if (html) cap.innerHTML = html; };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
"""


def api(path: str, body: dict | None = None):
    req = urllib.request.Request(BASE + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def warm_cache() -> None:
    """Fetch everything the demo needs once, so the recording doesn't sit on loading states."""
    names = [line.rsplit(",", 1)[0].rsplit(" - ", 1)[0] for line in FUNDS.splitlines()]
    for m in api("/api/match", {"names": FUNDS.splitlines() + names}):
        if m.get("best"):
            api(f"/api/scheme/{m['best']['search_id']}")
    api("/api/stocks/match", {"items": STOCKS.splitlines()})
    api("/api/size-buckets")
    for key in ("nifty500", "mid150"):
        api(f"/api/index/{key}")


class Demo:
    def __init__(self, page: Page):
        self.p = page
        self.x, self.y = W / 2, H / 2
        self.t0 = time.time()

    def mark(self, label: str) -> None:
        print(f"  {time.time() - self.t0:5.1f}s  {label}")

    def caption(self, html: str | None) -> None:
        self.p.evaluate("h => window.__caption && window.__caption(h)", html)

    def move_to(self, selector: str, dx: float = 0.5, dy: float = 0.5, steps: int = 22) -> tuple[float, float]:
        box = self.p.locator(selector).first.bounding_box()
        tx, ty = box["x"] + box["width"] * dx, box["y"] + box["height"] * dy
        self.p.mouse.move(tx, ty, steps=steps)
        self.x, self.y = tx, ty
        return tx, ty

    def click(self, selector: str, pause: float = 0.25) -> None:
        self.move_to(selector)
        time.sleep(pause)
        self.p.mouse.down(); self.p.mouse.up()

    def scroll_to(self, selector: str, offset: int = 78, wait: float = 0.9) -> None:
        self.p.evaluate("""([sel, off]) => {
            const el = document.querySelector(sel);
            const y = el.getBoundingClientRect().top + scrollY - off;
            scrollTo({ top: y, behavior: 'smooth' });
        }""", [selector, offset])
        # wait until the smooth scroll has really settled, so later clicks land where we aim
        self.p.evaluate("""() => new Promise(res => {
            let last = -1, still = 0;
            const t = setInterval(() => {
                if (Math.abs(scrollY - last) < 0.5) { if (++still >= 4) { clearInterval(t); res(); } } else still = 0;
                last = scrollY;
            }, 40);
            setTimeout(() => { clearInterval(t); res(); }, 2500);
        })""")
        time.sleep(max(0.0, wait - 0.4))

    def type_slow(self, selector: str, text: str, delay_ms: int = 9) -> None:
        self.click(selector)
        self.p.locator(selector).first.type(text, delay=delay_ms)


def record(raw_dir: Path) -> Path:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1, color_scheme="light",
                                  record_video_dir=str(raw_dir), record_video_size={"width": W, "height": H},
                                  accept_downloads=True)
        ctx.add_init_script(OVERLAY_JS)
        page = ctx.new_page()
        d = Demo(page)
        page.goto(BASE, wait_until="networkidle")
        page.evaluate("document.fonts.ready")
        page.mouse.move(W * 0.62, H * 0.55)
        time.sleep(0.6)

        # 1. intro
        d.mark("intro")
        d.caption("<b>Portfolio Lens</b> See what you really own through your mutual funds")
        time.sleep(2.0)

        # 2. paste funds
        d.mark("funds")
        d.scroll_to("#inputCard", offset=70, wait=0.7)
        d.caption("<b>1</b> Paste your funds. Rough names and amounts are fine")
        d.click("#pasteBtn")
        page.wait_for_selector("#pasteArea", state="visible")
        d.type_slow("#pasteArea", FUNDS)
        time.sleep(0.4)
        d.click("#pasteApply")
        d.caption("Every name is matched to the right scheme, even renamed funds")
        page.wait_for_selector("#results:not(.hidden)", timeout=60000)
        page.wait_for_function("!document.querySelector('#analyzeBtn').disabled", timeout=60000)
        time.sleep(1.5)

        # 3. direct stocks
        d.mark("stocks")
        d.scroll_to("#stockCard", offset=70, wait=0.7)
        d.caption("<b>2</b> Add shares you hold directly (optional)")
        d.click("#stockPasteBtn")
        page.wait_for_selector("#stockPasteArea", state="visible")
        d.type_slow("#stockPasteArea", STOCKS)
        d.click("#stockPasteApply")
        page.wait_for_function("!document.querySelector('#analyzeBtn2').disabled && document.querySelectorAll('#stockRows .conf.high').length >= 2", timeout=60000)
        time.sleep(0.5)

        # 4. overview
        d.mark("overview")
        d.scroll_to("#overview", wait=0.8)
        d.caption("<b>3</b> Your true exposure: every fund opened up, each stock counted once")
        d.move_to("#treemap", 0.35, 0.45, steps=30)
        time.sleep(2.0)

        # 5. top holdings
        d.mark("top holdings")
        d.caption("Biggest exposures, split by the fund they come from")
        d.scroll_to("#top-holdings", wait=0.7)
        d.move_to("#stockChart", 0.42, 0.12, steps=25)
        time.sleep(1.9)

        # 6. compare with an index
        d.mark("compare")
        d.caption("<b>4</b> Compare with any Indian index: size mix, sectors and stocks")
        d.scroll_to("#compare", wait=0.7)
        d.move_to("#benchSelect")
        time.sleep(0.4)
        page.mouse.down(); page.mouse.up()
        page.select_option("#benchSelect", "mid150")
        page.keyboard.press("Escape")
        time.sleep(2.2)

        # 7. rebalance with a slider
        d.mark("rebalance")
        d.caption("<b>5</b> Drag a slider to rebalance. Everything updates live")
        d.scroll_to("#inputCard", offset=70, wait=0.7)
        # grab the thumb where it actually is (its position follows the current value)
        frac = page.evaluate("""() => { const s = document.querySelector('#fundRows .fund-row:nth-child(3) .sl');
                                          return (s.value - s.min) / (s.max - s.min); }""")
        x, y = d.move_to("#fundRows .fund-row:nth-child(3) .sl", 0.03 + 0.94 * frac, 0.5)
        time.sleep(0.2)
        page.mouse.down()
        page.mouse.move(x + 90, y, steps=24)
        page.mouse.up()
        time.sleep(1.2)

        # 8. holdings table
        d.mark("holdings")
        d.caption("Search every holding and see exactly where it comes from")
        d.scroll_to("#all-holdings", wait=0.7)
        d.click("#tableSearch")
        page.locator("#tableSearch").type("infosys", delay=55)
        time.sleep(0.3)
        d.click("#holdTable tbody tr.stock-row")
        time.sleep(1.6)

        # 9. download PDF
        d.mark("pdf")
        d.caption("<b>6</b> Download the full analysis as a PDF. Nothing leaves your browser")
        d.scroll_to("#download", offset=200, wait=0.7)
        with page.expect_download(timeout=90000):
            d.click("#download .pdfBtn")
        d.mark("pdf saved")
        d.caption("✓ PDF saved to your Downloads")
        time.sleep(1.6)
        d.mark("end")

        video = page.video
        ctx.close()   # finalises the video file
        browser.close()
        return Path(video.path())


def convert(webm: Path) -> None:
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    OUT_DIR.mkdir(exist_ok=True)
    mp4, gif = OUT_DIR / "demo.mp4", OUT_DIR / "demo.gif"
    # trim the blank first frames while the page loads
    subprocess.run([ff, "-y", "-loglevel", "error", "-ss", "0.6", "-i", str(webm),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-preset", "slow",
                    "-movflags", "+faststart", "-an", str(mp4)], check=True)
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(mp4), "-vf",
                    "fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", str(gif)], check=True)
    for f in (mp4, gif):
        print(f"{f.relative_to(ROOT)}  {f.stat().st_size / 1e6:.1f} MB")


def main() -> int:
    try:
        api("/api/indices")
    except Exception:
        print(f"Start the app first (./run.sh) so it's reachable at {BASE}", file=sys.stderr)
        return 1
    print("warming cache…"); warm_cache()
    raw = Path(tempfile.mkdtemp(prefix="portfolio-lens-demo-"))
    try:
        print("recording…"); webm = record(raw)
        print("converting…"); convert(webm)
    finally:
        shutil.rmtree(raw, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
