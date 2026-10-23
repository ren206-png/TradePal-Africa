#!/usr/bin/env python3
"""
Builds the "How to use TradePal Africa" video (about one minute, 1280x720, with narration) without any downloaded tool:
  - narration: macOS `say` (voice Samantha), one clip per scene, timed into one track
  - pictures:  Pillow draws every frame (a phone with a WhatsApp-style chat on the left, captions on the right)
  - encoding:  encode.swift (AVFoundation) writes the H.264 video, `afconvert` makes the AAC audio, and AVFoundation joins them.
Every chat message shown is what the product really replies (see src/commands/commandRouter.ts and src/ai/applyParsedIntent.ts).
All names and amounts are made up.

  python3 scripts/video/how_to_video.py OUT_DIR  ->  OUT_DIR/how-to-use.mp4
"""
import math, os, subprocess, sys, wave, shutil
from multiprocessing import Pool
from PIL import Image, ImageDraw, ImageFont

W, H, S, FPS = 1280, 720, 2, 30
INK, INK2, PAPER, PAPER2, SAFFRON, CLAY, LEAF = "#0f2a22", "#173a2f", "#f7f1e5", "#efe6d3", "#e9a21b", "#b5441f", "#2f7d5b"
WA_BG, WA_OUT, WA_IN = "#efe7dc", "#d9fdd3", "#ffffff"
F = "/System/Library/Fonts/Supplemental/"
FONT = {"sans": F + "Arial.ttf", "bold": F + "Arial Bold.ttf", "serif": F + "Georgia Bold.ttf", "mono": F + "Courier New Bold.ttf"}

_fonts = {}
def font(kind, size):
    k = (kind, size)
    if k not in _fonts:
        _fonts[k] = ImageFont.truetype(FONT[kind], int(size * S))
    return _fonts[k]

def ease(x):
    x = max(0.0, min(1.0, x))
    return 1 - (1 - x) ** 3

def lerp_color(a, b, t):
    a = tuple(int(a[i:i + 2], 16) for i in (1, 3, 5)); b = tuple(int(b[i:i + 2], 16) for i in (1, 3, 5))
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# ------------------------------------------------------------------------------------------------ storyboard
MONEY_SALE = "Logged sale of 12000.00 NGN."
SCENES = [
    dict(id="intro", kind="title", narration="Here is how to keep your shop's records on WhatsApp, with TradePal Africa. It takes about a minute to learn.",
         label="HOW TO USE", title="TradePal Africa", body=["Your shop's records,", "inside WhatsApp."]),
    dict(id="hello", kind="chat", label="STEP 1", title="Say hello on WhatsApp",
         body=["Message TradePal. It asks for", "your shop's name and works out", "your country and currency for you."],
         narration="Step one. Say hello on WhatsApp. TradePal asks for your shop's name, and works out your country and currency for you.",
         chat=[("out", "Hi TradePal, I'd like to set up my shop."), ("in", "Welcome to TradePal! We noticed you're in Nigeria. What's the name of your business?"), ("out", "Mama Ade Provisions")]),
    dict(id="log", kind="chat", label="STEP 2", title="Write down what happens",
         body=["Type it like you would text a friend.", "No forms. No app to install."],
         narration="Step two. Write down what happens, just like texting a friend. No forms. No app to install.",
         chat=[("out", "sold 2 bags of rice for 12000"), ("in", MONEY_SALE), ("out", "paid transport 1500"), ("in", "Logged expense of 1500.00 NGN.")]),
    dict(id="today", kind="chat", label="STEP 3", title="Check your numbers",
         body=["At the end of the day,", "type today to see your sales,", "expenses and payments.", "The slash is optional."],
         narration="Step three. At the end of the day, type today, to see your sales, your expenses, and what came in. You don't need the slash.",
         chat=[("out", "today"), ("in", "Today (Africa/Lagos):\nTransactions: 2\nSales: 12000.00 NGN\nExpenses: 1500.00 NGN\nPayments received: 0.00 NGN\nNet: 10500.00 NGN")]),
    dict(id="debts", kind="chat", label="SELLING ON CREDIT", title="Know who owes you",
         body=["debt Amina 500  - note a debt", "paid Amina 300  - record a payment", "debts  - see who owes you"],
         narration="Selling on credit? Type debt, a name, and an amount, to note who owes you. Type paid when they pay. And type debts to see everyone who still owes you.",
         chat=[("out", "debt Amina 500"), ("in", "Recorded: Amina owes 500.00 NGN.\n\n(I read that as: /debt Amina 500. Not what you meant? Send \"undo\".)"),
               ("out", "paid Amina 300"), ("in", "Applied 300.00 NGN to Amina's debt. Remaining owed: 200.00 NGN.\n\n(I read that as: /paid Amina 300. Not what you meant? Send \"undo\".)"),
               ("out", "debts"), ("in", "Who owes you: 200.00 NGN across 1 customer\nAmina: 200.00 NGN")]),
    dict(id="undo", kind="chat", label="STEP 4", title="Fix mistakes fast",
         body=["Typed the wrong amount?", "Send undo and the last entry", "is reversed. Nothing is silently deleted."],
         narration="Step four. Made a mistake? Send undo, and the last entry is reversed. Nothing is silently deleted.",
         chat=[("out", "sold rice for 120000"), ("in", "Logged sale of 120000.00 NGN."), ("out", "undo"), ("in", "Undone: SALE of 120000.00 NGN.")]),
    dict(id="outro", kind="outro", narration="Send help any time to see what else you can do. Start free on WhatsApp, at tradepal africa dot com.",
         label="NEED A HAND?", title="Send help any time", body=["It lists everything", "you can do."]),
]

