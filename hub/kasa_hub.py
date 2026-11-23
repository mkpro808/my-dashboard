#!/usr/bin/env python3
"""ʻOhana home hub.

Runs on the always-on tablet (in Termux). Finds the Kasa devices on the home
Wi-Fi and lets the ʻOhana dashboard switch them, through a small web server
that only answers on this tablet (127.0.0.1) and only to the dashboard page.

Kasa login (needed by newer models) comes from KASA_USERNAME / KASA_PASSWORD,
normally set in ~/.ohana-hub.env. Nothing is sent anywhere except to the
devices themselves.
"""
import asyncio
import json
import os
import sys
import time

from aiohttp import web
from kasa import Discover, Module

ORIGIN = "https://my-dashboard-azp.pages.dev"
PORT = 8738
REFRESH = 20        # seconds between status checks
REDISCOVER = 600    # seconds between looking for new devices

DEVS = {}           # host -> device
LOCKS = {}          # host -> asyncio.Lock
BAD = set()         # hosts that failed their last check
ITEMS = {}          # id -> (thing to switch, host of the device it lives on)
UNSUPPORTED = []
SKIPPED = set()      # hosts already reported as skipped (log once)
STATE = {"devices": [], "ts": 0}
TIMERS = {}         # id -> time (seconds) to switch it off
TFILE = os.path.expanduser("~/.ohana-timers.json")


def load_timers():
    try:
        with open(TFILE) as f:
            TIMERS.update({k: float(v) for k, v in json.load(f).items()})
    except Exception:
        pass


def save_timers():
    try:
        with open(TFILE, "w") as f:
            json.dump(TIMERS, f)
    except Exception as e:
        log("couldn't save timers:", e)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def login():
    return os.environ.get("KASA_USERNAME") or None, os.environ.get("KASA_PASSWORD") or None


def ident(d):
    for attr in ("device_id", "mac"):
        try:
            v = getattr(d, attr)
            if v:
                return str(v)
        except Exception:
            pass
    return str(getattr(d, "host", id(d)))


def light_of(d):
    try:
        m = d.modules.get(Module.Light)
    except Exception:
        m = None
    if m is None:
        return None
    try:
        if hasattr(m, "has_feature"):
            return m if m.has_feature("brightness") else None
    except Exception:
        pass
    try:
        if getattr(m, "is_dimmable", True) is False:
            return None
    except Exception:
        pass
    return m


def kind_of(d):
    try:
        t = d.device_type.name.lower()
    except Exception:
        t = ""
    if "bulb" in t or "lightstrip" in t:
        return "bulb"
    if "dimmer" in t or "switch" in t:
        return "switch"
    return "plug"


def describe(d, host, parent=None):
    it = {"id": ident(d), "name": d.alias or getattr(d, "model", "Device"),
          "model": getattr(parent or d, "model", ""), "kind": kind_of(parent or d),
          "on": bool(d.is_on), "ok": host not in BAD}
    if parent is not None:
        it["kind"] = "plug"
        it["group"] = parent.alias or parent.model
    if it["id"] in TIMERS:
        it["offAt"] = int(TIMERS[it["id"]] * 1000)
    lt = light_of(d)
    if lt is not None:
        try:
            it["bri"] = int(lt.brightness)
            if it["kind"] == "plug":
                it["kind"] = "switch"
        except Exception:
            pass
    return it


def feat(d, name):
    try:
        f = d.features.get(name)
        return None if f is None else f.value
    except Exception:
        return None


def sensor_of(d, host, parent=None):
    """Temperature/humidity/door sensors (Tapo hub children). None if not a sensor."""
    t, h, o = feat(d, "temperature"), feat(d, "humidity"), feat(d, "is_open")
    if t is None and h is None and o is None:
        return None
    it = {"id": ident(d), "name": d.alias or getattr(d, "model", "Sensor"),
          "model": getattr(d, "model", ""), "kind": "sensor", "ok": host not in BAD}
    if t is not None:
        it["temp"] = round(float(t), 1)
        unit = str(feat(d, "temperature_unit") or "celsius").lower()
        it["unit"] = "F" if unit.startswith("f") else "C"
    if h is not None:
        it["hum"] = int(h)
    if o is not None:
        it["open"] = bool(o)
    if feat(d, "battery_low"):
        it["low"] = True
    if parent is not None:
        it["group"] = parent.alias or parent.model
    return it


def rebuild():
    items, out = {}, []
    for host, d in DEVS.items():
        try:
            kids = list(d.children or [])
        except Exception:
            kids = []
        try:
            if kids:
                for c in kids:
                    try:
                        sn = sensor_of(c, host, d)
                        if sn is not None:
                            out.append(sn)
                            continue
                        if not hasattr(c, "turn_on"):
                            continue
                        it = describe(c, host, d)
                        items[ident(c)] = (c, host)
                        out.append(it)
                    except Exception as e:
                        log("skipping", getattr(c, "alias", "?"), type(e).__name__)
            else:
                items[ident(d)] = (d, host)
                out.append(describe(d, host))
        except Exception as e:  # never checked yet, or login failed
            if host not in SKIPPED:
                SKIPPED.add(host)
                try:
                    model = d.model
                except Exception:
                    model = "?"
                log("skipping", host, model, "-", type(e).__name__, str(e)[:140])
    out.sort(key=lambda x: x["name"].lower())
    ITEMS.clear()
    ITEMS.update(items)
    STATE["devices"] = out
    STATE["ts"] = int(time.time() * 1000)
    STATE["unsupported"] = len(UNSUPPORTED)


