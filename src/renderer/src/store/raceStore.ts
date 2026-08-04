/**
 * Race store — renderer-side state slice for the 赛马 (model racing)
 * feature. Folds RaceEvent pushes into RaceGroup snapshots and fronts the
 * race IPC actions.
 *
 * Deliberately decoupled from chatStore: race lanes subscribe to their role
 * session's message ui via chatStore themselves (engine events for role
 * sessions flow through the normal engine:event pipeline).
 */

import { create } from 'zustand';

import type { RaceAdoptStrategy, RaceEventEnvelope, RaceGroup, RaceRole, RaceRoleConfig, RaceRoleConfigs, RaceStage } from '@shared/race';
import { raceRoleKey, translate } from '../i18n';
import { rlog } from '../log/logger';
import { announceSystem, useChatStore } from './chatStore';

interface RaceState {
  /** raceId → 最新快照（编排事件就地合并；缺失时整体拉取）。 */
  races: Record<string, RaceGroup>;
  /** 当前全屏打开的赛马视图；null = 不在赛马视图。 */
  activeRaceId: string | null;
  /** 发起面板（Composer 🏇 入口打开的配置对话框）。 */
  setupOpen: boolean;
  /** 选手配置调整弹窗（重试前改 A/B 引擎/模型/思考档）。 */
  tuneOpen: boolean;
  /** raceId → 最近一次编排错误（视图顶部横幅展示）。 */
  errors: Record<string, string | undefined>;
  /** 阶段切换飘字：进入新环节时短暂提示，自动消失（RaceView 渲染）。 */
  stageFlash: { raceId: string; stage: RaceStage; seq: number } | null;
  init(): Promise<void>;
  openSetup(): void;
  closeSetup(): void;
  /** 发令：创建并立即开跑，同时进入赛马视图（寄生于宿主对话）。 */
  startRace(
    prompt: string,
    cwd: string,
    roles: RaceRoleConfigs,
    parentSessionId?: string,
    contextSeed?: string,
  ): Promise<void>;
  openRace(raceId: string): void;
  closeRace(): void;
  /** ④a 采纳决策（4 选 1 + 可选评语）。 */
  adopt(strategy: RaceAdoptStrategy, comment?: string): Promise<void>;
  /** ④a 反悔：撤回采纳决策（裁判尚未出方案时），回到选策略关口。 */
  revokeAdopt(): Promise<void>;
  /** 让裁判按既定策略重新出方案（换裁判引擎后手动重跑，v+1 覆盖）。 */
  rerunJudge(): Promise<void>;
  /** ④c 批注 → 裁判修订。 */
  revise(annotation: string): Promise<void>;
  /** 定稿 → Builder。 */
  finalize(): Promise<void>;
  /** 重启后继续被打断的赛马（重跑当前阶段）。 */
  resumeRace(): Promise<void>;
  openTune(): void;
  closeTune(): void;
  /** 手动关闭错误横幅（仅清本地展示态，不影响主进程编排；阶段重试
   *  入口仍在各泳道的「重试」按钮上）。 */
  dismissError(): void;
  /** 重试前调整选手配置（仅 racerA/racerB）。 */
  updateRole(role: RaceRole, cfg: RaceRoleConfig): Promise<void>;
  /** 单选手重试：只补跑该选手当前阶段回合。 */
  retryRacer(role: RaceRole): Promise<void>;
  /** ✂ 剔除选手（三人以上在场且裁判选策略前；不可逆）。 */
  eliminateRacer(role: RaceRole): Promise<void>;
  /** 裁判选策略前回退：清空产物重跑双规划。 */
  restartPlanning(): Promise<void>;
  cancelRace(): Promise<void>;
}

type SetFn = (fn: (s: RaceState) => Partial<RaceState>) => void;

let unsubscribe: (() => void) | undefined;

/** 事件先于快照到达（如刚创建）时，整体拉一次该 race。 */
function refreshRace(set: SetFn, raceId: string): void {
  void window.cyberslots.raceGet(raceId).then((g) => {
    if (g) set((s) => ({ races: { ...s.races, [raceId]: g } }));
  });
}

// 阶段飘字自动消失：时长与 index.css 的 race-stage-toast 动画同步，
// 动画淡出结束后 store 才清掉，避免元素在淡出中途被突然卸载。
const STAGE_FLASH_MS = 2600;
let flashSeq = 0;

