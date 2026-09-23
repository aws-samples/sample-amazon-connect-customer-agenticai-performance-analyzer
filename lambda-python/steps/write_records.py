# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Write consolidated contact record to DynamoDB."""
import os
import time
from decimal import Decimal
from datetime import datetime
import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.resource("dynamodb")
TABLE_NAME = os.environ.get("SESSIONS_TABLE_NAME", "")


def write_records(
    session_id: str,
    contact_id: str,
    assistant_id: str,
    agent_name: str,
    contact_lens_data: dict,
    metrics: dict,
    spans: list,
    voice_engine: str = "Unknown",
    is_redacted: bool = False,
    source_bucket: str = "",
    source_key: str = "",
) -> None:
    """Write a single consolidated record per contact to DynamoDB.

    Contact Lens produces both an unredacted and a redacted analysis file per contact,
    and both trigger this pipeline. We keep exactly one record per contactId and always
    prefer the unredacted data:

      - An UNREDACTED record is written unconditionally (it always wins).
      - A REDACTED record is written only if no unredacted record already exists for the
        contact. This is enforced with a conditional write, so ordering does not matter:
          * redacted arrives first  -> written; later unredacted overwrites it.
          * unredacted arrives first -> written; later redacted write is rejected/skipped.
    """
    table = dynamodb.Table(TABLE_NAME)
    timestamp = datetime.utcnow().isoformat() + "Z"

    record = {
        "contactId": contact_id,
        "sessionId": session_id,
        "assistantId": assistant_id,
        "agentName": agent_name,
        "timestamp": timestamp,
        "voiceEngine": voice_engine,
        # Track which analysis variant produced this record.
        "redacted": is_redacted,
        # Source S3 location of the Contact Lens file, so a record that was written with
        # missing correlation (no session found yet) can be automatically re-processed
        # later once the correlation logs are available. See reprocess in pipeline.
        "sourceBucket": source_bucket,
        "sourceKey": source_key,
        # Contact Lens: only timing and transcript (for STT/TTS calculation)
        "contactLens": {
            "transcript": _trim_transcript(contact_lens_data.get("transcript", [])),
            "callDurationMs": contact_lens_data.get("call_duration_ms", 0),
        },
        # Spans: slim structure with only essential fields
        "spans": _sanitize_spans(spans),
        # Calculated metrics (comprehensive)
        "turnCount": len(metrics["turns"]),
        "turns": metrics["turns"],
        "aggregateMetrics": metrics["aggregates"],
        # TTL (30 days)
        "expiresAt": int(time.time()) + 30 * 24 * 60 * 60,
    }

    # Convert floats to Decimal for DynamoDB and remove None values
    cleaned = _clean_for_dynamo(record)

    if not is_redacted:
        # Unredacted always wins — write unconditionally.
        table.put_item(Item=cleaned)
        print(f"[INFO] write_complete | contact_id={contact_id} | variant=unredacted | turn_count={len(metrics['turns'])}")
        return

    # Redacted: only write if there is no existing UNREDACTED record for this contact.
    # Allowed when the item does not exist, or when the existing item is itself redacted.
    try:
        table.put_item(
            Item=cleaned,
            ConditionExpression="attribute_not_exists(contactId) OR redacted = :true",
            ExpressionAttributeValues={":true": True},
        )
        print(f"[INFO] write_complete | contact_id={contact_id} | variant=redacted | turn_count={len(metrics['turns'])}")
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            # An unredacted record already exists — keep it, skip the redacted write.
            print(f"[INFO] write_skipped_redacted | contact_id={contact_id} | reason=unredacted_record_exists")
        else:
            raise


def _trim_transcript(transcript: list) -> list:
    """Keep only timing and participant fields needed for STT/TTS calculation."""
    return [
        {
            "participant": seg.get("participant", ""),
            "content": seg.get("content", ""),
            "beginOffsetMillis": seg.get("beginOffsetMillis", 0),
            "endOffsetMillis": seg.get("endOffsetMillis", 0),
        }
        for seg in transcript
    ]


def _sanitize_spans(spans: list) -> list:
    """Extract only essential fields from spans to stay within DynamoDB 400KB limit.
    
    Captures all attributes used for metrics calculation, drops large text fields
    (inputMessages, outputMessages, systemInstructions).
    """
    # Attributes to keep (all used by the performance comparison metrics)
    KEEP_ATTRS = {
        "aiAgentId", "aiAgentName", "aiAgentType", "aiAgentVersion",
        "aiAgentOrchestratorUseCase",
        "timeToFirstTokenMs",
        "usageInputTokens", "usageOutputTokens", "usageTotalTokens",
        "cacheReadInputTokens", "cacheWriteInputTokens",
        "requestModel", "requestMaxTokens", "temperature",
        "responseFinishReasons",
        "toolName", "toolType",
        "operationName", "providerName",
        "contactId", "sessionName",
        "errorType",
        "inputMessages", "outputMessages",
    }

    sanitized = []
    for span in spans:
        attrs = span.get("attributes", {}) or {}
        slim_attrs = {}
        for k, v in attrs.items():
            if k in KEEP_ATTRS and v is not None:
                # Trim inputMessages/outputMessages to keep only text values (truncated)
                if k in ("inputMessages", "outputMessages") and isinstance(v, list):
                    slim_attrs[k] = _trim_messages(v)
                else:
                    slim_attrs[k] = v

        sanitized.append({
            "spanId": span.get("spanId", ""),
            "parentSpanId": span.get("parentSpanId", ""),
            "spanName": span.get("spanName", ""),
            "startTimestamp": _ts_to_str(span.get("startTimestamp")),
            "endTimestamp": _ts_to_str(span.get("endTimestamp")),
            "status": span.get("status", ""),
            "attributes": slim_attrs,
        })
    return sanitized


def _ts_to_str(ts) -> str:
    """Convert timestamp (datetime or string) to ISO string."""
    if ts is None:
        return ""
    if isinstance(ts, datetime):
        return ts.isoformat() + "Z"
    return str(ts)


def _trim_messages(messages: list) -> list:
    """Trim inputMessages/outputMessages to keep participant, timestamp, and text content."""
    trimmed = []
    for msg in messages:
        entry = {
            "participant": msg.get("participant", ""),
            "timestamp": _ts_to_str(msg.get("timestamp")),
        }
        # Extract text values from the values list
        values = msg.get("values", [])
        texts = []
        for val in values:
            if isinstance(val, dict) and "text" in val:
                text_val = val["text"].get("value", "") if isinstance(val["text"], dict) else str(val["text"])
                texts.append(text_val)
        if texts:
            entry["text"] = texts[0]  # Keep first text value
        trimmed.append(entry)
    return trimmed


def _clean_for_dynamo(obj):
    """Recursively clean an object for DynamoDB: convert floats to Decimal, remove None."""
    if obj is None:
        return None
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, datetime):
        return obj.isoformat() + "Z"
    if isinstance(obj, list):
        return [_clean_for_dynamo(item) for item in obj if item is not None]
    if isinstance(obj, dict):
        return {k: _clean_for_dynamo(v) for k, v in obj.items() if v is not None}
    return str(obj)
