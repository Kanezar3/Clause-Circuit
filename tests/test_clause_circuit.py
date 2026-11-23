import hashlib
import json
from pathlib import Path
import pytest

from contracts.clause_circuit import (
    ClauseCircuit,
    MAX_ATOMS,
    MAX_ATOM_ATTEMPTS,
    MAX_EVIDENCE_BYTES,
    MAX_NODES,
    enforce_atom_verdict_compatibility,
    evaluate_kleene_circuit,
    evaluate_kleene_gate,
    is_compatible_atom_verdict_reason,
    is_valid_evidence_url,
    validate_and_toposort_circuit,
    validate_atom_leader_response,
)
from conftest import (
    ADDR_ATTACKER,
    ADDR_BENEFICIARY,
    ADDR_SOLVER,
    ADDR_SPONSOR,
    MockWebResponse,
    UserError,
    emitted_transfers,
    gl_mock,
    mock_llm_responses,
    mock_web_responses,
    set_sender,
    set_time,
    set_value,
)

EVIDENCE_DIR = Path(__file__).resolve().parent.parent / "evidence"
COMMIT_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
BASE_URL = f"https://raw.githubusercontent.com/Kanezar3/Clause-Circuit/{COMMIT_SHA}/evidence"

FILES = {
    "atom_eu_antitrust": "atom_eu_antitrust.json",
    "atom_us_cfius": "atom_us_cfius.json",
    "atom_uk_cma": "atom_uk_cma.json",
    "atom_bank_debt": "atom_bank_debt.json",
    "atom_bridge_equity": "atom_bridge_equity.json",
    "atom_injunction": "atom_injunction.json",
}

CLAIMS = {
    "atom_eu_antitrust": "The European Commission unconditionally granted Phase I merger clearance for the acquisition.",
    "atom_us_cfius": "CFIUS unconditionally cleared the acquisition with no unresolved mitigation conditions.",
    "atom_uk_cma": "The UK CMA unconditionally cleared the proposed acquisition without Phase 2 referral.",
    "atom_bank_debt": "The senior syndicated bank debt commitment letter remains active and available to fund closing.",
    "atom_bridge_equity": "The sovereign bridge equity facility is executed and unconditionally committed to fund closing.",
    "atom_injunction": "An active court injunction currently bars closing of the acquisition.",
}


def _sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def setup_ma_fixtures() -> dict[str, dict]:
    out = {}
    for key, fname in FILES.items():
        raw = (EVIDENCE_DIR / fname).read_bytes()
        assert b"\r\n" not in raw, f"{fname} must use LF line endings"
        assert 1 <= len(raw) <= MAX_EVIDENCE_BYTES
        url = f"{BASE_URL}/{fname}"
        mock_web_responses[url] = MockWebResponse(status=200, body=raw)
        out[key] = {"url": url, "hash": _sha256_hex(raw), "bytes": raw}
    return out


def setup_ma_llm():
    def handler(prompt: str) -> dict:
        if "EC-M-2026-11402" in prompt:
            return {"verdict": "TRUE", "reason": "CLAIM_VERIFIED"}
        if "CFIUS-2026-08914" in prompt:
            return {"verdict": "FALSE", "reason": "CLAIM_CONTRADICTED"}
        if "CMA-ME-2026-7118" in prompt:
            return {"verdict": "TRUE", "reason": "CLAIM_VERIFIED"}
        if "SYND-DEBT-2026-441" in prompt:
            return {"verdict": "FALSE", "reason": "CLAIM_CONTRADICTED"}
        if "BRIDGE-EQ-2026-908" in prompt:
            return {"verdict": "TRUE", "reason": "CLAIM_VERIFIED"}
        if "CA-2026-1192-DEL" in prompt:
            return {"verdict": "FALSE", "reason": "CLAIM_CONTRADICTED"}
        return {"verdict": "UNKNOWN", "reason": "FETCH_OR_PARSE_FAILURE"}

    mock_llm_responses.append(handler)


