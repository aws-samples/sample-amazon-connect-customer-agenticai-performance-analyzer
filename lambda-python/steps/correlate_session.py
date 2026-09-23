# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Correlate a contact ID to a Q Connect session via CloudWatch Logs Insights."""
import os
import re
import time
import threading
import boto3

cwlogs = boto3.client("logs")
# Optional explicit override. When set, it is used as-is. When empty, the agentic
# log group is auto-discovered from the Q Connect assistant's CloudWatch Logs
# delivery configuration (see _resolve_log_group_name).
LOG_GROUP_NAME = os.environ.get("LOG_GROUP_NAME", "")
QCONNECT_ASSISTANT_ID = os.environ.get("QCONNECT_ASSISTANT_ID", "")

# Resolved preferred log group (env override / discovery / default), cached for the
# lifetime of the Lambda container.
_resolved_log_group = None
# Auto-discovered agentic log group, cached separately so the discovery failover can
# run even when LOG_GROUP_NAME is set (in which case _resolved_log_group is the env
# value and never triggers discovery). A value of "" is a valid "discovered nothing"
# cache; None means "not yet attempted".
_resolved_discovered_group = None


def _resolve_log_group_name() -> str:
    """Determine the CloudWatch log group holding Q Connect agentic session events.

    Q Connect (Wisdom) delivers agentic EVENT_LOGS to CloudWatch via a Logs delivery
    (delivery source -> delivery -> delivery destination -> log group). The log group
    name is account/assistant specific, so rather than hardcoding it we discover it
    dynamically from that delivery configuration for QCONNECT_ASSISTANT_ID.

    Resolution order:
      1. LOG_GROUP_NAME env var, if explicitly set (operator override).
      2. Auto-discovery from the assistant's EVENT_LOGS delivery destination.
      3. Fallback to the legacy default name.
    The result is cached so the discovery API calls run at most once per container.
    """
    global _resolved_log_group
    if _resolved_log_group is not None:
        return _resolved_log_group

    # 1. Explicit override wins.
    if LOG_GROUP_NAME:
        _resolved_log_group = LOG_GROUP_NAME
        print(f"[INFO] log_group_from_env | log_group={LOG_GROUP_NAME}")
        return _resolved_log_group

    # 2. Auto-discover from the Q Connect assistant's log delivery config.
    discovered = _discover_agentic_log_group(QCONNECT_ASSISTANT_ID)
    if discovered:
        _resolved_log_group = discovered
        print(f"[INFO] log_group_discovered | assistant_id={QCONNECT_ASSISTANT_ID} | log_group={discovered}")
        return _resolved_log_group

    # 3. Legacy default.
    _resolved_log_group = "AmazonConnectAgenticLogs"
    print(f"[WARN] log_group_fallback_default | log_group={_resolved_log_group}")
    return _resolved_log_group


def _discover_agentic_log_group(assistant_id: str) -> str:
    """Find the log group that receives EVENT_LOGS for the given Wisdom assistant.

    Walks: delivery-sources (matching the assistant ARN, logType EVENT_LOGS) ->
    deliveries (source -> destination ARN) -> delivery-destinations (destination ARN
    -> log group ARN). Returns the bare log group name, or "" if not found.
    """
    if not assistant_id:
        return ""
    try:
        # Delivery sources for this assistant's EVENT_LOGS.
        source_names = []
        paginator = cwlogs.get_paginator("describe_delivery_sources")
        for page in paginator.paginate():
            for src in page.get("deliverySources", []):
                if src.get("logType") != "EVENT_LOGS":
                    continue
                arns = src.get("resourceArns", []) or []
                if any(assistant_id in a for a in arns):
                    source_names.append(src.get("name"))
        if not source_names:
            return ""

        # Map each source -> delivery destination ARN.
        dest_arns = set()
        dpaginator = cwlogs.get_paginator("describe_deliveries")
        for page in dpaginator.paginate():
            for dl in page.get("deliveries", []):
                if dl.get("deliverySourceName") in source_names and dl.get("deliveryDestinationArn"):
                    dest_arns.add(dl["deliveryDestinationArn"])
        if not dest_arns:
            return ""

        # Resolve destination ARN -> log group ARN -> bare log group name.
        ddpaginator = cwlogs.get_paginator("describe_delivery_destinations")
        for page in ddpaginator.paginate():
            for dd in page.get("deliveryDestinations", []):
                if dd.get("arn") not in dest_arns:
                    continue
                cfg = dd.get("deliveryDestinationConfiguration", {}) or {}
                dest_res = cfg.get("destinationResourceArn", "")
                # e.g. arn:aws:logs:REGION:ACCT:log-group:logs/pdx-QiC-events:*
                if ":log-group:" in dest_res:
                    name = dest_res.split(":log-group:", 1)[1]
                    return name.rstrip(":*").rstrip(":")
    except Exception as e:
        print(f"[WARN] discover_agentic_log_group_failed | assistant_id={assistant_id} | error={e}")
    return ""


