# Kooda Watch

Citizens photograph garbage dumps. Municipal officers see where they are on a heatmap, with ward boundaries and how long each spot has been open.

## What it does

**Citizen page (`/`)**: take a photo, share GPS, send. The date and time are recorded automatically.

**Officer page (`/officer.html`)**, behind a passcode:
- Heatmap of reported spots (hotter = more reports).
- Each hotspot is a dot coloured by age: green under 3 days, amber 3 to 14, red over 14.
- Click a dot for the ward, first report, latest report, number of reports, how long it has been open, and photos.
- Delhi ward boundaries as an outline layer. Hover a ward for its name.

### How a "hotspot" and "days open" work
- Reports within **50 m** of each other become one hotspot (`RADIUS_M` in `backend/core.py`).
- **First reported** and **Latest report** are the times of the earliest and latest report there.
- **Open for** counts from the first report **until now**. There is no "cleared" status yet, so a spot stays open until you add one.
- **First to latest** is the gap between the first and last report.
- All times use the **server clock**, not the phone's, so a wrong phone clock can't distort the numbers.

## Run it on your computer (no AWS)

Needs Python 3.9+ only.

```bash
python3 dev/seed.py --local          # optional: 100+ DEMO reports so the map isn't empty
python3 dev/server.py                # http://localhost:8000
```

- Citizen: http://localhost:8000/
- Officer: http://localhost:8000/officer.html (passcode `local-officer-key`, or set `OFFICER_KEY=...`)

The officer page loads the map library from the internet (unpkg), so it needs a connection.
Phones need HTTPS to share GPS, so test the citizen page on the same computer, or deploy (below).
Demo reports are labelled "Demo data" in the popup and are made-up points, not real dump sites.

## Deploy to AWS

Needs the AWS CLI (logged in) and [AWS SAM CLI](https://github.com/aws/aws-sam-cli).

```bash
sam build
sam deploy --guided                  # asks for OfficerKey: choose a long passcode (12+ characters)
```

Note the outputs `SiteUrl`, `SiteBucketName`, `DistributionId`, `ReportsTableName`. Then upload the website:

```bash
aws s3 sync frontend s3://<SiteBucketName> --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"
```

Citizen page is `SiteUrl`; officer page is `SiteUrl/officer.html`. Optional demo data:
`python3 dev/seed.py --table <ReportsTableName>` (needs `pip install boto3`).

### What gets created
S3 + CloudFront (website, HTTPS) &rarr; `/api/*` &rarr; API Gateway (HTTP API) &rarr; Lambda &rarr; DynamoDB (reports) + a private S3 bucket (photos).
Officers see photos through short-lived signed links (1 hour).

## Ward boundaries

The map loads `frontend/data/wards.geojson`. Without it everything else works, and the page shows a notice.

**What is in the repo right now:** a 290-feature file with the **old 2017 delimitation** (MCD wards numbered 1 to 272, plus 9 NDMC charges and 8 Cantonment boards). It is here to demonstrate the feature, **not** as the official current boundaries: ward numbers and names will not match today's 250 MCD wards. The map legend says so. The code does not depend on the ward count, so swapping in the 250-ward file is just replacing the file (keep the `Ward_No` / `Ward_Name` fields, or any similarly named ones) and updating `WARD_SOURCE_NOTE` in `frontend/js/officer.js`.

*Source of the file: to be added (credit the original publisher here).*

For the **current** MCD boundaries (250 wards, 2022 delimitation), where I'd look:
- **OpenCity**: a DataMeet thread (May 2023) says it hosts the 2022 delimitation ward and zone maps, sourced from Delhi's GSDL. I couldn't open it from where I built this, so I haven't confirmed the format or licence.
- The official delimitation order and ward descriptions are PDFs on sec.delhi.gov.in. Those are not map data.
- **Avoid** the Hindustan Times Labs shapefiles for this: they are the **2017** delimitation (272 wards), whose ward numbers and names no longer match.

If you get a shapefile or the file isn't plain lat/lng, convert it to GeoJSON in WGS84 (EPSG:4326) with QGIS or [mapshaper.org](https://mapshaper.org) (also use it to simplify a heavy file). Then check it:

```bash
python3 dev/check_wards.py frontend/data/wards.geojson
```

It reports the ward count (should be 250), whether coordinates fall inside Delhi, file size, and the property fields. Ward names are picked up from fields like `Ward_Name` / `Ward_No`.

## Known limits (deliberate, for now)
- **Officer passcode** is one shared secret stored as a Lambda environment variable. Fine for a demo; use Cognito for real use.
- **No spam protection** on report uploads beyond API throttling (10 requests/second). No check that a photo actually shows garbage.
- Officer data is read with a full DynamoDB scan and grouped on each request. Fine for thousands of reports; for far more, group at write time.
- Photos are JPEGs shrunk on the phone (about 1280 px). Faces and plates are not blurred.
- Map libraries load from unpkg without integrity hashes.

## Layout
```
frontend/   index.html (citizen), officer.html, js/, css/, data/wards.geojson (you add)
backend/    app.py (Lambda), core.py (all the logic, no AWS imports)
template.yaml   SAM / CloudFormation
dev/        server.py (local), seed.py (demo data), check_wards.py
```