def assert_conservation(contract: ClauseCircuit):
    acct = json.loads(contract.get_accounting_summary())
    assert acct["conservation_ok"] is True
    assert acct["escrow_amount"] == (
        acct["locked_escrow"]
        + acct["total_pending_payouts"]
        + acct["total_withdrawn"]
    )


def build_ma_circuit(contract: ClauseCircuit, fx: dict[str, dict], escrow: int = 1000):
    set_sender(ADDR_SPONSOR)
    set_value(escrow)
    assert contract.open_circuit(str(ADDR_BENEFICIARY), escrow, 3600) == f"CIRCUIT_OPENED:ESCROW_{escrow}"
    set_value(0)

    for key in FILES:
        assert contract.add_atom(key, CLAIMS[key], fx[key]["url"], fx[key]["hash"]) == f"ATOM_ADDED:{key}"

    assert contract.add_gate("gate_reg_quorum", "K_OF_N", ["atom_eu_antitrust", "atom_us_cfius", "atom_uk_cma"], 2) == "GATE_ADDED:gate_reg_quorum:K_OF_N"
    assert contract.add_gate("gate_financing", "OR", ["atom_bank_debt", "atom_bridge_equity"], 0) == "GATE_ADDED:gate_financing:OR"
    assert contract.add_gate("gate_no_injunction", "NOT", ["atom_injunction"], 0) == "GATE_ADDED:gate_no_injunction:NOT"
    assert contract.add_gate("root", "AND", ["gate_reg_quorum", "gate_financing", "gate_no_injunction"], 0) == "GATE_ADDED:root:AND"
    assert contract.freeze_circuit("root") == "CIRCUIT_FROZEN:root:NODES_10"


# =============================================================================
# 1. Happy-Path M&A Kleene 3-Valued Predicate Circuit + Native Payout
# =============================================================================
def test_ma_closing_circuit_happy_path_k3_and_native_payout():
    fx = setup_ma_fixtures()
    setup_ma_llm()

    contract = ClauseCircuit()
    build_ma_circuit(contract, fx, escrow=1000)
    assert_conservation(contract)

    # Evaluate K_OF_N (2 of 3): TRUE, FALSE, TRUE -> gate_reg_quorum == TRUE
    set_sender(ADDR_SOLVER)
    assert contract.evaluate_atom("atom_eu_antitrust") == "ATOM_CONCLUDED:atom_eu_antitrust:TRUE:CLAIM_VERIFIED"
    assert contract.evaluate_atom("atom_us_cfius") == "ATOM_CONCLUDED:atom_us_cfius:FALSE:CLAIM_CONTRADICTED"
    assert contract.evaluate_atom("atom_uk_cma") == "ATOM_CONCLUDED:atom_uk_cma:TRUE:CLAIM_VERIFIED"

    # Evaluate OR: FALSE, TRUE -> gate_financing == TRUE
    assert contract.evaluate_atom("atom_bank_debt") == "ATOM_CONCLUDED:atom_bank_debt:FALSE:CLAIM_CONTRADICTED"
    assert contract.evaluate_atom("atom_bridge_equity") == "ATOM_CONCLUDED:atom_bridge_equity:TRUE:CLAIM_VERIFIED"

    # Fail-closed NOT(UNKNOWN) == UNKNOWN: settle_circuit MUST revert before atom_injunction is evaluated
    view_before = json.loads(contract.evaluate_circuit_view())
    assert view_before["node_values"]["gate_reg_quorum"] == "TRUE"
    assert view_before["node_values"]["gate_financing"] == "TRUE"
    assert view_before["node_values"]["gate_no_injunction"] == "UNKNOWN"
    assert view_before["root_value"] == "UNKNOWN"

    with pytest.raises(UserError, match="CIRCUIT_STILL_UNDETERMINED"):
        contract.settle_circuit()

    # Now evaluate atom_injunction -> FALSE => NOT(FALSE) == TRUE => root == TRUE
    assert contract.evaluate_atom("atom_injunction") == "ATOM_CONCLUDED:atom_injunction:FALSE:CLAIM_CONTRADICTED"
    view_after = json.loads(contract.evaluate_circuit_view())
    assert view_after["node_values"]["gate_no_injunction"] == "TRUE"
    assert view_after["root_value"] == "TRUE"

    # Permissionless settlement releases 1000 wei to beneficiary
    assert contract.settle_circuit() == "SETTLED:RELEASED_TO_BENEFICIARY:AMOUNT_1000"
    assert_conservation(contract)

    # Replay settlement blocked
    with pytest.raises(UserError, match="CIRCUIT_ALREADY_SETTLED"):
        contract.settle_circuit()

    # Beneficiary withdraws real native wei via _EoaRecipient.emit_transfer
    assert contract.get_pending_payout(str(ADDR_BENEFICIARY)) == 1000
    set_sender(ADDR_BENEFICIARY)
    assert contract.withdraw_payout() == 1000
    assert contract.get_pending_payout(str(ADDR_BENEFICIARY)) == 0
    assert emitted_transfers == [{"to": str(ADDR_BENEFICIARY), "value": 1000}]
    assert_conservation(contract)

    # Second withdrawal blocked
    with pytest.raises(UserError, match="NO_PENDING_PAYOUT"):
        contract.withdraw_payout()


