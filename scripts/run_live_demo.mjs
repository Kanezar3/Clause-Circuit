import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createClient, createAccount, generatePrivateKey } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state.json');
const MANIFEST_FILE = path.join(ROOT_DIR, 'release_manifest.json');
const CONTRACT_FILE = path.join(ROOT_DIR, 'contracts', 'clause_circuit.py');
const PROBE_FILE = path.join(__dirname, 'probe.py');
const STUDIO_RPC = 'https://studio.genlayer.com/api';

function sha256(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return {};
}

function saveState(patch) {
  const cur = loadState();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function rawRpcCall(method, params = [], retries = 5) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(STUDIO_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${method}`);
      const data = await resp.json();
      if (data.error) throw new Error(`RPC error on ${method}: ${JSON.stringify(data.error)}`);
      return data.result;
    } catch (err) {
      lastErr = err;
      console.warn(`  [RPC ${method} attempt ${attempt}]: ${err.message || err}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  throw lastErr;
}

function createStudioClient(account) {
  return createClient({ chain: studionet, endpoint: STUDIO_RPC, account });
}

const STATUS_NAMES = {
  0: 'PENDING', 1: 'PROPOSED', 2: 'COMMITTING', 3: 'REVEALING', 4: 'VOTING',
  5: 'ACCEPTED', 6: 'UNDETERMINED', 7: 'FINALIZED', 8: 'CANCELED', 9: 'APPEAL_REVEALING'
};

function normalizeReadable(val) {
  if (typeof val !== 'string') return String(val ?? '');
  let s = val.trim();
  while ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed;
      else break;
    } catch { break; }
  }
  return s;
}

function extractResultInfo(tx) {
  let statusName = tx.status_name || (tx.status !== undefined ? (STATUS_NAMES[tx.status] || String(tx.status)) : '');
  let resultName = tx.result_name || (tx.result !== undefined ? String(tx.result) : '');
  const receipt = tx.consensus_data?.leader_receipt?.[0] || {};
  const execResult = receipt.execution_result || '';
  const stderr = receipt.genvm_result?.stderr || '';
  const readableRaw = receipt.result?.payload?.readable;
  const readableStr = typeof readableRaw === 'string'
    ? normalizeReadable(readableRaw)
    : (readableRaw !== undefined ? JSON.stringify(readableRaw) : '');
  const votes = tx.consensus_data?.votes || {};
  const contractAddress = tx.data?.contract_address || tx.contract_address || '';
  return { statusName, resultName, execResult, stderr, readableStr, votes, contractAddress };
}

