# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Calculate detailed latency, token, and performance metrics from span data."""
from datetime import datetime

import re

# Maximum plausible silence (ms) between a customer segment ending and its paired
# agent segment beginning. Pairings exceeding this are treated as cross-matches
# (e.g. an empty-output transfer turn that positionally matched a distant segment)
# and are left undecomposed so transfer/routing wait is not mislabeled as STT/TTS.
SEGMENT_PROXIMITY_GUARD_MS = 10000

# NOTE on TTS: true text-to-speech time is NOT measurable from ListSpans + Contact
# Lens. The only "agent audio started" signal is the Contact Lens agent-segment start,
# which lags the real (streaming) audio start by seconds. So STT and TTS are not split;
# instead the whole non-LLM portion of the customer's silence is reported together as
# Speech Processing (speechProcessingMs) = full_silence - (Orch + TTFT + MsgRem).
# See _compute_latency_breakdowns.

# First-party tool names (internal/control tools) - normalized lowercase, no hyphens/spaces
FIRST_PARTY_TOOL_NAMES = {
    "escalate", "complete", "endconversation", "end_conversation",
    "returncontrol", "return_control", "transfertoqueue", "transfer_to_queue",
    "transfertoagent", "transfer_to_agent", "transfertoflow", "transfer_to_flow",
    "holdcustomer", "hold_customer", "resumecustomer", "resume_customer",
    "pauseconversation", "pause_conversation",
}

# Argument keys that indicate 1st-party/control tools
FIRST_PARTY_ARG_KEYS = {
    "reason", "escalationreason", "transferreason",
    "queuename", "queueid", "agentid", "flowid", "flowname",
}

# Regex patterns in argument values that indicate control/routing actions
FIRST_PARTY_VALUE_PATTERNS = [
    re.compile(r"\bescalat", re.IGNORECASE),
    re.compile(r"\btransfer\s*(to|the)\s*(agent|human|representative|queue|flow)", re.IGNORECASE),
    re.compile(r"\bspeak\s*(to|with)\s*(a\s*)?(human|agent|representative|person)", re.IGNORECASE),
    re.compile(r"\bend\s*(the\s*)?(conversation|call|chat|session|interaction)", re.IGNORECASE),
    re.compile(r"\bhang\s*up", re.IGNORECASE),
    re.compile(r"\breturn\s*(control|to\s*flow)", re.IGNORECASE),
    re.compile(r"\bdisconnect", re.IGNORECASE),
    re.compile(r"\bcall\s*complete", re.IGNORECASE),
    re.compile(r"\bconversation\s*(complete|ended|finished|done)", re.IGNORECASE),
    re.compile(r"\bgoodbye", re.IGNORECASE),
]


