/**
 * EngineAdapter — the seam that keeps the app engine-agnostic.
 *
 * One adapter instance == one live engine session (child process or
 * thread). KimiAdapter speaks ACP; CodexAdapter (phase 6) will speak
 * app-server JSON-RPC. Both translate into `EngineEvent`s.
 */

import type { EngineEvent, GoalControlAction, PermissionMode } from '@shared/types';

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
   * 原生斜杠命令回合（opencode POST /session/{id}/command）。仅引擎侧
   * 不解析 prompt 文本里的斜杠、但提供专用命令端点时实现；由
   * SessionManager.prompt 的发送侧斜杠路由调度。attachments 为附件路径
   * （实现方按自家协议并入或文本注入）。
   */
  /** path/isSkill 仅 opencode 兜底用：服务端清单缺项时客户端读源文件展开
 * （命令模板代入 / 技能全文+base dir 提示），其余适配器忽略。 */
command?(name: string, args: string, attachments?: string[], path?: string, isSkill?: boolean): Promise<void>;
  /**
   * 原生技能注入回合（codex app-server v2 turn/start 的 {type:'skill'} 输入
   * 项 — core 直读 SKILL.md 全文注入，与 TUI $mention 等效）。仅引擎协议
   * 原生支持时实现；缺省时由路由层退回「读技能文件」文本展开。
   */
  promptSkill?(name: string, path: string, args: string): Promise<void>;
  /**
   * Inject user input into the in-flight turn (codex turn/steer).
   * Returns false when there is no steerable active turn.
   * messageId 会透传为引擎侧 client_user_message_id，用于把「RPC 已接受」和
   * 「引擎真正消费（已发给 LLM）」区分开。
   */
  steer?(text: string, attachments?: string[], messageId?: string): Promise<boolean>;
  /**
   * steer 返回 true 后引擎会异步 emit `steer.confirmed`（真正消费该输入时）。
   * 无此能力的引擎（kimi KAP 等）由 SessionManager 在 steer 成功后立即回显。
   */
  steerConfirmable?: boolean;
  /**
   * Engine-native goal surface (codex thread/goal/*). Engines without a
   * client-side goal API omit these and the UI hides the goal controls.
   */
  setGoal?(objective: string): Promise<void>;
  controlGoal?(action: GoalControlAction): Promise<void>;
  /**
   * Engine-native swarm mode toggle (kimi KAP agent_config.swarm_mode)。
   * 无原生面的引擎缺省 — UI 退回提示词引导（swarmBoost 前缀）。
   */
  setSwarm?(active: boolean): Promise<void>;
  /** Kill the engine process and release resources. */
  dispose(): Promise<void>;
}

export type EngineEventSink = (event: EngineEvent) => void;
