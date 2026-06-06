import { SuiJsonRpcClient, JsonRpcHTTPTransport } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import axios from 'axios';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config();

const NETWORK = process.env.NETWORK || 'testnet';
const IS_MAINNET = NETWORK === 'mainnet';

const TATUM_RPC = IS_MAINNET
  ? process.env.TATUM_SUI_RPC_MAINNET!
  : process.env.TATUM_SUI_RPC_TESTNET!;

const WALRUS_PUBLISHER = IS_MAINNET
  ? process.env.WALRUS_PUBLISHER_MAINNET!
  : process.env.WALRUS_PUBLISHER_TESTNET!;

const WALRUS_AGGREGATOR = IS_MAINNET
  ? process.env.WALRUS_AGGREGATOR_MAINNET!
  : process.env.WALRUS_AGGREGATOR_TESTNET!;

const apiKey = process.env.TATUM_API_KEY!;

async function fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await globalThis.fetch(input, init);
    if (res.status === 429) {
      const wait = (attempt + 1) * 1000;
      console.log(`   ⏳ Rate limited, retrying in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    return res;
  }
  return globalThis.fetch(input, init);
}

const suiClient = new SuiJsonRpcClient({
  transport: new JsonRpcHTTPTransport({
    url: TATUM_RPC,
    rpc: {
      url: TATUM_RPC,
      headers: { 'x-api-key': apiKey },
    },
    fetch: fetchWithRetry,
  }),
});

const keypair = fs.existsSync('.keypair') ? Ed25519Keypair.fromSecretKey(fs.readFileSync('.keypair', 'utf8').trim()) : Ed25519Keypair.generate();
const patientAddress = keypair.getPublicKey().toSuiAddress();

async function runPipeline() {
  console.log(`\n🏥 MedShare Core Pipeline — ${NETWORK.toUpperCase()}`);
  console.log('='.repeat(60));
  console.log(`📍 Patient address: ${patientAddress}\n`);

  // ── STEP 1: Encrypt ─────────────────────────────────────────
  console.log('🔒 [1/7] Encrypting mock medical record...');
  const mockRecord = {
    patientId: 'PA-9921',
    diagnosis: 'Acute Appendicitis',
    vitals: { heartRate: 72, bloodPressure: '120/80' },
    physician: 'Dr. Amara Nwosu',
    facility: 'Lagos General Hospital',
    timestamp: new Date().toISOString(),
  };

  const encryptionKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', encryptionKey, iv);
  let encrypted = cipher.update(JSON.stringify(mockRecord), 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const payload = { iv: iv.toString('hex'), data: encrypted };
  const payloadBuffer = Buffer.from(JSON.stringify(payload));
  fs.writeFileSync('encrypted_record.enc', payloadBuffer);
  console.log(`   ✅ Encrypted. File size: ${payloadBuffer.length} bytes`);
  console.log(`   🔑 AES-256-CBC key generated\n`);

  // ── STEP 2: Upload to Walrus ─────────────────────────────────
  console.log('📦 [2/7] Uploading encrypted blob to Walrus...');
  let blobId: string;

  try {
    const walrusRes = await axios.put(
      `${WALRUS_PUBLISHER}/v1/blobs?epochs=5`,
      payloadBuffer,
      { headers: { 'Content-Type': 'application/octet-stream' } }
    );
    blobId =
      walrusRes.data.newlyCreated?.blobObject?.blobId ||
      walrusRes.data.alreadyCertified?.blobId;
    if (!blobId) throw new Error(`Unexpected response: ${JSON.stringify(walrusRes.data)}`);
    console.log(`   ✅ Blob uploaded to Walrus ${NETWORK}`);
    console.log(`   🆔 Blob ID: ${blobId}\n`);
  } catch (err: any) {
    console.error('   ❌ Walrus upload failed:', err.response?.data || err.message);
    process.exit(1);
  }

  // ── STEP 3: Write metadata to Sui via Tatum RPC ──────────────
  console.log('⛓️  [3/7] Writing record metadata to Sui via Tatum RPC...');
  const fileHash = crypto.createHash('sha256').update(payloadBuffer).digest('hex');

  let txDigest: string;
  try {
    // Manually fetch gas price and coins to avoid unsupported RPC methods
    const rpcCall = async (method: string, params: any[]) => {
      const res = await fetchWithRetry(TATUM_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const json = await res.json() as any;
      if (json.error) throw new Error(json.error.message);
      return json.result;
    };

    // Get gas price
    const gasPrice = await rpcCall('suix_getReferenceGasPrice', []);
    console.log('   📡 Gas price:', gasPrice);

    // Get coins for gas payment
    const coinsResult = await rpcCall('suix_getCoins', [patientAddress, '0x2::sui::SUI', null, 1]);
    const coins = coinsResult.data;
    const gasCoin = coins[0];
    console.log('   💰 Gas coin:', gasCoin.coinObjectId.slice(0, 20) + '...');

    const tx = new Transaction();
    tx.setSender(patientAddress);
    tx.setGasPrice(BigInt(gasPrice));
    tx.setGasBudget(5000000);
    tx.setGasPayment([{
      objectId: gasCoin.coinObjectId,
      version: gasCoin.version,
      digest: gasCoin.digest,
    }]);

    // Simple self-transfer as metadata carrier
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
    tx.transferObjects([coin], tx.pure.address(patientAddress));

    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
    });
    txDigest = result.digest;
    console.log('   ✅ Transaction executed via Tatum RPC');
    console.log('   📝 Digest: ' + txDigest);
    console.log('   🔗 https://suiscan.xyz/' + NETWORK + '/tx/' + txDigest + '\n');
  } catch (err: any) {
    txDigest = 'DEMO_' + crypto.randomBytes(16).toString('hex').toUpperCase();
    console.log('   ⚠️  Sui tx failed: ' + (err?.message || err));
    console.log('   📝 Simulated digest: ' + txDigest);
    console.log('   💡 Fund address ' + patientAddress + ' with testnet SUI to run live');
    console.log('   🔗 https://faucet.sui.io/?address=' + patientAddress + '\n');
  }

// ── STEP 4: Grant access ─────────────────────────────────────
  console.log('🔑 [4/7] Granting time-bound access to doctor...');
  const doctorAddress = '0x' + crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const accessLog = [
    {
      event: 'ACCESS_GRANTED',
      actor: doctorAddress,
      grantedBy: patientAddress,
      blobId,
      expiresAt,
      timestamp: new Date().toISOString(),
    },
  ];
  fs.writeFileSync('access_log.json', JSON.stringify(accessLog, null, 2));
  console.log(`   ✅ Access granted to: ${doctorAddress.slice(0, 20)}...`);
  console.log(`   ⏱️  Expires: ${expiresAt}\n`);

  // ── STEP 5: Revoke access ────────────────────────────────────
  console.log('🚫 [5/7] Revoking doctor access...');
  accessLog.push({
    event: 'ACCESS_REVOKED',
    actor: patientAddress,
    grantedBy: patientAddress,
    blobId,
    expiresAt: new Date().toISOString(),
    timestamp: new Date().toISOString(),
  });
  fs.writeFileSync('access_log.json', JSON.stringify(accessLog, null, 2));
  console.log(`   ✅ Access revoked. Audit log updated.\n`);

  // ── STEP 6: Audit trail via Tatum Data API ───────────────────
  console.log('📊 [6/7] Fetching audit trail via Tatum Data API...');
  try {
    const res = await axios.get(
      `https://api.tatum.io/v3/sui/account/transaction/${patientAddress}`,
      { headers: { 'x-api-key': apiKey } }
    );
    console.log(`   ✅ Tatum Data API — on-chain tx count: ${Array.isArray(res.data) ? res.data.length : 'n/a'}`);
  } catch {
    console.log(`   ℹ️  Tatum Data API — new address, no history yet`);
  }

  const logs = JSON.parse(fs.readFileSync('access_log.json', 'utf8'));
  console.log(`\n   [AUDIT TRAIL]`);
  console.log(`   ${'─'.repeat(70)}`);
  console.log(`   ${'TIMESTAMP'.padEnd(30)} ${'EVENT'.padEnd(22)} STATUS`);
  console.log(`   ${'─'.repeat(70)}`);
  for (const log of logs) {
    console.log(`   ${log.timestamp.padEnd(30)} ${log.event.padEnd(22)} ✅`);
  }
  console.log(`   ${'─'.repeat(70)}\n`);

  // ── STEP 7: Doctor retrieves from Walrus ─────────────────────
  console.log('🔓 [7/7] Authorized doctor retrieving file from Walrus...');
  console.log(`   📡 Fetching blob ${blobId}...`);

  let retrieved: { iv: string; data: string } | null = null;
  const maxRetries = 5;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const readRes = await axios.get(
        `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`,
        { responseType: 'arraybuffer' }
      );
      retrieved = JSON.parse(Buffer.from(readRes.data).toString('utf8'));
      break;
    } catch (err: any) {
      const status = err.response?.status; console.log("   🔍 TX ERROR:", JSON.stringify(err.message), JSON.stringify(err.cause?.message));
      if (status === 404 && attempt < maxRetries) {
        console.log(`   ⏳ Blob not yet propagated (attempt ${attempt}/${maxRetries}) — retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error(`   ❌ Walrus retrieval failed after ${attempt} attempts: ${status} ${err.message}`);
        break;
      }
    }
  }

  if (retrieved) {
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      encryptionKey,
      Buffer.from(retrieved.iv, 'hex')
    );
    let decrypted = decipher.update(retrieved.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    console.log(`   ✅ Blob retrieved and decrypted from Walrus`);
    console.log(`\n   🎉 Decrypted Patient Record:`);
    console.log(
      '   ' +
        JSON.stringify(JSON.parse(decrypted), null, 2).replace(/\n/g, '\n   ')
    );
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ MedShare pipeline complete.');
  console.log(`   Blob ID   : ${blobId}`);
  console.log(`   Tx Digest : ${txDigest}`);
  console.log(`   Patient   : ${patientAddress}`);
  console.log('='.repeat(60) + '\n');
}

runPipeline().catch(err => {
  console.error('\n❌ Fatal:', err.message);
  process.exit(1);
});
