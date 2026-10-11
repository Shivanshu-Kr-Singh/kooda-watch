"""Kooda Watch core logic.

No AWS imports here, so it runs (and is tested) anywhere. The storage layer is
passed in as `store`, which must provide:

    put_report(item: dict)          save one report
    put_image(key: str, data: bytes) save one photo
    list_reports() -> list[dict]     every saved report
    image_url(key: str) -> str       a URL the officer's browser can load
"""
import base64
import binascii
import hmac
import math
import uuid
from datetime import datetime, timezone

RADIUS_M = 50.0                    # reports closer than this form one hotspot
MAX_IMAGE_BYTES = 2 * 1024 * 1024  # decoded photo size limit
MAX_PHOTOS_PER_HOTSPOT = 3
EARTH_RADIUS_M = 6371000.0


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- time helpers

def utcnow():
    return datetime.now(timezone.utc)


def to_iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value):
    """Parse an ISO-8601 string to an aware UTC datetime, or None if invalid."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ------------------------------------------------------------------ validation

def _number(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApiError(400, "%s must be a number" % name)
    if math.isnan(value) or math.isinf(value) or value < low or value > high:
        raise ApiError(400, "%s is out of range" % name)
    return float(value)


def _decode_image(value):
    if not isinstance(value, str) or not value:
        raise ApiError(400, "A photo is required")
    if value.startswith("data:"):
        value = value.partition(",")[2]
    if len(value) > MAX_IMAGE_BYTES * 4 // 3 + 16:  # cheap check before decoding
        raise ApiError(413, "Photo is too large")
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise ApiError(400, "Photo is not valid base64")
    if len(data) > MAX_IMAGE_BYTES:
        raise ApiError(413, "Photo is too large")
    if data[:3] != b"\xff\xd8\xff":
        raise ApiError(400, "Photo must be a JPEG")
    return data


def check_officer_key(provided, expected):
    if not provided or not expected:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))


# --------------------------------------------------------------------- reports

def create_report(body, store, now=None):
    """Validate and save one citizen report. Returns {"id", "receivedAt"}."""
    now = now or utcnow()
    if not isinstance(body, dict):
        raise ApiError(400, "Invalid request body")

    lat = _number(body.get("lat"), "lat", -90, 90)
    lng = _number(body.get("lng"), "lng", -180, 180)
    accuracy = None
    if body.get("accuracy") is not None:
        accuracy = _number(body["accuracy"], "accuracy", 0, 1e6)
    captured_at = parse_iso(body.get("capturedAt"))
    image = _decode_image(body.get("image"))

    report_id = uuid.uuid4().hex
    image_key = "reports/%s.jpg" % report_id
    item = {
        "id": report_id,
        "lat": lat,
        "lng": lng,
        "accuracy": accuracy,
        # Phone clock: shown to the officer for reference, never used for maths.
        "capturedAt": to_iso(captured_at) if captured_at else None,
        # Server clock: this is the time that counts for "days open".
        "receivedAt": to_iso(now),
        "imageKey": image_key,
    }
    store.put_image(image_key, image)   # photo first, so a report never points at nothing
    store.put_report(item)
    return {"id": report_id, "receivedAt": item["receivedAt"]}


# -------------------------------------------------------------------- hotspots

def haversine_m(lat1, lng1, lat2, lng2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def build_hotspots(reports, now, radius_m=RADIUS_M):
    """Group reports into hotspots. Returns clusters (oldest first), each holding
    its members sorted by time. Greedy, in time order: a report joins the nearest
    hotspot within radius_m of its centre, otherwise it starts a new one."""
    parsed = []
    for r in reports:
        received = parse_iso(r.get("receivedAt"))
        try:
            lat, lng = float(r["lat"]), float(r["lng"])
        except (KeyError, TypeError, ValueError):
            continue
        if received is None or math.isnan(lat) or math.isnan(lng):
            continue
        parsed.append({"report": r, "t": received, "lat": lat, "lng": lng})
    parsed.sort(key=lambda p: p["t"])

    clusters = []
    for p in parsed:
        best, best_d = None, radius_m
        for c in clusters:
            d = haversine_m(p["lat"], p["lng"], c["lat"], c["lng"])
            if d <= best_d:
                best, best_d = c, d
        if best is None:
            clusters.append({"lat": p["lat"], "lng": p["lng"], "sum_lat": p["lat"],
                             "sum_lng": p["lng"], "members": [p]})
        else:
            best["members"].append(p)
            best["sum_lat"] += p["lat"]
            best["sum_lng"] += p["lng"]
            best["lat"] = best["sum_lat"] / len(best["members"])
            best["lng"] = best["sum_lng"] / len(best["members"])
    return clusters


def get_hotspots(store, now=None, radius_m=RADIUS_M):
    """What the officer map needs. daysOpen counts from the FIRST report until now
    (there is no 'cleared' status yet); reportedSpanDays is first report -> last."""
    now = now or utcnow()
    reports = store.list_reports()
    clusters = build_hotspots(reports, now, radius_m)

    hotspots = []
    for c in clusters:
        members = c["members"]
        first, last = members[0], members[-1]
        with_photo = [m for m in members if m["report"].get("imageKey")]
        recent = with_photo[-MAX_PHOTOS_PER_HOTSPOT:][::-1]
        hotspots.append({
            "id": first["report"].get("id"),
            "lat": round(c["lat"], 6),
            "lng": round(c["lng"], 6),
            "reportCount": len(members),
            "firstReportedAt": to_iso(first["t"]),
            "lastReportedAt": to_iso(last["t"]),
            "daysOpen": round(max(0.0, (now - first["t"]).total_seconds()) / 86400.0, 2),
            "reportedSpanDays": round((last["t"] - first["t"]).total_seconds() / 86400.0, 2),
            "images": [store.image_url(m["report"]["imageKey"]) for m in recent],
            "demo": all(bool(m["report"].get("seed")) for m in members),
        })
    hotspots.sort(key=lambda h: h["daysOpen"], reverse=True)
    return {
        "generatedAt": to_iso(now),
        "totalReports": len(reports),
        "radiusMeters": radius_m,
        "hotspots": hotspots,
    }
