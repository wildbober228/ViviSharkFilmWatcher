export const QUALITY = {
  high: { label: '1080p · up to 5 Mbps', height: 1080, bitrate: 5_000_000 },
  mid: { label: '720p · up to 2.5 Mbps', height: 720, bitrate: 2_500_000 },
  low: { label: '480p · up to 1 Mbps', height: 480, bitrate: 1_000_000 },
} as const;
export type QualityKey = keyof typeof QUALITY;
export type ViewMode = 'movie' | 'browse';

const camConstraints = (deviceId?: string): MediaTrackConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
});

const micConstraints = (deviceId?: string): MediaTrackConstraints => ({
  ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
});

/**
 * Camera + mic as one stream that always has exactly one video and one audio track.
 * Missing devices are replaced by black/silent placeholders so the WebRTC call still
 * negotiates both directions and real devices can be swapped in later via replaceTrack.
 */
export class LocalMedia {
  readonly stream = new MediaStream();
  camOn = true;
  micOn = true;
  realCam = false;
  realMic = false;

  get videoTrack(): MediaStreamTrack | undefined {
    return this.stream.getVideoTracks()[0];
  }
  get audioTrack(): MediaStreamTrack | undefined {
    return this.stream.getAudioTracks()[0];
  }

  /** Returns a warning to show the user, or null. */
  async init(camId?: string, micId?: string): Promise<string | null> {
    const md = navigator.mediaDevices;
    let got: MediaStream | null = null;
    let warn: string | null = null;

    if (!md?.getUserMedia) {
      warn = 'This browser can’t use the camera. Open the link in Safari or Chrome (not inside a messenger app).';
    } else {
      const attempts: MediaStreamConstraints[] = [
        { video: camConstraints(camId), audio: micConstraints(micId) },
        { video: camConstraints(), audio: micConstraints() },
        { audio: micConstraints() },
        { video: camConstraints() },
      ];
      let cause: unknown;
      for (const c of attempts) {
        try {
          got = await md.getUserMedia(c);
          break;
        } catch (e) {
          cause ??= e;
          const name = (e as DOMException).name;
          if (name === 'NotAllowedError' || name === 'SecurityError') break;
        }
      }
      if (!got) warn = deviceProblem('camera and microphone', cause);
      else if (!got.getVideoTracks().length) warn = deviceProblem('camera', cause);
      else if (!got.getAudioTracks().length) warn = deviceProblem('microphone', cause);
    }

    const v = got?.getVideoTracks()[0];
    const a = got?.getAudioTracks()[0];
    this.realCam = !!v;
    this.realMic = !!a;

    const video = v ?? blackVideoTrack();
    const audio = a ?? silentAudioTrack();
    if (video) this.stream.addTrack(video);
    if (audio) this.stream.addTrack(audio);
    this.setCam(this.realCam);
    this.setMic(this.realMic);
    return warn;
  }

  setCam(on: boolean): void {
    this.camOn = on && this.realCam;
    if (this.videoTrack) this.videoTrack.enabled = this.camOn;
  }

  setMic(on: boolean): void {
    this.micOn = on && this.realMic;
    if (this.audioTrack) this.audioTrack.enabled = this.micOn;
  }

  async switchDevice(kind: 'video' | 'audio', deviceId?: string): Promise<MediaStreamTrack> {
    const constraints =
      kind === 'video' ? { video: camConstraints(deviceId) } : { audio: micConstraints(deviceId) };
    const fresh = (await navigator.mediaDevices.getUserMedia(constraints)).getTracks()[0];
    const old = kind === 'video' ? this.videoTrack : this.audioTrack;
    if (old) {
      this.stream.removeTrack(old);
      old.stop();
    }
    this.stream.addTrack(fresh);
    if (kind === 'video') {
      this.realCam = true;
      this.setCam(true);
    } else {
      this.realMic = true;
      this.setMic(true);
    }
    return fresh;
  }

  /** iOS can end capture tracks while the app is in the background; reopen them. */
  async revive(): Promise<MediaStreamTrack[]> {
    const fresh: MediaStreamTrack[] = [];
    const checks: Array<['video' | 'audio', MediaStreamTrack | undefined, boolean]> = [
      ['video', this.videoTrack, this.realCam],
      ['audio', this.audioTrack, this.realMic],
    ];
    for (const [kind, track, real] of checks) {
      if (!real || !track || track.readyState !== 'ended') continue;
      const wasOn = kind === 'video' ? this.camOn : this.micOn;
      try {
        fresh.push(await this.switchDevice(kind, track.getSettings().deviceId));
        if (kind === 'video') this.setCam(wasOn);
        else this.setMic(wasOn);
      } catch {
        /* device gone — keep the dead track */
      }
    }
    return fresh;
  }
}

