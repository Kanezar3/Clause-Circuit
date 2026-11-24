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

function tryExec(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function getToolchainVersions() {
  let genlayerJs = 'unknown';
  for (const base of [ROOT_DIR, __dirname]) {
    try {
      genlayerJs = JSON.parse(
        fs.readFileSync(path.join(base, 'node_modules', 'genlayer-js', 'package.json'), 'utf-8')
      ).version;
      break;
    } catch {}
  }
  return {
    node: process.version,
    genlayerJs,
    python: tryExec('python --version'),
    pytest: tryExec('python -m pytest --version').split('\n')[0],
    genvmLinter: '0.11.0'
  };
}

function extractRunnerDepends(sourceText) {
  const firstLine = sourceText.split(/\r?\n/)[0] || '';
  const m = firstLine.match(/"Depends"\s*:\s*"([^"]+)"/);
  return m ? m[1] : firstLine;
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

function decodeGenVmErrorPayload(val) {
  if (!val) return '';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length >= 4) {
      try {
        const buf = Buffer.from(trimmed, 'base64');
        if (buf.length > 1 && (buf[0] === 1 || buf[0] === 2)) {
          const text = buf.subarray(1).toString('utf-8').trim();
          if (text && /^[\x20-\x7e\r\n\t]+$/.test(text)) return text;
        }
        const full = buf.toString('utf-8').trim();
        if (full && /^[\x20-\x7e\r\n\t]+$/.test(full)) return full;
      } catch {}
    }
    return normalizeReadable(trimmed);
  }
  if (typeof val === 'object') {
    if (val.payload?.readable !== undefined) return normalizeReadable(String(val.payload.readable));
    if (typeof val.payload === 'string') return decodeGenVmErrorPayload(val.payload);
    if (typeof val.raw === 'string') return decodeGenVmErrorPayload(val.raw);
    if (val.raw instanceof Uint8Array || Array.isArray(val.raw)) {
      const buf = Buffer.from(val.raw);
      const slice = buf.length > 1 && (buf[0] === 1 || buf[0] === 2) ? buf.subarray(1) : buf;
      return slice.toString('utf-8').trim();
    }
  }
  return '';
}

