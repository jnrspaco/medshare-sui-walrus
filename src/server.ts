import express from 'express';
import cors from 'cors';
import path from 'path';
import * as dotenv from 'dotenv';
import { encryptRecord, decryptRecord } from './services/encryption.js';
import { uploadBlob, retrieveBlob, WalrusConfig } from './services/walrus.js';
import {
  createSuiClient,
  loadOrCreateKeypair,
  writeMetadataToSui,
  getTransactionHistory,
  SuiConfig,
} from './services/sui.js';
import { AccessManager } from './services/access.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'frontend')));

const NETWORK = process.env.NETWORK || 'testnet';
const IS_MAINNET = NETWORK === 'mainnet';

const walrusConfig: WalrusConfig = {
  publisherUrl: IS_MAINNET
    ? process.env.WALRUS_PUBLISHER_MAINNET!
    : process.env.WALRUS_PUBLISHER_TESTNET!,
  aggregatorUrl: IS_MAINNET
    ? process.env.WALRUS_AGGREGATOR_MAINNET!
    : process.env.WALRUS_AGGREGATOR_TESTNET!,
};

const suiConfig: SuiConfig = {
  rpcUrl: IS_MAINNET
    ? process.env.TATUM_SUI_RPC_MAINNET!
    : process.env.TATUM_SUI_RPC_TESTNET!,
  apiKey: process.env.TATUM_API_KEY!,
  network: NETWORK,
};

const suiClient = createSuiClient(suiConfig);
const keypair = loadOrCreateKeypair();
const patientAddress = keypair.getPublicKey().toSuiAddress();
const accessManager = new AccessManager();

// In-memory session state
let sessionState: {
  encryptionKey?: Buffer;
  blobId?: string;
  txDigest?: string;
  doctorAddress?: string;
  record?: object;
} = {};

// ── API Routes ──────────────────────────────────────────────

app.get('/api/status', (_req, res) => {
  res.json({
    network: NETWORK,
    patientAddress,
    walrusPublisher: walrusConfig.publisherUrl,
    suiRpc: suiConfig.rpcUrl,
    session: {
      hasEncryptionKey: !!sessionState.encryptionKey,
      blobId: sessionState.blobId || null,
      txDigest: sessionState.txDigest || null,
      doctorAddress: sessionState.doctorAddress || null,
    },
  });
});