def calculate_metrics(spans: list, contact_lens_transcript: list = None, is_redacted: bool = False,
                      base_timestamp_ms: int = None, voice_engine: str = "") -> dict:
    """Calculate comprehensive per-turn and aggregate metrics from spans and Contact Lens.

    is_redacted: when True, the Contact Lens transcript has PII masked, so PII-mismatch
    detection is skipped (it would produce false results against masked content).

    base_timestamp_ms: epoch-ms base (from the Contact Lens filename) used to convert
    transcript offsets to absolute timestamps so the per-turn latency breakdown
    (STT, Orchestration, TTFT, Msg Remainder, TTS) can be anchored on real span and
    message timestamps.
    """
    invoke_agent_spans = sorted(
        [s for s in spans if s.get("spanName") == "invoke_agent"],
        key=lambda s: s.get("startTimestamp", ""),
    )
    inference_spans = [s for s in spans if s.get("spanName") == "inference"]
    tool_spans = [s for s in spans if s.get("spanName") == "execute_tool"]

    # Classify tools
    third_party_tools = [s for s in tool_spans if _get_tool_type(s, spans) == "third-party"]
    first_party_tools = [s for s in tool_spans if _get_tool_type(s, spans) == "first-party"]

    # Split turns by with/without tool
    turns_with_tool = [s for s in invoke_agent_spans if any(t.get("parentSpanId") == s.get("spanId") for t in tool_spans)]
    turns_without_tool = [s for s in invoke_agent_spans if not any(t.get("parentSpanId") == s.get("spanId") for t in tool_spans)]

    # Per-turn breakdowns
    all_breakdowns = [_compute_turn_breakdown(s, inference_spans) for s in invoke_agent_spans]
    all_breakdowns = [b for b in all_breakdowns if b]
    with_tool_breakdowns = [_compute_turn_breakdown(s, inference_spans) for s in turns_with_tool]
    with_tool_breakdowns = [b for b in with_tool_breakdowns if b]
    without_tool_breakdowns = [_compute_turn_breakdown(s, inference_spans) for s in turns_without_tool]
    without_tool_breakdowns = [b for b in without_tool_breakdowns if b]

    # Durations
    turn_durations = [_span_duration_ms(s) for s in invoke_agent_spans]
    with_tool_durations = [_span_duration_ms(s) for s in turns_with_tool]
    without_tool_durations = [_span_duration_ms(s) for s in turns_without_tool]
    inference_durations = [_span_duration_ms(s) for s in inference_spans]
    tool_durations = [_span_duration_ms(s) for s in tool_spans]
    third_party_tool_durations = [_span_duration_ms(s) for s in third_party_tools]

    # TTFT values
    ttft_values = []
    for s in inference_spans:
        attrs = s.get("attributes", {}) or {}
        val = attrs.get("timeToFirstTokenMs", 0) or 0
        if val > 0:
            ttft_values.append(val)

    # Token metrics
    input_tokens = [_get_attr(s, "usageInputTokens", 0) for s in inference_spans]
    output_tokens = [_get_attr(s, "usageOutputTokens", 0) for s in inference_spans]

    # Cache metrics
    cache_read_turns = [s for s in inference_spans if _get_attr(s, "cacheReadInputTokens", 0) > 0]
    cache_write_turns = [s for s in inference_spans if _get_attr(s, "cacheWriteInputTokens", 0) > 0]
    total_cache_read_tokens = sum(_get_attr(s, "cacheReadInputTokens", 0) for s in inference_spans)
    total_cache_write_tokens = sum(_get_attr(s, "cacheWriteInputTokens", 0) for s in inference_spans)

    # Primary model
    primary_model = ""
    if inference_spans:
        raw_model = _get_attr(inference_spans[0], "requestModel", "")
        primary_model = raw_model

    # Turn categorization (pause, barge-in, etc.)
    turn_categories = _categorize_turns(invoke_agent_spans, inference_spans, tool_spans, contact_lens_transcript, spans, is_redacted)

    # Per-turn latency breakdown (STT, Orchestration, TTFT, Msg Remainder, TTS)
    # computed against real span/message timestamps.
    latency_breakdowns = _compute_latency_breakdowns(
        invoke_agent_spans, inference_spans, contact_lens_transcript, base_timestamp_ms, voice_engine
    )

    # Build per-turn data
    turns = []
    for idx, invoke_span in enumerate(invoke_agent_spans):
        child_infs = [s for s in inference_spans if s.get("parentSpanId") == invoke_span.get("spanId")]
        child_tools = [s for s in tool_spans if s.get("parentSpanId") == invoke_span.get("spanId")]
        has_tool = len(child_tools) > 0

        inf_attrs = child_infs[0].get("attributes", {}) if child_infs else {}
        orch_ms = 0
        ttft_ms = 0
        if child_infs:
            orch_ms = _parse_ts(child_infs[0].get("startTimestamp")) - _parse_ts(invoke_span.get("startTimestamp"))
            ttft_ms = (inf_attrs.get("timeToFirstTokenMs") or 0)

        # Get turn category info
        cat = turn_categories[idx] if idx < len(turn_categories) else {}
        bd = latency_breakdowns[idx] if idx < len(latency_breakdowns) else {}

        turns.append({
            "turnNumber": idx + 1,
            "totalDurationMs": _span_duration_ms(invoke_span),
            "orchestrationMs": orch_ms,
            "ttftMs": ttft_ms,
            # Message remainder = time from first token to full response logged (ttfm - ttft)
            "msgRemMs": bd.get("msgRemMs"),
            "inferenceDurationMs": _span_duration_ms(child_infs[0]) if child_infs else 0,
            "toolExecutionMs": sum(_span_duration_ms(t) for t in child_tools),
            "toolNames": _extract_tool_names(child_tools, spans),
            "hasTool": has_tool,
            "inputTokens": inf_attrs.get("usageInputTokens") or 0,
            "outputTokens": inf_attrs.get("usageOutputTokens") or 0,
            "cacheReadTokens": inf_attrs.get("cacheReadInputTokens") or 0,
            "cacheWriteTokens": inf_attrs.get("cacheWriteInputTokens") or 0,
            # Speech Processing (STT + TTS): the non-LLM portion of the customer's
            # silence (speech recognition + routing + text-to-speech), reported as a
            # single consistent metric. True per-component TTS is not measurable here.
            "speechProcessingMs": bd.get("speechProcessingMs"),
            "customerWaitMs": _get_customer_wait(idx, contact_lens_transcript),
            # Turn categories and flags
            "category": cat.get("category", "normal"),
            "flags": cat.get("flags", []),
            "piiMismatch": cat.get("piiMismatch"),
        })

    # Aggregate metrics
    aggregates = {
        # Turn-level
        "totalTurns": len(invoke_agent_spans),
        "turnsWithTool": len(turns_with_tool),
        "turnsWithoutTool": len(turns_without_tool),
        "avgTurnDuration": _avg(turn_durations),
        "maxTurnDuration": _max(turn_durations),
        "avgTurnWithTool": _avg(with_tool_durations),
        "maxTurnWithTool": _max(with_tool_durations),
        "avgTurnWithoutTool": _avg(without_tool_durations),
        "maxTurnWithoutTool": _max(without_tool_durations),
        # Orchestration
        "avgOrch": _avg_key(all_breakdowns, "orchMs"),
        "maxOrch": _max_key(all_breakdowns, "orchMs"),
        "avgOrchWithTool": _avg_key(with_tool_breakdowns, "orchMs"),
        "avgOrchWithoutTool": _avg_key(without_tool_breakdowns, "orchMs"),
        # TTFT
        "avgTtft": _avg(ttft_values),
        "maxTtft": _max(ttft_values),
        "avgTtftWithTool": _avg_key([b for b in with_tool_breakdowns if b["ttftMs"] > 0], "ttftMs"),
        "avgTtftWithoutTool": _avg_key([b for b in without_tool_breakdowns if b["ttftMs"] > 0], "ttftMs"),
        # Orch + TTFT
        "avgOrchPlusTtft": _avg_key([b for b in all_breakdowns if b["ttftMs"] > 0], "orchPlusTtft"),
        "maxOrchPlusTtft": _max_key([b for b in all_breakdowns if b["ttftMs"] > 0], "orchPlusTtft"),
        "avgOrchPlusTtftWithTool": _avg_key([b for b in with_tool_breakdowns if b["ttftMs"] > 0], "orchPlusTtft"),
        "avgOrchPlusTtftWithoutTool": _avg_key([b for b in without_tool_breakdowns if b["ttftMs"] > 0], "orchPlusTtft"),
        # LLM Inference
        "avgLlmInference": _avg(inference_durations),
        "maxLlmInference": _max(inference_durations),
        "totalInferences": len(inference_spans),
        # Tools
        "avgToolTime": _avg(tool_durations),
        "maxToolTime": _max(tool_durations),
        "totalTools": len(tool_spans),
        "avgThirdPartyToolTime": _avg(third_party_tool_durations),
        "maxThirdPartyToolTime": _max(third_party_tool_durations),
        "totalThirdPartyTools": len(third_party_tools),
        "totalFirstPartyTools": len(first_party_tools),
        # Tokens
        "totalInputTokens": sum(input_tokens),
        "totalOutputTokens": sum(output_tokens),
        "avgInputTokensPerTurn": round(sum(input_tokens) / len(inference_spans)) if inference_spans else 0,
        "avgOutputTokensPerTurn": round(sum(output_tokens) / len(inference_spans)) if inference_spans else 0,
        # Cache
        "cacheReadTurns": len(cache_read_turns),
        "cacheWriteTurns": len(cache_write_turns),
        "totalCacheReadTokens": total_cache_read_tokens,
        "totalCacheWriteTokens": total_cache_write_tokens,
        # Model
        "primaryModel": primary_model,
        # Speech Processing (STT + TTS): the non-LLM portion of the customer's silence
        # (STT + routing + TTS), reported as one consistent metric per turn.
        "avgSpeechProcessing": _avg([t["speechProcessingMs"] for t in turns if t.get("speechProcessingMs") is not None]),
        "maxSpeechProcessing": _max([t["speechProcessingMs"] for t in turns if t.get("speechProcessingMs") is not None]),
        # Message remainder (time after first token until full response logged)
        "avgMsgRem": _avg([t["msgRemMs"] for t in turns if t.get("msgRemMs") is not None]),
        "maxMsgRem": _max([t["msgRemMs"] for t in turns if t.get("msgRemMs") is not None]),
        # Customer Wait (full silence = STT + Orch + TTFT + Msg Remainder + TTS)
        "avgCustomerWait": _avg([t["customerWaitMs"] for t in turns if t.get("customerWaitMs") is not None and t["customerWaitMs"] > 0]),
        "maxCustomerWait": _max([t["customerWaitMs"] for t in turns if t.get("customerWaitMs") is not None and t["customerWaitMs"] > 0]),
    }

    return {"turns": turns, "aggregates": aggregates}