async def check(host):
    d = DEVS[host]
    async with LOCKS[host]:
        try:
            await asyncio.wait_for(d.update(), 10)
            BAD.discard(host)
        except Exception as e:
            if host not in BAD:
                log("can't reach", d.alias or host, "-", type(e).__name__, str(e)[:120])
            BAD.add(host)


async def discover():
    user, pw = login()
    UNSUPPORTED.clear()

    async def unsupported(e):
        UNSUPPORTED.append(str(e)[:160])

    try:
        found = await Discover.discover(username=user, password=pw, discovery_timeout=6,
                                        on_unsupported=unsupported)
    except TypeError:
        found = await Discover.discover(username=user, password=pw)
    new = [h for h in found if h not in DEVS]
    for h in new:
        DEVS[h] = found[h]
        LOCKS[h] = asyncio.Lock()
    await asyncio.gather(*(check(h) for h in new))
    if new:
        log("found", len(new), "new device(s); total", len(DEVS))
    rebuild()


async def loop():
    last = 0
    while True:
        try:
            if time.time() - last > REDISCOVER:
                last = time.time()
                await discover()
            else:
                await asyncio.gather(*(check(h) for h in list(DEVS)))
                rebuild()
        except Exception as e:
            log("refresh problem:", type(e).__name__, str(e)[:160])
        await asyncio.sleep(REFRESH)


async def timer_loop():
    while True:
        await asyncio.sleep(5)
        now = time.time()
        for tid, at in list(TIMERS.items()):
            if now < at:
                continue
            hit = ITEMS.get(tid)
            if not hit:
                if now - at > 300:          # device gone for 5 minutes: give up
                    TIMERS.pop(tid, None)
                    save_timers()
                continue
            thing, host = hit
            try:
                async with LOCKS[host]:
                    await asyncio.wait_for(thing.turn_off(), 10)
                    await asyncio.wait_for(DEVS[host].update(), 10)
                TIMERS.pop(tid, None)
                save_timers()
                log("timer: turned off", thing.alias)
                rebuild()
            except Exception as e:
                log("timer: couldn't turn off", getattr(thing, "alias", tid), "-", type(e).__name__)
                if now - at > 300:
                    TIMERS.pop(tid, None)
                    save_timers()


@web.middleware
async def guard(req, handler):
    if req.method == "OPTIONS":
        resp = web.Response()
    elif req.path != "/" and req.headers.get("X-Ohana") != "1":
        # The custom header forces the browser to ask first (preflight),
        # and only the dashboard's own address is allowed through.
        resp = web.json_response({"error": "forbidden"}, status=403)
    else:
        resp = await handler(req)
    resp.headers["Access-Control-Allow-Origin"] = ORIGIN
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "X-Ohana, Content-Type"
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    resp.headers["Access-Control-Max-Age"] = "600"
    resp.headers["Cache-Control"] = "no-store"
    return resp


async def home(req):
    names = ", ".join(x["name"] for x in STATE["devices"]) or "none yet"
    return web.Response(text="ʻOhana hub is running. Devices: %s\n" % names)


async def state(req):
    return web.json_response(STATE)


async def set_(req):
    try:
        b = await req.json()
    except Exception:
        return web.json_response({"error": "bad request"}, status=400)
    hit = ITEMS.get(str(b.get("id", "")))
    if not hit:
        return web.json_response({"error": "unknown device"}, status=404)
    thing, host = hit
    async with LOCKS[host]:
        try:
            if b.get("bri") is not None:
                lt = light_of(thing)
                if lt is not None:
                    await asyncio.wait_for(lt.set_brightness(max(1, min(100, int(b["bri"])))), 10)
            if b.get("timer") is not None:
                mins = max(0, min(720, int(b["timer"])))
                if mins:
                    TIMERS[str(b["id"])] = time.time() + mins * 60
                else:
                    TIMERS.pop(str(b["id"]), None)
                save_timers()
            if b.get("on") is not None:
                await asyncio.wait_for(thing.turn_on() if b["on"] else thing.turn_off(), 10)
                if not b["on"] and TIMERS.pop(str(b["id"]), None) is not None:
                    save_timers()
            await asyncio.wait_for(DEVS[host].update(), 10)
            BAD.discard(host)
            log("set", thing.alias, {k: b[k] for k in ("on", "bri", "timer") if b.get(k) is not None})
        except Exception as e:
            BAD.add(host)
            log("couldn't switch", getattr(thing, "alias", host), "-", type(e).__name__, str(e)[:120])
            rebuild()
            return web.json_response(dict(STATE, error="That device didn't respond."), status=502)
    rebuild()
    return web.json_response(STATE)


async def main():
    user, _ = login()
    load_timers()
    log("ʻOhana hub starting", "(with Kasa login)" if user else "(no Kasa login set)")
    await discover()
    for x in STATE["devices"]:
        if x["kind"] == "sensor":
            bits = [("%s°%s" % (x["temp"], x["unit"])) if "temp" in x else "", ("%s%%" % x["hum"]) if "hum" in x else "",
                    ("open" if x.get("open") else "closed") if "open" in x else ""]
            log("  ", x["name"], "- sensor", " ".join(b for b in bits if b))
        else:
            log("  ", x["name"], "-", x["model"], "on" if x["on"] else "off", "" if x["ok"] else "(not responding)")
    for u in UNSUPPORTED:
        log("   skipped (not supported):", u)
    app = web.Application(middlewares=[guard])
    app.router.add_get("/", home)
    app.router.add_get("/state", state)
    app.router.add_post("/set", set_)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT).start()
    log("ready on http://127.0.0.1:%d  (leave this running)" % PORT)
    asyncio.ensure_future(timer_loop())
    await loop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