# ------------------------------------------------------------------------------------------------ geometry (1x units)
PH_X, PH_Y, PH_W, PH_H = 110, 32, 390, 656
SC_X, SC_Y, SC_W, SC_H = PH_X + 14, PH_Y + 14, PH_W - 28, PH_H - 28
HEAD_H, INPUT_H = 62, 60
CH_TOP, CH_BOT = SC_Y + HEAD_H, SC_Y + SC_H - INPUT_H
BUB_MAX = SC_W - 90
PAD_X, PAD_Y = 12, 9
LINE_H = 23
CAP_X = 590
TYPE_SPEED = 0.05

def wrap(text, f, max_w):
    lines = []
    for para in text.split("\n"):
        words, cur = para.split(" "), ""
        for w in words:
            t = (cur + " " + w).strip()
            if f.getlength(t) / S <= max_w or not cur:
                cur = t
            else:
                lines.append(cur); cur = w
        lines.append(cur)
    return lines

def plan_scene(sc, narr_dur):
    """Timeline of one scene: typing in the input bar, then the bubble; typing dots before a reply. Times are relative to the scene start."""
    ev, t = [], 0.7
    f = font("sans", 17)
    for who, text in sc.get("chat", []):
        lines = wrap(text, f, BUB_MAX - 2 * PAD_X)
        h = len(lines) * LINE_H + 2 * PAD_Y + 6
        if who == "out":
            dur = max(0.7, len(text) * TYPE_SPEED)
            ev.append(dict(who="out", text=text, lines=lines, h=h, type_start=t, show=t + dur))
            t += dur + 0.55
        else:
            dots = 0.9 + 0.012 * len(text)
            ev.append(dict(who="in", text=text, lines=lines, h=h, type_start=t, show=t + dots))
            t += dots + 0.9
    return ev, t

# ------------------------------------------------------------------------------------------------ drawing
def rr(d, box, r, fill, outline=None, width=1):
    x0, y0, x1, y1 = [v * S for v in box]
    d.rounded_rectangle((x0, y0, x1, y1), radius=r * S, fill=fill, outline=outline, width=int(width * S))

def text(d, xy, s, kind, size, fill, anchor="la"):
    d.text((xy[0] * S, xy[1] * S), s, font=font(kind, size), fill=fill, anchor=anchor)