def _compute_latency_breakdowns(invoke_spans, inference_spans, transcript, base_timestamp_ms, voice_engine=""):
    """Compute the per-turn latency breakdown for each turn.

    For each turn (a CUSTOMER segment followed by an AGENT/SYSTEM segment), the
    customer's silence is decomposed into real, timestamp-anchored components:

        Customer Perceived Wait = Speech Processing (STT+TTS) + Orchestration + TTFT

    where, using the filename base timestamp to place transcript offsets on the
    same absolute clock as the spans:

        customer_end       = base + customer_seg.endOffsetMillis
        system_start       = base + agent_seg.beginOffsetMillis
        full_silence       = system_start   - customer_end
        Orch               = inference.start - invoke_span.start      (clamp >= 0)
        TTFM               = inference.end   - inference.start        (clamp >= 0)
        TTFT               = inference.attributes.timeToFirstTokenMs
        MsgRem (msgRemMs)  = TTFM - TTFT                              (clamp >= 0)
        Speech Processing  = full_silence - (Orch + TTFT)            (clamp >= 0)
          (speechProcessingMs)

    Speech Processing (STT + TTS) is the single, always-available non-LLM portion of
    the customer-perceived silence: speech-to-text, VAD, routing, and text-to-speech /
    audio delivery. True per-component TTS is NOT measurable from ListSpans + Contact
    Lens (the agent segment start lags the real streaming audio start by seconds), so
    STT and TTS are reported together rather than split.

    Msg Remainder (post-first-token generation) is NOT subtracted from Speech
    Processing: it overlaps with the streaming of early audio and is not part of the
    customer-perceived wait. It is reported separately as LLM detail. The
    customer-perceived wait therefore reconciles as:
    Speech Processing + Orch + TTFT == full silence.

    Returns a list (one dict per invoke span) with keys speechProcessingMs, msgRemMs.
    Values are None when they cannot be reliably computed (missing transcript,
    missing base timestamp, no matching segment, or barge-in with negative silence).
    """
    n = len(invoke_spans)
    empty = [{} for _ in range(n)]
    if not transcript or base_timestamp_ms is None:
        return empty

    customer_segs = sorted(
        [s for s in transcript if s.get("participant") == "CUSTOMER" and s.get("endOffsetMillis") is not None],
        key=lambda s: s.get("beginOffsetMillis", 0),
    )
    agent_segs = sorted(
        [s for s in transcript if s.get("participant") in ("AGENT", "SYSTEM") and s.get("beginOffsetMillis") is not None],
        key=lambda s: s.get("beginOffsetMillis", 0),
    )

    used_agent_indices = set()

    results = []
    for i, invoke_span in enumerate(invoke_spans):
        bd = {"speechProcessingMs": None, "msgRemMs": None}

        child_infs = [s for s in inference_spans if s.get("parentSpanId") == invoke_span.get("spanId")]
        if not child_infs:
            results.append(bd)
            continue
        inf = min(child_infs, key=lambda s: _parse_ts(s.get("startTimestamp")))

        # --- Match this turn to a transcript AGENT segment ---
        # Primary: content-based. Match the inference's output text to the AGENT
        # segment with the best normalized-text similarity (each segment used once).
        # This is robust to pauses/barge-ins that break simple positional pairing.
        # Fallback: positional (the i-th customer segment).
        agent_text = _get_output_text(inf)
        agent_idx = _best_agent_segment_index(agent_text, agent_segs, used_agent_indices)

        cust_seg = None
        agent_seg = None
        matched_agent_idx = None
        if agent_idx is not None:
            agent_seg = agent_segs[agent_idx]
            matched_agent_idx = agent_idx
            # The customer segment for this turn is the last CUSTOMER segment that
            # ends before this agent segment begins.
            cust_seg = _preceding_customer_segment(agent_seg, customer_segs)
        else:
            # Fallback: positional pairing.
            if i < len(customer_segs):
                cust_seg = customer_segs[i]
                agent_seg = next(
                    (a for a in agent_segs if a["beginOffsetMillis"] > cust_seg["endOffsetMillis"]),
                    None,
                )

        if cust_seg is None or agent_seg is None:
            results.append(bd)
            continue

        # Time-proximity guard: reject pairings where the customer and the paired
        # agent segment are implausibly far apart. Turns whose inference has empty
        # output text (e.g. transfer/tool-control turns) cannot be content-matched, so
        # the positional fallback can cross-match to a distant segment (observed: a
        # transfer turn paired ~16s away, producing a nonsense TTS that actually
        # captured transfer/queue latency). If the gap exceeds the guard, this turn is
        # not a clean speech-processing pair and is left undecomposed rather than
        # attributing the routing/transfer wait to STT/TTS.
        gap_ms = agent_seg["beginOffsetMillis"] - cust_seg["endOffsetMillis"]
        if gap_ms > SEGMENT_PROXIMITY_GUARD_MS:
            print(
                f"[INFO] latency_pair_skipped_proximity | turn={i} | gap_ms={gap_ms} "
                f"| guard_ms={SEGMENT_PROXIMITY_GUARD_MS} | empty_output={not bool(agent_text)}"
            )
            results.append(bd)
            continue

        # The content match is only committed (segment marked used) once it passes the
        # proximity guard, so a rejected match doesn't consume a segment other turns need.
        if matched_agent_idx is not None:
            used_agent_indices.add(matched_agent_idx)

        # Absolute timestamps (epoch ms) on the same clock as the spans.
        customer_end = base_timestamp_ms + cust_seg["endOffsetMillis"]
        system_start = base_timestamp_ms + agent_seg["beginOffsetMillis"]

        # Barge-in / invalid silence -> cannot decompose.
        silence_ms = system_start - customer_end
        if silence_ms < 0:
            results.append(bd)
            continue

        invoke_start = _parse_ts(invoke_span.get("startTimestamp"))
        inf_start = _parse_ts(inf.get("startTimestamp"))
        inf_end = _parse_ts(inf.get("endTimestamp"))

        # TTFM: inference start -> inference END (the full LLM generation window).
        ttfm = inf_end - inf_start
        if ttfm < 0:
            ttfm = 0

        # Msg Remainder = TTFM - TTFT (clamp >= 0): all post-first-token generation.
        attrs = inf.get("attributes", {}) or {}
        ttft = attrs.get("timeToFirstTokenMs")
        msg_rem = None
        if ttft is not None:
            msg_rem = ttfm - ttft
            if msg_rem < 0:
                msg_rem = 0

        # Speech Processing (STT + TTS), reported as a SINGLE consistent metric.
        #
        # True TTS is not measurable from ListSpans + Contact Lens (the Contact Lens
        # agent-segment start lags the real streaming audio start by seconds), and a
        # per-engine baseline produced inconsistent 0/150/200ms values. Instead, we
        # report the non-LLM-response portion of the customer's silence as one bar:
        #
        #   Speech Processing = full_silence - (Orchestration + TTFT)
        #
        # Note this subtracts only Orch + TTFT (the time up to the first token), NOT
        # Msg Remainder. Msg Remainder (post-first-token generation) overlaps with the
        # streaming of early audio, so it is NOT part of the customer-perceived wait
        # and is not deducted here. As a result:
        #
        #   Customer Perceived Wait = Speech Processing + Orchestration + TTFT
        #                           = full_silence   (reconciles exactly)
        #
        # Speech Processing captures everything that is not LLM-to-first-token — STT,
        # VAD, routing, and TTS / audio delivery — derived purely from Contact Lens
        # segment timing plus the LLM span components, so it is consistent across every
        # decomposable turn.
        orch = inf_start - invoke_start
        if orch < 0:
            orch = 0
        speech_processing = silence_ms - (orch + (ttft or 0))
        if speech_processing < 0:
            speech_processing = 0

        bd["speechProcessingMs"] = int(round(speech_processing))
        bd["msgRemMs"] = int(round(msg_rem)) if msg_rem is not None else None
        results.append(bd)

    return results