# =============================================================================
# 2. Short-Circuit Falsification (Root == FALSE while other atoms stay UNKNOWN)
# =============================================================================
def test_short_circuit_falsification_refunds_sponsor():
    fx = setup_ma_fixtures()

    def falsifying_llm(prompt: str) -> dict:
        if "CA-2026-1192-DEL" in prompt:
            # Suppose injunction IS active -> TRUE => NOT(TRUE) == FALSE => root AND == FALSE immediately!
            return {"verdict": "TRUE", "reason": "CLAIM_VERIFIED"}
        return {"verdict": "UNKNOWN", "reason": "FETCH_OR_PARSE_FAILURE"}

    mock_llm_responses.append(falsifying_llm)

    contract = ClauseCircuit()
    build_ma_circuit(contract, fx, escrow=1000)

    # Only evaluate atom_injunction (other 5 atoms remain UNKNOWN!)
    set_sender(ADDR_SOLVER)
    assert contract.evaluate_atom("atom_injunction") == "ATOM_CONCLUDED:atom_injunction:TRUE:CLAIM_VERIFIED"

    view = json.loads(contract.evaluate_circuit_view())
    assert view["node_values"]["gate_no_injunction"] == "FALSE"
    assert view["node_values"]["gate_reg_quorum"] == "UNKNOWN"
    assert view["root_value"] == "FALSE"

    # Short-circuit settlement refunds 1000 wei to Sponsor immediately
    assert contract.settle_circuit() == "SETTLED:REFUNDED_TO_SPONSOR:AMOUNT_1000"
    assert contract.get_pending_payout(str(ADDR_SPONSOR)) == 1000
    assert_conservation(contract)

    set_sender(ADDR_SPONSOR)
    assert contract.withdraw_payout() == 1000
    assert emitted_transfers == [{"to": str(ADDR_SPONSOR), "value": 1000}]
    assert_conservation(contract)