def draw_phone(img, d, sc, ev, t):
    rr(d, (PH_X, PH_Y, PH_X + PH_W, PH_Y + PH_H), 44, INK2)
    rr(d, (PH_X + 3, PH_Y + 3, PH_X + PH_W - 3, PH_Y + PH_H - 3), 41, INK)
    rr(d, (SC_X, SC_Y, SC_X + SC_W, SC_Y + SC_H), 30, WA_BG)
    # chat area drawn on its own layer so bubbles scroll under the header and input bar
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    appeared = [e for e in ev if t >= e["show"]]
    typing_in = next((e for e in ev if e["who"] == "in" and e["type_start"] <= t < e["show"]), None)
    items = [(e, ease((t - e["show"]) / 0.28)) for e in appeared]
    total = 0.0
    heights = []
    for e, p in items:
        hh = (e["h"] + 8) * p
        heights.append(hh); total += hh
    if typing_in: total += 36 + 8
    area = CH_BOT - CH_TOP - 14
    scroll = max(0.0, total - area)
    y = CH_TOP + 10 - scroll
    for (e, p), hh in zip(items, heights):
        bw = max(f_len(l) for l in e["lines"]) + 2 * PAD_X + (38 if len(e["lines"]) == 1 else 0)
        bw = min(bw, BUB_MAX)
        x = SC_X + 12 if e["who"] == "in" else SC_X + SC_W - 12 - bw
        col = WA_IN if e["who"] == "in" else WA_OUT
        a = int(255 * p)
        oy = (1 - p) * 14
        fillc = lerp_color(WA_BG, col, 1.0)
        rr(ld, (x, y + oy, x + bw, y + oy + e["h"]), 12, fillc + (a,))
        for i, l in enumerate(e["lines"]):
            text(ld, (x + PAD_X, y + oy + PAD_Y + i * LINE_H), l, "sans", 17, (17, 27, 33, a))
        text(ld, (x + bw - 9, y + oy + e["h"] - 6), "9:41", "sans", 10, (110, 122, 128, a), "rb")
        y += hh
    if typing_in:
        phase = t * 6
        rr(ld, (SC_X + 12, y, SC_X + 12 + 68, y + 36), 14, (255, 255, 255, 255))
        for i in range(3):
            lift = abs(math.sin(phase - i * 0.7)) * 5
            cx = SC_X + 12 + 20 + i * 14
            ld.ellipse(((cx - 4) * S, (y + 18 - lift - 4) * S, (cx + 4) * S, (y + 18 - lift + 4) * S), fill=(120, 130, 136, 255))
    # clip the layer to the chat window
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rectangle((SC_X * S, CH_TOP * S, (SC_X + SC_W) * S, CH_BOT * S), fill=255)
    layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", img.size, 0), mask))
    img.paste(layer, (0, 0), layer)
    d = ImageDraw.Draw(img)
    # header
    rr(d, (SC_X, SC_Y, SC_X + SC_W, SC_Y + HEAD_H), 30, INK2)
    d.rectangle((SC_X * S, (SC_Y + 30) * S, (SC_X + SC_W) * S, (SC_Y + HEAD_H) * S), fill=INK2)
    d.ellipse(((SC_X + 16) * S, (SC_Y + 12) * S, (SC_X + 54) * S, (SC_Y + 50) * S), fill=SAFFRON)
    text(d, (SC_X + 35, SC_Y + 32), "T", "serif", 22, INK, "mm")
    text(d, (SC_X + 66, SC_Y + 19), "TradePal Africa", "bold", 17, "#ffffff")
    text(d, (SC_X + 66, SC_Y + 40), "online", "sans", 12, "#b9d3c8")
    # input bar with what is being typed
    rr(d, (SC_X, CH_BOT, SC_X + SC_W, SC_Y + SC_H), 30, WA_BG)
    d.rectangle((SC_X * S, CH_BOT * S, (SC_X + SC_W) * S, (CH_BOT + 24) * S), fill=WA_BG)
    rr(d, (SC_X + 12, CH_BOT + 8, SC_X + SC_W - 62, CH_BOT + 50), 21, "#ffffff")
    typing_out = next((e for e in ev if e["who"] == "out" and e["type_start"] <= t < e["show"]), None)
    if typing_out:
        n = int(len(typing_out["text"]) * min(1, (t - typing_out["type_start"]) / (typing_out["show"] - typing_out["type_start"])))
        shown = typing_out["text"][:n]
        while font("sans", 17).getlength(shown) / S > SC_W - 62 - 12 - 36 - 20 and shown:
            shown = shown[1:]
        text(d, (SC_X + 28, CH_BOT + 29), shown + ("|" if int(t * 3) % 2 == 0 else ""), "sans", 17, "#111b21", "lm")
    else:
        text(d, (SC_X + 28, CH_BOT + 29), "Message", "sans", 17, "#8696a0", "lm")
    d.ellipse(((SC_X + SC_W - 54) * S, (CH_BOT + 8) * S, (SC_X + SC_W - 12) * S, (CH_BOT + 50) * S), fill=LEAF)
    d.polygon([((SC_X + SC_W - 40) * S, (CH_BOT + 20) * S), ((SC_X + SC_W - 24) * S, (CH_BOT + 29) * S), ((SC_X + SC_W - 40) * S, (CH_BOT + 38) * S)], fill="#ffffff")

