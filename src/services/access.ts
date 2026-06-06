import * as crypto from 'crypto';

export interface AccessEvent {
  event: 'ACCESS_GRANTED' | 'ACCESS_REVOKED' | 'RECORD_CREATED';
  actor: string;
  target?: string;
  blobId: string;
  expiresAt?: string;
  timestamp: string;
}

export class AccessManager {
  private logs: AccessEvent[] = [];
  private accessList: Set<string> = new Set();

  createRecord(patientAddress: string, blobId: string): AccessEvent {
    const event: AccessEvent = {
      event: 'RECORD_CREATED',
      actor: patientAddress,
      blobId,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(event);
    return event;
  }

  grantAccess(
    patientAddress: string,
    doctorAddress: string,
    blobId: string,
    durationMs = 86400000
  ): AccessEvent {
    this.accessList.add(doctorAddress);
    const event: AccessEvent = {
      event: 'ACCESS_GRANTED',
      actor: doctorAddress,
      target: doctorAddress,
      blobId,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
      timestamp: new Date().toISOString(),
    };
    this.logs.push(event);
    return event;
  }

  revokeAccess(
    patientAddress: string,
    doctorAddress: string,
    blobId: string
  ): AccessEvent {
    this.accessList.delete(doctorAddress);
    const event: AccessEvent = {
      event: 'ACCESS_REVOKED',
      actor: patientAddress,
      target: doctorAddress,
      blobId,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(event);
    return event;
  }

  hasAccess(address: string): boolean {
    return this.accessList.has(address);
  }

  getAuditLog(): AccessEvent[] {
    return [...this.logs];
  }

  generateDoctorAddress(): string {
    return '0x' + crypto.randomBytes(32).toString('hex');
  }
}
