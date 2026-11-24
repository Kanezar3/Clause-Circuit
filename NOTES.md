# Release Notes: Clause Circuit

## Overview

```text
ClauseCircuit is a bilateral Kleene 3-valued (K3) predicate DAG (AND/OR/NOT/K_OF_N) escrow with real native transfers on GenLayer StudioNet. Sponsor locks payable GEN and proposes an acyclic DAG (Kahn's sort, 0 orphan nodes); beneficiary accepts before activation. Parties freeze the graph up front while validators judge commit-pinned prose into TRUE/FALSE/UNKNOWN under exact 5-field canonical consensus and strict fail-closed compatibility (retriable UNKNOWN <=5; immutable TRUE/FALSE).

Live at 0xBc668baE5C965080F28fDA1bAe2D1F67317E4eec (34 finalized txs, 0 blank errors, 34/34 read-backs): cleared an M&A circuit via K_OF_N(2/3) despite CFIUS FALSE, live OR(UNKNOWN, TRUE) short-circuiting, and NOT(FALSE), paying 0.5 GEN native to beneficiary. Blocked 9 abuses: unauthorized open, value mismatch, unpinned URL, cycle, unilateral accept, atom replay, NOT(UNKNOWN) settle, replay settle, and zero draw.

Caveat: audits pinned prose filings; not off-chain share transfer.
```

---

## Verified Deployment & Transaction References

### Core Contract & Repository Links
- **StudioNet Explorer Contract**: https://explorer-studio.genlayer.com/address/0xBc668baE5C965080F28fDA1bAe2D1F67317E4eec
- **Public GitHub Repository**: https://github.com/Kanezar3/Clause-Circuit
- **Commit-Pinned Contract (`d56f7ec`)**: https://github.com/Kanezar3/Clause-Circuit/blob/d56f7eca43e073b7f0c84ab015052cf1bb034802/contracts/clause_circuit.py
- **Commit-Pinned Release Manifest (`0989696`)**: https://github.com/Kanezar3/Clause-Circuit/blob/098969626fd1d471f3bc40e7e271fe2f4e1769d4/release_manifest.json
- **Runner Probe Contract (`probe_ok`)**: https://explorer-studio.genlayer.com/address/0x66EEB6F0C8B4077a93C3b3892fb9a80b09ee7B13

### Key Positive Demo Transactions (All `FINALIZED` + `SUCCESS`)
- **DEPLOY**: https://explorer-studio.genlayer.com/tx/0x1206ae01d7dbf80eb2531c399e900a9edace1c31fa702212c859d9767300df7a
- **S1 (`open_circuit` 0.5 GEN payable)**: https://explorer-studio.genlayer.com/tx/0x28a8f946724aa7f34dab69f36ba6723dc0fb8250ee42d78ff66093052e90f6d8
- **S12 (`propose_circuit` 10-node acyclic DAG, 0 orphans)**: https://explorer-studio.genlayer.com/tx/0xe265fbd3409522fc9eff04971f6562d4f50631833fbc0a4b590cf2c6e516d3d0
- **S13 (`accept_circuit` beneficiary bilateral freeze)**: https://explorer-studio.genlayer.com/tx/0xbd61461eca6263ce98e852ad34161e6865ee29c3038847a9367ecfdd7854451c
- **S14 (`atom_eu_antitrust` prose -> `TRUE`)**: https://explorer-studio.genlayer.com/tx/0x665716602f3fdd4e82cbc816689c8cd5e16e0b8cd7c6d89d4e055e1bba6ebdd1
- **S15 (`atom_us_cfius` prose -> `FALSE`)**: https://explorer-studio.genlayer.com/tx/0x006af32a8005b06a4da5ad784ebe827f4cfb18e0bc45989b4dec13bd25dfb981
- **S16 (`atom_uk_cma` prose -> `TRUE`, `K_OF_N` 2/3 satisfied)**: https://explorer-studio.genlayer.com/tx/0x8c1c000b17fa544c5520263dcd003dd8c55ba46140ab13e9a69ce460e8153d5c
- **S17 (`atom_bridge_equity` prose -> `TRUE`, live `OR(UNKNOWN, TRUE)` short-circuit)**: https://explorer-studio.genlayer.com/tx/0x97f4dff996b72bce1e55612d4fcb493a947fb7733f936a1bb1fabb86f2b237d1
- **S18 (`atom_injunction` prose -> `FALSE`, `NOT(FALSE)=TRUE`)**: https://explorer-studio.genlayer.com/tx/0x0c0b5cb4f2b60a3ee1e174ac560be7bb5da1667776e505390d3e85dbb9bdd565
- **S19 (`settle_circuit` `RELEASED_TO_BENEFICIARY`)**: https://explorer-studio.genlayer.com/tx/0x44a17de2106cc89db5cf8771c9d17e296cf66052cf0f35d177cfa4528bcfdff2
- **S20 (`withdraw_payout` 0.5 GEN real native EOA payout)**: https://explorer-studio.genlayer.com/tx/0x5edc46bc3ff6846a36a87470c132fcf1b2ac7de893260bd3a5d4add918224380