_DIGIT_WORDS = {
    "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
    "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
}


def _normalize_for_match(text: str) -> str:
    """Normalize text for fuzzy span<->transcript matching.

    Beyond lowercasing and punctuation stripping, this expands spoken-form tokens so
    the model's output text pairs with the ASR transcript in verification-heavy flows:
      - digits -> words ("24684" -> "two four six eight four"), because ASR often
        transcribes spoken numbers as words while the model emits digits;
      - "@" -> "at" and "." -> "dot" between word characters (email/domain context),
        for the same reason.
    """
    if not text:
        return ""
    t = text.lower().strip()
    # Expand @ and . in email/domain context BEFORE punctuation is stripped.
    t = t.replace("@", " at ")
    t = re.sub(r"(?<=\w)\.(?=\w)", " dot ", t)
    # Expand each digit to its word form.
    t = "".join(f" {_DIGIT_WORDS[c]} " if c in _DIGIT_WORDS else c for c in t)
    # Strip remaining punctuation and collapse whitespace.
    t = re.sub(r"[^\w\s]", " ", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def _text_match_score(a: str, b: str) -> float:
    """Similarity score (0..1) between two texts based on their leading content.

    Uses the first ~40 normalized characters: 1.0 if one is a prefix of the other,
    otherwise the fraction of matching leading characters. Robust enough to pair an
    agent's transcript segment with the model's output text without heavy deps.
    """
    an = _normalize_for_match(a)[:40]
    bn = _normalize_for_match(b)[:40]
    if not an or not bn:
        return 0.0
    if an.startswith(bn) or bn.startswith(an):
        return 1.0
    common = 0
    for ca, cb in zip(an, bn):
        if ca == cb:
            common += 1
        else:
            break
    longest = max(len(an), len(bn))
    return common / longest if longest else 0.0


def _best_agent_segment_index(agent_text, agent_segs, used_indices, threshold=0.4):
    """Return the index of the AGENT segment best matching agent_text, or None.

    Skips segments already matched to an earlier turn. Requires the score to meet
    the threshold so a poor match falls back to positional pairing instead.
    """
    if not agent_text:
        return None
    best_idx = None
    best_score = 0.0
    for idx, seg in enumerate(agent_segs):
        if idx in used_indices:
            continue
        score = _text_match_score(agent_text, seg.get("content", ""))
        if score > best_score:
            best_score = score
            best_idx = idx
    return best_idx if best_score >= threshold else None


def _preceding_customer_segment(agent_seg, customer_segs):
    """Return the last CUSTOMER segment that ends before this agent segment begins."""
    prev = None
    for c in customer_segs:
        if c["endOffsetMillis"] <= agent_seg["beginOffsetMillis"]:
            prev = c
        else:
            break
    return prev


def _first_output_timestamp(inference_span):
    """Return the epoch-ms timestamp of the first ASSISTANT output message, or None."""
    attrs = inference_span.get("attributes", {}) or {}
    for msg in attrs.get("outputMessages", []) or []:
        if not isinstance(msg, dict):
            continue
        participant = str(msg.get("participant", "")).upper()
        if participant in ("BOT", "ASSISTANT", "AGENT", ""):
            ts = msg.get("timestamp")
            if ts is not None:
                parsed = _parse_ts(ts)
                if parsed:
                    return parsed
    return None


def _categorize_turns(invoke_spans, inference_spans, tool_spans, transcript, all_spans=None, is_redacted=False):
    """Categorize each turn: normal, pause, barge_in, tool, pii_input, no_cl_match.

    is_redacted: when True, PII-mismatch detection is skipped because the transcript
    content is masked and any comparison would be meaningless or misleading.
    """
    if not transcript:
        return [{"category": "no_cl_match", "flags": ["No Contact Lens data"]} for _ in invoke_spans]

    customer_segs = sorted(
        [s for s in transcript if s.get("participant") == "CUSTOMER" and s.get("endOffsetMillis") is not None],
        key=lambda s: s.get("beginOffsetMillis", 0),
    )
    agent_segs = sorted(
        [s for s in transcript if s.get("participant") in ("AGENT", "SYSTEM") and s.get("beginOffsetMillis") is not None],
        key=lambda s: s.get("beginOffsetMillis", 0),
    )

    categories = []
    for i, invoke_span in enumerate(invoke_spans):
        cat = {"category": "normal", "flags": [], "piiMismatch": None}

        if i >= len(customer_segs):
            cat["category"] = "no_cl_match"
            cat["flags"].append("No CL segment")
            categories.append(cat)
            continue

        cust_seg = customer_segs[i]
        child_tools = [t for t in tool_spans if t.get("parentSpanId") == invoke_span.get("spanId")]
        child_infs = [s for s in inference_spans if s.get("parentSpanId") == invoke_span.get("spanId")]

        # Barge-in detection
        prev_agent_seg = None
        for a in agent_segs:
            if a["beginOffsetMillis"] < cust_seg["beginOffsetMillis"]:
                prev_agent_seg = a
            else:
                break

        is_customer_barge_in = (
            prev_agent_seg is not None
            and prev_agent_seg.get("endOffsetMillis", 0) > cust_seg["beginOffsetMillis"]
        )
        is_agent_barge_in = any(
            a["beginOffsetMillis"] > cust_seg["beginOffsetMillis"]
            and a["beginOffsetMillis"] < cust_seg["endOffsetMillis"]
            for a in agent_segs
        )

        # Think-time / pause detection (>3s gap before customer spoke)
        is_pause = (
            not is_customer_barge_in
            and prev_agent_seg is not None
            and (cust_seg["beginOffsetMillis"] - prev_agent_seg.get("endOffsetMillis", 0)) > 5000
        )

        # Categorize
        if is_customer_barge_in:
            cat["category"] = "customer_barge_in"
            cat["flags"].append("Customer interrupted agent")
        elif is_agent_barge_in:
            cat["category"] = "agent_barge_in"
            cat["flags"].append("Agent interrupted customer")
        elif is_pause:
            pause_ms = cust_seg["beginOffsetMillis"] - prev_agent_seg.get("endOffsetMillis", 0)
            cat["category"] = "customer_pause"
            cat["flags"].append(f"Customer paused {pause_ms}ms before speaking")
        elif len(child_tools) > 0:
            cat["category"] = "tool_invocation"
            cat["flags"].append(f"Tool: {_extract_tool_names(child_tools, all_spans)}")

        # PII mismatch detection (using ListSpans inputMessages vs outputMessages).
        # Skipped for redacted transcripts, where PII is masked and a comparison would
        # be meaningless. Wrapped in try/except so a detection error never fails the turn.
        if child_infs and not is_redacted:
            try:
                customer_text = _get_input_text(child_infs[0])
                agent_output_text = _get_output_text(child_infs[0])
                if customer_text and agent_output_text:
                    mismatch = _detect_pii_mismatch(customer_text, agent_output_text)
                    if mismatch:
                        cat["piiMismatch"] = mismatch
                        cat["flags"].append(f"PII mismatch: {mismatch['type']}")
            except Exception as e:
                print(f"[WARN] pii_mismatch_detection_failed | turn={i} | error={e}")

        categories.append(cat)

    return categories


def _get_input_text(inference_span) -> str:
    """Extract the customer's input text from an inference span's inputMessages."""
    attrs = inference_span.get("attributes", {}) or {}
    messages = attrs.get("inputMessages", [])
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict):
                # Only look at CUSTOMER participant messages
                if msg.get("participant", "").upper() == "CUSTOMER":
                    values = msg.get("values", [])
                    for val in values:
                        if isinstance(val, dict) and "text" in val:
                            text_obj = val["text"]
                            if isinstance(text_obj, dict):
                                return text_obj.get("value", "")
                            return str(text_obj)
    return ""


