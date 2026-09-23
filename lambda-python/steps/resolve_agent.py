# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Sync AI agents from Q Connect to DynamoDB and resolve agent names."""
import os
import re
import boto3

AGENTS_TABLE = os.environ.get("AGENTS_TABLE_NAME", "")
SESSIONS_TABLE = os.environ.get("SESSIONS_TABLE_NAME", "")
QCONNECT_ASSISTANT_ID = os.environ.get("QCONNECT_ASSISTANT_ID", "")

dynamodb = boto3.resource("dynamodb")
qconnect = boto3.client("qconnect")

# A bare agent ID looks like a UUID. When a record's agentName matches this, the name
# was never resolved (resolution fell back to the raw ID), so it should be re-resolved.
_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def _looks_like_agent_id(value: str) -> bool:
    """True if the value is a bare UUID (i.e. an unresolved agent ID, not a name)."""
    return bool(value and _GUID_RE.match(value.strip()))


def sync_agents_table(assistant_id: str) -> None:
    """Fetch all AI agents from Q Connect and write/update them in the agents DynamoDB table."""
    if not AGENTS_TABLE:
        print("[WARN] sync_agents_table | AGENTS_TABLE_NAME not set, skipping sync")
        return

    aid = assistant_id or QCONNECT_ASSISTANT_ID
    if not aid:
        print("[WARN] sync_agents_table | No assistant_id available, skipping sync")
        return

    table = dynamodb.Table(AGENTS_TABLE)

    try:
        agents = []
        params = {"assistantId": aid, "maxResults": 100}

        while True:
            response = qconnect.list_ai_agents(**params)
            summaries = response.get("aiAgentSummaries", [])
            agents.extend(summaries)

            next_token = response.get("nextToken")
            if not next_token:
                break
            params["nextToken"] = next_token

        # Batch write all agents to DynamoDB
        with table.batch_writer() as batch:
            for agent in agents:
                batch.put_item(Item={
                    "agentId": agent.get("aiAgentId", ""),
                    "name": agent.get("name", ""),
                    "type": agent.get("type", ""),
                    "assistantId": aid,
                    "status": agent.get("status", ""),
                    "origin": agent.get("origin", ""),
                })

        print(f"[INFO] sync_agents_complete | agent_count={len(agents)}")

    except Exception as e:
        print(f"[ERROR] sync_agents_failed | error={e}")


def resolve_agent_name(spans: list, assistant_id: str, session_id: str = "") -> str:
    """Resolve the AI agent name for a contact.

    Agent ID resolution is attempted in order:
      1. From span attributes (aiAgentId) — available when spans are retrieved.
      2. From the QConnect session's aiAgentConfiguration — a fallback used when
         spans are empty or do not carry the agent ID, so the agent info is still
         populated instead of defaulting to "Unknown".

    The resolved agent ID is then looked up in the agents DynamoDB table to get a
    human-readable name. If the agent is not yet in the table, we fetch it directly
    from QConnect (GetAIAgent), upsert it, and use that name.
    """
    aid = assistant_id or QCONNECT_ASSISTANT_ID

    # 1) Try spans, 2) fall back to the session configuration.
    agent_id = _extract_agent_id(spans)
    if not agent_id and session_id:
        agent_id = _agent_id_from_session(aid, session_id)

    if not agent_id:
        print(f"[WARN] agent_id_unresolved | session_id={session_id}")
        return "Unknown"

    name = _lookup_agent_name(agent_id)
    if name:
        return name

    # Not in the agents table — fetch it directly and upsert so future lookups hit.
    name = _fetch_and_cache_agent(aid, agent_id)
    return name or agent_id


def _extract_agent_id(spans: list) -> str:
    """Extract agent ID from span attributes."""
    for span in spans:
        attrs = span.get("attributes", {})
        if attrs and attrs.get("aiAgentId"):
            return attrs["aiAgentId"]
    return ""


def _agent_id_from_session(assistant_id: str, session_id: str) -> str:
    """Fall back to the session's aiAgentConfiguration to find the agent ID.

    aiAgentConfiguration is a map keyed by agent type; each value has an aiAgentId.
    Returns the first configured agent ID found, or '' if none.
    """
    if not assistant_id or not session_id:
        return ""
    try:
        resp = qconnect.get_session(assistantId=assistant_id, sessionId=session_id)
        cfg = resp.get("session", {}).get("aiAgentConfiguration", {}) or {}
        for _agent_type, value in cfg.items():
            agent_id = (value or {}).get("aiAgentId")
            if agent_id:
                print(f"[INFO] agent_id_from_session | session_id={session_id} | agent_id={agent_id}")
                return agent_id
    except Exception as e:
        print(f"[WARN] get_session_failed | session_id={session_id} | error={e}")
    return ""


