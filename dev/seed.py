"""Fill the map with DEMO reports so the officer view has something to show.

    python3 dev/seed.py --local            # into dev/data/ (for dev/server.py)
    python3 dev/seed.py --table NAME       # into a deployed DynamoDB table (needs boto3 + AWS login)

Every seeded report is flagged "seed": true and has no photo. The officer popup
labels them as demo data. These are made-up points scattered around well-known
parts of Delhi, NOT real dump sites.
"""
import argparse
import json
import os
import random
import sys
import uuid
from datetime import timedelta
from decimal import Decimal

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import core  # noqa: E402

# Approximate centres of localities, used only to scatter demo points.
AREAS = [
    ("Seelampur", 28.6700, 77.2700), ("Shaheen Bagh", 28.5560, 77.3010),
    ("Mundka", 28.6830, 77.0310), ("Dwarka", 28.5810, 77.0510),
    ("Rohini", 28.7150, 77.1230), ("Karol Bagh", 28.6510, 77.1900),
    ("Lajpat Nagar", 28.5680, 77.2430), ("Mayur Vihar", 28.6090, 77.2950),
    ("Bawana", 28.7980, 77.0340), ("Narela", 28.8530, 77.0930),
    ("Sangam Vihar", 28.5000, 77.2400), ("Janakpuri", 28.6290, 77.0870),
    ("Pitampura", 28.6990, 77.1310), ("Okhla", 28.5355, 77.2710),
    ("Shahdara", 28.6730, 77.2890), ("Najafgarh", 28.6090, 76.9790),
]
SPOTS = 34
SCATTER_DEG = 0.012      # about 1.3 km around each locality centre
JITTER_DEG = 0.0003      # about 30 m between reports of the same spot


def make_reports(rng, now):
    reports = []
    for _ in range(SPOTS):
        _, base_lat, base_lng = rng.choice(AREAS)
        lat = base_lat + rng.uniform(-SCATTER_DEG, SCATTER_DEG)
        lng = base_lng + rng.uniform(-SCATTER_DEG, SCATTER_DEG)
        age_days = rng.choice([0.2, 0.8, 1.5, 2.5, 4, 6, 9, 12, 16, 21, 28, 40])
        count = max(1, min(14, int(rng.expovariate(1 / 3.5)) + 1))
        for i in range(count):
            offset = 0 if i == 0 else rng.uniform(0, age_days)   # first report is the oldest
            received = now - timedelta(days=age_days - offset)
            reports.append({
                "id": uuid.uuid4().hex,
                "lat": round(lat + rng.uniform(-JITTER_DEG, JITTER_DEG), 6),
                "lng": round(lng + rng.uniform(-JITTER_DEG, JITTER_DEG), 6),
                "accuracy": float(rng.choice([6, 9, 14, 22, 35])),
                "capturedAt": core.to_iso(received),
                "receivedAt": core.to_iso(received),
                "imageKey": None,
                "seed": True,
            })
    return reports


def save_local(reports):
    data_dir = os.path.join(ROOT, "dev", "data")
    os.makedirs(os.path.join(data_dir, "images"), exist_ok=True)
    path = os.path.join(data_dir, "reports.json")
    existing = []
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            existing = [r for r in json.load(fh) if not r.get("seed")]   # replace old demo data
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(existing + reports, fh)
    print("Wrote %d demo reports to %s (kept %d real ones)" % (len(reports), path, len(existing)))


def save_dynamo(reports, table_name):
    import boto3
    table = boto3.resource("dynamodb").Table(table_name)
    with table.batch_writer() as batch:
        for r in reports:
            item = {k: (Decimal(str(v)) if isinstance(v, float) else v)
                    for k, v in r.items() if v is not None}
            batch.put_item(Item=item)
    print("Wrote %d demo reports to table %s" % (len(reports), table_name))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--local", action="store_true")
    target.add_argument("--table")
    parser.add_argument("--seed", type=int, default=7, help="random seed (same number = same demo data)")
    args = parser.parse_args()

    demo = make_reports(random.Random(args.seed), core.utcnow())
    if args.local:
        save_local(demo)
    else:
        save_dynamo(demo, args.table)