function flashStage(set: SetFn, raceId: string, stage: RaceStage): void {
  const seq = ++flashSeq;
  set(() => ({ stageFlash: { raceId, stage, seq } }));
  window.setTimeout(() => {
    // 只清自己那条：期间又来了新飘字（seq 更大）则由新定时器负责。
    set((s) => (s.stageFlash?.seq === seq ? { stageFlash: null } : {}));
  }, STAGE_FLASH_MS);
}

function applyRaceEvent(set: SetFn, envelope: RaceEventEnvelope): void {
  const { raceId, event } = envelope;
  // 阶段确实发生变化时记下新阶段，set 完成后触发飘字（避免在
  // set 回调内嵌套 set 副作用）。
  let entered: RaceStage | undefined;
  set((s) => {
    const g = s.races[raceId];
    if (!g) {
      refreshRace(set, raceId);
      return {};
    }
    const next: RaceGroup = { ...g, updatedAt: envelope.ts };
    switch (event.type) {
      case 'race.stage':
        // 阶段推进 = 上一个错误已翻篇，顺手清掉错误横幅。
        if (g.stage !== event.stage) entered = event.stage;
        next.stage = event.stage;
        return { races: { ...s.races, [raceId]: next }, errors: { ...s.errors, [raceId]: undefined } };
      case 'race.role': {
        next.sessions = { ...next.sessions, [event.role]: event.sessionId };
        // 角色会话由主进程创建，renderer 会话表未收录 → 拉一次，
        // 使泳道能读到该会话真实运行状态（后续 session.status 实时更新）。
        void window.cyberslots.sessionList().then((sessions) => useChatStore.setState({ sessions }));
        break;
      }
      case 'race.artifacts':
        next.artifacts = event.artifacts;
        break;
      case 'race.eliminated': {
        next.eliminated = [...(g.eliminated ?? []), event.role];
        // 剔除痕迹回流宿主对话；若错误横幅正是被剔者贡献的，一并清掉。
        if (g.parentSessionId) {
          announceSystem(g.parentSessionId, translate('raceAnnounceEliminated', { role: translate(raceRoleKey(event.role)) }));
        }
        return { races: { ...s.races, [raceId]: next }, errors: { ...s.errors, [raceId]: undefined } };
      }
      case 'race.finalPlan':
        next.finalPlan = event.text;
        next.finalPlanVersion = event.version;
        break;
      case 'race.audit':
        next.audit = { passed: event.passed, issues: event.issues };
        next.repairRound = event.repairRound;
        break;
      case 'race.stats':
        next.stats = event.stats;
        break;
      case 'race.done': {
        if (g.stage !== 'done') entered = 'done';
        next.stage = 'done';
        // 产出回流宿主对话：留下可回溯的收尾公告（寄生闭环）。
        if (g.parentSessionId) {
          announceSystem(
            g.parentSessionId,
            event.delivered
              ? translate('raceAnnounceDoneDelivered', { prompt: g.prompt.slice(0, 40), v: g.finalPlanVersion })
              : translate('raceAnnounceDoneEnded', { prompt: g.prompt.slice(0, 40) }),
          );
        }
        break;
      }
      case 'race.error':
        return {
          races: { ...s.races, [raceId]: next },
          errors: { ...s.errors, [raceId]: event.message },
        };
    }
    return { races: { ...s.races, [raceId]: next } };
  });
  if (entered) flashStage(set, raceId, entered);
}

