import axios from 'axios';

export interface WalrusConfig {
  publisherUrl: string;
  aggregatorUrl: string;
}

export async function uploadBlob(
  config: WalrusConfig,
  data: Buffer,
  epochs = 5
): Promise<string> {
  const res = await axios.put(
    `${config.publisherUrl}/v1/blobs?epochs=${epochs}`,
    data,
    { headers: { 'Content-Type': 'application/octet-stream' } }
  );
  const blobId =
    res.data.newlyCreated?.blobObject?.blobId ||
    res.data.alreadyCertified?.blobId;
  if (!blobId) throw new Error(`No blobId in Walrus response`);
  return blobId;
}

export async function retrieveBlob(
  config: WalrusConfig,
  blobId: string,
  maxRetries = 5
): Promise<Buffer> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.get(
        `${config.aggregatorUrl}/v1/blobs/${blobId}`,
        { responseType: 'arraybuffer' }
      );
      return Buffer.from(res.data);
    } catch (err: any) {
      if (err.response?.status === 404 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Blob retrieval failed after retries');
}
