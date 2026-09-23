# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Lambda handler for processing Contact Lens analysis files from S3."""
import re
import time
import urllib.parse
from pipeline import process_contact_lens_file


def handler(event, context):
    """S3 event trigger entry point."""
    request_id = context.aws_request_id
    start_time = time.time()

    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

        print(f"[INFO] processing_started | request_id={request_id} | bucket={bucket} | key={key}")

        if not _is_contact_lens_file(key):
            print(f"[WARN] skipped_non_matching_key | key={key}")
            continue

        try:
            result = process_contact_lens_file(bucket, key, request_id)
            duration_ms = int((time.time() - start_time) * 1000)
            print(
                f"[INFO] processing_complete | contact_id={result['contact_id']} "
                f"| session_id={result['session_id']} | turn_count={result['turn_count']} "
                f"| duration_ms={duration_ms}"
            )
        except Exception as e:
            print(f"[ERROR] processing_failed | key={key} | error={e}")


def _is_contact_lens_file(key: str) -> bool:
    """Check if the S3 key matches a Contact Lens analysis file pattern.

    For every contact, Contact Lens writes TWO analysis JSON files under the same
    prefix — an unredacted transcript and a redacted transcript:
      - Unredacted: Analysis/Voice/ivr/YYYY/MM/DD/{contactId}_analysis_*.json
      - Redacted:   Analysis/Voice/ivr/Redacted/YYYY/MM/DD/{contactId}_analysis_redacted_*.json

    Both files are processed. The pipeline writes a single DynamoDB record per contact
    and prefers the unredacted data: a redacted file will not overwrite an existing
    unredacted record (see write_records). Redacted WAV files and other objects are
    skipped.
    """
    # Unredacted analysis JSON
    if re.match(r"^Analysis/Voice/ivr/\d{4}/\d{2}/\d{2}/[^/]+_analysis_[^/]+\.json$", key):
        return True
    # Redacted analysis JSON
    if re.match(
        r"^Analysis/Voice/ivr/Redacted/\d{4}/\d{2}/\d{2}/"
        r"[^/]+_analysis_redacted_[^/]+\.json$",
        key,
    ):
        return True
    return False