# =============================================================================
# 3. Adversarial Leader Tests (Direct Validator + On-Chain Consensus Rejection)
# =============================================================================
def test_adversarial_leader_direct_and_on_chain_rejection():
    valid = {
        "evidence_digest": "a" * 64,
        "expected_hash": "a" * 64,
        "node_id": "atom_eu_antitrust",
        "reason": "CLAIM_VERIFIED",
        "verdict": "TRUE",
    }
    assert validate_atom_leader_response(valid, valid) is True

    # Same headline verdict ("TRUE") with forged reason / digest / expected_hash / node_id
    for field, bad_val in [
        ("reason", "CLAIM_CONTRADICTED"),
        ("evidence_digest", "b" * 64),
        ("expected_hash", "c" * 64),
        ("node_id", "atom_uk_cma"),
        ("verdict", "FALSE"),
    ]:
        tampered = dict(valid)
        tampered[field] = bad_val
        assert validate_atom_leader_response(tampered, valid) is False

    # Extra key, missing key, non-dict, incompatible pair even if both match
    extra = dict(valid)
    extra["injected"] = "evil"
    assert validate_atom_leader_response(extra, valid) is False

    missing = dict(valid)
    del missing["reason"]
    assert validate_atom_leader_response(missing, valid) is False

    assert validate_atom_leader_response("not_a_dict", valid) is False
    assert validate_atom_leader_response(None, valid) is False

    incompat = dict(valid)
    incompat["verdict"] = "FALSE"
    incompat["reason"] = "CLAIM_VERIFIED"
    assert validate_atom_leader_response(incompat, incompat) is False

    # On-chain Byzantine leader tampering reverts with CONSENSUS_VALIDATION_FAILED
    fx = setup_ma_fixtures()
    setup_ma_llm()
    contract = ClauseCircuit()
    build_ma_circuit(contract, fx, escrow=500)

    def byzantine_tamper(res: dict) -> dict:
        bad = dict(res)
        bad["evidence_digest"] = "0" * 64
        return bad

    gl_mock.adversarial_leader_fn = byzantine_tamper
    with pytest.raises(UserError, match="CONSENSUS_VALIDATION_FAILED"):
        contract.evaluate_atom("atom_eu_antitrust")


# =============================================================================
# 4. Verdict/Reason Compatibility Table & Kleene Gate Truth Tables
# =============================================================================
def test_compatibility_table_and_kleene_truth_tables():
    assert is_compatible_atom_verdict_reason("TRUE", "CLAIM_VERIFIED") is True
    assert is_compatible_atom_verdict_reason("FALSE", "CLAIM_CONTRADICTED") is True
    assert is_compatible_atom_verdict_reason("UNKNOWN", "FETCH_OR_PARSE_FAILURE") is True
    assert is_compatible_atom_verdict_reason("UNKNOWN", "HASH_MISMATCH") is True

    # Invalid cross-pairs
    for v, r in [
        ("TRUE", "CLAIM_CONTRADICTED"),
        ("TRUE", "FETCH_OR_PARSE_FAILURE"),
        ("FALSE", "CLAIM_VERIFIED"),
        ("FALSE", "HASH_MISMATCH"),
        ("UNKNOWN", "CLAIM_VERIFIED"),
        ("UNKNOWN", "CLAIM_CONTRADICTED"),
        ("APPROVED", "CLAIM_VERIFIED"),
        (True, "CLAIM_VERIFIED"),
    ]:
        assert is_compatible_atom_verdict_reason(v, r) is False

    # Deterministic coercion
    assert enforce_atom_verdict_compatibility("TRUE", "CLAIM_VERIFIED") == ("TRUE", "CLAIM_VERIFIED")
    assert enforce_atom_verdict_compatibility("TRUE", "CLAIM_CONTRADICTED") == ("FALSE", "CLAIM_CONTRADICTED")
    assert enforce_atom_verdict_compatibility("TRUE", "HASH_MISMATCH") == ("UNKNOWN", "FETCH_OR_PARSE_FAILURE")
    assert enforce_atom_verdict_compatibility("FALSE", "CLAIM_VERIFIED") == ("UNKNOWN", "FETCH_OR_PARSE_FAILURE")
    assert enforce_atom_verdict_compatibility("UNKNOWN", "CLAIM_VERIFIED") == ("UNKNOWN", "FETCH_OR_PARSE_FAILURE")
    assert enforce_atom_verdict_compatibility("HALLUCINATED", "BOGUS") == ("UNKNOWN", "FETCH_OR_PARSE_FAILURE")

    # Kleene K_OF_N short-circuit truth table
    assert evaluate_kleene_gate("K_OF_N", ["TRUE", "TRUE", "UNKNOWN"], 2) == "TRUE"
    assert evaluate_kleene_gate("K_OF_N", ["FALSE", "FALSE", "UNKNOWN"], 2) == "FALSE"
    assert evaluate_kleene_gate("K_OF_N", ["TRUE", "FALSE", "UNKNOWN"], 2) == "UNKNOWN"
    assert evaluate_kleene_gate("NOT", ["UNKNOWN"]) == "UNKNOWN"
    assert evaluate_kleene_gate("NOT", ["FALSE"]) == "TRUE"
    assert evaluate_kleene_gate("NOT", ["TRUE"]) == "FALSE"


