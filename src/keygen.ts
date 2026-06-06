import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import * as fs from 'fs';

const keypair = Ed25519Keypair.generate();
const exported = keypair.getSecretKey();
const address = keypair.getPublicKey().toSuiAddress();

fs.writeFileSync('.keypair', exported);
console.log('✅ Keypair saved to .keypair');
console.log(`📍 Address: ${address}`);
console.log(`\n🚰 Fund this address at:`);
console.log(`   https://faucet.sui.io/?address=${address}`);
