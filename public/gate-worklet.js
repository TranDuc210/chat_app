// Cong loc tieng on (noise gate)
// File nay chay tren luong am thanh rieng cua trinh duyet, nen khong bi cham lai khi tab o che do nen.
class GateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.thr = 0;                                        // nguong (bien do tuyen tinh), 0 = khong loc
    this.env = 0;                                        // muc am thanh hien tai (duong bao)
    this.open = true;                                    // cong dang mo?
    this.hold = 0;                                       // so mau con giu cong mo sau khi het tieng
    this.holdSamples = Math.round(0.35 * sampleRate);    // giu cong mo 0,35 giay
    this.gain = 1;                                       // do loi hien tai (doi muot)
    this.atk = 1 - Math.exp(-1 / (0.004 * sampleRate));  // mo cong ~4 ms
    this.rel = 1 - Math.exp(-1 / (0.040 * sampleRate));  // dong cong ~40 ms
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      if (e.data && typeof e.data.thr === 'number') this.thr = e.data.thr;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const src = input[0];
    const dst = output[0];
    const n = src.length;

    // Muc am thanh cua khoi nay (RMS): len ngay lap tuc, ha xuong tu tu
    let sum = 0;
    for (let i = 0; i < n; i++) sum += src[i] * src[i];
    const rms = Math.sqrt(sum / n);
    this.env = Math.max(rms, this.env * 0.92);

    // Quyet dinh dong / mo cong
    if (this.thr <= 0 || this.env >= this.thr) {
      this.open = true;
      this.hold = this.holdSamples;
    } else if (this.hold > 0) {
      this.hold -= n;
    } else {
      this.open = false;
    }

    // Ap dung do loi, doi muot de khong bi tieng "tach"
    const target = this.open ? 1 : 0;
    const k = target > this.gain ? this.atk : this.rel;
    for (let i = 0; i < n; i++) {
      this.gain += (target - this.gain) * k;
      dst[i] = src[i] * this.gain;
    }

    // Bao muc am thanh ve trang web khoang 20 lan/giay (de ve thanh do)
    this.sinceReport += n;
    if (this.sinceReport >= sampleRate * 0.05) {
      this.sinceReport = 0;
      const db = 20 * Math.log10(this.env + 1e-9);
      this.port.postMessage({ db: Math.max(-100, db), open: this.open });
    }
    return true;
  }
}

registerProcessor('gate-processor', GateProcessor);