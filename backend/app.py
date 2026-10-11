"""AWS Lambda entry point (API Gateway HTTP API, payload format 2.0).

POST /api/reports   citizen uploads a photo + GPS + time
GET  /api/hotspots  officer map data (needs the X-Officer-Key header)
"""
import base64
import json
import logging
import os
from decimal import Decimal

import core

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MAX_BODY_BYTES = 4 * 1024 * 1024
PHOTO_LINK_SECONDS = 3600


def _to_dynamo(item):
    return {k: (Decimal(str(v)) if isinstance(v, float) else v) for k, v in item.items()}


def _from_dynamo(item):
    return {k: (float(v) if isinstance(v, Decimal) else v) for k, v in item.items()}


class AwsStore:
    """DynamoDB for reports, S3 for photos."""

    def __init__(self):
        import boto3                      # imported here so tests need no boto3
        from botocore.config import Config
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        self._table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
        self._bucket = os.environ.get("IMAGE_BUCKET")
        self._s3 = boto3.client("s3", region_name=region,
                                config=Config(signature_version="s3v4"))

    def put_report(self, item):
        self._table.put_item(Item=_to_dynamo(item))

    def put_image(self, key, data):
        self._s3.put_object(Bucket=self._bucket, Key=key, Body=data, ContentType="image/jpeg")

    def list_reports(self):
        items, kwargs = [], {}
        while True:
            resp = self._table.scan(**kwargs)
            items.extend(_from_dynamo(i) for i in resp.get("Items", []))
            last = resp.get("LastEvaluatedKey")
            if not last:
                return items
            kwargs["ExclusiveStartKey"] = last

    def image_url(self, key):
        return self._s3.generate_presigned_url(
            "get_object", Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=PHOTO_LINK_SECONDS)


_store = None


def get_store():
    global _store
    if _store is None:
        _store = AwsStore()
    return _store


def _response(status, payload):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(payload),
    }


def _json_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    if len(raw) > MAX_BODY_BYTES:
        raise core.ApiError(413, "Request is too large")
    try:
        return json.loads(raw)
    except ValueError:
        raise core.ApiError(400, "Body must be JSON")


def handler(event, context=None):
    http = (event.get("requestContext") or {}).get("http") or {}
    method = (http.get("method") or "").upper()
    path = event.get("rawPath") or ""
    try:
        if method == "POST" and path == "/api/reports":
            return _response(201, core.create_report(_json_body(event), get_store()))
        if method == "GET" and path == "/api/hotspots":
            headers = event.get("headers") or {}
            if not core.check_officer_key(headers.get("x-officer-key"),
                                          os.environ.get("OFFICER_KEY")):
                return _response(401, {"error": "Officer key required"})
            return _response(200, core.get_hotspots(get_store()))
        return _response(404, {"error": "Not found"})
    except core.ApiError as err:
        return _response(err.status, {"error": err.message})
    except Exception:
        logger.exception("Unhandled error")
        return _response(500, {"error": "Something went wrong"})