def _get_output_text(inference_span) -> str:
    """Extract the agent's output text from an inference span's outputMessages."""
    attrs = inference_span.get("attributes", {}) or {}
    messages = attrs.get("outputMessages", [])
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict):
                values = msg.get("values", [])
                for val in values:
                    if isinstance(val, dict) and "text" in val:
                        text_obj = val["text"]
                        if isinstance(text_obj, dict):
                            return text_obj.get("value", "")
                        return str(text_obj)
    return ""


def _detect_pii_mismatch(customer_text: str, agent_text: str) -> dict:
    """Detect if PII in customer input doesn't match what the agent echoed back.
    
    Uses ListSpans data only: compares inputMessages (customer speech as captured by STT)
    against outputMessages (agent's response). Detects mismatches in emails, phone numbers,
    account numbers, and spelled-out text.
    Returns mismatch details or None.

    IMPORTANT — Data Privacy Notice:
    This function extracts and returns actual PII values (emails, phone numbers, account
    numbers) from customer speech. These values are stored in DynamoDB records. Deployers
    handling regulated data (e.g., HIPAA, GDPR, PCI-DSS, CCPA) must apply appropriate
    controls including access restrictions, encryption, data retention policies, and audit
    logging. See the AWS Shared Responsibility Model for guidance.
    """
    import re

    if not customer_text or not agent_text:
        return None

    customer_lower = customer_text.lower()
    agent_lower = agent_text.lower()

    # Email detection
    email_pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
    customer_emails = re.findall(email_pattern, customer_text.lower())
    if customer_emails:
        agent_emails = re.findall(email_pattern, agent_lower)
        for ce in customer_emails:
            if ce not in agent_lower and not any(ce in ae for ae in agent_emails):
                # Check if agent mentioned an email that's different
                if agent_emails:
                    return {"type": "email", "customer": ce, "agent": agent_emails[0]}

    # Phone number detection (sequences of 6+ digits, possibly with spaces/dashes)
    phone_pattern = r'[\d\s\-]{7,}'
    customer_phones = re.findall(phone_pattern, customer_text)
    customer_digits = [''.join(c for c in p if c.isdigit()) for p in customer_phones if len(''.join(c for c in p if c.isdigit())) >= 6]
    if customer_digits:
        agent_digits_raw = re.findall(phone_pattern, agent_text)
        agent_digits = [''.join(c for c in p if c.isdigit()) for p in agent_digits_raw if len(''.join(c for c in p if c.isdigit())) >= 6]
        for cd in customer_digits:
            if not any(cd in ad or ad in cd for ad in agent_digits):
                if agent_digits:
                    return {"type": "phone/account", "customer": cd, "agent": agent_digits[0]}

    # Spelling detection (word-by-word spelled out like "d-i-l-i-n-j-o")
    # If customer spelled something and agent repeated differently
    spell_pattern = r'(?:[a-zA-Z][\s\-,]+){3,}[a-zA-Z]'
    customer_spelled = re.findall(spell_pattern, customer_text)
    if customer_spelled:
        spelled_word = ''.join(c for c in customer_spelled[0] if c.isalpha())
        if spelled_word and spelled_word.lower() not in agent_lower:
            return {"type": "spelling", "customer": spelled_word, "agent": "(not echoed correctly)"}

    return None


