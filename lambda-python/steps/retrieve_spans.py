# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Retrieve spans from Q Connect (Amazon Q in Connect) ListSpans API."""
import os
import boto3

QCONNECT_ASSISTANT_ID = os.environ.get("QCONNECT_ASSISTANT_ID", "")

qconnect = boto3.client("qconnect")


def retrieve_spans(session_id: str, assistant_id: str) -> list:
    """Call ListSpans to get all span data for a session (handles pagination)."""
    aid = assistant_id or QCONNECT_ASSISTANT_ID
    if not aid or not session_id:
        print(f"[WARN] retrieve_spans_skipped | assistant_id={aid!r} | session_id={session_id!r}")
        return []

    spans = []
    params = {"assistantId": aid, "sessionId": session_id, "maxResults": 100}

    try:
        while True:
            response = qconnect.list_spans(**params)
            spans.extend(response.get("spans", []))

            next_token = response.get("nextToken")
            if not next_token:
                break
            params["nextToken"] = next_token

        print(f"[INFO] retrieve_spans_complete | session_id={session_id} | span_count={len(spans)}")
        return spans
    except Exception as e:
        print(f"[ERROR] retrieve_spans_failed | session_id={session_id} | error={e}")
        return spans