function extractResultInfo(tx) {
  let statusName = tx.status_name || (tx.status !== undefined ? (STATUS_NAMES[tx.status] || String(tx.status)) : '');
  let resultName = tx.result_name || (tx.result !== undefined ? String(tx.result) : '');
  const receipt = tx.consensus_data?.leader_receipt?.[0] || {};
  const execResult = receipt.execution_result || '';
  const stderr =
    receipt.genvm_result?.stderr ||
    receipt.genvm_result?.error_description ||
    (receipt.genvm_result?.raw_error ? JSON.stringify(receipt.genvm_result.raw_error) : '') ||
    '';
  const readableRaw = receipt.result?.payload?.readable;
  let readableStr = '';
  if (readableRaw !== undefined && readableRaw !== null && String(readableRaw).trim() !== '') {
    readableStr = typeof readableRaw === 'string' ? normalizeReadable(readableRaw) : JSON.stringify(readableRaw);
  } else {
    readableStr = decodeGenVmErrorPayload(receipt.result);
  }
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
        let readableStr = info.readableStr;
        let stderr = info.stderr;
        // Fallback: fetch raw RPC receipt to decode Base64 UserError payload (0x01 + UTF-8)
        if (!readableStr && !stderr) {
          try {
            const rawTx = await rawRpcCall('eth_getTransactionByHash', [txHash]);
            const rawReceipt = rawTx?.consensus_data?.leader_receipt?.[0] || {};
            readableStr = decodeGenVmErrorPayload(rawReceipt.result);
            stderr = rawReceipt.genvm_result?.stderr || rawReceipt.genvm_result?.error_description || '';
          } catch {}
        }
        if (expectSuccess && info.execResult && info.execResult !== 'SUCCESS') {
          throw new Error(`Transaction ${txHash} finalized with GenVM ${info.execResult} (expected SUCCESS). stderr=${stderr} readable=${readableStr}`);
        }
        if (!expectSuccess && info.execResult === 'SUCCESS') {
          throw new Error(`Transaction ${txHash} unexpectedly SUCCEEDED (expected ERROR). readable=${readableStr}`);
        }
        return {
          finalized: true,
          status: info.statusName,
          result: info.resultName,
          executionResult: info.execResult,
          returnReadable: readableStr,
          stderr,
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

function assertExpected(step, actual, expected, expectSuccess) {
  const a = normalizeReadable(actual);
  const e = normalizeReadable(expected);
  if (!e) return;
  if (expectSuccess) {
    if (a !== e) {
      throw new Error(`STOP: Step ${step} landed unexpectedly! expected="${e}" got="${a}"`);
    }
  } else {
    if (!a || !a.includes(e)) {
      throw new Error(`STOP: Expected failure ${step} did not match guard! expected="${e}" got="${a}"`);
    }
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
  const runnerDepends = extractRunnerDepends(contractCode);
  const toolchainVersions = getToolchainVersions();

  const EVIDENCE_FILES = [
    'atom_eu_antitrust.txt',
    'atom_us_cfius.txt',
    'atom_uk_cma.txt',
    'atom_bank_debt.txt',
    'atom_bridge_equity.txt',
    'atom_injunction.txt'
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
      description: 'Bilateral Kleene 3-Valued Boolean Predicate Graph (AND/OR/NOT/K_OF_N) Closing-Condition Escrow with Real Native Transfers on GenLayer StudioNet',
      repositoryUrl: 'https://github.com/Kanezar3/Clause-Circuit',
      deployCommitSha: commitSha,
      contractPath: 'contracts/clause_circuit.py',
      gitBlobHash: blobSha,
      localContractSha256,
      onChainCodeSha256: s.onChainSha256 || '',
      blobEqualityVerified: s.blobEquality || false,
      runner: runnerDepends,
      constructorArgs: [],
      toolchainVersions,
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
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');
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

  const readStatus = async () => JSON.parse(await readContractWithRetry(clients.sponsor, { address: MAIN_ADDR, functionName: 'get_circuit_status' }));
  const readEval = async () => JSON.parse(await readContractWithRetry(clients.solver, { address: MAIN_ADDR, functionName: 'evaluate_circuit_view' }));
  const readNode = (id) => async () => JSON.parse(await readContractWithRetry(clients.solver, { address: MAIN_ADDR, functionName: 'get_node', args: [id] }));
  const readAcct = async () => JSON.parse(await readContractWithRetry(clients.solver, { address: MAIN_ADDR, functionName: 'get_accounting_summary' }));

  async function runStep({ step, scenario, role, functionName, args = [], value = 0n, expectSuccess = true, expected, readBackFn = readStatus }) {
    if (history.find(h => h.step === step)) return;
    console.log(`\n--- Step ${step}: ${scenario} ---`);
    const { txHash, receipt } = await safeWrite(clients[role], {
      address: MAIN_ADDR, functionName, args, value, expectSuccess
    });
    const retOrErr = expectSuccess ? receipt.returnReadable : (receipt.returnReadable || receipt.stderr || '');
    if (expected !== undefined) {
      assertExpected(step, retOrErr, expected, expectSuccess);
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
    expectSuccess: false, expected: 'UNAUTHORIZED_CALLER', readBackFn: readStatus
  });

  // X2: Value mismatch on payable open_circuit
  await runStep({
    step: 'X2', scenario: 'Payable Escrow Value Mismatch Blocked', role: 'sponsor',
    functionName: 'open_circuit', args: [accounts.beneficiary.address, 1000, 3600], value: 500n,
    expectSuccess: false, expected: 'ESCROW_VALUE_MISMATCH', readBackFn: readStatus
  });

  // S1: Open circuit with 1000 wei real native escrow
  await runStep({
    step: 'S1', scenario: 'Sponsor Opens Circuit with 1000 wei Payable Escrow', role: 'sponsor',
    functionName: 'open_circuit', args: [accounts.beneficiary.address, 1000, 3600], value: 1000n,
    expectSuccess: true, expected: 'CIRCUIT_OPENED:ESCROW_1000', readBackFn: readStatus
  });

  // X3: Unpinned /main/ URL blocked
  await runStep({
    step: 'X3', scenario: 'Unpinned Mutable /main/ URL Blocked', role: 'sponsor',
    functionName: 'add_atom',
    args: ['bad_url', 'Claim', 'https://raw.githubusercontent.com/Kanezar3/Clause-Circuit/main/evidence/atom_eu_antitrust.txt', EVIDENCES['atom_eu_antitrust.txt'].hash],
    expectSuccess: false, expected: 'INVALID_EVIDENCE_URL', readBackFn: readStatus
  });

  // S2-S7: Add 6 natural-language prose M&A atoms
  const atomKeys = [
    ['S2', 'atom_eu_antitrust', 'atom_eu_antitrust.txt'],
    ['S3', 'atom_us_cfius', 'atom_us_cfius.txt'],
    ['S4', 'atom_uk_cma', 'atom_uk_cma.txt'],
    ['S5', 'atom_bank_debt', 'atom_bank_debt.txt'],
    ['S6', 'atom_bridge_equity', 'atom_bridge_equity.txt'],
    ['S7', 'atom_injunction', 'atom_injunction.txt']
  ];
  for (const [st, id, fname] of atomKeys) {
    await runStep({
      step: st, scenario: `Sponsor Adds Atom ${id}`, role: 'sponsor',
      functionName: 'add_atom', args: [id, CLAIMS[id], EVIDENCES[fname].url, EVIDENCES[fname].hash],
      expectSuccess: true, expected: `ATOM_ADDED:${id}`, readBackFn: readNode(id)
    });
  }

  // S8-S11: Add composite gates
  await runStep({
    step: 'S8', scenario: 'Sponsor Adds K_OF_N (2 of 3) Regulatory Quorum Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['gate_reg_quorum', 'K_OF_N', ['atom_eu_antitrust', 'atom_us_cfius', 'atom_uk_cma'], 2],
    expectSuccess: true, expected: 'GATE_ADDED:gate_reg_quorum:K_OF_N', readBackFn: readNode('gate_reg_quorum')
  });
  await runStep({
    step: 'S9', scenario: 'Sponsor Adds OR Financing Fallback Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['gate_financing', 'OR', ['atom_bank_debt', 'atom_bridge_equity'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:gate_financing:OR', readBackFn: readNode('gate_financing')
  });
  await runStep({
    step: 'S10', scenario: 'Sponsor Adds NOT Active-Injunction Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['gate_no_injunction', 'NOT', ['atom_injunction'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:gate_no_injunction:NOT', readBackFn: readNode('gate_no_injunction')
  });
  await runStep({
    step: 'S11', scenario: 'Sponsor Adds Root AND Closing Gate', role: 'sponsor',
    functionName: 'add_gate', args: ['root', 'AND', ['gate_reg_quorum', 'gate_financing', 'gate_no_injunction'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:root:AND', readBackFn: readNode('root')
  });

  // Prove Kahn's cycle rejection (X4) and orphan cleanup (S11D/S11E -> zero dead nodes in storage)
  await runStep({
    step: 'S11B', scenario: 'Sponsor Adds Temporary Cyclic Gate g_cyc1 (Cycle Guard Test)', role: 'sponsor',
    functionName: 'add_gate', args: ['g_cyc1', 'OR', ['atom_eu_antitrust', 'g_cyc2'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:g_cyc1:OR', readBackFn: readStatus
  });
  await runStep({
    step: 'S11C', scenario: 'Sponsor Adds Temporary Cyclic Gate g_cyc2 (Closes Cycle)', role: 'sponsor',
    functionName: 'add_gate', args: ['g_cyc2', 'NOT', ['g_cyc1'], 0],
    expectSuccess: true, expected: 'GATE_ADDED:g_cyc2:NOT', readBackFn: readStatus
  });
  await runStep({
    step: 'X4', scenario: 'Kahn Topological Sort Rejects Cyclic Circuit Root', role: 'sponsor',
    functionName: 'propose_circuit', args: ['g_cyc1'],
    expectSuccess: false, expected: 'CYCLE_DETECTED', readBackFn: readStatus
  });
  await runStep({
    step: 'S11D', scenario: 'Sponsor Removes Temporary Cyclic Gate g_cyc2 from Draft', role: 'sponsor',
    functionName: 'remove_draft_node', args: ['g_cyc2'],
    expectSuccess: true, expected: 'NODE_REMOVED:g_cyc2', readBackFn: readStatus
  });
  await runStep({
    step: 'S11E', scenario: 'Sponsor Removes Temporary Cyclic Gate g_cyc1 from Draft', role: 'sponsor',
    functionName: 'remove_draft_node', args: ['g_cyc1'],
    expectSuccess: true, expected: 'NODE_REMOVED:g_cyc1', readBackFn: readStatus
  });

  // S12: Sponsor proposes clean 10-node acyclic DAG (nodes_count === 10, zero orphans)
  await runStep({
    step: 'S12', scenario: 'Sponsor Proposes Clean Acyclic 10-Node M&A Circuit (DRAFT -> PROPOSED)', role: 'sponsor',
    functionName: 'propose_circuit', args: ['root'],
    expectSuccess: true, expected: 'CIRCUIT_PROPOSED:root:NODES_10', readBackFn: readStatus
  });

  // X5: Sponsor/non-beneficiary CANNOT unilaterally freeze the circuit
  await runStep({
    step: 'X5', scenario: 'Unilateral Non-Beneficiary accept_circuit Blocked (Bilateral Consent Guard)', role: 'sponsor',
    functionName: 'accept_circuit', args: [],
    expectSuccess: false, expected: 'UNAUTHORIZED_CALLER', readBackFn: readStatus
  });

  // S13: Beneficiary verifies claims/hashes and activates circuit (PROPOSED -> FROZEN)
  await runStep({
    step: 'S13', scenario: 'Beneficiary Accepts Proposed Circuit (PROPOSED -> FROZEN)', role: 'beneficiary',
    functionName: 'accept_circuit', args: [],
    expectSuccess: true, expected: 'CIRCUIT_FROZEN:root:NODES_10', readBackFn: readEval
  });

  // S14: Evaluate atom_eu_antitrust -> TRUE
  await runStep({
    step: 'S14', scenario: 'Consensus Adjudicates EU Antitrust Prose Notice -> TRUE', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_eu_antitrust'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_eu_antitrust:TRUE:CLAIM_VERIFIED', readBackFn: readNode('atom_eu_antitrust')
  });

  // X6: Re-evaluate concluded atom blocked
  await runStep({
    step: 'X6', scenario: 'Re-Evaluation of Concluded TRUE Atom Blocked (Immutability)', role: 'attacker',
    functionName: 'evaluate_atom', args: ['atom_eu_antitrust'],
    expectSuccess: false, expected: 'ATOM_ALREADY_CONCLUDED', readBackFn: readNode('atom_eu_antitrust')
  });

  // S15-S16: Evaluate CFIUS (FALSE) + UK CMA (TRUE) -> K_OF_N(2/3) becomes TRUE despite 1 FALSE!
  await runStep({
    step: 'S15', scenario: 'Consensus Adjudicates US CFIUS Extended Review Notice -> FALSE', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_us_cfius'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_us_cfius:FALSE:CLAIM_CONTRADICTED', readBackFn: readNode('atom_us_cfius')
  });
  await runStep({
    step: 'S16', scenario: 'Consensus Adjudicates UK CMA Phase 1 Notice -> TRUE (K_OF_N 2/3 Satisfied)', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_uk_cma'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_uk_cma:TRUE:CLAIM_VERIFIED', readBackFn: readEval
  });

  // S17: Evaluate ONLY atom_bridge_equity -> TRUE while leaving atom_bank_debt UNKNOWN!
  // Proves LIVE Kleene K3 OR(UNKNOWN, TRUE) == TRUE short-circuiting!
  await runStep({
    step: 'S17', scenario: 'Consensus Adjudicates Bridge Equity Notice -> TRUE (Live OR(UNKNOWN, TRUE) Short-Circuit)', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_bridge_equity'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_bridge_equity:TRUE:CLAIM_VERIFIED', readBackFn: readEval
  });

  // X7: Fail-closed NOT(UNKNOWN) == UNKNOWN blocks premature settlement
  await runStep({
    step: 'X7', scenario: 'Fail-Closed NOT(UNKNOWN) Blocks Premature Settlement', role: 'solver',
    functionName: 'settle_circuit', args: [],
    expectSuccess: false, expected: 'CIRCUIT_STILL_UNDETERMINED', readBackFn: readStatus
  });

  // S18: Evaluate atom_injunction -> FALSE => NOT(FALSE) == TRUE => root == TRUE (while atom_bank_debt remains UNKNOWN!)
  await runStep({
    step: 'S18', scenario: 'Consensus Adjudicates Delaware Court Order -> FALSE (NOT(FALSE)=TRUE, root=TRUE)', role: 'solver',
    functionName: 'evaluate_atom', args: ['atom_injunction'],
    expectSuccess: true, expected: 'ATOM_CONCLUDED:atom_injunction:FALSE:CLAIM_CONTRADICTED', readBackFn: readEval
  });

  // S19: Permissionless Kleene K3 Settlement -> RELEASED_TO_BENEFICIARY
  await runStep({
    step: 'S19', scenario: 'Permissionless Kleene K3 Settlement Releases 1000 wei to Beneficiary', role: 'solver',
    functionName: 'settle_circuit', args: [],
    expectSuccess: true, expected: 'SETTLED:RELEASED_TO_BENEFICIARY:AMOUNT_1000', readBackFn: readAcct
  });

  // X8: Replay settlement blocked
  await runStep({
    step: 'X8', scenario: 'Replay settle_circuit Blocked After Terminal Settlement', role: 'attacker',
    functionName: 'settle_circuit', args: [],
    expectSuccess: false, expected: 'CIRCUIT_ALREADY_SETTLED', readBackFn: readAcct
  });

  // X9: Zero-balance withdrawal blocked
  await runStep({
    step: 'X9', scenario: 'Unauthorized Zero-Balance Withdrawal Blocked', role: 'attacker',
    functionName: 'withdraw_payout', args: [],
    expectSuccess: false, expected: 'NO_PENDING_PAYOUT', readBackFn: readAcct
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
        const acct = await readAcct();
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
