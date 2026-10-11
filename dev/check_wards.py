"""Check a ward boundary file before putting it on the map.

    python3 dev/check_wards.py frontend/data/wards.geojson

Tells you how many wards it has, whether the coordinates look like Delhi
longitude/latitude, how big the file is, and which property fields it has.
"""
import json
import os
import sys

# Rough box around Delhi NCT, in degrees (lng, lat).
DELHI = (76.80, 28.38, 77.40, 28.90)


def walk(coords):
    if coords and isinstance(coords[0], (int, float)):
        yield coords
    else:
        for part in coords:
            yield from walk(part)


def main(path):
    size_mb = os.path.getsize(path) / 1e6
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    problems = []
    if data.get("type") != "FeatureCollection":
        sys.exit("FAIL: top level must be a GeoJSON FeatureCollection (got %r)" % data.get("type"))
    features = data.get("features") or []
    print("Wards (features): %d" % len(features))
    print("File size: %.1f MB" % size_mb)

    box = [1e9, 1e9, -1e9, -1e9]
    empty = bad_type = 0
    for f in features:
        g = f.get("geometry")
        if not g:
            empty += 1
            continue
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            bad_type += 1
            continue
        for pt in walk(g["coordinates"]):
            box[0], box[1] = min(box[0], pt[0]), min(box[1], pt[1])
            box[2], box[3] = max(box[2], pt[0]), max(box[3], pt[1])
    print("Coordinate box (lng/lat): %.3f, %.3f to %.3f, %.3f" % tuple(box))

    if empty:
        problems.append("%d features have no geometry (they will be skipped)" % empty)
    if bad_type:
        problems.append("%d features are not Polygon/MultiPolygon (they will be skipped)" % bad_type)
    if not (DELHI[0] <= box[0] and box[2] <= DELHI[2] and DELHI[1] <= box[1] and box[3] <= DELHI[3]):
        problems.append("Coordinates are not inside Delhi as lng/lat. If they look like big numbers "
                        "(for example 77000.0), reproject to WGS84 / EPSG:4326 first. If lat and lng "
                        "look swapped, swap them.")
    if size_mb > 8:
        problems.append("File is large (%.1f MB). Simplify it (mapshaper.org) so the page loads fast." % size_mb)

    keys = sorted({k for f in features for k in (f.get("properties") or {})})
    print("Property fields: %s" % (", ".join(keys) or "(none)"))
    for f in features[:3]:
        print("  sample properties: %s" % json.dumps(f.get("properties"), ensure_ascii=False))
    if not keys:
        problems.append("No properties, so the map cannot show ward names or numbers.")

    count = len(features)
    if count == 250:
        print("Ward count is 250: matches the current MCD wards (2022 delimitation).")
    elif count == 272:
        problems.append("272 wards = the OLD 2017 delimitation. Ward numbers and names will not match "
                        "today's MCD. Look for the 2022 (250-ward) boundaries.")
    else:
        problems.append("Expected 250 wards for the current MCD, found %d. Check this is the right file." % count)

    print()
    if problems:
        print("Things to look at:")
        for p in problems:
            print("  - " + p)
    else:
        print("Looks good.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