def f_len(s):
    return font("sans", 17).getlength(s) / S

def caption(d, sc, t, dark=False, center=False, top=None):
    ink = PAPER if dark else INK
    sub = "#cfe1d8" if dark else "#44574f"
    def line(y, s, kind, size, col, delay, anchor="la", x=CAP_X):
        p = ease((t - delay) / 0.45)
        if p <= 0: return
        c = lerp_color("#f7f1e5" if not dark else INK, col if isinstance(col, str) and col.startswith("#") else "#000000", p) if isinstance(col, str) else col
        text(d, (x, y + (1 - p) * 14), s, kind, size, c, anchor)
    x = W / 2 if center else CAP_X
    anc = "ma" if center else "la"
    y = top if top is not None else (214 if not center else 190)
    line(y, sc["label"], "bold", 20, SAFFRON if dark else CLAY, 0.1, anc, x)
    # title (wrapped by hand to the free width)
    tf = font("serif", 54)
    words, lines, cur = sc["title"].split(" "), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if tf.getlength(trial) / S <= (640 if not center else 1000) or not cur:
            cur = trial
        else:
            lines.append(cur); cur = w
    lines.append(cur)
    yy = y + 40
    for l in lines:
        line(yy, l, "serif", 54, PAPER if dark else INK, 0.25, anc, x)
        yy += 64
    yy += 14
    for i, b in enumerate(sc["body"]):
        kind = "mono" if (b.startswith("/") or b.split(" ")[0] in ("debt", "paid", "debts")) and " - " in b else "sans"
        line(yy, b, kind, 24 if kind == "mono" else 28, "#cfe1d8" if dark else "#34463f", 0.6 + i * 0.35, anc, x)
        yy += 42
    return yy

def draw_logo_bar(d, dark):
    d.rectangle((0, 0, W * S, 10 * S), fill=SAFFRON)

def render(args):
    t, plan = args
    img = Image.new("RGB", (W * S, H * S), PAPER)
    d = ImageDraw.Draw(img)
    sc, lt, ev, dur = plan
    if sc["kind"] == "outro":
        d.rectangle((0, 0, W * S, H * S), fill=INK)
        draw_logo_bar(d, True)
        yy = caption(d, sc, lt, dark=True, center=True)
        p = ease((lt - 1.6) / 0.5)
        if p > 0:
            bw, bh = 520, 78
            x0, y0 = (W - bw) / 2, 470 + (1 - p) * 20
            rr(d, (x0, y0 + 6, x0 + bw, y0 + bh + 6), 39, "#b87500")
            rr(d, (x0, y0, x0 + bw, y0 + bh), 39, SAFFRON)
            text(d, (W / 2, y0 + bh / 2), "Start free on WhatsApp", "bold", 30, INK, "mm")
            text(d, (W / 2, y0 + bh + 40), "tradepalafrica.com", "sans", 24, "#cfe1d8", "mm")
    elif sc["kind"] == "title":
        draw_logo_bar(d, False)
        d.rounded_rectangle((W * S / 2 - 46 * S, 120 * S, W * S / 2 + 46 * S, 212 * S), radius=22 * S, fill=INK)
        text(d, (W / 2, 167), "T", "serif", 62, SAFFRON, "mm")
        caption(d, sc, lt, center=True, top=258)
    else:
        d.rectangle((0, 0, W * S, H * S), fill=PAPER)
        draw_logo_bar(d, False)
        d.rounded_rectangle(((CAP_X - 24) * S, 190 * S, (CAP_X - 18) * S, 460 * S), radius=3 * S, fill=SAFFRON)
        draw_phone(img, d, sc, ev, lt)
        d = ImageDraw.Draw(img)
        caption(d, sc, lt)
    # fade between scenes
    fade = min(1.0, lt / 0.35) * min(1.0, (dur - lt) / 0.3)
    if fade < 1:
        base = Image.new("RGB", img.size, INK if sc["kind"] == "outro" else PAPER)
        img = Image.blend(base, img, max(0.0, fade))
    return img.resize((W, H), Image.LANCZOS)

