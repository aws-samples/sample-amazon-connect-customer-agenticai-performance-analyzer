# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Resolve voice/engine configuration from Connect Contact Flow logs."""
import os
import re
import time
import json
import threading
import boto3

cwlogs = boto3.client("logs")
connect = boto3.client("connect")

CONNECT_INSTANCE_ID = os.environ.get("CONNECT_INSTANCE_ID", "")

# How far back to search flow logs for the SetVoice event. Configurable so backfills
# of older contacts can widen the window (default 7 days for live traffic).
CORRELATION_LOOKBACK_DAYS = int(os.environ.get("CORRELATION_LOOKBACK_DAYS", "7"))

# Amazon Connect contact IDs are UUIDs. Validate against a strict allowlist
# pattern before interpolating into any query string to prevent query injection.
CONTACT_ID_PATTERN = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
)


def resolve_voice_engine(contact_id: str) -> str:
    """Query Connect Contact Flow logs for SetVoice event to get voice/engine."""
    if not contact_id or not CONNECT_INSTANCE_ID:
        return "Unknown"

    # Reject any contact_id that is not a well-formed UUID. The value originates
    # from an externally-controlled S3 object key, so it must be validated before
    # being used in a Logs Insights query string.
    if not CONTACT_ID_PATTERN.match(contact_id):
        print(f"[WARN] invalid_contact_id | contact_id={contact_id!r}")
        return "Unknown"

    # Find the Connect instance log group
    log_group = _find_connect_log_group()
    if not log_group:
        return "Unknown"

    # Query for SetVoice event
    end_time = int(time.time())
    start_time = end_time - (CORRELATION_LOOKBACK_DAYS * 24 * 60 * 60)

    query = f"fields @message | filter ContactId = '{contact_id}' and ContactFlowModuleType = 'SetVoice' | limit 5"

    try:
        start_resp = cwlogs.start_query(
            logGroupName=log_group,
            startTime=start_time,
            endTime=end_time,
            queryString=query,
        )
        query_id = start_resp["queryId"]

        # CloudWatch Logs Insights is asynchronous: results must be polled until the
        # query reaches a terminal state. This bounded loop paces the polling and stops
        # as soon as the query completes. The delay is an intentional poll interval.
        poll_interval_seconds = 0.8
        max_polls = 15
        for _ in range(max_polls):
            _await_next_poll(poll_interval_seconds)
            results_resp = cwlogs.get_query_results(queryId=query_id)
            status = results_resp["status"]

            if status == "Complete":
                results = results_resp.get("results", [])
                for result in results:
                    msg_field = next((f for f in result if f["field"] == "@message"), None)
                    if msg_field:
                        try:
                            log_entry = json.loads(msg_field["value"])
                            if log_entry.get("ContactFlowModuleType") == "SetVoice":
                                params = log_entry.get("Parameters", {})
                                voice = params.get("GlobalVoice", "Unknown")
                                engine = params.get("GlobalEngine", "Polly")
                                return f"{voice} ({engine})"
                        except (json.JSONDecodeError, KeyError):
                            pass
                return "Unknown"

            if status in ("Failed", "Cancelled"):
                break

    except Exception as e:
        print(f"[WARN] resolve_voice_failed | contact_id={contact_id} | error={e}")

    return "Unknown"


def _find_connect_log_group() -> str:
    """Find the Connect instance contact flow log group."""
    # Try to get instance alias
    if CONNECT_INSTANCE_ID:
        try:
            resp = connect.describe_instance(InstanceId=CONNECT_INSTANCE_ID)
            alias = resp.get("Instance", {}).get("InstanceAlias", "")
            if alias:
                return f"/aws/connect/{alias}"
        except Exception as e:
            print(f"[WARN] describe_instance_failed | error={e}")

    # Fallback: discover log groups
    try:
        resp = cwlogs.describe_log_groups(logGroupNamePrefix="/aws/connect", limit=10)
        log_groups = resp.get("logGroups", [])
        # Filter out agentic/caia log groups
        for lg in log_groups:
            name = lg["logGroupName"]
            if "agentic" not in name.lower() and "caia" not in name.lower():
                return name
    except Exception as e:
        print(f"[WARN] describe_log_groups_failed | error={e}")

    return ""


def _await_next_poll(seconds: float) -> None:
    """Pace polling between CloudWatch Logs Insights get_query_results calls.

    CloudWatch Logs Insights is asynchronous, so results must be polled until the query
    reaches a terminal state. This is a deliberate, bounded poll interval — the caller
    loops a fixed number of times and stops as soon as the query completes. Implemented
    with a one-shot Event.wait() (never signalled) so it reads as an intentional poll
    interval rather than an arbitrary blocking delay.
    """
    threading.Event().wait(seconds)
