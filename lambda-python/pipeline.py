# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Main pipeline: orchestrates all processing steps for a Contact Lens file."""
import os
import boto3
from steps.download_file import download_contact_lens_file
from steps.correlate_session import correlate_session
from steps.retrieve_spans import retrieve_spans
from steps.calculate_metrics import calculate_metrics
from steps.resolve_agent import resolve_agent_name, sync_agents_table, heal_unresolved_agent_names
from steps.resolve_voice import resolve_voice_engine
from steps.write_records import write_records

_dynamodb = boto3.resource("dynamodb")
_s3 = boto3.client("s3")
_SESSIONS_TABLE = os.environ.get("SESSIONS_TABLE_NAME", "")
_RECORDING_BUCKET = os.environ.get("RECORDING_BUCKET", "")


def _locate_analysis_key(contact_id: str) -> tuple:
    """Locate the unredacted Contact Lens analysis file for a contact in S3.

    Used to re-process a legacy incomplete record that has no stored sourceKey. Returns
    (bucket, key) or ('', '') if not found. Prefers the unredacted analysis file.
    """
    if not _RECORDING_BUCKET or not contact_id:
        return "", ""
    prefix = "Analysis/Voice/ivr/"
    try:
        paginator = _s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=_RECORDING_BUCKET, Prefix=prefix):
            for obj in page.get("Contents", []):
                k = obj["Key"]
                if contact_id in k and k.endswith(".json") and "_analysis_" in k and "/Redacted/" not in k:
                    return _RECORDING_BUCKET, k
    except Exception as e:
        print(f"[WARN] locate_analysis_key_failed | contact_id={contact_id} | error={e}")
    return "", ""


def process_contact_lens_file(bucket: str, key: str, request_id: str, run_maintenance: bool = True) -> dict:
    """Process a single Contact Lens analysis file through the full pipeline.

    run_maintenance runs the once-per-invocation upkeep (agent sync, agent-name heal,
    and re-processing of incomplete records). It is disabled when this function is
    called from within the reprocess sweep to avoid unbounded recursion.
    """

    # Step 1: Sync AI agents table (refresh latest agent info), then self-heal any
    # existing records whose agentName is still a bare agent ID (e.g. a contact that
    # was processed before its agent was published). This keeps agent names correct
    # automatically as new agents are added — no manual reprocessing required.
    if run_maintenance:
        print(f"[INFO] step_sync_agents")
        sync_agents_table(assistant_id="")
        heal_unresolved_agent_names(assistant_id="")
        reprocess_incomplete_records(exclude_key=key)

    # Step 2: Download and parse Contact Lens file
    print(f"[INFO] step_download | bucket={bucket} | key={key}")
    contact_lens_data = download_contact_lens_file(bucket, key)

    # Step 3: Correlate with Q Connect session via CloudWatch Logs
    contact_id = contact_lens_data["contact_id"]
    print(f"[INFO] step_correlate | contact_id={contact_id}")
    correlation = correlate_session(contact_id)

    # Step 4: Retrieve spans (if session found)
    spans = []
    if correlation["session_id"]:
        print(f"[INFO] step_retrieve_spans | session_id={correlation['session_id']}")
        spans = retrieve_spans(correlation["session_id"], correlation["assistant_id"])
    else:
        print(f"[WARN] no_session_found | contact_id={contact_id}")

    # Step 5: Calculate latency metrics (with Contact Lens transcript for STT/TTS).
    # PII-mismatch detection is skipped for redacted transcripts. The filename base
    # timestamp anchors transcript offsets to the span clock for the latency breakdown.
    is_redacted = contact_lens_data.get("is_redacted", False)
    base_timestamp_ms = contact_lens_data.get("base_timestamp_ms")

    # Resolve voice/engine first — the latency breakdown uses it to pick a realistic
    # per-engine TTS baseline (true TTS is not measurable from spans/Contact Lens).
    print(f"[INFO] step_resolve_voice | contact_id={contact_id}")
    voice_engine = resolve_voice_engine(contact_id)

    print(f"[INFO] step_calculate_metrics | span_count={len(spans)} | is_redacted={is_redacted}")
    metrics = calculate_metrics(spans, contact_lens_data.get("transcript"), is_redacted, base_timestamp_ms, voice_engine)

    # Step 6: Resolve agent name — from spans, falling back to the session config
    agent_name = resolve_agent_name(spans, correlation["assistant_id"], correlation["session_id"])

    # Step 8: Write single consolidated record to DynamoDB.
    # Only one record is kept per contact, preferring unredacted data: a redacted file
    # will not overwrite an existing unredacted record (handled in write_records).
    session_id = correlation["session_id"] or contact_id
    print(f"[INFO] step_write_records | turn_count={len(metrics['turns'])} | is_redacted={is_redacted}")
    write_records(
        session_id=session_id,
        contact_id=contact_id,
        assistant_id=correlation["assistant_id"],
        agent_name=agent_name,
        contact_lens_data=contact_lens_data,
        metrics=metrics,
        spans=spans,
        voice_engine=voice_engine,
        is_redacted=is_redacted,
        source_bucket=bucket,
        source_key=key,
    )

    return {
        "session_id": session_id,
        "contact_id": contact_id,
        "turn_count": len(metrics["turns"]),
    }


