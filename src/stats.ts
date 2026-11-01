type Target = { pc: RTCPeerConnection; what: 'screen' | 'cam' } | null;

const LIMITS: Record<string, string> = {
  bandwidth: 'limited by internet',
  cpu: 'limited by CPU',
};

/** Compact connection readout: "Screen · 1080p · 30 fps · 4.2 Mbps · 180 ms · direct". */
export class StatsMonitor {
  private timer = 0;
  private last: { bytes: number; ts: number; key: string } | null = null;

  constructor(
    private readonly target: () => Target,
    private readonly sending: (what: 'screen' | 'cam') => boolean,
    private readonly render: (text: string) => void,
  ) {}

  start(): void {
    this.stop();
    void this.tick();
    this.timer = window.setInterval(() => void this.tick(), 2000);
  }

  stop(): void {
    clearInterval(this.timer);
    this.last = null;
  }

  private async tick(): Promise<void> {
    const t = this.target();
    if (!t) return this.render('Not connected');
    const out = this.sending(t.what);
    const report = await t.pc.getStats();
    const byId = new Map<string, any>();
    let rtp: any;
    let pairId: string | undefined;
    report.forEach((s: any) => {
      byId.set(s.id, s);
      if (s.kind === 'video' && s.type === (out ? 'outbound-rtp' : 'inbound-rtp')) {
        if (!rtp || (s.bytesSent ?? s.bytesReceived) > (rtp.bytesSent ?? rtp.bytesReceived)) rtp = s;
      }
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    let pair = pairId ? byId.get(pairId) : undefined;
    if (!pair) report.forEach((s: any) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && (pair = s));

    const parts: string[] = [t.what === 'screen' ? 'Screen' : 'Camera'];
    if (rtp) {
      if (rtp.frameHeight) parts.push(`${rtp.frameHeight}p`);
      if (rtp.framesPerSecond != null) parts.push(`${Math.round(rtp.framesPerSecond)} fps`);
      const bytes = out ? rtp.bytesSent : rtp.bytesReceived;
      const key = `${t.what}:${rtp.id}`;
      if (this.last && this.last.key === key && rtp.timestamp > this.last.ts) {
        const mbps = ((bytes - this.last.bytes) * 8) / ((rtp.timestamp - this.last.ts) / 1000) / 1e6;
        parts.push(`${mbps.toFixed(1)} Mbps`);
      }
      this.last = { bytes, ts: rtp.timestamp, key };
      if (out && rtp.qualityLimitationReason && LIMITS[rtp.qualityLimitationReason]) {
        parts.push(LIMITS[rtp.qualityLimitationReason]);
      }
    }
    if (pair) {
      if (pair.currentRoundTripTime != null) parts.push(`${Math.round(pair.currentRoundTripTime * 1000)} ms`);
      const local = byId.get(pair.localCandidateId)?.candidateType;
      const remote = byId.get(pair.remoteCandidateId)?.candidateType;
      parts.push(local === 'relay' || remote === 'relay' ? 'via TURN relay' : 'direct');
    }
    this.render(parts.join(' · '));
  }
}