async function waitForReceipt(client, txHash, { expectSuccess = true, maxAttempts = 120, intervalMs = 5000 } = {}) {
  console.log(`[POLL] Waiting for tx ${txHash} (expectSuccess=${expectSuccess})...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const tx = await client.getTransaction({ hash: txHash });
      if (!tx) continue;
      const info = extractResultInfo(tx);
      console.log(`  [Attempt ${attempt}/${maxAttempts}] status=${info.statusName} result=${info.resultName} GenVM=${info.execResult}`);
      if (info.statusName === 'FINALIZED' || info.statusName === 'UNDETERMINED') {
        if (info.statusName === 'UNDETERMINED') {
          throw new Error(`Transaction ${txHash} ended UNDETERMINED`);
        }
        if (expectSuccess && info.execResult && info.execResult !== 'SUCCESS') {
          throw new Error(`Transaction ${txHash} finalized with GenVM ${info.execResult} (expected SUCCESS). stderr=${info.stderr} readable=${info.readableStr}`);
        }
        if (!expectSuccess && info.execResult === 'SUCCESS') {
          throw new Error(`Transaction ${txHash} unexpectedly SUCCEEDED (expected ERROR). readable=${info.readableStr}`);
        }
        return {
          finalized: true,
          status: info.statusName,
          result: info.resultName,
          executionResult: info.execResult,
          returnReadable: info.readableStr,
          stderr: info.stderr,
          votes: info.votes,
          contractAddress: info.contractAddress
        };
      }
    } catch (err) {
      if (err.message && (err.message.includes('finalized with GenVM') || err.message.includes('unexpectedly SUCCEEDED') || err.message.includes('UNDETERMINED'))) {
        throw err;
      }
      console.warn(`  [Poll attempt ${attempt}]: ${err.message || err}`);
    }
  }
  throw new Error(`Transaction ${txHash} did not finalize`);
}

async function readContractWithRetry(client, { address, functionName, args = [] }, retries = 6, delayMs = 3000) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await client.readContract({ address, functionName, args });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
  throw lastErr;
}

async function safeDeploy(client, code, retries = 5) {
  let txHash = null, lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      txHash = await client.deployContract({ code });
      console.log(`  -> deployContract sent: ${txHash}`);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
  if (!txHash) throw new Error(`Deploy failed: ${lastErr?.message || lastErr}`);
  const receipt = await waitForReceipt(client, txHash, { expectSuccess: true });
  return { txHash, receipt };
}

async function safeWrite(client, { address, functionName, args = [], value = 0n, expectSuccess = true, retries = 5 }) {
  let txHash = null, lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      txHash = await client.writeContract({ address, functionName, args, value });
      console.log(`  -> writeContract ${functionName} sent: ${txHash}`);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
  if (!txHash) throw new Error(`writeContract ${functionName} failed: ${lastErr?.message || lastErr}`);
  const receipt = await waitForReceipt(client, txHash, { expectSuccess });
  return { txHash, receipt };
}

function assertExpected(step, actual, expected) {
  const a = normalizeReadable(actual);
  const e = normalizeReadable(expected);
  if (e && a !== e) {
    throw new Error(`STOP: Step ${step} landed unexpectedly! expected="${e}" got="${a}"`);
  }
}

async function main() {
  console.log('===============================================================');
  console.log('  ClauseCircuit: StudioNet Probe, Native Deploy & Live Demo    ');
  console.log('===============================================================');

  let state = loadState();
  const ROLES = ['sponsor', 'beneficiary', 'solver', 'attacker'];
  if (!state.keys) {
    const keys = {};
    for (const role of ROLES) {
      const pk = generatePrivateKey();
      const acc = createAccount(pk);
      keys[role] = { privateKey: pk, address: acc.address };
    }
    state = saveState({ keys });
    console.log('Generated 4 fresh dedicated ClauseCircuit accounts in gitignored state.json');
  }

  const accounts = {}, clients = {};
  for (const role of ROLES) {
    accounts[role] = createAccount(state.keys[role].privateKey);
    clients[role] = createStudioClient(accounts[role]);
    console.log(`${role.padEnd(12)}: ${accounts[role].address}`);
  }

  // Fund Sponsor and Attacker for real native payable transfers
  const fundingInfo = state.funding || {};
  for (const role of ['sponsor', 'attacker']) {
    const addr = accounts[role].address;
    let balHex = await rawRpcCall('eth_getBalance', [addr, 'latest']);
    let balWei = BigInt(balHex || '0x0');
    if (balWei < 10000n) {
      console.log(`Funding ${role} (${addr}) with 1,000,000 wei via sim_fundAccount...`);
      const fundTx = await rawRpcCall('sim_fundAccount', [addr, 1000000]);
      await new Promise(r => setTimeout(r, 3000));
      balHex = await rawRpcCall('eth_getBalance', [addr, 'latest']);
      balWei = BigInt(balHex || '0x0');
      fundingInfo[role] = { address: addr, simFundAccountTx: fundTx, fundedBalanceWei: balWei.toString() };
      console.log(`  -> Funded ${role}: balance=${balWei.toString()} wei`);
    } else if (!fundingInfo[role]) {
      fundingInfo[role] = { address: addr, fundedBalanceWei: balWei.toString() };
    }
  }
  state = saveState({ funding: fundingInfo });

  const commitSha = execSync('git rev-parse HEAD', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
  const blobSha = execSync('git rev-parse HEAD:contracts/clause_circuit.py', { cwd: ROOT_DIR, encoding: 'utf-8' }).trim();
  const contractCode = fs.readFileSync(CONTRACT_FILE, 'utf-8');
  const localContractSha256 = sha256(contractCode);

  const EVIDENCE_FILES = [
    'atom_eu_antitrust.json',
    'atom_us_cfius.json',
    'atom_uk_cma.json',
    'atom_bank_debt.json',
    'atom_bridge_equity.json',
    'atom_injunction.json'
  ];
  const EVIDENCES = {};
  const evidenceManifestList = [];
  for (const fname of EVIDENCE_FILES) {
    const raw = fs.readFileSync(path.join(ROOT_DIR, 'evidence', fname));
    const h = sha256(raw);
    const url = `https://raw.githubusercontent.com/Kanezar3/Clause-Circuit/${commitSha}/evidence/${fname}`;
    EVIDENCES[fname] = { url, hash: h, size: raw.length };
    evidenceManifestList.push({ file: `evidence/${fname}`, url, sha256: h, size: raw.length });
  }

  const CLAIMS = {
    atom_eu_antitrust: 'The European Commission unconditionally granted Phase I merger clearance for the acquisition.',
    atom_us_cfius: 'CFIUS unconditionally cleared the acquisition with no unresolved mitigation conditions.',
    atom_uk_cma: 'The UK CMA unconditionally cleared the proposed acquisition without Phase 2 referral.',
    atom_bank_debt: 'The senior syndicated bank debt commitment letter remains active and available to fund closing.',
    atom_bridge_equity: 'The sovereign bridge equity facility is executed and unconditionally committed to fund closing.',
    atom_injunction: 'An active court injunction currently bars closing of the acquisition.'
  };

  const history = state.history || [];

  function writeManifest() {
    const s = loadState();
    const manifest = {
      projectName: 'ClauseCircuit',
      humanName: 'Clause Circuit',
      description: 'Kleene 3-Valued Boolean Predicate Graph (AND/OR/NOT/K_OF_N) Closing-Condition Escrow with Real Native Transfers on GenLayer StudioNet',
      repositoryUrl: 'https://github.com/Kanezar3/Clause-Circuit',
      deployCommitSha: commitSha,
      contractPath: 'contracts/clause_circuit.py',
      gitBlobHash: blobSha,
      localContractSha256,
      onChainCodeSha256: s.onChainSha256 || '',
      blobEqualityVerified: s.blobEquality || false,
      settlementMode: 'OPTION_A_REAL_NATIVE_PAYABLE',
      probeContractAddress: s.probeAddress || '',
      probeDeployTxHash: s.probeDeployTx || '',
      probeSetTxHash: s.probeSetTx || '',
      probeVerifiedValue: s.probeVal || '',
      mainContractAddress: s.mainAddress || '',
      mainDeployTxHash: s.mainDeployTx || '',
      chain: {
        chainId: 61999,
        network: 'GenLayer StudioNet',
        rpcUrl: STUDIO_RPC,
        explorerUrl: 'https://explorer-studio.genlayer.com'
      },
      accounts: {
        sponsor: accounts.sponsor.address,
        beneficiary: accounts.beneficiary.address,
        solver: accounts.solver.address,
        attacker: accounts.attacker.address
      },
      funding: s.funding || {},
      evidenceFiles: evidenceManifestList,
      transactions: s.history || []
    };
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  }

  function recordStep(stepObj) {
    const idx = history.findIndex(h => h.step === stepObj.step);
    if (idx >= 0) history[idx] = stepObj;
    else history.push(stepObj);
    saveState({ history });
    writeManifest();
    console.log(`  [RECORDED ${stepObj.step}] ${stepObj.method} | ${stepObj.status}/${stepObj.executionResult} | ${stepObj.returnOrError}`);
  }

  // Step 3A: Runner Probe
  if (!state.probeAddress) {
    console.log('\n--- Step 3A: Deploying Runner Probe ---');
    const probeCode = fs.readFileSync(PROBE_FILE, 'utf-8');
    const { txHash: pDeployTx, receipt: pRec } = await safeDeploy(clients.sponsor, probeCode);
    const probeAddr = pRec.contractAddress;
    const { txHash: pSetTx } = await safeWrite(clients.sponsor, {
      address: probeAddr, functionName: 'set_val', args: ['probe_ok'], expectSuccess: true
    });
    const probeVal = normalizeReadable(await readContractWithRetry(clients.sponsor, {
      address: probeAddr, functionName: 'get_val', args: []
    }));
    if (probeVal !== 'probe_ok') throw new Error(`Probe mismatch: ${probeVal}`);
    state = saveState({ probeAddress: probeAddr, probeDeployTx: pDeployTx, probeSetTx: pSetTx, probeVal });
    writeManifest();
    console.log(`[PASS] Runner Probe verified at ${probeAddr}`);
  }

  // Step 3B: Deploy ClauseCircuit & Verify Byte-for-Byte Equality
  if (!state.mainAddress) {
    console.log('\n--- Step 3B: Deploying ClauseCircuit ---');
    const { txHash: mDeployTx, receipt: mRec } = await safeDeploy(clients.sponsor, contractCode);
    state = saveState({ mainAddress: mRec.contractAddress, mainDeployTx: mDeployTx });
    writeManifest();
    console.log(`ClauseCircuit deployed at: ${mRec.contractAddress}`);
  }
  const MAIN_ADDR = loadState().mainAddress;

  if (!loadState().blobEquality) {
    let onChainCode = await rawRpcCall('gen_getContractCode', [MAIN_ADDR]);
    if (typeof onChainCode === 'string' && onChainCode.startsWith('0x')) {
      onChainCode = Buffer.from(onChainCode.slice(2), 'hex').toString('utf-8');
    } else if (typeof onChainCode === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(onChainCode) && !onChainCode.includes('class ClauseCircuit')) {
      onChainCode = Buffer.from(onChainCode, 'base64').toString('utf-8');
    }
    const onChainSha256 = sha256(onChainCode);
    const blobEquality = (contractCode === onChainCode) && (localContractSha256 === onChainSha256);
    saveState({ onChainSha256, blobEquality });
    writeManifest();
    if (!blobEquality) throw new Error(`CRITICAL: Bytecode mismatch! local=${localContractSha256} onChain=${onChainSha256}`);
    console.log(`[PASS] Byte-for-byte on-chain equality verified (SHA-256: ${onChainSha256})`);
  }

  async function runStep({ step, scenario, role, functionName, args = [], value = 0n, expectSuccess = true, expected, readBackFn = null }) {
    if (history.find(h => h.step === step)) return;
    console.log(`\n--- Step ${step}: ${scenario} ---`);
    const { txHash, receipt } = await safeWrite(clients[role], {
      address: MAIN_ADDR, functionName, args, value, expectSuccess
    });
    const retOrErr = expectSuccess ? receipt.returnReadable : (receipt.returnReadable || receipt.stderr || '');
    if (expectSuccess && expected !== undefined) {
      assertExpected(step, receipt.returnReadable, expected);
    }
    const readBack = readBackFn ? await readBackFn() : undefined;
    recordStep({
      step, scenario, method: functionName, caller: role, hash: txHash,
      status: receipt.status, executionResult: receipt.executionResult,
      returnOrError: retOrErr, votes: receipt.votes || {},
      expected, expectedFailure: !expectSuccess,
      ...(readBack !== undefined ? { readBack } : {})
    });
  }

  // X1: Unauthorized open_circuit
  await runStep({
    step: 'X1', scenario: 'Unauthorized Non-Sponsor open_circuit Blocked', role: 'attacker',
    functionName: 'open_circuit', args: [accounts.beneficiary.address, 1000, 3600], value: 1000n,
    expectSuccess: false, expected: 'UNAUTHORIZED_CALLER'
  });

  // X2: Value mismatch on payable open_circuit
  await runStep({
    step: 'X2', scenario: 'Payable Escrow Value Mismatch Blocked', role: 'sponsor',
    functionName: 'open_circuit', args: [accounts.beneficiary.address, 1000, 3600], value: 500n,
    expectSuccess: false, expected: 'ESCROW_VALUE_MISMATCH'
  });

  // S1: Open circuit with 1000 wei real native escrow
  await runStep({
    step: 'S1', scenario: 'Sponsor Opens Circuit with 1000 wei Payable Escrow', role: 'sponsor',
    functionName: 'open_circuit', args: [accounts.beneficiary.address, 1000, 3600], value: 1000n,
    expectSuccess: true, expected: 'CIRCUIT_OPENED:ESCROW_1000',
    readBackFn: async () => JSON.parse(await readContractWithRetry(clients.sponsor, { address: MAIN_ADDR, functionName: 'get_circuit_status' }))
  });

  // X3: Unpinned /main/ URL blocked
  await runStep({
    step: 'X3', scenario: 'Unpinned Mutable /main/ URL Blocked', role: 'sponsor',
    functionName: 'add_atom',
    args: ['bad_url', 'Claim', 'https://raw.githubusercontent.com/Kanezar3/Clause-Circuit/main/evidence/atom_eu_antitrust.json', EVIDENCES['atom_eu_antitrust.json'].hash],
    expectSuccess: false, expected: 'INVALID_EVIDENCE_URL'
  });

  // S2-S7: Add 6 M&A atoms
  const atomKeys = [
    ['S2', 'atom_eu_antitrust', 'atom_eu_antitrust.json'],
    ['S3', 'atom_us_cfius', 'atom_us_cfius.json'],
    ['S4', 'atom_uk_cma', 'atom_uk_cma.json'],
    ['S5', 'atom_bank_debt', 'atom_bank_debt.json'],
    ['S6', 'atom_bridge_equity', 'atom_bridge_equity.json'],
    ['S7', 'atom_injunction', 'atom_injunction.json']
  ];
  for (const [st, id, fname] of atomKeys) {
    await runStep({
      step: st, scenario: `Sponsor Adds Atom ${id}`, role: 'sponsor',
      functionName: 'add_atom', args: [id, CLAIMS[id], EVIDENCES[fname].url, EVIDENCES[fname].hash],
      expectSuccess: true, expected: `ATOM_ADDED:${id}`
    });
  }

  // S8-S11: Add composite gates
  await runStep({
    step: 'S8', scenario: 'Sponsor Adds K_OF_N (2 of 3) Regulatory Quorum Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['gate_reg_quorum', 'K_OF_N', ['atom_eu_antitrust', 'atom_us_cfius', 'atom_uk_cma'], 2],
    expectSuccess: true, expected: 'GATE_ADDED:gate_reg_quorum:K_OF_N'
  });
  await runStep({
    step: 'S9', scenario: 'Sponsor Adds OR Financing Fallback Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['gate_financing', 'OR', ['atom_bank_debt', 'atom_bridge_equity'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:gate_financing:OR'
  });
  await runStep({
    step: 'S10', scenario: 'Sponsor Adds NOT Active-Injunction Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['gate_no_injunction', 'NOT', ['atom_injunction'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:gate_no_injunction:NOT'
  });
  await runStep({
    step: 'S11', scenario: 'Sponsor Adds Root AND Closing Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['root', 'AND', ['gate_reg_quorum', 'gate_financing', 'gate_no_injunction'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:root:AND'
  });

  // Add cyclic test gates (outside root's subgraph) to prove Kahn cycle rejection on-chain in X4
  await runStep({
    step: 'S11B', scenario: 'Sponsor Adds Auxiliary Cyclic Gate g_cyc1 (For Cycle Guard Proof)', role: 'sponsor',
    functionName: 'add_gate', args: ['g_cyc1', 'OR', ['atom_eu_antitrust', 'g_cyc2'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:g_cyc1:OR'
  });
  await runStep({
    step: 'S11C', scenario: 'Sponsor Adds Auxiliary Cyclic Gate g_cyc2 (Closes Cycle)', role: 'sponsor',
    functionName: 'add_gate', args: ['g_cyc2', 'NOT', ['g_cyc1'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:g_cyc2:NOT'
  });
  await runStep({
    step: 'X4', scenario: 'Kahn Topological Sort Rejects Cyclic Circuit Root', role: 'sponsor',
    functionName: 'freeze_circuit', args: ['g_cyc1'],
    expectSuccess: false, expected: 'CYCLE_DETECTED'
  });

  // S12: Freeze valid acyclic root circuit (10 reachable nodes)
  await runStep({
    step: 'S12', scenario: 'Sponsor Freezes Acyclic 10-Node M&A Circuit', role: 'sponsor',
    functionName: 'freeze_circuit', args: ['root'],
    expectSuccess: true, expected: 'CIRCUIT_FROZEN:root:NODES_10',
    readBackFn: async () => JSON.parse(await readContractWithRetry(clients.sponsor, { address: MAIN_ADDR, functionName: 'evaluate_circuit_view' }))
  });

  // S13: Evaluate atom_eu_antitrust -> TRUE
  await runStep({
    step: 'S13', scenario: 'Consensus Adjudicates EU Antitrust Clearance -> TRUE', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_eu_antitrust'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_eu_antitrust:TRUE:CLAIM_VERIFIED',
    readBackFn: async () => JSON.parse(await readContractWithRetry(clients.solver, { address: MAIN_ADDR, functionName: 'get_node', args: ['atom_eu_antitrust'] }))
  });

  // X5: Re-evaluate concluded atom blocked
  await runStep({
    step: 'X5', scenario: 'Re-Evaluation of Concluded TRUE Atom Blocked (Immutability)', role: 'attacker',
    functionName: 'evaluate_atom', args: ['atom_eu_antitrust'],
    expectSuccess: false, expected: 'ATOM_ALREADY_CONCLUDED'
  });

  // S14-S17: Evaluate remaining 4 atoms (US CFIUS FALSE, UK CMA TRUE, Bank Debt FALSE, Bridge Equity TRUE)
  await runStep({
    step: 'S14', scenario: 'Consensus Adjudicates US CFIUS Mitigation Unresolved -> FALSE', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_us_cfius'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_us_cfius:FALSE:CLAIM_CONTRADICTED'
  });
  await runStep({
    step: 'S15', scenario: 'Consensus Adjudicates UK CMA Clearance -> TRUE (K_OF_N 2/3 Satisfied)', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_uk_cma'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_uk_cma:TRUE:CLAIM_VERIFIED'
  });
  await runStep({
    step: 'S16', scenario: 'Consensus Adjudicates Bank Debt Lapsed -> FALSE', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_bank_debt'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_bank_debt:FALSE:CLAIM_CONTRADICTED'
  });
  await runStep({
    step: 'S17', scenario: 'Consensus Adjudicates Bridge Equity Executed -> TRUE (OR Fallback Satisfied)', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_bridge_equity'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_bridge_equity:TRUE:CLAIM_VERIFIED',
    readBackFn: async () => JSON.parse(await readContractWithRetry(clients.solver, { address: MAIN_ADDR, functionName: 'evaluate_circuit_view' }))
  });

  // X6: Fail-closed NOT(UNKNOWN) == UNKNOWN blocks premature settlement
  await runStep({
    step: 'X6', scenario: 'Fail-Closed NOT(UNKNOWN) Blocks Premature Settlement', role: 'solver',
    functionName: 'settle_circuit', args: [],
    expectSuccess: false, expected: 'CIRCUIT_STILL_UNDETERMINED'
  });

  // S18: Evaluate atom_injunction -> FALSE => NOT(FALSE) == TRUE => root == TRUE!
  await runStep({
    step: 'S18', scenario: 'Consensus Adjudicates Court Injunction Dismissed -> FALSE (NOT(FALSE)=TRUE)', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_injunction'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_injunction:FALSE:CLAIM_CONTRADICTED',
    readBackFn: async () => JSON.parse(await readContractWithRetry(clients.solver, { address: MAIN_ADDR, functionName: 'evaluate_circuit_view' }))
  });

  // S19: Permissionless Kleene K3 Settlement -> RELEASED_TO_BENEFICIARY
  await runStep({
    step: 'S19', scenario: 'Permissionless Kleene K3 Settlement Releases 1000 wei to Beneficiary', role: 'solver',
    functionName: 'settle_circuit', args: [],
    expectSuccess: true, expected: 'SETTLED:RELEASED_TO_BENEFICIARY:AMOUNT_1000',
    readBackFn: async () => JSON.parse(await readContractWithRetry(clients.solver, { address: MAIN_ADDR, functionName: 'get_accounting_summary' }))
  });

  // X7: Replay settlement blocked
  await runStep({
    step: 'X7', scenario: 'Replay settle_circuit Blocked After Terminal Settlement', role: 'attacker',
    functionName: 'settle_circuit', args: [],
    expectSuccess: false, expected: 'CIRCUIT_ALREADY_SETTLED'
  });

  // X8: Zero-balance withdrawal blocked
  await runStep({
    step: 'X8', scenario: 'Unauthorized Zero-Balance Withdrawal Blocked', role: 'attacker',
    functionName: 'withdraw_payout', args: [],
    expectSuccess: false, expected: 'NO_PENDING_PAYOUT'
  });

  // S20: Beneficiary withdraws 1000 wei real native value via _EoaRecipient.emit_transfer
  if (!history.find(h => h.step === 'S20')) {
    const balBeforeHex = await rawRpcCall('eth_getBalance', [accounts.beneficiary.address, 'latest']);
    const balBefore = BigInt(balBeforeHex || '0x0');
    await runStep({
      step: 'S20', scenario: 'Beneficiary Withdraws 1000 wei Real Native Payout via _EoaRecipient.emit_transfer', role: 'beneficiary',
      functionName: 'withdraw_payout', args: [],
      expectSuccess: true, expected: '1000',
      readBackFn: async () => {
        const balAfterHex = await rawRpcCall('eth_getBalance', [accounts.beneficiary.address, 'latest']);
        const balAfter = BigInt(balAfterHex || '0x0');
        const acct = JSON.parse(await readContractWithRetry(clients.beneficiary, { address: MAIN_ADDR, functionName: 'get_accounting_summary' }));
        return {
          beneficiary_eoa_balance_before_wei: balBefore.toString(),
          beneficiary_eoa_balance_after_wei: balAfter.toString(),
          beneficiary_eoa_delta_wei: (balAfter - balBefore).toString(),
          accounting: acct
        };
      }
    });
  }

  console.log('\n===============================================================');
  console.log('  ClauseCircuit Live StudioNet Demo 100% COMPLETE!             ');
  console.log(`  Contract: ${MAIN_ADDR}`);
  console.log(`  Manifest: ${MANIFEST_FILE}`);
  console.log('===============================================================');
}

main().catch(err => {
  console.error('\n[FATAL ERROR]:', err);
  process.exit(1);
});