// Step 1: Encrypt
app.post('/api/encrypt', (req, res) => {
  try {
    const record = req.body.record || {
      patientId: 'PA-9921',
      diagnosis: 'Acute Appendicitis',
      vitals: { heartRate: 72, bloodPressure: '120/80' },
      physician: 'Dr. Amara Nwosu',
      facility: 'Lagos General Hospital',
      timestamp: new Date().toISOString(),
    };
    const result = encryptRecord(record);
    sessionState.encryptionKey = result.key;
    sessionState.record = record;
    res.json({
      step: 1,
      status: 'success',
      fileSize: result.buffer.length,
      hash: result.payload.hash,
      record,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Upload to Walrus
app.post('/api/upload', async (_req, res) => {
  try {
    if (!sessionState.encryptionKey) throw new Error('Run encrypt first');
    const result = encryptRecord(sessionState.record!);
    sessionState.encryptionKey = result.key;
    const blobId = await uploadBlob(walrusConfig, result.buffer);
    sessionState.blobId = blobId;
    accessManager.createRecord(patientAddress, blobId);
    res.json({ step: 2, status: 'success', blobId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 3: Write to Sui via Tatum
app.post('/api/register', async (_req, res) => {
  try {
    if (!sessionState.blobId) throw new Error('Run upload first');
    const result = await writeMetadataToSui(suiConfig, suiClient, keypair, {
      blobId: sessionState.blobId,
      fileHash: 'sha256:' + sessionState.blobId,
    });
    sessionState.txDigest = result.digest;
    res.json({
      step: 3,
      status: 'success',
      digest: result.digest,
      explorerUrl: result.explorerUrl,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 4: Grant access
app.post('/api/grant-access', (req, res) => {
  try {
    if (!sessionState.blobId) throw new Error('Run upload first');
    const doctorAddress =
      req.body?.doctorAddress || accessManager.generateDoctorAddress();
    sessionState.doctorAddress = doctorAddress;
    const event = accessManager.grantAccess(
      patientAddress,
      doctorAddress,
      sessionState.blobId
    );
    res.json({ step: 4, status: 'success', event });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 5: Revoke access
app.post('/api/revoke-access', (_req, res) => {
  try {
    if (!sessionState.blobId || !sessionState.doctorAddress)
      throw new Error('Run grant-access first');
    const event = accessManager.revokeAccess(
      patientAddress,
      sessionState.doctorAddress,
      sessionState.blobId
    );
    res.json({ step: 5, status: 'success', event });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 6: Audit trail
app.get('/api/audit-trail', async (_req, res) => {
  try {
    const onChain = await getTransactionHistory(suiConfig, patientAddress);
    res.json({
      step: 6,
      status: 'success',
      localLogs: accessManager.getAuditLog(),
      onChainTxCount: Array.isArray(onChain) ? onChain.length : 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 7: Retrieve & decrypt
app.post('/api/retrieve', async (_req, res) => {
  try {
    if (!sessionState.blobId || !sessionState.encryptionKey)
      throw new Error('Run the full pipeline first');
    const raw = await retrieveBlob(walrusConfig, sessionState.blobId);
    const parsed = JSON.parse(raw.toString('utf8'));
    const decrypted = decryptRecord(parsed, sessionState.encryptionKey);
    res.json({ step: 7, status: 'success', record: decrypted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 0: Run full pipeline
app.post('/api/run-pipeline', async (req, res) => {
  const steps: any[] = [];
  try {
    // Step 1
    const record = req.body?.record || {
      patientId: 'PA-9921',
      diagnosis: 'Acute Appendicitis',
      vitals: { heartRate: 72, bloodPressure: '120/80' },
      physician: 'Dr. Amara Nwosu',
      facility: 'Lagos General Hospital',
      timestamp: new Date().toISOString(),
    };
    const enc = encryptRecord(record);
    sessionState.encryptionKey = enc.key;
    sessionState.record = record;
    steps.push({ step: 1, status: 'success', fileSize: enc.buffer.length });

    // Step 2
    const blobId = await uploadBlob(walrusConfig, enc.buffer);
    sessionState.blobId = blobId;
    accessManager.createRecord(patientAddress, blobId);
    steps.push({ step: 2, status: 'success', blobId });

    // Step 3
    try {
      const suiResult = await writeMetadataToSui(
        suiConfig,
        suiClient,
        keypair,
        { blobId, fileHash: enc.payload.hash }
      );
      sessionState.txDigest = suiResult.digest;
      steps.push({
        step: 3,
        status: 'success',
        digest: suiResult.digest,
        explorerUrl: suiResult.explorerUrl,
      });
    } catch (err: any) {
      steps.push({ step: 3, status: 'simulated', error: err.message });
    }

    // Step 4
    const doctorAddress = accessManager.generateDoctorAddress();
    sessionState.doctorAddress = doctorAddress;
    const grantEvent = accessManager.grantAccess(
      patientAddress,
      doctorAddress,
      blobId
    );
    steps.push({ step: 4, status: 'success', event: grantEvent });

    // Step 5
    const revokeEvent = accessManager.revokeAccess(
      patientAddress,
      doctorAddress,
      blobId
    );
    steps.push({ step: 5, status: 'success', event: revokeEvent });

    // Step 6
    steps.push({
      step: 6,
      status: 'success',
      auditLog: accessManager.getAuditLog(),
    });

    // Step 7
    const raw = await retrieveBlob(walrusConfig, blobId);
    const parsed = JSON.parse(raw.toString('utf8'));
    const decrypted = decryptRecord(parsed, enc.key);
    steps.push({ step: 7, status: 'success', record: decrypted });

    res.json({
      pipeline: 'complete',
      network: NETWORK,
      patientAddress,
      blobId,
      txDigest: sessionState.txDigest || 'simulated',
      steps,
    });
  } catch (err: any) {
    res.status(500).json({ pipeline: 'failed', steps, error: err.message });
  }
});

// Reset session
app.post('/api/reset', (_req, res) => {
  sessionState = {};
  res.json({ status: 'reset' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏥 MedShare API running at http://localhost:${PORT}`);
  console.log(`   Network: ${NETWORK}`);
  console.log(`   Patient: ${patientAddress}`);
  console.log(`   Dashboard: http://localhost:${PORT}\n`);
});
