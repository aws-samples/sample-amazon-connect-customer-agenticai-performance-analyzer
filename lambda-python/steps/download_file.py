# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Download and parse Contact Lens analysis file from S3."""
import json
import re
from datetime import datetime, timezone
import boto3

s3 = boto3.client("s3")


def _extract_base_timestamp(key: str):
    """Extract the base timestamp from the Contact Lens filename.

    The filename timestamp is the anchor for applying the transcript
    BeginOffsetMillis/EndOffsetMillis, so offsets can be converted to absolute
    timestamps that align with the span timestamps.

    Handles: {contactId}_analysis_2026-06-09T01:08:23Z.json
             {contactId}_analysis_redacted_2026-06-09T01:08:23Z.json
    Returns epoch milliseconds, or None if not found.
    """
    m = re.search(r"_analysis(?:_redacted)?_(\d{4}-\d{2}-\d{2}T[\d:]+Z)\.json$", key)
    if m:
        dt = datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    return None


def download_contact_lens_file(bucket: str, key: str) -> dict:
    """Download and parse a Contact Lens JSON file from S3.

    Only extracts fields needed for STT/TTS/customer-wait calculation:
    - transcript with timing (beginOffsetMillis, endOffsetMillis, participant, content)
    - callDurationMs

    Also flags whether this is a redacted analysis file. Redacted transcripts have PII
    masked in their content, so downstream PII-mismatch detection is skipped for them.
    """
    response = s3.get_object(Bucket=bucket, Key=key)
    body = response["Body"].read().decode("utf-8")
    data = json.loads(body)

    # A redacted analysis file lives under the .../Redacted/... prefix and its
    # filename contains "_analysis_redacted_".
    is_redacted = "/Redacted/" in key or "_analysis_redacted_" in key

    # Extract contactId from filename: {contactId}_analysis_{timestamp}.json
    # (redacted: {contactId}_analysis_redacted_{timestamp}.json)
    filename = key.split("/")[-1]
    contact_id = filename.split("_analysis")[0] if "_analysis" in filename else ""
    if not contact_id:
        contact_id = data.get("ContactId", "")
    if not contact_id:
        raise ValueError(f"Cannot extract contactId from key: {key}")

    # Transcript with timing only (for STT/TTS calculation)
    transcript = []
    for seg in data.get("Transcript", []):
        transcript.append({
            "participant": seg.get("ParticipantId", ""),
            "content": seg.get("Content", ""),
            "beginOffsetMillis": seg.get("BeginOffsetMillis", 0),
            "endOffsetMillis": seg.get("EndOffsetMillis", 0),
        })

    call_duration_ms = (
        data.get("ConversationCharacteristics", {})
        .get("TotalConversationDurationMillis", 0)
    )

    # Base timestamp (epoch ms) from the filename, used to convert transcript
    # offsets into absolute timestamps that align with span timestamps.
    base_timestamp_ms = _extract_base_timestamp(key)

    return {
        "contact_id": contact_id,
        "transcript": transcript,
        "call_duration_ms": call_duration_ms,
        "is_redacted": is_redacted,
        "base_timestamp_ms": base_timestamp_ms,
    }