def _get_customer_wait(turn_idx, transcript):
    """Get customer wait time (silence between customer stop and agent start) for a turn."""
    if not transcript:
        return None
    customer_segs = sorted(
        [s for s in transcript if s.get("participant") == "CUSTOMER" and s.get("endOffsetMillis") is not None],
        key=lambda s: s.get("beginOffsetMillis", 0),
    )
    agent_segs = sorted(
        [s for s in transcript if s.get("participant") in ("AGENT", "SYSTEM") and s.get("beginOffsetMillis") is not None],
        key=lambda s: s.get("beginOffsetMillis", 0),
    )
    if turn_idx >= len(customer_segs):
        return None
    cust_seg = customer_segs[turn_idx]
    agent_seg = next((a for a in agent_segs if a["beginOffsetMillis"] > cust_seg["endOffsetMillis"]), None)
    if not agent_seg:
        return None
    return agent_seg["beginOffsetMillis"] - cust_seg["endOffsetMillis"]


def _compute_turn_breakdown(invoke_span, inference_spans):
    """Compute orchestration, TTFT, remainder breakdown for a turn."""
    child_infs = [s for s in inference_spans if s.get("parentSpanId") == invoke_span.get("spanId")]
    if not child_infs:
        return None
    first_inf = child_infs[0]
    orch_ms = _parse_ts(first_inf.get("startTimestamp")) - _parse_ts(invoke_span.get("startTimestamp"))
    ttft_ms = _get_attr(first_inf, "timeToFirstTokenMs", 0)
    inf_dur = _span_duration_ms(first_inf)
    rem_ms = max(0, inf_dur - ttft_ms) if ttft_ms > 0 else 0
    return {"orchMs": orch_ms, "ttftMs": ttft_ms, "remMs": rem_ms, "orchPlusTtft": orch_ms + ttft_ms}