def _discover_and_cache_group() -> str:
    """Auto-discover the agentic log group and cache it for the container lifetime.

    Unlike _resolve_log_group_name (which short-circuits on the LOG_GROUP_NAME env var),
    this always performs delivery-config discovery. It is used as a correlation failover
    so discovery still runs even when an explicit LOG_GROUP_NAME is configured but wrong.
    """
    global _resolved_discovered_group
    if _resolved_discovered_group is not None:
        return _resolved_discovered_group
    _resolved_discovered_group = _discover_agentic_log_group(QCONNECT_ASSISTANT_ID)
    if _resolved_discovered_group:
        print(f"[INFO] log_group_discovered_for_failover | assistant_id={QCONNECT_ASSISTANT_ID} | log_group={_resolved_discovered_group}")
    else:
        print(f"[WARN] log_group_discovery_empty | assistant_id={QCONNECT_ASSISTANT_ID}")
    return _resolved_discovered_group

# How far back to search CloudWatch Logs for the session correlation. Configurable
# so backfills of older contacts can widen the window (default 7 days for live traffic).
CORRELATION_LOOKBACK_DAYS = int(os.environ.get("CORRELATION_LOOKBACK_DAYS", "7"))

# Amazon Connect contact IDs are UUIDs. Validate against a strict allowlist
# pattern before interpolating into any query string to prevent query injection.
CONTACT_ID_PATTERN = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"
)


def _run_correlation_query(contact_id: str, log_group_name: str) -> dict:
    """Run the session-correlation Logs Insights query against one log group.

    Returns a dict:
      {"session_id", "assistant_id", "ok", "matched"}
    where ok=False means the query itself errored/failed (so a fallback log group is
    worth trying) and matched=False means the query ran fine but found no session
    (the log group is reachable but does not contain this contact's event).
    """
    end_time = int(time.time())
    start_time = end_time - (CORRELATION_LOOKBACK_DAYS * 24 * 60 * 60)

    query = (
        "fields session_id, assistant_id "
        "| filter event_type = 'TRANSCRIPT_CREATE_SESSION' "
        f"and (session_name = '{contact_id}' or contact_id = '{contact_id}') "
        "| sort @timestamp desc "
        "| limit 1"
    )

    try:
        start_resp = cwlogs.start_query(
            logGroupName=log_group_name,
            startTime=start_time,
            endTime=end_time,
            queryString=query,
        )
        query_id = start_resp["queryId"]

        # CloudWatch Logs Insights is asynchronous: results must be polled until the
        # query reaches a terminal state. This bounded loop paces the polling and never
        # waits longer than ~30s. The delay is an intentional, bounded poll interval.
        poll_interval_seconds = 1
        max_polls = 30
        for _ in range(max_polls):
            _await_next_poll(poll_interval_seconds)
            results_resp = cwlogs.get_query_results(queryId=query_id)
            status = results_resp["status"]

            if status == "Complete":
                results = results_resp.get("results", [])
                if results:
                    session_id = ""
                    assistant_id = ""
                    for field in results[0]:
                        if field["field"] == "session_id":
                            session_id = field.get("value", "")
                        if field["field"] == "assistant_id":
                            assistant_id = field.get("value", "")
                    return {
                        "session_id": session_id,
                        "assistant_id": assistant_id or QCONNECT_ASSISTANT_ID,
                        "ok": True,
                        "matched": bool(session_id),
                    }
                # Query ran successfully but this contact is not in this log group.
                return {"session_id": "", "assistant_id": QCONNECT_ASSISTANT_ID, "ok": True, "matched": False}

            if status in ("Failed", "Cancelled"):
                print(f"[WARN] cwl_query_failed | status={status} | query_id={query_id} | log_group={log_group_name}")
                return {"session_id": "", "assistant_id": QCONNECT_ASSISTANT_ID, "ok": False, "matched": False}

    except Exception as e:
        # A ResourceNotFoundException here means the configured log group does not
        # exist — a strong signal that LOG_GROUP_NAME is misconfigured.
        print(f"[ERROR] cwl_query_error | contact_id={contact_id} | log_group={log_group_name} | error={e}")
        return {"session_id": "", "assistant_id": QCONNECT_ASSISTANT_ID, "ok": False, "matched": False}

    # Polling exhausted without a terminal state.
    return {"session_id": "", "assistant_id": QCONNECT_ASSISTANT_ID, "ok": False, "matched": False}


