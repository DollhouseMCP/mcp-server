/** Trusted dormant composition only; no config/request or restored object can open this boot. */
export interface MemoryBootIdentity {
  readonly tenant: string;
  readonly store: object;
  readonly backend: 'database';
}
interface Qualification {
  readonly identity: MemoryBootIdentity;
  readonly epoch: number;
}
export class DatabaseMemoryBootQualification {
  private epoch = 0;
  private current?: Qualification;
  private readonly qualifications = new WeakSet<object>();

  /** Always starts closed. Final trusted composition owns the actual inspection callback. */
  async qualify(identity: MemoryBootIdentity, inspect: (captured: MemoryBootIdentity) => Promise<void>): Promise<void> {
    this.close();
    if (typeof identity.tenant !== 'string' || !identity.tenant || identity.backend !== 'database' ||
      !identity.store || typeof identity.store !== 'object') this.refuse();
    const capturedIdentity = Object.freeze({ ...identity });
    const epoch = this.epoch;
    await inspect(capturedIdentity);
    if (epoch !== this.epoch || identity.tenant !== capturedIdentity.tenant || identity.store !== capturedIdentity.store ||
      identity.backend !== capturedIdentity.backend) this.refuse();
    const qualification = Object.freeze({ identity: capturedIdentity, epoch });
    this.qualifications.add(qualification);
    this.current = qualification;
  }

  /** An unknown outcome or operator stop invalidates already captured qualification too. */
  close(): void { this.epoch++; this.current = undefined; }

  isQualified(identity: MemoryBootIdentity): boolean {
    return this.current?.epoch === this.epoch && this.current.identity.tenant === identity.tenant &&
      this.current.identity.store === identity.store && identity.backend === 'database';
  }

  capture(identity: MemoryBootIdentity): object {
    const qualification = this.current;
    if (!identity.tenant || qualification?.identity.tenant !== identity.tenant ||
      qualification.identity.store !== identity.store || identity.backend !== 'database') this.refuse();
    return qualification;
  }

  require(captured: object, identity: MemoryBootIdentity): void {
    if (!this.qualifications.has(captured) || captured !== this.current ||
      (captured as Qualification).epoch !== this.epoch || this.capture(identity) !== captured) this.refuse();
  }

  private refuse(): never {
    throw Object.assign(new Error('Fresh guarded memory boot qualification required'), { code: 'EMEMORYBOOT' });
  }
}