def _get_tool_type(span, all_spans=None):
    """Classify tool as first-party (internal/control) or third-party (external).
    
    Uses 3 strategies:
    1. Check span type (INTERNAL = first-party)
    2. Check tool name against known first-party names
    3. Analyze tool arguments for control/routing patterns
    """
    # Strategy 1: Check span type
    if span.get("spanType") == "INTERNAL":
        return "first-party"

    # Check for sibling INTERNAL span under same parent
    if all_spans and span.get("parentSpanId"):
        has_internal_sibling = any(
            s.get("parentSpanId") == span.get("parentSpanId")
            and s.get("spanType") == "INTERNAL"
            and s.get("spanId") != span.get("spanId")
            for s in all_spans
        )
        if has_internal_sibling:
            return "first-party"

    # Strategy 2: Check tool name
    tool_name = _get_tool_name_from_messages(span)
    if tool_name:
        normalized = tool_name.lower().replace("-", "").replace(" ", "")
        if normalized in FIRST_PARTY_TOOL_NAMES:
            return "first-party"
        # Check prefixes
        if tool_name.startswith("AGENT::") or tool_name.startswith("agent::"):
            return "first-party"
        if tool_name.startswith("Connect_") or tool_name.startswith("connect_"):
            return "first-party"

    # Strategy 3: Analyze tool arguments
    tool_args = _get_tool_arguments(span)
    if tool_args and isinstance(tool_args, dict):
        arg_keys = {k.lower() for k in tool_args.keys()}

        # Check if argument keys match known 1st-party patterns
        has_control_key = bool(arg_keys & FIRST_PARTY_ARG_KEYS)

        if has_control_key and len(arg_keys) <= 3:
            # Verify by checking value content
            all_values = " ".join(str(v) for v in tool_args.values())
            matches = sum(1 for p in FIRST_PARTY_VALUE_PATTERNS if p.search(all_values))
            if matches > 0:
                return "first-party"

        # Even without matching keys, check all values for strong signals
        all_values = " ".join(str(v) for v in tool_args.values())
        strong_matches = sum(1 for p in FIRST_PARTY_VALUE_PATTERNS if p.search(all_values))
        if strong_matches >= 2:
            return "first-party"
        if strong_matches >= 1 and len(arg_keys) <= 2:
            return "first-party"

    return "third-party"


