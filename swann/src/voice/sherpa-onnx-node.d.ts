/**
 * Minimal ambient declaration for sherpa-onnx-node.
 *
 * The package ships no TypeScript types (it is a CJS native addon), which under
 * `noImplicitAny` makes `import('sherpa-onnx-node')` an error. We declare only
 * the small surface the voice module uses (the Vad class). This lives in the
 * voice module so no shared file is touched; if the audio/mistral modules need
 * other sherpa surfaces they can widen it.
 */
declare module 'sherpa-onnx-node' {
  interface SileroVadModelConfig {
    model: string;
    threshold?: number;
    minSpeechDuration?: number;
    minSilenceDuration?: number;
    windowSize?: number;
  }

  interface VadConfig {
    sileroVad: SileroVadModelConfig;
    sampleRate: number;
  }

  interface SpeechSegment {
    samples: Float32Array;
    start: number;
  }

  class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isDetected(): boolean;
    isEmpty(): boolean;
    front(): SpeechSegment;
    pop(): void;
    flush(): void;
    reset(): void;
    clear(): void;
  }

  const _default: { Vad: typeof Vad };
  export default _default;
  export { Vad };
}
