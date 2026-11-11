#!/usr/bin/env python3
"""A pretend rider on the test server, to try the driver's side of the Android app on an emulator with nothing else.
Never the live server: it refuses anything but the test server's address.

  rider-sim.py order <driver user id> [lat lng dropLat dropLng]   # orders from that driver; they get the offer
  rider-sim.py bid <cents>                                        # names a price: it goes on the market
  rider-sim.py plan <driver user id> [hours ahead]                # a planned ride, for that driver first
  rider-sim.py status | pay | checkin | cancel | review <stars>
  rider-sim.py say <user id> <words>                              # needs nothing but the server; sealed like a phone does
"""
import base64, json, os, pathlib, sys, urllib.request, urllib.error

BASE = os.environ.get("SERVER", "http://your-server:8090")
if "8090" not in BASE and "127.0.0.1" not in BASE:
    sys.exit("only for the test server")
STATE = pathlib.Path(os.environ.get("SIM_STATE", "/tmp/drivezzz-rider-sim.json"))
DEVICE = os.environ.get("SIM_DEVICE", "android-rider-sim-1")
state = json.loads(STATE.read_text()) if STATE.exists() else {}


def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body or {}).encode() if method != "GET" else None)
    req.add_header("content-type", "application/json")
    req.add_header("x-device-id", DEVICE)
    if state.get("token"):
        req.add_header("authorization", "Bearer " + state["token"])
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read()[:300].decode("utf8", "ignore"))
        sys.exit(1)


def save():
    STATE.write_text(json.dumps(state))


def login():
    if state.get("token"):
        return
    me = call("POST", "/api/auth/continue", {"deviceId": DEVICE})
    state["token"] = me["token"]
    state["id"] = me["user"]["id"]
    save()
    call("PATCH", "/api/me", {"name": "Sim Rider"})


def here(lat, lng):
    call("POST", "/api/location", {"lat": lat, "lng": lng})


def show(ride):
    keep = {k: ride.get(k) for k in ("id", "status", "priceCents", "maxCents", "coin", "payBy", "testPay", "canCheckIn", "apartM", "refundPercent", "cancelReason")}
    print(json.dumps(keep))


login()
what = sys.argv[1] if len(sys.argv) > 1 else "status"
args = sys.argv[2:]
PICKUP = (52.0890, 4.3240)
DROPOFF = (52.0700, 4.3130)

if what in ("order", "plan", "bid"):
    target = args[0] if what != "bid" else None
    extra = args[1:] if what == "order" else []
    a = tuple(map(float, extra[:2])) if len(extra) >= 2 else PICKUP
    b = tuple(map(float, extra[2:4])) if len(extra) >= 4 else DROPOFF
    here(*a)
    body = {
        "pickup": {"lat": a[0], "lng": a[1], "label": "Sim pickup"},
        "dropoff": {"lat": b[0], "lng": b[1], "label": "Sim drop-off"},
        "passengers": 1, "pets": os.environ.get("SIM_PETS") == "1", "coin": "sol",
    }
    if what == "plan":
        hours = float(args[1]) if len(args) > 1 else 5
        import time
        body["scheduledAt"] = (time.time() + hours * 3600) * 1000
    q = call("POST", "/api/quote", body)
    print("offers:", [(o["id"], o.get("name"), o.get("priceCents")) for o in q.get("offers") or []])
    body["pickup"], body["dropoff"] = q["pickup"], q["dropoff"]
    if what == "bid":
        body.update(mode="bid", bidCents=int(args[0]))
    else:
        offer = next((o for o in q.get("offers") or [] if o["id"] == target), None)
        if not offer:
            sys.exit("that driver isn't offered: online, within range, with a fitting vehicle and coin?")
        body.update(mode="driver", driverId=target, expectedCents=offer.get("priceCents"))
    ride = call("POST", "/api/rides", body)["ride"]
    state["ride"] = ride["id"]
    save()
    show(ride)
elif what == "status":
    show(call("GET", f"/api/rides/{state['ride']}")["ride"])
elif what == "pay":
    call("POST", f"/api/rides/{state['ride']}/pretend-pay")
    show(call("GET", f"/api/rides/{state['ride']}")["ride"])
elif what == "checkin":
    ride = call("GET", f"/api/rides/{state['ride']}")["ride"]
    d = ride.get("driver") or {}
    lat, lng = d.get("lat", PICKUP[0]), d.get("lng", PICKUP[1])
    here(lat, lng)
    show(call("POST", f"/api/rides/{state['ride']}/check-in", {"lat": lat, "lng": lng, "plateChecked": True})["ride"])
elif what == "cancel":
    show(call("POST", f"/api/rides/{state['ride']}/cancel")["ride"])
elif what == "review":
    show(call("POST", f"/api/rides/{state['ride']}/review", {"stars": int(args[0]), "text": "From the simulator"})["ride"])
elif what == "reset":
    STATE.unlink(missing_ok=True)
else:
    sys.exit(__doc__)