### Expected-Failure Abuse Guards (All `FINALIZED` + `ERROR` with Exact Decoded Revert Codes)
- **X1 (`UNAUTHORIZED_CALLER` on `open_circuit`)**: https://explorer-studio.genlayer.com/tx/0x89f8b52fa45a5e2c93b910c6efb0fdd425a2301214de2f5c7424b23a6f0f5156
- **X2 (`ESCROW_VALUE_MISMATCH` on payable `open_circuit`)**: https://explorer-studio.genlayer.com/tx/0x0384aee0653730d06e14fcb8fc2c2d8c4a6a70364a6ecbaaf5e1be35b6e4d81e
- **X3 (`INVALID_EVIDENCE_URL` on unpinned `/main/`)**: https://explorer-studio.genlayer.com/tx/0x37785d71dd7398331259908fc0f2ae488c6e7878645869e327a32bf34cf60c58
- **X4 (`CYCLE_DETECTED` via Kahn's sort on `propose_circuit`)**: https://explorer-studio.genlayer.com/tx/0x2a2489522eb6d29f5df4119b8362a88a1f2a6cad8fe38ab94261883827bd17d3
- **X5 (`UNAUTHORIZED_CALLER` on unilateral `accept_circuit`)**: https://explorer-studio.genlayer.com/tx/0x7fc75a13aafc825c4390ab7d4b7739f29244400c7a375532713e603b956f4515
- **X6 (`ATOM_ALREADY_CONCLUDED` on atom replay)**: https://explorer-studio.genlayer.com/tx/0x3151b82fb52db2b44b349ee934741505f6f95b6e4514c1c4ae7a97998dcde6aa
- **X7 (`CIRCUIT_STILL_UNDETERMINED` on fail-closed `NOT(UNKNOWN)`)**: https://explorer-studio.genlayer.com/tx/0x00712482e639c18c7a1b227a6ecb850a7e5b51a64e5bd92f2bf80bde73ec4820
- **X8 (`CIRCUIT_ALREADY_SETTLED` on replay settlement)**: https://explorer-studio.genlayer.com/tx/0x216d647817b2f936090b4ec1337b3ea8ddded880d8231146132480b27bf0c140
- **X9 (`NO_PENDING_PAYOUT` on zero-balance withdrawal)**: https://explorer-studio.genlayer.com/tx/0xcfb31c9e1acf16812ad3229b164227ff88a3e7814071727744ebd72c74a321b8
- **S8_RETRY (`NODE_ALREADY_EXISTS` — labeled RPC 502 client retry)**: https://explorer-studio.genlayer.com/tx/0x72d24a578aa7a2f8dd6f119898cb214d9899df0fd546e5982da9af833496d26e