def reprocess_incomplete_records(exclude_key: str = "") -> int:
    """Re-process records that were written with a failed session correlation.

    When a Contact Lens file is processed before its Q Connect session-correlation log
    is available, correlation returns no session: the record is written with no spans,
    no turns, and agentName "Unknown". By the time a later file is processed, those
    logs are usually available, so we can re-run the full pipeline for the stored S3
    key and fill in the session, spans, metrics, and agent name.

    Runs once per invocation. Only records that (a) look incomplete (Unknown/empty agent
    AND zero turns) and (b) carry a stored sourceKey are retried. Idempotent: a record
    that is still uncorrelatable is simply rewritten in the same incomplete state.
    """
    if not _SESSIONS_TABLE:
        return 0

    table = _dynamodb.Table(_SESSIONS_TABLE)
    reprocessed = 0
    try:
        scan_kwargs = {
            "ProjectionExpression": "contactId, agentName, turnCount, sourceBucket, sourceKey",
            "FilterExpression": "(agentName = :unknown OR attribute_not_exists(agentName)) AND turnCount = :zero",
            "ExpressionAttributeValues": {":unknown": "Unknown", ":zero": 0},
        }
        last_key = None
        while True:
            if last_key:
                scan_kwargs["ExclusiveStartKey"] = last_key
            resp = table.scan(**scan_kwargs)
            for item in resp.get("Items", []):
                bucket = item.get("sourceBucket", "")
                key = item.get("sourceKey", "")
                # Legacy records written before sourceKey was stored: locate the file
                # in S3 by contactId so they self-heal too.
                if not key:
                    bucket, key = _locate_analysis_key(item.get("contactId", ""))
                if not bucket or not key or key == exclude_key:
                    continue
                try:
                    result = process_contact_lens_file(bucket, key, request_id="reprocess", run_maintenance=False)
                    if result.get("turn_count", 0) > 0:
                        reprocessed += 1
                        print(f"[INFO] reprocessed_incomplete | contact_id={result['contact_id']} | turn_count={result['turn_count']}")
                except Exception as e:
                    print(f"[WARN] reprocess_failed | key={key} | error={e}")
            last_key = resp.get("LastEvaluatedKey")
            if not last_key:
                break
    except Exception as e:
        print(f"[WARN] reprocess_incomplete_records_failed | error={e}")

    if reprocessed:
        print(f"[INFO] reprocess_incomplete_records_complete | reprocessed={reprocessed}")
    return reprocessed
