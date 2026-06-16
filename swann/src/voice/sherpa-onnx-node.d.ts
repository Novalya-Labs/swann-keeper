/**
 * Minimal ambient declaration for sherpa-onnx-node.
 *
 * The package ships no TypeScript types (it is a CJS native addon), which under
 * `noImplicitAny` makes `import('sherpa-onnx-node')` an error. We declare only
 * the small surface the voice module uses: the Vad class (utterance capture)
 * and the KeywordSpotter class (on-device wake word). This lives in the voice
 * module so no shared file is touched; widen it if other modules need more.
 */
declare module 'sherpa-onnx-node' {
  // --- Silero VAD ----------------------------------------------------------
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

  // --- Keyword spotting (wake word) ----------------------------------------
  interface FeatureConfig {
    sampleRate: number;
    featureDim: number;
  }

  interface TransducerModelConfig {
    encoder: string;
    decoder: string;
    joiner: string;
  }

  interface OnlineModelConfig {
    transducer: TransducerModelConfig;
    tokens: string;
    numThreads?: number;
    provider?: string;
    debug?: boolean;
  }

  interface KeywordSpotterConfig {
    featConfig: FeatureConfig;
    modelConfig: OnlineModelConfig;
    keywordsFile: string;
    keywordsThreshold?: number;
    keywordsScore?: number;
    maxActivePaths?: number;
    numTrailingBlanks?: number;
  }

  interface KeywordResult {
    /** Empty string when no keyword matched this stream state. */
    keyword: string;
    start_time?: number;
    timestamps?: number[];
  }

  interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  /** Online streaming buffer shared by KWS / online ASR. */
  class SherpaOnlineStream {
    acceptWaveform(obj: Waveform): void;
    inputFinished(): void;
  }

  class KeywordSpotter {
    constructor(config: KeywordSpotterConfig);
    createStream(): SherpaOnlineStream;
    isReady(stream: SherpaOnlineStream): boolean;
    decode(stream: SherpaOnlineStream): void;
    reset(stream: SherpaOnlineStream): void;
    getResult(stream: SherpaOnlineStream): KeywordResult;
  }

  // --- Online ASR (diagnostic: transcribe what the model hears) -------------
  interface OnlineRecognizerConfig {
    featConfig: FeatureConfig;
    modelConfig: OnlineModelConfig;
    decodingMethod?: string;
    enableEndpoint?: boolean | number;
    rule1MinTrailingSilence?: number;
    rule2MinTrailingSilence?: number;
    rule3MinUtteranceLength?: number;
  }

  interface OnlineRecognizerResult {
    text: string;
    tokens?: string[];
  }

  class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig);
    createStream(): SherpaOnlineStream;
    isReady(stream: SherpaOnlineStream): boolean;
    decode(stream: SherpaOnlineStream): void;
    isEndpoint(stream: SherpaOnlineStream): boolean;
    reset(stream: SherpaOnlineStream): void;
    getResult(stream: SherpaOnlineStream): OnlineRecognizerResult;
  }

  const _default: {
    Vad: typeof Vad;
    KeywordSpotter: typeof KeywordSpotter;
    OnlineRecognizer: typeof OnlineRecognizer;
  };
  export default _default;
  export { Vad, KeywordSpotter, OnlineRecognizer, SherpaOnlineStream };
}
