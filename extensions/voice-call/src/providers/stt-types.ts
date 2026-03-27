/**
 * Provider-neutral contract for voice-call streaming transcription.
 *
 * Keep this surface narrow so media-stream handling can support both realtime
 * providers and buffered/local backends without depending on one vendor class.
 */
export interface VoiceCallStreamingSttSession {
  /** Connect to the transcription service. */
  connect(): Promise<void>;
  /** Send mu-law audio data (8kHz mono). */
  sendAudio(audio: Buffer): void;
  /** Wait for the next completed transcript. */
  waitForTranscript(timeoutMs?: number): Promise<string>;
  /** Receive partial transcript updates. */
  onPartial(callback: (partial: string) => void): void;
  /** Receive finalized transcripts. */
  onTranscript(callback: (transcript: string) => void): void;
  /** Observe speech-start events for barge-in handling. */
  onSpeechStart(callback: () => void): void;
  /** Close the session. */
  close(): void;
  /** Check whether the session is connected. */
  isConnected(): boolean;
}

export interface VoiceCallStreamingSttProvider {
  readonly name: string;
  createSession(): VoiceCallStreamingSttSession;
}
