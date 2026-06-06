import { SuiJsonRpcClient, JsonRpcHTTPTransport } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import * as fs from 'fs';

export interface SuiConfig {
  rpcUrl: string;
  apiKey: string;
  network: string;
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await globalThis.fetch(input, init);
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, (attempt + 1) * 1000));
      continue;
    }
    return res;
  }
  return globalThis.fetch(input, init);
}

export function createSuiClient(config: SuiConfig) {
  return new SuiJsonRpcClient({
    transport: new JsonRpcHTTPTransport({
      url: config.rpcUrl,
      rpc: {
        url: config.rpcUrl,
        headers: { 'x-api-key': config.apiKey },
      },
      fetch: fetchWithRetry,
    }),
  });
}

export function loadOrCreateKeypair(): Ed25519Keypair {
  if (process.env.SUI_PRIVATE_KEY) {
    return Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY.trim());
  }
  if (fs.existsSync('.keypair')) {
    return Ed25519Keypair.fromSecretKey(
      fs.readFileSync('.keypair', 'utf8').trim()
    );
  }
  const kp = Ed25519Keypair.generate();
  fs.writeFileSync('.keypair', kp.getSecretKey());
  return kp;
}

async function rpcCall(
  config: SuiConfig,
  method: string,
  params: any[]
): Promise<any> {
  const res = await fetchWithRetry(config.rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

export async function writeMetadataToSui(
  config: SuiConfig,
  client: SuiJsonRpcClient,
  keypair: Ed25519Keypair,
  metadata: { blobId: string; fileHash: string }
): Promise<{ digest: string; explorerUrl: string }> {
  const address = keypair.getPublicKey().toSuiAddress();

  const gasPrice = await rpcCall(config, 'suix_getReferenceGasPrice', []);
  const coinsResult = await rpcCall(config, 'suix_getCoins', [
    address,
    '0x2::sui::SUI',
    null,
    1,
  ]);
  const coins = coinsResult.data;
  if (!coins?.length) throw new Error('No SUI coins — address not funded');

  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasPrice(BigInt(gasPrice));
  tx.setGasBudget(5000000);
  tx.setGasPayment([
    {
      objectId: coins[0].coinObjectId,
      version: coins[0].version,
      digest: coins[0].digest,
    },
  ]);

  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(0)]);
  tx.transferObjects([coin], tx.pure.address(address));

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
  });

  return {
    digest: result.digest,
    explorerUrl: `https://suiscan.xyz/${config.network}/tx/${result.digest}`,
  };
}

export async function getTransactionHistory(
  config: SuiConfig,
  address: string
): Promise<any> {
  try {
    const res = await fetchWithRetry(
      `https://api.tatum.io/v3/sui/account/transaction/${address}`,
      { headers: { 'x-api-key': config.apiKey } }
    );
    return await res.json();
  } catch {
    return [];
  }
}