def _lookup_agent_name(agent_id: str) -> str:
    """Look up an agent name in the agents DynamoDB table. Returns '' if not found."""
    if not AGENTS_TABLE:
        return ""
    try:
        table = dynamodb.Table(AGENTS_TABLE)
        resp = table.get_item(Key={"agentId": agent_id})
        if "Item" in resp:
            return resp["Item"].get("name", "")
    except Exception as e:
        print(f"[WARN] agent_lookup_failed | agent_id={agent_id} | error={e}")
    return ""


def _fetch_and_cache_agent(assistant_id: str, agent_id: str) -> str:
    """Fetch a single agent from QConnect (GetAIAgent) and upsert it into the table.

    Handles the case where a contact references an agent that was created after the
    last full sync, so the agent name is still resolved instead of showing the raw ID.
    """
    if not assistant_id or not agent_id:
        return ""
    try:
        resp = qconnect.get_ai_agent(assistantId=assistant_id, aiAgentId=agent_id)
        agent = resp.get("aiAgent", {}) or {}
        name = agent.get("name", "")
        if AGENTS_TABLE and name:
            try:
                dynamodb.Table(AGENTS_TABLE).put_item(Item={
                    "agentId": agent_id,
                    "name": name,
                    "type": agent.get("type", ""),
                    "assistantId": assistant_id,
                    "status": agent.get("status", ""),
                    "origin": agent.get("origin", ""),
                })
                print(f"[INFO] agent_cached | agent_id={agent_id} | name={name}")
            except Exception as e:
                print(f"[WARN] agent_cache_failed | agent_id={agent_id} | error={e}")
        return name
    except Exception as e:
        print(f"[WARN] get_ai_agent_failed | agent_id={agent_id} | error={e}")
    return ""


def heal_unresolved_agent_names(assistant_id: str) -> int:
    """Fix existing session records whose agentName is still a bare agent ID.

    Records store the agent name resolved at write time. A contact processed before
    its agent existed in the catalog (e.g. a newly published agent) freezes the raw
    agent ID as its name. This sweep runs on every pipeline invocation: after the
    catalog has been synced, it scans for records whose agentName looks like a UUID
    and rewrites it with the resolved human-readable name. It is idempotent and only
    touches the affected rows, so it is safe to run repeatedly and automatically
    handles any agents added in the future.
    """
    if not SESSIONS_TABLE or not AGENTS_TABLE:
        return 0

    aid = assistant_id or QCONNECT_ASSISTANT_ID
    table = dynamodb.Table(SESSIONS_TABLE)
    healed = 0
    # Cache id -> name lookups within this sweep to avoid repeat calls.
    name_cache: dict = {}

    def resolve(agent_id: str) -> str:
        if agent_id in name_cache:
            return name_cache[agent_id]
        name = _lookup_agent_name(agent_id) or _fetch_and_cache_agent(aid, agent_id)
        name_cache[agent_id] = name
        return name

    try:
        scan_kwargs = {
            "ProjectionExpression": "contactId, agentName",
            # Only pull rows that still hold an unresolved id; DynamoDB has no regex,
            # so we filter UUID-shaped values in code after a lightweight projection.
        }
        last_key = None
        while True:
            if last_key:
                scan_kwargs["ExclusiveStartKey"] = last_key
            resp = table.scan(**scan_kwargs)
            for item in resp.get("Items", []):
                current = item.get("agentName", "")
                if not _looks_like_agent_id(current):
                    continue
                resolved = resolve(current)
                if resolved and resolved != current:
                    try:
                        table.update_item(
                            Key={"contactId": item["contactId"]},
                            UpdateExpression="SET agentName = :n",
                            ConditionExpression="agentName = :old",
                            ExpressionAttributeValues={":n": resolved, ":old": current},
                        )
                        healed += 1
                        print(f"[INFO] agent_name_healed | contact_id={item['contactId']} | {current} -> {resolved}")
                    except Exception as e:
                        print(f"[WARN] agent_name_heal_failed | contact_id={item.get('contactId')} | error={e}")
            last_key = resp.get("LastEvaluatedKey")
            if not last_key:
                break
    except Exception as e:
        print(f"[WARN] heal_unresolved_agent_names_failed | error={e}")

    if healed:
        print(f"[INFO] heal_unresolved_agent_names_complete | healed={healed}")
    return healed