# =============================================================================
# 5. Transient UNKNOWN Retry Lifecycle & Conclusive Immutability
# =============================================================================
def test_transient_unknown_retry_and_conclusive_immutability():
    fx = setup_ma_fixtures()
    setup_ma_llm()
    contract = ClauseCircuit()
    build_ma_circuit(contract, fx, escrow=1000)

    # Attempt 1: transient HTTP 503 -> UNKNOWN (retriable!)
    eu_url = fx["atom_eu_antitrust"]["url"]
    mock_web_responses[eu_url] = MockWebResponse(status=503, body=b"Service Unavailable")
    assert contract.evaluate_atom("atom_eu_antitrust") == "ATOM_UNKNOWN:atom_eu_antitrust:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    node1 = json.loads(contract.get_node("atom_eu_antitrust"))
    assert node1["attempts"] == 1
    assert node1["verdict"] == "UNKNOWN"

    # Attempt 2: endpoint recovers -> concludes TRUE
    mock_web_responses[eu_url] = MockWebResponse(status=200, body=fx["atom_eu_antitrust"]["bytes"])
    assert contract.evaluate_atom("atom_eu_antitrust") == "ATOM_CONCLUDED:atom_eu_antitrust:TRUE:CLAIM_VERIFIED"
    node2 = json.loads(contract.get_node("atom_eu_antitrust"))
    assert node2["attempts"] == 2
    assert node2["verdict"] == "TRUE"

    # Attempt 3: conclusive TRUE is strictly immutable
    with pytest.raises(UserError, match="ATOM_ALREADY_CONCLUDED"):
        contract.evaluate_atom("atom_eu_antitrust")

    # Conclusive FALSE is strictly immutable
    assert contract.evaluate_atom("atom_us_cfius") == "ATOM_CONCLUDED:atom_us_cfius:FALSE:CLAIM_CONTRADICTED"
    with pytest.raises(UserError, match="ATOM_ALREADY_CONCLUDED"):
        contract.evaluate_atom("atom_us_cfius")

    # 5 consecutive UNKNOWN attempts cap out -> 6th raises MAX_ATOM_RETRIES_EXCEEDED
    uk_url = fx["atom_uk_cma"]["url"]
    mock_web_responses[uk_url] = MockWebResponse(status=503, body=b"Down")
    for i in range(1, MAX_ATOM_ATTEMPTS + 1):
        assert contract.evaluate_atom("atom_uk_cma") == f"ATOM_UNKNOWN:atom_uk_cma:FETCH_OR_PARSE_FAILURE:ATTEMPT_{i}"
    with pytest.raises(UserError, match="MAX_ATOM_RETRIES_EXCEEDED"):
        contract.evaluate_atom("atom_uk_cma")