def render_to(args):
    idx, t, plan, outdir = args
    render((t, plan)).save(os.path.join(outdir, f"f{idx:05d}.png"), compress_level=1)
    return idx

# ------------------------------------------------------------------------------------------------ audio
def wav_len(path):
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()

def vtt_time(x):
    h, m = int(x // 3600), int(x % 3600 // 60)
    return f"{h:02d}:{m:02d}:{x % 60:06.3f}"

def write_captions(plans, path):
    """English captions (WebVTT) for the narration: each sentence gets a share of the clip in proportion to its length."""
    lines = ["WEBVTT", ""]
    for pl in plans:
        sentences = [x.strip() for x in pl["sc"]["narration"].replace("? ", "?|").replace(". ", ".|").split("|") if x.strip()]
        total = sum(len(x) for x in sentences)
        t = pl["start"] + 0.3
        for x in sentences:
            d = pl["nd"] * len(x) / total
            lines += [f"{vtt_time(t)} --> {vtt_time(t + d)}", x.replace("slash ", "/").replace("tradepal africa dot com", "tradepalafrica.com"), ""]
            t += d
    open(path, "w").write("\n".join(lines))

def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    work = os.path.join(out_dir, "work"); frames = os.path.join(work, "frames")
    shutil.rmtree(work, ignore_errors=True); os.makedirs(frames)
    # 1. narration
    clips = []
    for i, sc in enumerate(SCENES):
        p = os.path.join(work, f"n{i}.wav")
        subprocess.run(["say", "-v", "Samantha", "-r", "168", "-o", p, "--data-format=LEI16@22050", sc["narration"]], check=True)
        clips.append((p, wav_len(p)))
    # 2. timeline
    plans, start = [], 0.0
    for sc, (p, nd) in zip(SCENES, clips):
        ev, end = plan_scene(sc, nd)
        dur = max(nd + 0.3 + 0.9, end + 1.6, 4.5)
        plans.append(dict(sc=sc, start=start, dur=dur, ev=ev, narr=p, nd=nd))
        start += dur
    total = start
    print(f"scenes: {[round(p['dur'], 1) for p in plans]}  total {total:.1f}s")
    write_captions(plans, os.path.join(out_dir, "how-to-use.en.vtt"))
    # 3. audio track
    rate = 22050
    pcm = bytearray(int(total * rate) * 2)
    for pl in plans:
        with wave.open(pl["narr"]) as w:
            data = w.readframes(w.getnframes())
        off = int((pl["start"] + 0.3) * rate) * 2
        pcm[off:off + len(data)] = data
    with wave.open(os.path.join(work, "audio.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(bytes(pcm))
    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "48000", os.path.join(work, "audio.wav"), os.path.join(work, "audio.m4a")], check=True)
    # 4. frames
    jobs = []
    n = int(total * FPS)
    for i in range(n):
        t = i / FPS
        pl = next(p for p in plans if p["start"] <= t < p["start"] + p["dur"] or p is plans[-1])
        jobs.append((i, t, (pl["sc"], t - pl["start"], pl["ev"], pl["dur"]), frames))
    with Pool(os.cpu_count()) as pool:
        for k, _ in enumerate(pool.imap_unordered(render_to, jobs, chunksize=8)):
            if k % 300 == 0: print(f"frames {k}/{n}", flush=True)
    # 5. encode
    here = os.path.dirname(os.path.abspath(__file__))
    # The command-line tools' compiler can be older than their SDK. When Xcode is installed, compile against ITS SDK, which matches.
    cmd = ["swiftc", "-O", os.path.join(here, "encode.swift"), "-o", os.path.join(work, "encode")]
    xcode_sdk = "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    env = dict(os.environ)
    if os.path.isdir(xcode_sdk):
        env["DEVELOPER_DIR"] = "/Applications/Xcode.app/Contents/Developer"
        cmd += ["-sdk", xcode_sdk]
    subprocess.run(cmd, check=True, env=env)
    subprocess.run([os.path.join(work, "encode"), frames, str(FPS), os.path.join(work, "audio.m4a"), os.path.join(out_dir, "how-to-use.mp4"), str(W), str(H)], check=True)
    print("wrote", os.path.join(out_dir, "how-to-use.mp4"))

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "out")