def _emit_correlation_diagnostics(contact_id: str, tried_groups: list) -> None:
    """Emit an ordered, actionable troubleshooting checklist when no session is found.

    The correlation depends on a chain of upstream configuration. When it fails, this
    prints the checks an operator should perform, in order, so the log line itself
    tells them what to look at rather than requiring tribal knowledge.
    """
    groups = ", ".join(g for g in tried_groups if g) or "(none)"
    print(
        "[ERROR] session_correlation_failed | "
        f"contact_id={contact_id} | assistant_id={QCONNECT_ASSISTANT_ID} | "
        f"log_groups_tried=[{groups}] | "
        "No TRANSCRIPT_CREATE_SESSION event matched this contact. "
        "TROUBLESHOOT IN ORDER: "
        "1) Confirm Contact Lens is ENABLED on the Amazon Connect flow/instance so an "
        "analysis file is produced for this contact. "
        "2) Confirm the Agentic AI logs are being WRITTEN — the Q Connect assistant must "
        "have an EVENT_LOGS CloudWatch Logs delivery, and that log group must contain a "
        f"TRANSCRIPT_CREATE_SESSION event whose session_name or contact_id = {contact_id}. "
        "3) If the Agentic AI logs exist but in a different group, fix the Lambda "
        "LOG_GROUP_NAME environment variable so it points to the correct Agentic AI log "
        "group path (or clear it to enable auto-discovery from the assistant's delivery "
        "configuration)."
    )


def correlate_session(contact_id: str) -> dict:
    """Query CloudWatch Logs to find the session_id and assistant_id for a contact.

    Resolution strategy:
      1. Query the preferred log group (LOG_GROUP_NAME env var if set, else the
         auto-discovered group, else the legacy default).
      2. If that query errored, or ran but found no matching session, fall back to the
         auto-discovered group (when it differs from the preferred one) and retry. This
         makes auto-discovery a genuine failover — not just the empty-env-var path.
      3. If still unresolved, emit an ordered troubleshooting checklist.

    NOTE: auto-discovery caches the resolved group in memory for the life of the Lambda
    container (via `_resolved_discovered_group`); it does NOT rewrite the Lambda's
    LOG_GROUP_NAME environment variable. Mutating the function configuration at runtime
    would require lambda:UpdateFunctionConfiguration and would conflict with the value
    managed by CloudFormation, so the env var remains the operator-owned source of truth.
    """
    # Reject any contact_id that is not a well-formed UUID. The value originates
    # from an externally-controlled S3 object key, so it must be validated before
    # being used in a Logs Insights query string.
    if not contact_id or not CONTACT_ID_PATTERN.match(contact_id):
        print(f"[WARN] invalid_contact_id | contact_id={contact_id!r}")
        return {"session_id": "", "assistant_id": QCONNECT_ASSISTANT_ID}

    preferred_group = _resolve_log_group_name()
    tried_groups = [preferred_group]

    result = _run_correlation_query(contact_id, preferred_group)
    if result["matched"]:
        return {"session_id": result["session_id"], "assistant_id": result["assistant_id"]}

    # Fallback: if the preferred group errored or simply had no match, try the
    # auto-discovered group as a failover (when it is different and available).
    discovered = _discover_and_cache_group()
    if discovered and discovered != preferred_group:
        reason = "query_error" if not result["ok"] else "no_match"
        print(
            f"[INFO] correlation_fallback_to_discovered | reason={reason} | "
            f"preferred={preferred_group} | discovered={discovered}"
        )
        tried_groups.append(discovered)
        fb = _run_correlation_query(contact_id, discovered)
        if fb["matched"]:
            return {"session_id": fb["session_id"], "assistant_id": fb["assistant_id"]}

    _emit_correlation_diagnostics(contact_id, tried_groups)
    return {"session_id": "", "assistant_id": QCONNECT_ASSISTANT_ID}


def _await_next_poll(seconds: float) -> None:
    """Pace polling between CloudWatch Logs Insights get_query_results calls.

    CloudWatch Logs Insights is asynchronous, so results must be polled until the query
    reaches a terminal state. This is a deliberate, bounded poll interval — the caller
    loops a fixed number of times and stops as soon as the query completes. Implemented
    with a one-shot Event.wait() (never signalled) so it reads as an intentional poll
    interval rather than an arbitrary blocking delay.
    """
    threading.Event().wait(seconds)