# =============================================================================
# 6. DAG Acyclicity, Dangling Refs, Unauthorized Callers, Payable & Expiry
# =============================================================================
def test_dag_validation_unauthorized_payable_and_expiry():
    fx = setup_ma_fixtures()
    contract = ClauseCircuit()

    # Unauthorized non-sponsor open_circuit
    set_sender(ADDR_ATTACKER)
    set_value(100)
    with pytest.raises(UserError, match="UNAUTHORIZED_CALLER"):
        contract.open_circuit(str(ADDR_BENEFICIARY), 100, 3600)

    # Value mismatch & beneficiary == sponsor
    set_sender(ADDR_SPONSOR)
    set_value(99)
    with pytest.raises(UserError, match="ESCROW_VALUE_MISMATCH"):
        contract.open_circuit(str(ADDR_BENEFICIARY), 100, 3600)
    set_value(100)
    with pytest.raises(UserError, match="BENEFICIARY_CANNOT_BE_SPONSOR"):
        contract.open_circuit(str(ADDR_SPONSOR), 100, 3600)

    # Open cleanly
    assert contract.open_circuit(str(ADDR_BENEFICIARY), 100, 3600) == "CIRCUIT_OPENED:ESCROW_100"
    set_value(0)

    # Unauthorized add_atom
    set_sender(ADDR_ATTACKER)
    with pytest.raises(UserError, match="UNAUTHORIZED_CALLER"):
        contract.add_atom("a1", "Claim", fx["atom_eu_antitrust"]["url"], fx["atom_eu_antitrust"]["hash"])

    set_sender(ADDR_SPONSOR)
    contract.add_atom("a1", "Claim 1", fx["atom_eu_antitrust"]["url"], fx["atom_eu_antitrust"]["hash"])

    # Atom-only circuit without composite gate fails freeze
    with pytest.raises(UserError, match="NO_COMPOSITE_GATE"):
        contract.freeze_circuit("a1")

    # Invalid gate arity, self-ref, duplicate child
    with pytest.raises(UserError, match="SELF_REFERENCE_NOT_ALLOWED"):
        contract.add_gate("g_self", "NOT", ["g_self"], 0)
    with pytest.raises(UserError, match="DUPLICATE_CHILD_REF"):
        contract.add_gate("g_dup", "AND", ["a1", "a1"], 0)
    with pytest.raises(UserError, match="INVALID_GATE_ARITY"):
        contract.add_gate("g_bad_not", "NOT", ["a1", "a2"], 0)
    with pytest.raises(UserError, match="INVALID_K_OF_N_THRESHOLD"):
        contract.add_gate("g_bad_k", "K_OF_N", ["a1", "a2"], 3)

    # Cycle detection at freeze_circuit: g1 -> g2 -> g1
    contract.add_gate("g1", "OR", ["a1", "g2"], 0)
    contract.add_gate("g2", "NOT", ["g1"], 0)
    with pytest.raises(UserError, match="CYCLE_DETECTED"):
        contract.freeze_circuit("g1")

    # Dangling child ref at freeze_circuit
    contract.add_gate("g_dang", "NOT", ["missing_node"], 0)
    with pytest.raises(UserError, match="DANGLING_CHILD_REF"):
        contract.freeze_circuit("g_dang")

    # Premature expire_circuit blocked
    with pytest.raises(UserError, match="CIRCUIT_STILL_ACTIVE"):
        contract.expire_circuit()

    # NO_BLOCK_TIME fails closed
    set_time(None)
    with pytest.raises(UserError, match="NO_BLOCK_TIME"):
        contract.expire_circuit()

    # Permissionless post-deadline expiry refunds 100% to Sponsor
    set_time(1795000000 + 3601)
    set_sender(ADDR_ATTACKER)
    assert contract.expire_circuit() == "EXPIRED_REFUNDED:AMOUNT_100"
    assert contract.get_pending_payout(str(ADDR_SPONSOR)) == 100
    assert_conservation(contract)

    set_sender(ADDR_SPONSOR)
    assert contract.withdraw_payout() == 100
    assert emitted_transfers == [{"to": str(ADDR_SPONSOR), "value": 100}]
    assert_conservation(contract)