export const useRaceStore = create<RaceState>((set, get) => ({
  races: {},
  activeRaceId: null,
  setupOpen: false,
  tuneOpen: false,
  errors: {},
  stageFlash: null,

  async init() {
    const list = await window.cyberslots.raceList();
    set({ races: Object.fromEntries(list.map((g) => [g.id, g])) });
    unsubscribe?.();
    unsubscribe = window.cyberslots.onRaceEvent((envelope) => applyRaceEvent(set, envelope));
  },

  openSetup() {
    set({ setupOpen: true });
  },

  closeSetup() {
    set({ setupOpen: false });
  },

  async startRace(prompt, cwd, roles, parentSessionId, contextSeed) {
    rlog.info('race', 'race start requested', { cwd, promptChars: prompt.length, parentSessionId });
    const g = await window.cyberslots.raceCreate({ prompt, cwd, roles, parentSessionId, contextSeed }).catch((err) => {
      rlog.error('race', 'raceCreate ipc failed', { cwd }, err);
      throw err;
    });
    // 发起痕迹回流宿主对话 —— 历史里能翻到“这里跑过一场赛马”。
    if (parentSessionId) {
      announceSystem(parentSessionId, translate('raceAnnounceStarted', { prompt: prompt.slice(0, 40) }));
    }
    set((s) => ({
      races: { ...s.races, [g.id]: g },
      activeRaceId: g.id,
      setupOpen: false,
      errors: { ...s.errors, [g.id]: undefined },
    }));
  },

  openRace(raceId) {
    set({ activeRaceId: raceId });
    refreshRace(set, raceId); // 后台跑的赛马重新打开时同步最新快照
  },

  closeRace() {
    set({ activeRaceId: null });
  },

  async adopt(strategy, comment) {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    // 乐观标记 adopt，UI 立即切到「裁判出方案中」；权威快照随事件到达。
    set((s) => {
      const g = s.races[raceId];
      return g ? { races: { ...s.races, [raceId]: { ...g, adopt: { strategy, comment } } } } : {};
    });
    await window.cyberslots.raceAdopt(raceId, strategy, comment).catch((err) => {
      rlog.error('race', 'raceAdopt ipc failed', { raceId, strategy }, err);
      throw err;
    });
  },

  async revise(annotation) {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    set((s) => {
      const g = s.races[raceId];
      return g ? { races: { ...s.races, [raceId]: { ...g, annotations: [...g.annotations, annotation] } } } : {};
    });
    await window.cyberslots.raceRevise(raceId, annotation);
  },

  async finalize() {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    await window.cyberslots.raceFinalize(raceId).catch((err) => {
      rlog.error('race', 'raceFinalize ipc failed', { raceId }, err);
      throw err;
    });
  },

  async resumeRace() {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    // 乐观清除打断标记与错误，后续阶段事件会把权威状态推回来。
    set((s) => {
      const g = s.races[raceId];
      return {
        ...(g ? { races: { ...s.races, [raceId]: { ...g, interrupted: false } } } : {}),
        errors: { ...s.errors, [raceId]: undefined },
      };
    });
    await window.cyberslots.raceResume(raceId);
    refreshRace(set, raceId);
  },

  openTune() {
    set({ tuneOpen: true });
  },

  closeTune() {
    set({ tuneOpen: false });
  },

  dismissError() {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    set((s) => ({ errors: { ...s.errors, [raceId]: undefined } }));
  },

  async updateRole(role, cfg) {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    await window.cyberslots.raceUpdateRole(raceId, role, cfg);
    // 调参后若阶段已停摆，主进程会自动重跑该选手 —— 旧错误横幅随之作废。
    set((s) => ({ errors: { ...s.errors, [raceId]: undefined } }));
    refreshRace(set, raceId);
  },

  async revokeAdopt() {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    await window.cyberslots.raceRevokeAdopt(raceId);
    set((s) => ({ errors: { ...s.errors, [raceId]: undefined } }));
    refreshRace(set, raceId); // adopt 已清，拉权威快照回到选策略关口
  },

  async rerunJudge() {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    set((s) => ({ errors: { ...s.errors, [raceId]: undefined } }));
    await window.cyberslots.raceRerunJudge(raceId);
  },

  async retryRacer(role) {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    set((s) => ({ errors: { ...s.errors, [raceId]: undefined } }));
    await window.cyberslots.raceRetryRacer(raceId, role);
  },

  async eliminateRacer(role) {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    await window.cyberslots.raceEliminate(raceId, role);
  },

  async restartPlanning() {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    set((s) => ({ errors: { ...s.errors, [raceId]: undefined } }));
    await window.cyberslots.raceRestartPlanning(raceId);
    refreshRace(set, raceId);
  },

  async cancelRace() {
    const raceId = get().activeRaceId;
    if (!raceId) return;
    await window.cyberslots.raceCancel(raceId).catch((err) => {
      rlog.error('race', 'raceCancel ipc failed', { raceId }, err);
      throw err;
    });
  },
}));