/** Plain-language reason a camera / mic couldn't be opened, with what to do about it. */
export function deviceProblem(what: string, err: unknown): string {
  const name = (err as DOMException | undefined)?.name;
  const message = (err as Error | undefined)?.message ?? '';
  const button = what.includes(' and ') ? 'the camera or mic button' : `the ${what} button`;
  if (name === 'NotAllowedError' && /system/i.test(message)) {
    return `Windows is blocking the ${what}: Settings → Privacy & security → Camera / Microphone → allow desktop apps. Then tap ${button}.`;
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `The ${what} is blocked for this site — allow it via the icon on the left of the address bar, then tap ${button}.`;
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return `The ${what} is busy in another app (Zoom, Discord, OBS…). Close it, then tap ${button}.`;
  }
  return `No ${what} found on this device. Plug one in, then tap ${button}.`;
}

function blackVideoTrack(): MediaStreamTrack | undefined {
  const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
  const g = canvas.getContext('2d');
  if (g) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  const s = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream?.(1);
  return s?.getVideoTracks()[0];
}

function silentAudioTrack(): MediaStreamTrack | undefined {
  try {
    const ctx = new AudioContext();
    return ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
  } catch {
    return undefined;
  }
}

/**
 * Tab / window / screen capture with sound. `focusCaptured` decides whether Chrome jumps
 * to the shared tab right away (we stay on our tab when the floating camera window isn't open yet).
 */
export async function captureDisplay(focusCaptured: boolean): Promise<MediaStream> {
  const Controller = (window as unknown as { CaptureController?: new () => unknown }).CaptureController;
  const controller = Controller ? (new Controller() as { setFocusBehavior?: (b: string) => void }) : undefined;
  const options: Record<string, unknown> = {
    video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
      // Keep our own tab (the partner's voice) out of whole-screen system audio where supported.
      restrictOwnAudio: true,
    },
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
    preferCurrentTab: false,
  };
  if (controller) options.controller = controller;
  const stream = await navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions);
  try {
    controller?.setFocusBehavior?.(focusCaptured ? 'focus-captured-surface' : 'no-focus-change');
  } catch {
    /* screen surfaces don't support focus control */
  }
  return stream;
}

/** Stream a local file straight from the <video> element — sharper and cleaner than screen capture. */
export async function captureFromVideo(video: HTMLVideoElement): Promise<MediaStream> {
  if (video.readyState < 2) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the file didn’t open')), 10_000);
      video.addEventListener('loadeddata', () => (clearTimeout(timer), resolve()), { once: true });
      video.addEventListener('error', () => (clearTimeout(timer), reject(new Error('this format isn’t supported'))), {
        once: true,
      });
    });
  }
  const el = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  const capture = el.captureStream ?? el.mozCaptureStream;
  if (!capture) throw new Error('this browser can’t stream files — use Chrome or Edge');
  const stream = capture.call(el);
  // Tracks can show up a moment after captureStream() returns.
  for (let i = 0; i < 20 && (!stream.getVideoTracks().length || !stream.getAudioTracks().length); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!stream.getVideoTracks().length) throw new Error('the file has no video');
  return stream;
}

/** Bitrate caps: the movie gets the bandwidth, the camera bubbles stay light. */
export function tuneSender(
  sender: RTCRtpSender,
  kind: 'cam' | 'screen',
  quality: QualityKey,
  sourceHeight: number,
): void {
  const track = sender.track;
  if (!track) return;
  const params = sender.getParameters();
  const enc = params.encodings?.[0];
  if (!enc) return;
  if (kind === 'cam') {
    if (track.kind !== 'video') return;
    enc.maxBitrate = 700_000;
    enc.maxFramerate = 24;
  } else if (track.kind === 'video') {
    const q = QUALITY[quality];
    const height = track.getSettings().height || sourceHeight || q.height;
    enc.maxBitrate = q.bitrate;
    enc.maxFramerate = 30;
    enc.scaleResolutionDownBy = Math.max(1, height / q.height);
  } else {
    enc.maxBitrate = 192_000;
  }
  sender.setParameters(params).catch((e) => console.warn('setParameters', e));
}

/** Ask for stereo, high-bitrate Opus so movie sound isn't squashed into a mono voice codec. */
export function opusStereo(sdp: string): string {
  const pts = [...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000\/2/gi)].map((m) => m[1]);
  for (const pt of pts) {
    sdp = sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`, 'g'), (_line, params: string) => {
      const kept = params
        .split(';')
        .map((p) => p.trim())
        .filter((p) => p && !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(p));
      kept.push('stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=192000');
      return `a=fmtp:${pt} ${kept.join(';')}`;
    });
  }
  return sdp;
}