# =============================================================================
# 7. Fail-Closed Evidence Processing (Non-200, Empty, Oversized, Bad UTF-8, Hash)
# =============================================================================
def test_fail_closed_evidence_and_url_allowlist():
    fx = setup_ma_fixtures()
    contract = ClauseCircuit()
    set_sender(ADDR_SPONSOR)
    set_value(200)
    contract.open_circuit(str(ADDR_BENEFICIARY), 200, 3600)
    set_value(0)

    # Unpinned URL, query params, fragments, path traversal rejected at add_atom
    for bad_url in [
        "https://raw.githubusercontent.com/Kanezar3/Clause-Circuit/main/evidence/a.json",
        f"{BASE_URL}/a.json?raw=1",
        f"{BASE_URL}/a.json#top",
        f"{BASE_URL}/../secret.json",
    ]:
        assert is_valid_evidence_url(bad_url) is False
        with pytest.raises(UserError, match="INVALID_EVIDENCE_URL"):
            contract.add_atom("bad", "Claim", bad_url, "a" * 64)

    url_404 = f"{BASE_URL}/missing.json"
    url_empty = f"{BASE_URL}/empty.json"
    url_big = f"{BASE_URL}/big.json"
    url_utf8 = f"{BASE_URL}/bad_utf8.bin"
    url_mismatch = f"{BASE_URL}/mismatch.json"

    mock_web_responses[url_404] = MockWebResponse(status=404, body=b"Not Found")
    mock_web_responses[url_empty] = MockWebResponse(status=200, body=b"")
    mock_web_responses[url_big] = MockWebResponse(status=200, body=b"X" * (MAX_EVIDENCE_BYTES + 1))
    mock_web_responses[url_utf8] = MockWebResponse(status=200, body=b"\xff\xfe\x00\xaa")
    mock_web_responses[url_mismatch] = MockWebResponse(status=200, body=b'{"tampered": true}')

    contract.add_atom("a_404", "Claim", url_404, "0" * 64)
    contract.add_atom("a_empty", "Claim", url_empty, _sha256_hex(b""))
    contract.add_atom("a_big", "Claim", url_big, _sha256_hex(b"X" * (MAX_EVIDENCE_BYTES + 1)))
    contract.add_atom("a_utf8", "Claim", url_utf8, _sha256_hex(b"\xff\xfe\x00\xaa"))
    contract.add_atom("a_mismatch", "Claim", url_mismatch, "f" * 64)
    contract.add_gate("root", "AND", ["a_404", "a_empty", "a_big", "a_utf8", "a_mismatch"], 0)
    contract.freeze_circuit("root")

    assert contract.evaluate_atom("a_404") == "ATOM_UNKNOWN:a_404:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    assert contract.evaluate_atom("a_empty") == "ATOM_UNKNOWN:a_empty:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    assert contract.evaluate_atom("a_big") == "ATOM_UNKNOWN:a_big:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    assert contract.evaluate_atom("a_utf8") == "ATOM_UNKNOWN:a_utf8:FETCH_OR_PARSE_FAILURE:ATTEMPT_1"
    assert contract.evaluate_atom("a_mismatch") == "ATOM_UNKNOWN:a_mismatch:HASH_MISMATCH:ATTEMPT_1"

    # Root must remain UNKNOWN (fail-closed)
    with pytest.raises(UserError, match="CIRCUIT_STILL_UNDETERMINED"):
        contract.settle_circuit()


# =============================================================================
# 8. Cancel Draft Circuit & Global Node/Atom Bounds
# =============================================================================
def test_cancel_draft_and_global_bounds():
    fx = setup_ma_fixtures()
    contract = ClauseCircuit()
    set_sender(ADDR_SPONSOR)
    set_value(300)
    contract.open_circuit(str(ADDR_BENEFICIARY), 300, 3600)
    set_value(0)

    for i in range(MAX_ATOMS):
        assert contract.add_atom(
            f"at_{i:02d}", f"Claim {i}", fx["atom_eu_antitrust"]["url"], fx["atom_eu_antitrust"]["hash"]
        ) == f"ATOM_ADDED:at_{i:02d}"

    with pytest.raises(UserError, match="MAX_ATOMS_EXCEEDED"):
        contract.add_atom("at_over", "Over", fx["atom_eu_antitrust"]["url"], fx["atom_eu_antitrust"]["hash"])

    for i in range(MAX_NODES - MAX_ATOMS):
        assert contract.add_gate(f"gt_{i:02d}", "NOT", ["at_00"], 0) == f"GATE_ADDED:gt_{i:02d}:NOT"

    with pytest.raises(UserError, match="MAX_NODES_EXCEEDED"):
        contract.add_gate("gt_over", "NOT", ["at_00"], 0)

    # Cancel draft circuit refunds 100% to sponsor
    assert contract.cancel_draft_circuit() == "CIRCUIT_CANCELLED:REFUND_300"
    assert contract.get_pending_payout(str(ADDR_SPONSOR)) == 300
    assert_conservation(contract)
    assert contract.withdraw_payout() == 300
    assert emitted_transfers == [{"to": str(ADDR_SPONSOR), "value": 300}]
    assert_conservation(contract)
