/**
 * EngineAdapter — the seam that keeps the app engine-agnostic.
 *
 * One adapter instance == one live engine session (child process or
 * thread). KimiAdapter speaks ACP; CodexAdapter (phase 6) will speak
 * app-server JSON-RPC. Both translate into `EngineEvent`s.
 */

import type { EngineEvent, PermissionMode } from '@shared/types';

export interface EngineAdapter {
  /** Spawn/connect and create the underlying engine session. */
  start(): Promise<{ engineSessionId: string }>;
  /** Send a user prompt; resolves when the turn ends. */
  prompt(text: string, attachments?: string[], effort?: string): Promise<void>;
  /** Interrupt the active turn. */
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  /** Answer a pending permission / ask-user request. */
  answerPermission(requestId: string, optionId?: string): void;
  /**
   * Fork the live engine session into an independent copy (sidechat).
   * Optional — engines without native fork omit it; implementations
   * return null when the CLI rejects the method (client then falls back
   * to history replay).
   */
  fork?(): Promise<{ engineSessionId: string } | null>;
  /** Compact/summarize the conversation context. Optional per engine. */
  compact?(): Promise<void>;
  /**
   * Inject user input into the in-flight turn (codex turn/steer).
   * Returns false when there is no steerable active turn.
   */
  steer?(text: string): Promise<boolean>;
  /** Kill the engine process and release resources. */
  dispose(): Promise<void>;
}

export type EngineEventSink = (event: EngineEvent) => void;
