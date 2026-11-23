# Portal Submission Note: Clause Circuit

## Section 1: Submission Description (Strictly < 1,000 Characters)

```text
ClauseCircuit implements a Kleene 3-valued (K3) boolean predicate graph (AND/OR/NOT/K_OF_N) escrow with real native value transfers on GenLayer StudioNet. A sponsor locks payable wei and builds a closing-condition DAG verified acyclic by Kahn's topological sort. GenLayer validators judge commit-pinned leaf atoms into TRUE/FALSE/UNKNOWN under exact 5-field canonical consensus and a strict compatibility table (retriable UNKNOWN <=5 attempts; immutable TRUE/FALSE). Deterministic K3 logic enforces fail-closed NOT(UNKNOWN)=UNKNOWN, OR fallbacks, and K_OF_N short-circuiting.

Live at 0xCC0903589e9e3baEA151BAde30D87A592Bc00137 (30 finalized txs): cleared an M&A circuit despite 2 FALSE atoms via K_OF_N(2/3), OR fallback, and NOT(FALSE), paying 1000 wei native to beneficiary (EOA +1000). Blocked 8 abuses: unauthorized open, value mismatch, unpinned URL, cyclic DAG, atom replay, NOT(UNKNOWN) settle, replay settle, and zero-balance draw.

Caveat: audits commit-pinned filings; does not enforce off-chain share transfer.
```

---

## Section 2: Complete Evidence & Reference Links

### Core Contract & Repository Links
- **StudioNet Explorer Contract**: https://explorer-studio.genlayer.com/address/0xCC0903589e9e3baEA151BAde30D87A592Bc00137
- **Public GitHub Repository**: https://github.com/Kanezar3/Clause-Circuit
- **Commit-Pinned Contract (`7d72a5e`)**: https://github.com/Kanezar3/Clause-Circuit/blob/7d72a5eef2ada8afa4f6c4a23ff2f236108a70a5/contracts/clause_circuit.py
- **Release Manifest**: https://github.com/Kanezar3/Clause-Circuit/blob/main/release_manifest.json
- **Runner Probe Contract**: https://explorer-studio.genlayer.com/address/0x079d803C3154B8BEA59818E09d1E9CE1270Daf4f

### Key Live Demo & Expected-Failure Transactions (All `FINALIZED`)
- **DEPLOY**: https://explorer-studio.genlayer.com/tx/0xa2458956e5db1f2838996fffc86f51fe783fae1a163d39f27d1163753dcb7f16
- **S1 (`open_circuit` 1000 wei payable)**: https://explorer-studio.genlayer.com/tx/0x350fd5c46b5668e53a36ea36117cdf6ccf8f2c10433e5758404c9984f9fb81b5
- **X4 (`freeze_circuit` `CYCLE_DETECTED`)**: https://explorer-studio.genlayer.com/tx/0xcd5181bbc8957606b7baf7e910a7b0a5cf28ad66749d219821449bdc2d6928dd
- **S12 (`freeze_circuit` 10-node DAG)**: https://explorer-studio.genlayer.com/tx/0xbb733d2851bc069dbd4baae1a22f5615f713d4944f3f4098e62be49d18601a6e
- **S15 (`K_OF_N` 2/3 satisfied despite CFIUS `FALSE`)**: https://explorer-studio.genlayer.com/tx/0x7381617c86a445ef63d671fd1be5899c0ef62614cd8668e42ece6e0253f1f716
- **S17 (`OR` fallback satisfied despite bank debt `FALSE`)**: https://explorer-studio.genlayer.com/tx/0x443ec3c73a6d482f1d9834089e0bdbefab4f4ed2ef326dd3c3f83cf2edb92a47
- **X6 (`settle_circuit` `CIRCUIT_STILL_UNDETERMINED` — fail-closed `NOT(UNKNOWN)`)**: https://explorer-studio.genlayer.com/tx/0xe81f3ad17f741d3466bc8978da1956a1bf069ba0d7c4d61188b40cc6d9d42c32
- **S18 (`atom_injunction` `FALSE` => `NOT(FALSE)=TRUE`)**: https://explorer-studio.genlayer.com/tx/0x30ef27996f8d176f7730dc0f8cc46d02b64f1146977705b708f23b08510c9e7a
- **S19 (`settle_circuit` `RELEASED_TO_BENEFICIARY`)**: https://explorer-studio.genlayer.com/tx/0x58848995972d6240eec0f556f7a4ce84e0ff97bc53dd158dc9d017430dc1d42c
- **S20 (`withdraw_payout` +1000 wei native EOA transfer)**: https://explorer-studio.genlayer.com/tx/0x55571966de626433bbbac0bb405cfe7be59e64fe20fb60d6f8a3c8fe9194f038