def _get_tool_arguments(span) -> dict:
    """Extract tool arguments from inputMessages."""
    attrs = span.get("attributes", {}) or {}
    messages = attrs.get("inputMessages", [])
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict):
                values = msg.get("values", [])
                for val in values:
                    if isinstance(val, dict) and "toolUse" in val:
                        args_str = val["toolUse"].get("arguments", "")
                        if isinstance(args_str, str):
                            try:
                                import json
                                return json.loads(args_str)
                            except (json.JSONDecodeError, TypeError):
                                pass
                        elif isinstance(args_str, dict):
                            return args_str
    return {}


def _extract_tool_names(tool_spans: list, all_spans: list = None) -> list:
    """Extract tool names and types from execute_tool spans."""
    names = []
    for span in tool_spans:
        attrs = span.get("attributes", {}) or {}
        name = attrs.get("toolName", "")
        if not name:
            name = _get_tool_name_from_messages(span)
        tool_type = _get_tool_type(span, all_spans)
        names.append({"name": name or "Unknown", "type": tool_type})
    return names


def _get_tool_name_from_messages(span) -> str:
    """Extract tool name from inputMessages[].values[].toolUse.name."""
    attrs = span.get("attributes", {}) or {}
    messages = attrs.get("inputMessages", [])
    if isinstance(messages, list):
        for msg in messages:
            values = msg.get("values", []) if isinstance(msg, dict) else []
            for val in values:
                if isinstance(val, dict) and "toolUse" in val:
                    return val["toolUse"].get("name", "")
    return ""


def _get_attr(span, key, default=0):
    """Safely get an attribute from a span."""
    attrs = span.get("attributes", {}) or {}
    val = attrs.get(key)
    return val if val is not None else default


def _span_duration_ms(span) -> int:
    if not span:
        return 0
    start = _parse_ts(span.get("startTimestamp", ""))
    end = _parse_ts(span.get("endTimestamp", ""))
    return max(0, end - start)


def _parse_ts(ts) -> int:
    """Parse a timestamp string or datetime to epoch milliseconds."""
    if not ts:
        return 0
    if isinstance(ts, datetime):
        return int(ts.timestamp() * 1000)
    if isinstance(ts, (int, float)):
        return int(ts * 1000) if ts < 1e12 else int(ts)
    try:
        ts_str = str(ts).replace("Z", "+00:00")
        dt = datetime.fromisoformat(ts_str)
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return 0


def _avg(values):
    values = [v for v in values if v is not None]
    return round(sum(values) / len(values)) if values else 0


def _max(values):
    values = [v for v in values if v is not None]
    return max(values) if values else 0


def _avg_key(items, key):
    values = [item[key] for item in items if item.get(key) is not None]
    return round(sum(values) / len(values)) if values else 0


def _max_key(items, key):
    values = [item[key] for item in items if item.get(key) is not None]
    return max(values) if values else 0
