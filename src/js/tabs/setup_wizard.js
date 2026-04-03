import semver from 'semver';
import * as config from '@/js/config.js';
import { API_VERSION_12_8 } from '@/js/configurator.svelte.js';
import { Mixer } from '@/js/Mixer.js';
import { serial } from '@/js/serial.js';
import { reinitialiseConnection } from "@/js/serial_backend.js";

const tab = {
    tabName: 'setup_wizard',
};

const WIZARD_SCREENS = 13;
const LAST_INDEX = WIZARD_SCREENS - 1;

/** 持久化布局版本：v2 起尾部拆为两屏，screenIndex≥10 的旧会话需 +1。 */
const WIZARD_STATE_VERSION = 2;

const STORAGE_KEY = 'rftuner_setup_wizard_state_v1';

let wizardHelpPrevScreenIndex = 0;

/** 在发送 MSP_SET_REBOOT 之前调用，确保断线/重连时走 `activateSetupWizardAfterReconnect` → `tab.onReconnect`。 */
function stageSetupWizardReconnectAfterReboot(reason) {
    GUI.setupWizardDisconnectPending = true;
    config.set({ lastTab: 'setup_wizard' });
    GUI.log(`[SetupWizard] stageReconnect: ${reason || 'reboot'} pending=${GUI.setupWizardDisconnectPending} active_tab=${GUI.active_tab}`);
    console.log('[SetupWizard] stageSetupWizardReconnectAfterReboot', reason, {
        pending: GUI.setupWizardDisconnectPending,
        active_tab: GUI.active_tab,
    });
}

const WIZARD_RECEIVER_INTERVAL_MS = 50;
const WIZARD_RECEIVER_INTERVAL_NAME = 'wizard_receiver_pull';

const SWASH_SERVO_INDICES = [0, 1, 2];
const TAIL_SERVO_INDEX = 3;

// `src/tabs/mixer.html`：主旋翼旋转方向 main_rotor_dir — 0 顺时针，1 逆时针。
// 集体螺距控制方向：`FC.MIXER_INPUTS[4]` 的 rate 符号（混控页 #mixerCollectiveDirection）。
const MIXER_INPUT_COLLECTIVE_INDEX = 4;
/** Mixer inputs index for cyclic roll (aileron); matches `src/js/tabs/mixer.js` / #mixerAileronDirection. */
const MIXER_INPUT_AILERON_INDEX = 1;
/** Mixer inputs index for cyclic pitch (elevator); matches #mixerElevatorDirection. */
const MIXER_INPUT_ELEVATOR_INDEX = 2;
/** Stabilized yaw / tail; matches `mixer.js` override row axis 3. */
const MIXER_INPUT_TAIL_INDEX = 3;

/** Main cyclic axes: same scale as `mixer.js` `overrideMixer` mixerMainRotor rows. */
const WIZARD_MIXER_MAIN_SCALE = 0.012;
/** Tail rotor vs motorized tail: same as `mixer.js` mixerTailRotor / mixerTailMotor. */
const WIZARD_MIXER_TAIL_SCALE_ROTOR = 0.024;
const WIZARD_MIXER_TAIL_SCALE_MOTOR = 0.1;

/** Swash trim in FC: 0.1% per unit; step 2 == 0.2% (see mixer `#mixerSwashRollTrim` scaling). */
const WIZARD_SWASH_TRIM_STEP = 2;
/** ±100.0% display range → ±1000 internal (mixer inputs use max 100 on form). */
const WIZARD_SWASH_TRIM_ABS_MAX = 1000;

/** 与 `mixer.html` 循环/集体螺距校准一致：min 20–200%，step 0.1%；内部 rate 为显示值×10。 */
const WIZARD_PITCH_CALIB_RATE_STEP = 2;
const WIZARD_PITCH_CALIB_RATE_ABS_MIN = 200;
const WIZARD_PITCH_CALIB_RATE_ABS_MAX = 2000;

/** 尾桨航向校准（`mixerTailRotorCalibration`）：显示 10–500%，每次 ±0.2% → rate ±2。 */
const WIZARD_TAIL_YAW_CALIB_RATE_ABS_MIN = 100;
const WIZARD_TAIL_YAW_CALIB_RATE_ABS_MAX = 5000;

/** 尾桨中心微调：与混控一致，电动尾为 %、普通尾桨为 °，每次 ±0.2。 */
const WIZARD_TAIL_CENTER_TRIM_STEP_DISP = 0.2;

/** 尾桨行程极限：与混控 `mixerTailRotorMinYaw` / `MaxYaw`（或 Motor 等价）一致，每次 ±0.2（显示单位）。 */
const WIZARD_TAIL_TRAVEL_STEP_DISP = 0.2;

// Keep in sync with `src/js/tabs/servos.js` (FLAG_REVERSE = 1).
const SERVO_FLAG_REVERSE = 1;

// Maps the UX "neutral point (us)" presets to FC.SERVO_CONFIG fields.
// Values are exactly the ones you specified for 1520/760/960us.
const SERVO_NEUTRAL_POINT_MAP = {
    '1520': { mid: 1500, min: -700, max: 700, rneg: 500, rpos: 500 },
    '760': { mid: 750, min: -350, max: 350, rneg: 250, rpos: 250 },
    '960': { mid: 1000, min: -433, max: 433, rneg: 333, rpos: 333 },
};

// UX "frequency" options map 1:1 to FC.SERVO_CONFIG.rate.
const SERVO_FREQUENCY_VALUES = [50, 120, 165, 200, 333, 560];

// Mapping for screen 2: Install orientation (right-side 2x2 tiles)
// to BOARD_ALIGNMENT_CONFIG roll/pitch/yaw (degrees).
const INSTALL_TO_BOARD_ALIGNMENT_MAP = {
    // 正面朝上，出线向前
    '1': { roll: 0, pitch: 0, yaw: 0 },
    // 正面朝上，出线向后
    '2': { roll: 0, pitch: 0, yaw: 180 },
    // 正面朝下，出线向前
    '3': { roll: 180, pitch: 0, yaw: 0 },
    // 正面朝下，出线向后
    '4': { roll: 0, pitch: 180, yaw: 0 },
};

// Mapping for screen 2: Swashplate type + elevator/aileron direction.
// Swash type numbers are taken from `src/js/Mixer.js`:
// SWASH_TYPE_120 = 2, SWASH_TYPE_135 = 3, SWASH_TYPE_140 = 4.
const SWASH_SELECTION_TO_MIXER_MAP = {
    // Row 1: HR3 — elevator reverse, aileron normal
    hr3_120: { swashType: 2, elevatorDir: -1, aileronDir: 1 },
    hr3_135: { swashType: 3, elevatorDir: -1, aileronDir: 1 },
    hr3_140: { swashType: 4, elevatorDir: -1, aileronDir: 1 },
    // Row 2: H3 — elevator + aileron normal (H3 135/140: 135/140 + both normal)
    h3_120: { swashType: 2, elevatorDir: 1, aileronDir: 1 },
    h3_135: { swashType: 3, elevatorDir: 1, aileronDir: 1 },
    h3_140: { swashType: 4, elevatorDir: 1, aileronDir: 1 },
};

/** Legacy session keys from older wizard builds */
const LEGACY_SWASH_VALUE_MAP = {
    h3: 'h3_120',
    hr3: 'hr3_120',
    135: 'hr3_135',
    140: 'hr3_140',
};

function normalizeSwashSelectionValue(raw) {
    if (!raw) return '';
    return LEGACY_SWASH_VALUE_MAP[raw] || raw;
}

/** 与 auxiliary / adjustments Tab 一致：前 5 通道为摇杆，AUX 从索引 0 起。 */
const WIZARD_PRIMARY_RC_CHANNELS = 5;
const WIZARD_ADJ_ALWAYS_ON_CH = 255;

/** 一键基础数据目标（与计划一致） */
const QUICK_BASIC_ARM_AUX = 0;
const QUICK_BASIC_ANGLE_AUX = 2;
const QUICK_BASIC_MODE_MIN = 1900;
const QUICK_BASIC_MODE_MAX = 2100;
const QUICK_BASIC_ADJ_FUNC_RATE = 1;
const QUICK_BASIC_ADJ_FUNC_PID = 2;
const QUICK_BASIC_ADJ_VALUE_CH = 1;
const QUICK_BASIC_ADJ_ENA = { start: 1500, end: 1500 };
const QUICK_BASIC_ADJ_PARAM = { start: 970, end: 2025 };
const QUICK_BASIC_ADJ_VAL = { min: 1, max: 3 };
const QUICK_BASIC_ADJ_RANGE2 = { start: 1500, end: 1500 };

/** 'idle' | 'writing' | 'done' */
let wizardQuickBasicUiState = 'idle';

function wizardQuickBasicIsWriting() {
    return wizardQuickBasicUiState === 'writing';
}

function getBoxIdByAuxName(name) {
    const idx = FC.AUX_CONFIG.indexOf(name);
    if (idx < 0 || idx >= FC.AUX_CONFIG_IDS.length) {
        return null;
    }
    return FC.AUX_CONFIG_IDS[idx];
}

function ensureModeRangesExtraAligned() {
    const n = FC.MODE_RANGES.length;
    while (FC.MODE_RANGES_EXTRA.length < n) {
        const i = FC.MODE_RANGES_EXTRA.length;
        const r = FC.MODE_RANGES[i] || { id: 0 };
        FC.MODE_RANGES_EXTRA.push({
            id: r.id,
            modeLogic: 0,
            linkedTo: 0,
        });
    }
}

function modeSlotMatchesTarget(i, modeId, auxIdx, rMin, rMax) {
    const r = FC.MODE_RANGES[i];
    const ex = FC.MODE_RANGES_EXTRA[i];
    if (!r || !ex) {
        return false;
    }
    if (ex.linkedTo !== 0) {
        return false;
    }
    return (
        r.id === modeId &&
        r.auxChannelIndex === auxIdx &&
        r.range.start === rMin &&
        r.range.end === rMax
    );
}

function hasModeRangeTarget(modeId, auxIdx, rMin, rMax) {
    for (let i = 0; i < FC.MODE_RANGES.length; i++) {
        if (modeSlotMatchesTarget(i, modeId, auxIdx, rMin, rMax)) {
            return true;
        }
    }
    return false;
}

/**
 * 与 auxiliary 页「空槽」判定一致：模式表里只显示有效范围（见 auxiliary.js dataToForm 中
 * range.start >= range.end 则 continue）；保存时若条数少于读回长度，formToData 会补 defaultModeRange（id:0, 900–900）。
 * ARM 的 box id 也是 0，一键校验统计时必须排除这类「未用数组项」，否则会误报多余 ARM。
 */
function isModeSlotEmpty(i) {
    const r = FC.MODE_RANGES[i];
    const ex = FC.MODE_RANGES_EXTRA[i];
    if (!r || !ex) {
        return false;
    }
    if (ex.linkedTo !== 0) {
        return false;
    }
    return r.id === 0 && r.range.start >= r.range.end;
}

/** 同上：未在模式 UI 中作为一条有效范围展示，但存在于 MODE_RANGES 固定长度数组中的项。 */
function isModeRangeInactivePlaceholderSlot(r, ex) {
    if (!r || !ex) {
        return false;
    }
    if (ex.linkedTo !== 0) {
        return false;
    }
    return r.id === 0 && r.range.start >= r.range.end;
}

function findModeSlotForWrite(modeId) {
    for (let i = 0; i < FC.MODE_RANGES.length; i++) {
        if (isModeSlotEmpty(i)) {
            return i;
        }
    }
    for (let i = 0; i < FC.MODE_RANGES.length; i++) {
        const ex = FC.MODE_RANGES_EXTRA[i];
        if (ex && ex.linkedTo === 0 && FC.MODE_RANGES[i].id === modeId) {
            return i;
        }
    }
    return -1;
}

function writeModeSlot(i, modeId, auxIdx, rMin, rMax) {
    FC.MODE_RANGES[i] = {
        id: modeId,
        auxChannelIndex: auxIdx,
        range: { start: rMin, end: rMax },
    };
    FC.MODE_RANGES_EXTRA[i] = {
        id: modeId,
        modeLogic: 0,
        linkedTo: 0,
    };
}

function adjustmentMatchesQuickBasic(adj, adjFunction) {
    if (!adj || adj.adjFunction !== adjFunction) {
        return false;
    }
    if (adj.enaChannel !== WIZARD_ADJ_ALWAYS_ON_CH) {
        return false;
    }
    if (adj.enaRange.start !== QUICK_BASIC_ADJ_ENA.start || adj.enaRange.end !== QUICK_BASIC_ADJ_ENA.end) {
        return false;
    }
    if (adj.adjChannel !== QUICK_BASIC_ADJ_VALUE_CH) {
        return false;
    }
    if (
        adj.adjRange1.start !== QUICK_BASIC_ADJ_PARAM.start ||
        adj.adjRange1.end !== QUICK_BASIC_ADJ_PARAM.end
    ) {
        return false;
    }
    if (adj.adjMin !== QUICK_BASIC_ADJ_VAL.min || adj.adjMax !== QUICK_BASIC_ADJ_VAL.max) {
        return false;
    }
    if (adj.adjStep !== 0) {
        return false;
    }
    if (
        adj.adjRange2.start !== QUICK_BASIC_ADJ_RANGE2.start ||
        adj.adjRange2.end !== QUICK_BASIC_ADJ_RANGE2.end
    ) {
        return false;
    }
    return true;
}

function hasAdjustmentTarget(adjFunction) {
    for (let i = 0; i < FC.ADJUSTMENT_RANGES.length; i++) {
        if (adjustmentMatchesQuickBasic(FC.ADJUSTMENT_RANGES[i], adjFunction)) {
            return true;
        }
    }
    return false;
}

function writeAdjustmentSlot(i, adjFunction) {
    FC.ADJUSTMENT_RANGES[i] = {
        adjFunction,
        enaChannel: WIZARD_ADJ_ALWAYS_ON_CH,
        enaRange: { ...QUICK_BASIC_ADJ_ENA },
        adjChannel: QUICK_BASIC_ADJ_VALUE_CH,
        adjRange1: { ...QUICK_BASIC_ADJ_PARAM },
        adjRange2: { ...QUICK_BASIC_ADJ_RANGE2 },
        adjMin: QUICK_BASIC_ADJ_VAL.min,
        adjMax: QUICK_BASIC_ADJ_VAL.max,
        adjStep: 0,
    };
}

function findAdjustmentSlotForWrite(adjFunction, excludeIndex) {
    for (let i = 0; i < FC.ADJUSTMENT_RANGES.length; i++) {
        if (i === excludeIndex) {
            continue;
        }
        if (FC.ADJUSTMENT_RANGES[i].adjFunction === 0) {
            return i;
        }
    }
    for (let i = 0; i < FC.ADJUSTMENT_RANGES.length; i++) {
        if (i === excludeIndex) {
            continue;
        }
        if (FC.ADJUSTMENT_RANGES[i].adjFunction === adjFunction) {
            return i;
        }
    }
    return -1;
}

/** 与 auxiliary 中占位槽一致：`id === 0` 且 `range.start >= range.end` */
function clearModeSlot(i) {
    FC.MODE_RANGES[i] = {
        id: 0,
        auxChannelIndex: 0,
        range: { start: 900, end: 900 },
    };
    FC.MODE_RANGES_EXTRA[i] = {
        id: 0,
        modeLogic: 0,
        linkedTo: 0,
    };
}

/** 与 adjustment 关闭/未用时一致（`adjFunction === 0` 且 `adjStep === 1` 的步进型） */
function clearAdjustmentSlot(i) {
    FC.ADJUSTMENT_RANGES[i] = {
        adjFunction: 0,
        enaChannel: 0,
        enaRange: { start: 1500, end: 1500 },
        adjChannel: 0,
        adjRange1: { start: 1500, end: 1500 },
        adjRange2: { start: 1500, end: 1500 },
        adjMin: 0,
        adjMax: 100,
        adjStep: 1,
    };
}

/**
 * 统计某 modeId 下：与目标一致的「好」行数、其余（链接/错误范围/重复好行）「坏」行数。
 * 目标状态：good === 1 且 bad === 0。
 */
function getModeTargetRowsSummary(modeId, auxIdx, rMin, rMax) {
    let good = 0;
    let bad = 0;
    for (let i = 0; i < FC.MODE_RANGES.length; i++) {
        const r = FC.MODE_RANGES[i];
        const ex = FC.MODE_RANGES_EXTRA[i];
        if (!ex || !r || r.id !== modeId) {
            continue;
        }
        if (isModeRangeInactivePlaceholderSlot(r, ex)) {
            continue;
        }
        if (ex.linkedTo === 0 && modeSlotMatchesTarget(i, modeId, auxIdx, rMin, rMax)) {
            good++;
        } else {
            bad++;
        }
    }
    return { good, bad };
}

/**
 * @returns {null | { kind: string, slot?: number, count?: number }}
 */
function getAdjustmentIntegrityIssue() {
    const pidIdx = [];
    const rateIdx = [];
    for (let i = 0; i < FC.ADJUSTMENT_RANGES.length; i++) {
        const adj = FC.ADJUSTMENT_RANGES[i];
        const f = adj.adjFunction;
        if (f === QUICK_BASIC_ADJ_FUNC_PID) {
            if (adjustmentMatchesQuickBasic(adj, QUICK_BASIC_ADJ_FUNC_PID)) {
                pidIdx.push(i);
            } else {
                return { kind: 'pid_wrong', slot: i };
            }
        } else if (f === QUICK_BASIC_ADJ_FUNC_RATE) {
            if (adjustmentMatchesQuickBasic(adj, QUICK_BASIC_ADJ_FUNC_RATE)) {
                rateIdx.push(i);
            } else {
                return { kind: 'rate_wrong', slot: i };
            }
        }
    }
    if (pidIdx.length > 1) {
        return { kind: 'pid_dup', count: pidIdx.length };
    }
    if (rateIdx.length > 1) {
        return { kind: 'rate_dup', count: rateIdx.length };
    }
    return null;
}


function evaluateQuickBasicConfig() {
    const auxCount = (FC.RC?.active_channels ?? 0) - WIZARD_PRIMARY_RC_CHANNELS;
    if (auxCount < 3) {
        return {
            ok: false,
            reason: 'aux',
            detail: 'aux_count',
            extra: { current: auxCount, need: 3 },
        };
    }
    const armId = getBoxIdByAuxName('ARM');
    if (armId == null) {
        return { ok: false, reason: 'box', detail: 'missing_arm_name' };
    }
    const angleId = getBoxIdByAuxName('ANGLE');
    if (angleId == null) {
        return { ok: false, reason: 'box', detail: 'missing_angle_name' };
    }
    if (!FC.MODE_RANGES?.length) {
        return { ok: false, reason: 'mode', detail: 'no_mode_ranges' };
    }
    if (FC.MODE_RANGES.length !== FC.MODE_RANGES_EXTRA?.length) {
        return {
            ok: false,
            reason: 'mode',
            detail: 'mode_len_mismatch',
            extra: {
                modeRanges: FC.MODE_RANGES.length,
                modeExtra: FC.MODE_RANGES_EXTRA?.length ?? 0,
            },
        };
    }
    const armSum = getModeTargetRowsSummary(
        armId,
        QUICK_BASIC_ARM_AUX,
        QUICK_BASIC_MODE_MIN,
        QUICK_BASIC_MODE_MAX,
    );
    if (armSum.good === 0) {
        return { ok: false, reason: 'mode', detail: 'missing_arm_range' };
    }
    if (armSum.bad > 0 || armSum.good > 1) {
        return { ok: false, reason: 'mode', detail: 'extraneous_arm' };
    }

    const angleSum = getModeTargetRowsSummary(
        angleId,
        QUICK_BASIC_ANGLE_AUX,
        QUICK_BASIC_MODE_MIN,
        QUICK_BASIC_MODE_MAX,
    );
    if (angleSum.good === 0) {
        return { ok: false, reason: 'mode', detail: 'missing_angle_range' };
    }
    if (angleSum.bad > 0 || angleSum.good > 1) {
        return { ok: false, reason: 'mode', detail: 'extraneous_angle' };
    }
    if (!FC.ADJUSTMENT_RANGES?.length) {
        return { ok: false, reason: 'adj', detail: 'no_adj_array' };
    }
    if (!hasAdjustmentTarget(QUICK_BASIC_ADJ_FUNC_PID)) {
        return { ok: false, reason: 'adj', detail: 'missing_pid' };
    }
    if (!hasAdjustmentTarget(QUICK_BASIC_ADJ_FUNC_RATE)) {
        return { ok: false, reason: 'adj', detail: 'missing_rate' };
    }
    const adjIssue = getAdjustmentIntegrityIssue();
    if (adjIssue) {
        return {
            ok: false,
            reason: 'adj',
            detail: 'adj_integrity',
            extra: adjIssue,
        };
    }
    return { ok: true };
}

/**
 * 将一键失败原因打到日志（多行，便于排查）。
 * @param {string} phase — 阶段说明，如 read / apply / verify
 * @param {{ ok?: boolean, reason?: string, detail?: string, extra?: Record<string, unknown> } | null} ev
 * @param {{ skipHeader?: boolean }} [opts]
 */
function logQuickBasicEvaluateFailure(phase, ev, opts) {
    const title = i18n.getMessage('setupWizardQuickBasicFailedTitle');
    if (!opts?.skipHeader) {
        GUI.log(`${title} [${phase}]`);
    }
    if (!ev || ev.ok) {
        GUI.log(i18n.getMessage('setupWizardQuickBasicFailUnknown'));
        return;
    }
    const r = ev.reason || 'unknown';
    const d = ev.detail || '';
    const ex = ev.extra || {};

    if (r === 'aux') {
        GUI.log(
            i18n.getMessage('setupWizardQuickBasicFailAux', {
                current: String(ex.current ?? '?'),
                need: String(ex.need ?? 3),
            }),
        );
        return;
    }
    if (r === 'box') {
        if (d === 'missing_arm_name') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailBoxArm'));
        } else if (d === 'missing_angle_name') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailBoxAngle'));
        } else {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailBox', { detail: d }));
        }
        return;
    }
    if (r === 'mode') {
        if (d === 'no_mode_ranges') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailModeEmpty'));
        } else if (d === 'mode_len_mismatch') {
            GUI.log(
                i18n.getMessage('setupWizardQuickBasicFailModeLen', {
                    mr: String(ex.modeRanges ?? '?'),
                    mre: String(ex.modeExtra ?? '?'),
                }),
            );
        } else if (d === 'missing_arm_range') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailModeNoArm'));
        } else if (d === 'missing_angle_range') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailModeNoAngle'));
        } else if (d === 'extraneous_arm') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailModeExtraArm'));
        } else if (d === 'extraneous_angle') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailModeExtraAngle'));
        } else {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailMode', { detail: d }));
        }
        return;
    }
    if (r === 'adj') {
        if (d === 'no_adj_array') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjEmpty'));
        } else if (d === 'missing_pid') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjMissingPid'));
        } else if (d === 'missing_rate') {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjMissingRate'));
        } else if (d === 'adj_integrity' && ex.kind) {
            const k = ex.kind;
            if (k === 'pid_wrong') {
                GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjBadPid', { slot: String(ex.slot) }));
            } else if (k === 'rate_wrong') {
                GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjBadRate', { slot: String(ex.slot) }));
            } else if (k === 'pid_dup') {
                GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjDupPid', { count: String(ex.count) }));
            } else if (k === 'rate_dup') {
                GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjDupRate', { count: String(ex.count) }));
            } else {
                GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdj', { detail: k }));
            }
        } else {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdj', { detail: d || 'unknown' }));
        }
    }
}

function logQuickBasicPatchFailure(patch) {
    const title = i18n.getMessage('setupWizardQuickBasicFailedTitle');
    const err = patch?.error;
    if (!err) {
        return;
    }
    GUI.log(`${title} [apply]`);
    if (err === 'aux') {
        const ex = patch.extra || {};
        GUI.log(
            i18n.getMessage('setupWizardQuickBasicFailAux', {
                current: String(ex.current ?? '?'),
                need: String(ex.need ?? 3),
            }),
        );
        return;
    }
    if (err === 'box_arm') {
        GUI.log(i18n.getMessage('setupWizardQuickBasicFailBoxArm'));
        return;
    }
    if (err === 'box_angle') {
        GUI.log(i18n.getMessage('setupWizardQuickBasicFailBoxAngle'));
        return;
    }
    if (err === 'mode_slot_arm') {
        GUI.log(i18n.getMessage('setupWizardQuickBasicFailModeSlotArm'));
        return;
    }
    if (err === 'mode_slot_angle') {
        GUI.log(i18n.getMessage('setupWizardQuickBasicFailModeSlotAngle'));
        return;
    }
    if (err === 'adj_slot_pid') {
        GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjSlotPid'));
        return;
    }
    if (err === 'adj_slot_rate') {
        GUI.log(i18n.getMessage('setupWizardQuickBasicFailAdjSlotRate'));
        return;
    }
    GUI.log(i18n.getMessage('setupWizardQuickBasicFailPatch', { code: String(err) }));
}

/**
 * 归一化某 flight mode：只保留一条与目标一致的非链接范围（保留最小槽下标），
 * 删除同 modeId 下其余行（链接、错误范围、重复的正确行）。
 */
function normalizeModeSlotsForQuickBasic(modeId, auxIdx, rMin, rMax) {
    ensureModeRangesExtraAligned();
    let changed = false;
    const goodIndices = [];
    for (let i = 0; i < FC.MODE_RANGES.length; i++) {
        const r = FC.MODE_RANGES[i];
        const ex = FC.MODE_RANGES_EXTRA[i];
        if (!ex || !r || r.id !== modeId) {
            continue;
        }
        if (ex.linkedTo === 0 && modeSlotMatchesTarget(i, modeId, auxIdx, rMin, rMax)) {
            goodIndices.push(i);
        }
    }
    const keepIdx = goodIndices.length ? Math.min(...goodIndices) : -1;
    for (let i = 0; i < FC.MODE_RANGES.length; i++) {
        const r = FC.MODE_RANGES[i];
        const ex = FC.MODE_RANGES_EXTRA[i];
        if (!ex || !r || r.id !== modeId) {
            continue;
        }
        const isExactGood =
            ex.linkedTo === 0 && modeSlotMatchesTarget(i, modeId, auxIdx, rMin, rMax);
        if (isExactGood && keepIdx === i) {
            continue;
        }
        if (isModeRangeInactivePlaceholderSlot(r, ex)) {
            continue;
        }
        clearModeSlot(i);
        changed = true;
    }
    return changed;
}

/**
 * 按 patch 发送模式与调整并写 EEPROM。
 */
function sendQuickBasicPatchToFc(patch, onEepromDone) {
    const afterModes = () => {
        if (!patch.adjChanged) {
            MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, onEepromDone);
            return;
        }
        mspHelper.sendAdjustmentRanges(() => {
            MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, onEepromDone);
        });
    };
    if (!patch.modeChanged) {
        afterModes();
        return;
    }
    mspHelper.sendModeRanges(afterModes);
}

/**
 * 清除与一键目标不符的 PID/Rate 调整行（或重复的合法行）。
 */
function clearAdjustmentConflictsForQuickBasic() {
    let changed = false;
    const pidGood = [];
    const rateGood = [];
    for (let i = 0; i < FC.ADJUSTMENT_RANGES.length; i++) {
        const adj = FC.ADJUSTMENT_RANGES[i];
        const f = adj.adjFunction;
        if (f === QUICK_BASIC_ADJ_FUNC_PID) {
            if (adjustmentMatchesQuickBasic(adj, QUICK_BASIC_ADJ_FUNC_PID)) {
                pidGood.push(i);
            } else {
                clearAdjustmentSlot(i);
                changed = true;
            }
        } else if (f === QUICK_BASIC_ADJ_FUNC_RATE) {
            if (adjustmentMatchesQuickBasic(adj, QUICK_BASIC_ADJ_FUNC_RATE)) {
                rateGood.push(i);
            } else {
                clearAdjustmentSlot(i);
                changed = true;
            }
        }
    }
    while (pidGood.length > 1) {
        const idx = pidGood.pop();
        clearAdjustmentSlot(idx);
        changed = true;
    }
    while (rateGood.length > 1) {
        const idx = rateGood.pop();
        clearAdjustmentSlot(idx);
        changed = true;
    }
    return changed;
}

/**
 * 应用补丁到 FC：先删与目标不一致的现有项，再写入目标。
 */
function applyQuickBasicPatchesToFC() {
    let modeChanged = false;
    let adjChanged = false;

    const auxCount = (FC.RC?.active_channels ?? 0) - WIZARD_PRIMARY_RC_CHANNELS;
    if (auxCount < 3) {
        return {
            modeChanged: false,
            adjChanged: false,
            error: 'aux',
            extra: { current: auxCount, need: 3 },
        };
    }

    const armId = getBoxIdByAuxName('ARM');
    if (armId == null) {
        return { modeChanged: false, adjChanged: false, error: 'box_arm' };
    }
    const angleId = getBoxIdByAuxName('ANGLE');
    if (angleId == null) {
        return { modeChanged: false, adjChanged: false, error: 'box_angle' };
    }

    ensureModeRangesExtraAligned();

    if (normalizeModeSlotsForQuickBasic(armId, QUICK_BASIC_ARM_AUX, QUICK_BASIC_MODE_MIN, QUICK_BASIC_MODE_MAX)) {
        modeChanged = true;
    }
    if (normalizeModeSlotsForQuickBasic(angleId, QUICK_BASIC_ANGLE_AUX, QUICK_BASIC_MODE_MIN, QUICK_BASIC_MODE_MAX)) {
        modeChanged = true;
    }

    if (!hasModeRangeTarget(armId, QUICK_BASIC_ARM_AUX, QUICK_BASIC_MODE_MIN, QUICK_BASIC_MODE_MAX)) {
        const si = findModeSlotForWrite(armId);
        if (si < 0) {
            return { modeChanged, adjChanged, error: 'mode_slot_arm' };
        }
        writeModeSlot(si, armId, QUICK_BASIC_ARM_AUX, QUICK_BASIC_MODE_MIN, QUICK_BASIC_MODE_MAX);
        modeChanged = true;
    }

    if (!hasModeRangeTarget(angleId, QUICK_BASIC_ANGLE_AUX, QUICK_BASIC_MODE_MIN, QUICK_BASIC_MODE_MAX)) {
        const si = findModeSlotForWrite(angleId);
        if (si < 0) {
            return { modeChanged, adjChanged, error: 'mode_slot_angle' };
        }
        writeModeSlot(si, angleId, QUICK_BASIC_ANGLE_AUX, QUICK_BASIC_MODE_MIN, QUICK_BASIC_MODE_MAX);
        modeChanged = true;
    }

    if (clearAdjustmentConflictsForQuickBasic()) {
        adjChanged = true;
    }

    let pidSlot = -1;
    if (!hasAdjustmentTarget(QUICK_BASIC_ADJ_FUNC_PID)) {
        pidSlot = findAdjustmentSlotForWrite(QUICK_BASIC_ADJ_FUNC_PID, -1);
        if (pidSlot < 0) {
            return { modeChanged, adjChanged, error: 'adj_slot_pid' };
        }
        writeAdjustmentSlot(pidSlot, QUICK_BASIC_ADJ_FUNC_PID);
        adjChanged = true;
    }

    if (!hasAdjustmentTarget(QUICK_BASIC_ADJ_FUNC_RATE)) {
        const ex = pidSlot >= 0 ? pidSlot : -1;
        const rateSlot = findAdjustmentSlotForWrite(QUICK_BASIC_ADJ_FUNC_RATE, ex);
        if (rateSlot < 0) {
            return { modeChanged, adjChanged, error: 'adj_slot_rate' };
        }
        writeAdjustmentSlot(rateSlot, QUICK_BASIC_ADJ_FUNC_RATE);
        adjChanged = true;
    }

    return { modeChanged, adjChanged, error: null };
}

function loadQuickBasicMspData() {
    return Promise.resolve(true)
        .then(() => MSP.promise(MSPCodes.MSP_STATUS))
        .then(() => MSP.promise(MSPCodes.MSP_RC))
        .then(() => MSP.promise(MSPCodes.MSP_BOXIDS))
        .then(() => MSP.promise(MSPCodes.MSP_BOXNAMES))
        .then(() => MSP.promise(MSPCodes.MSP_MODE_RANGES))
        .then(() => MSP.promise(MSPCodes.MSP_MODE_RANGES_EXTRA))
        .then(() => MSP.promise(MSPCodes.MSP_ADJUSTMENT_RANGES));
}

function setWizardQuickBasicUIState(state) {
    wizardQuickBasicUiState = state;
    const $root = $('.tab-setup-wizard');
    // Always strip root classes first: if `.wizard-btn-quick-basic` is missing we used to return early
    // and left `wizard-quick-basic-busy` on the DOM while JS state could already be `idle`.
    $root.removeClass('wizard-quick-basic-busy wizard-quick-basic-done');

    const $btn = $root.find('.wizard-btn-quick-basic');
    if (!$btn.length) {
        return;
    }

    $btn.removeClass('wizard-btn-quick-basic--done');
    $btn.prop('disabled', false);

    if (state === 'writing') {
        $root.addClass('wizard-quick-basic-busy');
        $btn.prop('disabled', true);
        $btn.text(i18n.getMessage('setupWizardQuickBasicWriting'));
        return;
    }
    if (state === 'done') {
        $root.addClass('wizard-quick-basic-done');
        $btn.addClass('wizard-btn-quick-basic--done');
        $btn.prop('disabled', true);
        $btn.text(i18n.getMessage('setupWizardQuickBasicDone'));
        return;
    }
    $btn.text(i18n.getMessage('setupWizardQuickBasicSetup'));
}

function refreshWizardQuickBasicStatusFromFC() {
    return loadQuickBasicMspData()
        .then(() => {
            const ev = evaluateQuickBasicConfig();
            if (ev.ok) {
                setWizardQuickBasicUIState('done');
            } else {
                setWizardQuickBasicUIState('idle');
            }
        })
        .catch(() => {
            setWizardQuickBasicUIState('idle');
        });
}

function runWizardQuickBasicWrite() {
    if (wizardQuickBasicUiState === 'done' || wizardQuickBasicUiState === 'writing') {
        return;
    }

    setWizardQuickBasicUIState('writing');

    loadQuickBasicMspData()
        .then(() => {
            const pre = evaluateQuickBasicConfig();
            if (pre.ok) {
                setWizardQuickBasicUIState('done');
                return null;
            }

            const patch = applyQuickBasicPatchesToFC();
            if (patch.error) {
                logQuickBasicPatchFailure(patch);
                setWizardQuickBasicUIState('idle');
                return null;
            }

            if (!patch.modeChanged && !patch.adjChanged) {
                GUI.log(i18n.getMessage('setupWizardQuickBasicFailedTitle'));
                GUI.log(i18n.getMessage('setupWizardQuickBasicFailPatchNoop'));
                logQuickBasicEvaluateFailure('state_after_apply', evaluateQuickBasicConfig(), { skipHeader: true });
                setWizardQuickBasicUIState('idle');
                return null;
            }

            return new Promise((resolve, reject) => {
                let verifyRetryUsed = false;

                const runVerifyAfterEeprom = () => {
                    loadQuickBasicMspData()
                        .then(() => {
                            const v = evaluateQuickBasicConfig();
                            if (v.ok) {
                                setWizardQuickBasicUIState('done');
                                resolve();
                                return;
                            }
                            if (!verifyRetryUsed) {
                                verifyRetryUsed = true;
                                const p2 = applyQuickBasicPatchesToFC();
                                if (p2.error) {
                                    logQuickBasicPatchFailure(p2);
                                } else if (p2.modeChanged || p2.adjChanged) {
                                    GUI.log(i18n.getMessage('setupWizardQuickBasicVerifyRetry'));
                                    sendQuickBasicPatchToFc(p2, () => {
                                        GUI.log(i18n.getMessage('eepromSaved'));
                                        runVerifyAfterEeprom();
                                    });
                                    return;
                                }
                            }
                            GUI.log(i18n.getMessage('setupWizardQuickBasicFailVerifyTitle'));
                            logQuickBasicEvaluateFailure('verify_after_eeprom', v, { skipHeader: true });
                            setWizardQuickBasicUIState('idle');
                            resolve();
                        })
                        .catch(() => {
                            setWizardQuickBasicUIState('idle');
                            reject(new Error('verify'));
                        });
                };

                const afterEeprom = () => {
                    GUI.log(i18n.getMessage('eepromSaved'));
                    runVerifyAfterEeprom();
                };

                sendQuickBasicPatchToFc(patch, afterEeprom);
            });
        })
        .catch(() => {
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailedTitle'));
            GUI.log(i18n.getMessage('setupWizardQuickBasicFailMspRead'));
            setWizardQuickBasicUIState('idle');
        })
        .finally(() => {
            if (wizardQuickBasicUiState === 'writing') {
                setWizardQuickBasicUIState('idle');
            }
        });
}

function defaultState() {
    return {
        screenIndex: 0,
        stateVersion: WIZARD_STATE_VERSION,
        dirIndex: 1,
        motorPoles: '',
        // Defaults for screen 1 (servo type selection)
        swashNeutralPoint: '1520',
        swashFrequency: '50',
        tailNeutralPoint: '760',
        tailFrequency: '50',
        swash: '',
        install: '',
    };
}

function readState() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** 每次从侧栏正常进入向导（完整 load）时调用；断联保留 DOM 时不会走 initialize，故仍可用 session 恢复。 */
function clearPersistedWizardState() {
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        /* ignore */
    }
}

function persistPatch(patch) {
    try {
        const cur = { ...defaultState(), ...readState() };
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...patch }));
    } catch {
        /* ignore quota / private mode */
    }
}

function wizardMixerPassthroughSupported() {
    return semver.gte(FC.CONFIG.apiVersion, API_VERSION_12_8);
}

function wizardClampOverrideValue(v) {
    return Math.max(Mixer.OVERRIDE_MIN, Math.min(Mixer.OVERRIDE_MAX, v));
}

/** Same as mixer tab `add_override` for main rotor axes (deg → MSP). */
function wizardMainDegToOverride(deg) {
    return wizardClampOverrideValue(Math.round((Number(deg) || 0) / WIZARD_MIXER_MAIN_SCALE));
}

function wizardTailDegToOverride(deg) {
    const scale = FC.MIXER_CONFIG.tail_rotor_mode > 0 ? WIZARD_MIXER_TAIL_SCALE_MOTOR : WIZARD_MIXER_TAIL_SCALE_ROTOR;
    return wizardClampOverrideValue(Math.round((Number(deg) || 0) / scale));
}

/**
 * Sets mixer inputs 1–4 (roll, pitch, tail, collective) and sends MSP in order.
 * @param {{ mode: 'passthrough' | 'values', roll?: number, pitch?: number, collective?: number, tail?: number }} opts
 * @param {function} [onComplete]
 */
function wizardSetFourAxes(opts, onComplete) {
    const passthroughOk = wizardMixerPassthroughSupported();
    if (opts.mode === 'passthrough' && passthroughOk) {
        FC.MIXER_OVERRIDE[MIXER_INPUT_AILERON_INDEX] = Mixer.OVERRIDE_PASSTHROUGH;
        FC.MIXER_OVERRIDE[MIXER_INPUT_ELEVATOR_INDEX] = Mixer.OVERRIDE_PASSTHROUGH;
        FC.MIXER_OVERRIDE[MIXER_INPUT_TAIL_INDEX] = Mixer.OVERRIDE_PASSTHROUGH;
        FC.MIXER_OVERRIDE[MIXER_INPUT_COLLECTIVE_INDEX] = Mixer.OVERRIDE_PASSTHROUGH;
    } else {
        const roll = opts.roll ?? 0;
        const pitch = opts.pitch ?? 0;
        const collective = opts.collective ?? 0;
        const tail = opts.tail ?? 0;
        FC.MIXER_OVERRIDE[MIXER_INPUT_AILERON_INDEX] = wizardMainDegToOverride(roll);
        FC.MIXER_OVERRIDE[MIXER_INPUT_ELEVATOR_INDEX] = wizardMainDegToOverride(pitch);
        FC.MIXER_OVERRIDE[MIXER_INPUT_TAIL_INDEX] = wizardTailDegToOverride(tail);
        FC.MIXER_OVERRIDE[MIXER_INPUT_COLLECTIVE_INDEX] = wizardMainDegToOverride(collective);
    }

    mspHelper.sendMixerOverride(MIXER_INPUT_AILERON_INDEX, function () {
        mspHelper.sendMixerOverride(MIXER_INPUT_ELEVATOR_INDEX, function () {
            mspHelper.sendMixerOverride(MIXER_INPUT_TAIL_INDEX, function () {
                mspHelper.sendMixerOverride(MIXER_INPUT_COLLECTIVE_INDEX, onComplete);
            });
        });
    });
}

/** Idle mixer state when navigating to wizard screens 5–10 (no in-screen test). */
function applyWizardMixerForScreen(screenIndex) {
    const i = screenIndex | 0;
    if (i === 5 || i === 8 || i === 9 || i === 10) {
        wizardSetFourAxes({ mode: 'passthrough' });
        return;
    }
    if (i === 6 || i === 7) {
        wizardSetFourAxes({ mode: 'values', roll: 0, pitch: 0, collective: 0, tail: 0 });
    }
}

function syncWizardMixerScreen8Idle() {
    wizardSetFourAxes({ mode: 'passthrough' });
}

function syncWizardMixerScreen9Idle() {
    wizardSetFourAxes({ mode: 'passthrough' });
}

function syncWizardMixerScreen10Idle() {
    wizardSetFourAxes({ mode: 'passthrough' });
}

function resetPitchCalibScreenUI() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="8"]');
    if (!$s.length) return;
    $s.removeClass(
        'wizard-pitch-test-mode-collective wizard-pitch-test-mode-cyclic wizard-pitch-zero-test-mode',
    );
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').removeClass('disabled');
    $s.find('.wizard-body--pitch-calib .wizard-calib-block .regular-button').removeClass('disabled');
    $s.find('.wizard-calib-pitch-test-btn').text(i18n.getMessage('setupWizardTestBtn'));
    $s.find('.wizard-calib-pitch-adjust-btn').addClass('disabled');
    $s.find('.wizard-calib-pitch-zero-btn').text(i18n.getMessage('setupWizardZeroBtn'));
}

/** 第一步「归零」：混控四轴覆盖为 0°；顶栏/底栏及其余块置灰，归零键变为「完成」。 */
function applyPitchZeroTestModeActive() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="8"]');
    if (!$s.length) return;
    resetPitchCalibScreenUI();
    $s.addClass('wizard-pitch-zero-test-mode');
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').addClass('disabled');
    $s.find('.wizard-pitch-calib-main .regular-button').addClass('disabled');
    $s.find('.wizard-calib-pitch-zero-btn').removeClass('disabled').text(i18n.getMessage('setupWizardTestEndBtn'));
    wizardSetFourAxes({ mode: 'values', roll: 0, pitch: 0, collective: 0, tail: 0 });
}

function exitPitchZeroTestMode() {
    resetPitchCalibScreenUI();
    syncWizardMixerScreen8Idle();
}

/** 集体 / 循环螺距：测试进行中时，仅当前块内「结束 + 增加/降低」可点，其余按钮置灰。 */
function applyPitchCalibTestModeActive(isCollective) {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="8"]');
    if (!$s.length) return;
    resetPitchCalibScreenUI();
    $s.addClass(isCollective ? 'wizard-pitch-test-mode-collective' : 'wizard-pitch-test-mode-cyclic');
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').addClass('disabled');
    const blockSel = isCollective ? '.wizard-calib-block--pitch-collective' : '.wizard-calib-block--pitch-cyclic';
    $s.find('.wizard-body--pitch-calib .wizard-calib-block').each(function () {
        const $block = $(this);
        if ($block.is(blockSel)) {
            $block.find('.wizard-calib-pitch-test-btn').text(i18n.getMessage('setupWizardTestEndBtn'));
            $block.find('.wizard-calib-pitch-adjust-btn').removeClass('disabled');
            return;
        }
        $block.find('.regular-button').addClass('disabled');
    });
    if (isCollective) {
        wizardSetFourAxes({ mode: 'values', roll: 0, pitch: 0, collective: 12, tail: 0 });
    } else {
        wizardSetFourAxes({ mode: 'values', roll: 9, pitch: 0, collective: 0, tail: 0 });
    }
}

function resetTailZeroCalibUI() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="9"]');
    if (!$s.length) return;
    $s.removeClass('wizard-tail-zero-test-mode');
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').removeClass('disabled');
    $s.find('.wizard-calib-block--tail-zero .regular-button').removeClass('disabled');
    $s.find('.wizard-calib-tail-zero-test-btn').text(i18n.getMessage('setupWizardTestBtn'));
    $s.find('.wizard-calib-tail-zero-adjust-btn').addClass('disabled');
    $s.find('.wizard-tail-dir input[type="radio"]').prop('disabled', false);
}

/** 尾桨 0°：测试中仅「完成 + 向左/向右」可点，顶栏/底栏与尾向选择禁用。 */
function applyTailZeroCalibTestModeActive() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="9"]');
    if (!$s.length) return;
    resetTailZeroCalibUI();
    $s.addClass('wizard-tail-zero-test-mode');
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').addClass('disabled');
    $s.find('.wizard-tail-dir input[type="radio"]').prop('disabled', true);
    $s.find('.wizard-calib-tail-zero-test-btn').text(i18n.getMessage('setupWizardTestEndBtn'));
    $s.find('.wizard-calib-tail-zero-adjust-btn').removeClass('disabled');
    wizardSetFourAxes({ mode: 'values', roll: 0, pitch: 0, collective: 0, tail: 0 });
}

function screen10HasAnyTailPitchTestMode($s) {
    return (
        $s.hasClass('wizard-tail-pitch22-test-mode') ||
        $s.hasClass('wizard-tail-travel-left-test-mode') ||
        $s.hasClass('wizard-tail-travel-right-test-mode')
    );
}

function resetTailPitchScreenUI() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="10"]');
    if (!$s.length) return;
    $s.removeClass(
        'wizard-tail-pitch22-test-mode wizard-tail-travel-left-test-mode wizard-tail-travel-right-test-mode',
    );
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').removeClass('disabled');
    $s.find('.wizard-body--tail-pitch-screen .wizard-calib-block .regular-button').removeClass('disabled');
    $s
        .find(
            '.wizard-calib-tail-pitch22-test-btn, .wizard-calib-tail-travel-left-test-btn, .wizard-calib-tail-travel-right-test-btn',
        )
        .text(i18n.getMessage('setupWizardTestBtn'));
    $s
        .find(
            '.wizard-calib-tail-pitch22-adjust-btn, .wizard-calib-tail-travel-left-adjust-btn, .wizard-calib-tail-travel-right-adjust-btn',
        )
        .addClass('disabled');
}

/** 尾桨 22°：测试中禁用顶栏、底栏与其余两行的按键。 */
function applyTailPitch22CalibTestModeActive() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="10"]');
    if (!$s.length) return;
    resetTailPitchScreenUI();
    $s.addClass('wizard-tail-pitch22-test-mode');
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').addClass('disabled');
    $s.find('.wizard-calib-block--tail-travel-left .regular-button, .wizard-calib-block--tail-travel-right .regular-button').addClass('disabled');
    $s.find('.wizard-calib-tail-pitch22-test-btn').text(i18n.getMessage('setupWizardTestEndBtn'));
    $s.find('.wizard-calib-tail-pitch22-adjust-btn').removeClass('disabled');
    wizardSetFourAxes({ mode: 'values', roll: 0, pitch: 0, collective: 0, tail: 22 });
}

function applyTailTravelLeftTestModeActive() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="10"]');
    if (!$s.length) return;
    resetTailPitchScreenUI();
    $s.addClass('wizard-tail-travel-left-test-mode');
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').addClass('disabled');
    $s.find('.wizard-calib-block--tail-pitch22 .regular-button, .wizard-calib-block--tail-travel-right .regular-button').addClass('disabled');
    $s.find('.wizard-calib-tail-travel-left-test-btn').text(i18n.getMessage('setupWizardTestEndBtn'));
    $s.find('.wizard-calib-tail-travel-left-adjust-btn').removeClass('disabled');
    wizardSetFourAxes({ mode: 'values', roll: 0, pitch: 0, collective: 0, tail: 60 });
}

function applyTailTravelRightTestModeActive() {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="10"]');
    if (!$s.length) return;
    resetTailPitchScreenUI();
    $s.addClass('wizard-tail-travel-right-test-mode');
    $s.find('.wizard-topbar a.regular-button, .wizard-footer a.regular-button').addClass('disabled');
    $s.find('.wizard-calib-block--tail-pitch22 .regular-button, .wizard-calib-block--tail-travel-left .regular-button').addClass('disabled');
    $s.find('.wizard-calib-tail-travel-right-test-btn').text(i18n.getMessage('setupWizardTestEndBtn'));
    $s.find('.wizard-calib-tail-travel-right-adjust-btn').removeClass('disabled');
    wizardSetFourAxes({ mode: 'values', roll: 0, pitch: 0, collective: 0, tail: -60 });
}

function handleTailPitchScreenTestButtonClick($btn) {
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="10"]');
    if (!$s.length) return;
    const $block = $btn.closest('.wizard-calib-block');
    let modeClass = '';
    let applyFn = null;
    if ($block.hasClass('wizard-calib-block--tail-pitch22')) {
        modeClass = 'wizard-tail-pitch22-test-mode';
        applyFn = applyTailPitch22CalibTestModeActive;
    } else if ($block.hasClass('wizard-calib-block--tail-travel-left')) {
        modeClass = 'wizard-tail-travel-left-test-mode';
        applyFn = applyTailTravelLeftTestModeActive;
    } else if ($block.hasClass('wizard-calib-block--tail-travel-right')) {
        modeClass = 'wizard-tail-travel-right-test-mode';
        applyFn = applyTailTravelRightTestModeActive;
    }
    if (!modeClass || !applyFn) return;
    if ($s.hasClass(modeClass)) {
        resetTailPitchScreenUI();
        syncWizardMixerScreen10Idle();
        return;
    }
    if (screen10HasAnyTailPitchTestMode($s)) {
        return;
    }
    applyFn();
}

function stopWizardReceiverPolling() {
    if (typeof GUI !== 'undefined' && GUI.interval_remove) {
        GUI.interval_remove(WIZARD_RECEIVER_INTERVAL_NAME);
    }
}

function startWizardReceiverPolling() {
    if (typeof GUI === 'undefined' || !GUI.interval_add) {
        return;
    }
    stopWizardReceiverPolling();
    Promise.resolve()
        .then(() => MSP.promise(MSPCodes.MSP_MODE_RANGES))
        .then(() => MSP.promise(MSPCodes.MSP_MODE_RANGES_EXTRA))
        .catch(() => {
            /* 仍轮询 RC；ARM 依赖 MODE_RANGES，失败时按无配置处理 */
        })
        .finally(() => {
            GUI.interval_add(WIZARD_RECEIVER_INTERVAL_NAME, pullWizardReceiverData, WIZARD_RECEIVER_INTERVAL_MS, true);
        });
}

/** Same formula as Status tab (`FC.RC_COMMAND[i] / 5`); clamp before round for display and bar. */
function clampRcPercentUnits(rcCommand) {
    const raw = (Number(rcCommand) || 0) / 5;
    return Math.max(-100, Math.min(100, raw));
}

function wizardReceiverDisplayPercent(rcCommand) {
    return Math.round(clampRcPercentUnits(rcCommand));
}

/** Same as Status tab throttle label: `FC.RC_COMMAND[4] / 10 + 50` → 0–100%. */
function wizardReceiverThrottlePercent() {
    const cmd = FC.RC_COMMAND?.[4] ?? 0;
    const pct = cmd / 10 + 50;
    return Math.max(0, Math.min(100, Math.round(pct)));
}

/** 与模式页（`auxiliary.js`）一致：前 5 路为滚转/俯仰/偏航/油门/螺距，AUX 从第 6 路起。 */
const WIZARD_RC_PRIMARY_CHANNEL_COUNT = 5;

function wizardRcPwmForAuxChannelIndex(auxChannelIndex) {
    const ch = WIZARD_RC_PRIMARY_CHANNEL_COUNT + (auxChannelIndex | 0);
    const channels = FC.RC?.channels;
    if (!channels || ch < 0 || ch >= channels.length) {
        return 1500;
    }
    const v = channels[ch];
    return Number.isFinite(v) ? v : 1500;
}

function wizardRcPwmInRange(pwm, start, end) {
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    return pwm >= lo && pwm <= hi;
}

/**
 * 按飞控逻辑根据当前 RC 判断某模式（box）是否应激活：遍历 `MODE_RANGES` 顺序，
 * 仅处理 `id === modeId` 且非链接行；首条定初值，后续按 `modeLogic` 0=OR、1=AND 组合。
 * 不读 `FC.CONFIG.mode`，接线调试时与「开关是否在 ARM 位」一致，而非是否已真正解锁。
 */
function evaluateModeActivationFromRc(modeId) {
    if (modeId == null || !Number.isFinite(Number(modeId))) {
        return false;
    }
    const ranges = FC.MODE_RANGES;
    const extras = FC.MODE_RANGES_EXTRA;
    if (!ranges?.length || !extras?.length || ranges.length !== extras.length) {
        return false;
    }
    let result = false;
    let first = true;
    for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const ex = extras[i];
        if (!r || !ex) {
            continue;
        }
        if (r.id !== modeId || ex.id !== modeId) {
            continue;
        }
        if (ex.linkedTo !== 0) {
            continue;
        }
        if (r.range.start >= r.range.end) {
            continue;
        }
        const pwm = wizardRcPwmForAuxChannelIndex(r.auxChannelIndex);
        const condition = wizardRcPwmInRange(pwm, r.range.start, r.range.end);
        if (first) {
            result = condition;
            first = false;
        } else if (ex.modeLogic === 0) {
            result = result || condition;
        } else {
            result = result && condition;
        }
    }
    return !first && result;
}

function isWizardReceiverArmSwitchInArmPosition() {
    const armModeId = getBoxIdByAuxName('ARM');
    return evaluateModeActivationFromRc(armModeId);
}

/** PID profile + rate profile from `MSP_STATUS` (`profiles` / `rates` tabs use `FC.CONFIG.profile` and `rateProfile`). */
function formatWizardReceiverBankDisplay() {
    const pid = Number(FC.CONFIG?.profile ?? 0);
    const rate = Number(FC.CONFIG?.rateProfile ?? 0);
    const pidUi = pid + 1;
    const rateUi = rate + 1;
    if (pidUi === rateUi) {
        return String(pidUi);
    }
    return `${pidUi},${rateUi}`;
}

function updateWizardReceiverStatusStrip($root) {
    const $strip = $root.find('.wizard-receiver-status-grid');
    if (!$strip.length) {
        return;
    }

    const armSwitchOn = isWizardReceiverArmSwitchInArmPosition();
    const $arm = $strip.find('[data-wizard-rc-strip="arm"]');
    $arm.text(armSwitchOn ? i18n.getMessage('setupWizardReceiverArmYes') : i18n.getMessage('setupWizardReceiverArmNo'));
    $arm.toggleClass('wizard-receiver-status-value--danger', armSwitchOn);

    const thrPct = wizardReceiverThrottlePercent();
    $strip.find('[data-wizard-rc-strip="throttle"]').text(`${thrPct}%`);

    $strip.find('[data-wizard-rc-strip="bank"]').text(formatWizardReceiverBankDisplay());

    const motorRun = armSwitchOn && thrPct > 40;
    const $motor = $strip.find('[data-wizard-rc-strip="motor"]');
    $motor.text(
        motorRun ? i18n.getMessage('setupWizardReceiverMotorStarted') : i18n.getMessage('setupWizardReceiverMotorStopped'),
    );
    $motor.toggleClass('wizard-receiver-status-value--danger', motorRun);
}

function formatWizardReceiverLabel(rcIndex, displayPercent) {
    if (displayPercent === 0) {
        return i18n.getMessage('setupWizardReceiverPctZero');
    }
    const abs = Math.abs(displayPercent);
    const p = { percent: String(abs) };
    switch (rcIndex) {
        case 0:
        case 2:
            return displayPercent > 0
                ? i18n.getMessage('setupWizardReceiverPctLateralRight', p)
                : i18n.getMessage('setupWizardReceiverPctLateralLeft', p);
        case 1:
            return displayPercent > 0
                ? i18n.getMessage('setupWizardReceiverPctPitchForward', p)
                : i18n.getMessage('setupWizardReceiverPctPitchBack', p);
        case 3:
            return displayPercent > 0
                ? i18n.getMessage('setupWizardReceiverPctCollectivePos', p)
                : i18n.getMessage('setupWizardReceiverPctCollectiveNeg', p);
        default:
            return i18n.getMessage('setupWizardReceiverPctZero');
    }
}

function updateWizardReceiverSignedBarHorizontal($fill, displayPercent) {
    const mag = (Math.abs(displayPercent) / 100) * 50;
    if (displayPercent === 0) {
        $fill.css({ left: '50%', width: '0%' });
        return;
    }
    if (displayPercent > 0) {
        $fill.css({ left: '50%', width: `${mag}%` });
    } else {
        $fill.css({ left: `${50 - mag}%`, width: `${mag}%` });
    }
}

function updateWizardReceiverSignedBarVertical($fill, displayPercent) {
    const mag = (Math.abs(displayPercent) / 100) * 50;
    if (displayPercent === 0) {
        $fill.css({ bottom: '50%', top: 'auto', height: '0%' });
        return;
    }
    if (displayPercent > 0) {
        $fill.css({
            bottom: '50%',
            top: 'auto',
            height: `${mag}%`,
            left: '0',
            right: '0',
            width: '100%',
        });
    } else {
        $fill.css({
            top: '50%',
            bottom: 'auto',
            height: `${mag}%`,
            left: '0',
            right: '0',
            width: '100%',
        });
    }
}

function updateWizardReceiverScreenUI() {
    const $root = $('.tab-setup-wizard .wizard-screen[data-screen="4"]');
    if (!$root.length || !$root.hasClass('active')) {
        return;
    }

    updateWizardReceiverStatusStrip($root);

    $root.find('[data-wizard-rc-index]').each(function () {
        const idx = parseInt($(this).attr('data-wizard-rc-index'), 10);
        if (!Number.isFinite(idx)) {
            return;
        }
        const cmd = FC.RC_COMMAND?.[idx] ?? 0;
        const dp = wizardReceiverDisplayPercent(cmd);
        $(this).find('.wizard-channel-value').text(formatWizardReceiverLabel(idx, dp));
        const $fill = $(this).find('.wizard-bar-fill');
        if ($fill.hasClass('wizard-bar-fill--h')) {
            updateWizardReceiverSignedBarHorizontal($fill, dp);
        } else if ($fill.hasClass('wizard-bar-fill--v')) {
            updateWizardReceiverSignedBarVertical($fill, dp);
        }
    });
}

function pullWizardReceiverData() {
    MSP.send_message(MSPCodes.MSP_STATUS, false, false, function () {
        MSP.send_message(MSPCodes.MSP_RC, false, false, function () {
            MSP.send_message(MSPCodes.MSP_RC_COMMAND, false, false, updateWizardReceiverScreenUI);
        });
    });
}

/**
 * Same sign convention as `src/js/tabs/mixer.js` `data_to_form` for #mixerAileronDirection / Elevator / Collective.
 * @param {number} inputIndex 1=aileron, 2=elevator, 4=collective
 * @returns {1|-1}
 */
function mixerInputDirectionSign(inputIndex) {
    const inputs = FC.MIXER_INPUTS;
    if (!Array.isArray(inputs) || !inputs[inputIndex] || typeof inputs[inputIndex].rate !== 'number') {
        return 1;
    }
    return inputs[inputIndex].rate < 0 ? -1 : 1;
}

/** Same scaling as `mixer.js` `data_to_form` for mixer input rate → display %. */
function wizardMixerInputRateAbsPercent(inputIndex) {
    const r = FC.MIXER_INPUTS?.[inputIndex]?.rate;
    if (typeof r !== 'number') {
        return null;
    }
    return Math.abs(r) * 0.1;
}

/** Tail center trim display string (motor: %, rotor: °) — matches mixer tab. */
function wizardFormatTailCenterTrimDisplay() {
    const mode = FC.MIXER_CONFIG?.tail_rotor_mode;
    const t = FC.MIXER_CONFIG?.tail_center_trim;
    if (typeof mode !== 'number' || typeof t !== 'number') {
        return '—';
    }
    if (mode > 0) {
        return `${(t * 0.1).toFixed(1)}%`;
    }
    return `${((t * 24) / 1000).toFixed(1)}°`;
}

/** Tail yaw travel limits in degrees for display — matches mixer tab min/max fields. */
function wizardTailYawMinDegDisplay() {
    const motor = FC.MIXER_CONFIG?.tail_rotor_mode > 0;
    const min = FC.MIXER_INPUTS?.[MIXER_INPUT_TAIL_INDEX]?.min;
    if (typeof min !== 'number') {
        return null;
    }
    if (motor) {
        return min * -0.1;
    }
    return (min * -24) / 1000;
}

function wizardTailYawMaxDegDisplay() {
    const motor = FC.MIXER_CONFIG?.tail_rotor_mode > 0;
    const max = FC.MIXER_INPUTS?.[MIXER_INPUT_TAIL_INDEX]?.max;
    if (typeof max !== 'number') {
        return null;
    }
    if (motor) {
        return max * 0.1;
    }
    return (max * 24) / 1000;
}

function updateWizardScreen6Live() {
    const t = FC.MIXER_CONFIG?.swash_trim?.[2];
    const v = typeof t === 'number' ? t * 0.1 : null;
    const num = v === null ? '—' : v.toFixed(1);
    const text = i18n.getMessage('setupWizardLiveCollectiveTrim', { value: num });
    $('.tab-setup-wizard .wizard-screen[data-screen="6"] .wizard-zero-pitch-live').text(text);
}

/**
 * Roll trim (swash_trim[0]): 与 `.wizard-dpad-btn` 左/右键一致，方向由 `mixerInputDirectionSign(AILERON)` 决定。
 * 语义符号 = rawTrim * ailSign：正 → 右，负 → 左；数值为绝对值 %。
 */
function wizardSwashRollDirAndAbsPct(rawTrim) {
    if (typeof rawTrim !== 'number') {
        return { dir: '—', val: '—' };
    }
    const pct = rawTrim * 0.1;
    const av = Math.abs(pct);
    if (av < 1e-9) {
        return { dir: i18n.getMessage('setupWizardSwashTrimCenter'), val: '0.0' };
    }
    const semantic = rawTrim * mixerInputDirectionSign(MIXER_INPUT_AILERON_INDEX);
    const dir =
        semantic > 0
            ? i18n.getMessage('setupWizardSwashRight')
            : i18n.getMessage('setupWizardSwashLeft');
    return { dir, val: av.toFixed(1) };
}

/**
 * Pitch trim (swash_trim[1]): 与前/后键一致，方向由 `mixerInputDirectionSign(ELEVATOR)` 决定。
 * 语义符号 = rawTrim * elevSign：正 → 前，负 → 后；数值为绝对值 %。
 */
function wizardSwashPitchDirAndAbsPct(rawTrim) {
    if (typeof rawTrim !== 'number') {
        return { dir: '—', val: '—' };
    }
    const pct = rawTrim * 0.1;
    const av = Math.abs(pct);
    if (av < 1e-9) {
        return { dir: i18n.getMessage('setupWizardSwashTrimCenter'), val: '0.0' };
    }
    const semantic = rawTrim * mixerInputDirectionSign(MIXER_INPUT_ELEVATOR_INDEX);
    const dir =
        semantic > 0
            ? i18n.getMessage('setupWizardSwashFront')
            : i18n.getMessage('setupWizardSwashBack');
    return { dir, val: av.toFixed(1) };
}

function updateWizardScreen7Live() {
    const raw0 = FC.MIXER_CONFIG?.swash_trim?.[0];
    const raw1 = FC.MIXER_CONFIG?.swash_trim?.[1];
    const roll = wizardSwashRollDirAndAbsPct(raw0);
    const pitch = wizardSwashPitchDirAndAbsPct(raw1);
    const text = i18n.getMessage('setupWizardLiveSwashAdjust', {
        rollDir: roll.dir,
        rollVal: roll.val,
        pitchDir: pitch.dir,
        pitchVal: pitch.val,
    });
    $('.tab-setup-wizard .wizard-screen[data-screen="7"] .wizard-swash-level-live').text(text);
}

function updateWizardScreen8Live() {
    const coll = wizardMixerInputRateAbsPercent(MIXER_INPUT_COLLECTIVE_INDEX);
    const cyc = wizardMixerInputRateAbsPercent(MIXER_INPUT_AILERON_INDEX);
    const collStr = coll === null ? '—' : coll.toFixed(1);
    const cycStr = cyc === null ? '—' : cyc.toFixed(1);
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="8"]');
    $s.find('.wizard-calib-block--pitch-collective .wizard-calib-live').text(
        i18n.getMessage('setupWizardLiveCollectiveCalib', { value: collStr }),
    );
    $s.find('.wizard-calib-block--pitch-cyclic .wizard-calib-live').text(
        i18n.getMessage('setupWizardLiveCyclicCalib', { value: cycStr }),
    );
}

function updateWizardScreen9Live() {
    const val = wizardFormatTailCenterTrimDisplay();
    const text = i18n.getMessage('setupWizardLiveTailTrim', { value: val });
    $('.tab-setup-wizard .wizard-screen[data-screen="9"] .wizard-calib-block--tail-zero .wizard-calib-live').text(text);
}

function updateWizardScreen10Live() {
    const yaw = wizardMixerInputRateAbsPercent(MIXER_INPUT_TAIL_INDEX);
    const yawStr = yaw === null ? '—' : yaw.toFixed(1);
    const minD = wizardTailYawMinDegDisplay();
    const maxD = wizardTailYawMaxDegDisplay();
    const minStr = minD === null ? '—' : minD.toFixed(1);
    const maxStr = maxD === null ? '—' : maxD.toFixed(1);
    const $s = $('.tab-setup-wizard .wizard-screen[data-screen="10"]');
    $s.find('.wizard-calib-block--tail-pitch22 .wizard-calib-live').text(
        i18n.getMessage('setupWizardLiveTailYawCalib', { value: yawStr }),
    );
    $s.find('.wizard-calib-block--tail-travel-left .wizard-calib-live').text(
        i18n.getMessage('setupWizardLiveTailYawLimitCCW', { value: minStr }),
    );
    $s.find('.wizard-calib-block--tail-travel-right .wizard-calib-live').text(
        i18n.getMessage('setupWizardLiveTailYawLimitCW', { value: maxStr }),
    );
}

function updateWizardMixerLiveForScreen(screenIndex) {
    const i = screenIndex | 0;
    if (i === 6) {
        updateWizardScreen6Live();
    } else if (i === 7) {
        updateWizardScreen7Live();
    } else if (i === 8) {
        updateWizardScreen8Live();
    } else if (i === 9) {
        updateWizardScreen9Live();
    } else if (i === 10) {
        updateWizardScreen10Live();
    }
}

/**
 * 第 8 页螺距校正：增加/降低集体或循环校准（与混控页 `mixerCyclicCalibration` / `mixerCollectiveCalibration` 一致）。
 * 显示每次变化 0.2% → 内部 rate 变化 ±2。
 */
function applyWizardPitchCalibrationAdjust(isCollective, increase) {
    if (wizardPitchCalibSaveInProgress) {
        return;
    }
    const inputs = FC.MIXER_INPUTS;
    if (!Array.isArray(inputs)) {
        return;
    }
    const deltaSign = increase ? 1 : -1;

    if (isCollective) {
        const inp = inputs[MIXER_INPUT_COLLECTIVE_INDEX];
        if (!inp || typeof inp.rate !== 'number') {
            return;
        }
        const dir = mixerInputDirectionSign(MIXER_INPUT_COLLECTIVE_INDEX);
        const curAbs = Math.abs(inp.rate);
        let nextAbs = curAbs + deltaSign * WIZARD_PITCH_CALIB_RATE_STEP;
        nextAbs = Math.max(
            WIZARD_PITCH_CALIB_RATE_ABS_MIN,
            Math.min(WIZARD_PITCH_CALIB_RATE_ABS_MAX, nextAbs),
        );
        if (nextAbs === curAbs) {
            return;
        }
        inp.rate = nextAbs * dir;
        wizardPitchCalibSaveInProgress = true;
        mspHelper.sendMixerInput(MIXER_INPUT_COLLECTIVE_INDEX, function () {
            MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
                wizardPitchCalibSaveInProgress = false;
                updateWizardScreen8Live();
            });
        });
        return;
    }

    const i1 = inputs[MIXER_INPUT_AILERON_INDEX];
    const i2 = inputs[MIXER_INPUT_ELEVATOR_INDEX];
    if (!i1 || !i2 || typeof i1.rate !== 'number' || typeof i2.rate !== 'number') {
        return;
    }
    const ailDir = mixerInputDirectionSign(MIXER_INPUT_AILERON_INDEX);
    const elevDir = mixerInputDirectionSign(MIXER_INPUT_ELEVATOR_INDEX);
    const curAbs = Math.abs(i1.rate);
    let nextAbs = curAbs + deltaSign * WIZARD_PITCH_CALIB_RATE_STEP;
    nextAbs = Math.max(
        WIZARD_PITCH_CALIB_RATE_ABS_MIN,
        Math.min(WIZARD_PITCH_CALIB_RATE_ABS_MAX, nextAbs),
    );
    if (nextAbs === curAbs) {
        return;
    }
    i1.rate = nextAbs * ailDir;
    i2.rate = nextAbs * elevDir;
    wizardPitchCalibSaveInProgress = true;
    mspHelper.sendMixerInput(MIXER_INPUT_AILERON_INDEX, function () {
        mspHelper.sendMixerInput(MIXER_INPUT_ELEVATOR_INDEX, function () {
            MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
                wizardPitchCalibSaveInProgress = false;
                updateWizardScreen8Live();
            });
        });
    });
}

function wizardSendMixerConfigThenEeprom(onDone) {
    MSP.send_message(MSPCodes.MSP_SET_MIXER_CONFIG, mspHelper.crunch(MSPCodes.MSP_SET_MIXER_CONFIG), false, function () {
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, onDone);
    });
}

function wizardSendMixerInput3ThenEeprom(onDone) {
    mspHelper.sendMixerInput(MIXER_INPUT_TAIL_INDEX, function () {
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, onDone);
    });
}

/**
 * 第 9 页：左/右调整尾桨中心微调（`tail_center_trim`），与混控 `mixerTailMotorCenterTrim` / `mixerTailRotorCenterTrim` 一致。
 * 右为增加、左为减少，步长 0.2（% 或 °）。
 */
function applyWizardTailCenterTrimAdjust(isRight) {
    if (wizardTailMixerSaveInProgress || !FC.MIXER_CONFIG) {
        return;
    }
    const t = FC.MIXER_CONFIG.tail_center_trim;
    if (typeof t !== 'number') {
        return;
    }
    const motor = FC.MIXER_CONFIG.tail_rotor_mode > 0;
    const deltaSign = isRight ? 1 : -1;
    const step = WIZARD_TAIL_CENTER_TRIM_STEP_DISP;

    let next;
    if (motor) {
        let disp = t * 0.1;
        disp += deltaSign * step;
        disp = Math.max(-50, Math.min(50, disp));
        next = Math.round(disp * 10);
    } else {
        let disp = (t * 24) / 1000;
        disp += deltaSign * step;
        disp = Math.max(-25, Math.min(25, disp));
        next = Math.round(disp * (1000 / 24));
    }
    if (next === t) {
        return;
    }
    FC.MIXER_CONFIG.tail_center_trim = next;
    wizardTailMixerSaveInProgress = true;
    wizardSendMixerConfigThenEeprom(function () {
        wizardTailMixerSaveInProgress = false;
        updateWizardScreen9Live();
    });
}

/**
 * 第 10 页第 1 块：航向校准（`MIXER_INPUTS[3].rate` 幅值），与 `mixerTailRotorCalibration` 一致，每次 ±0.2%。
 */
function applyWizardTailYawCalibrationAdjust(increase) {
    if (wizardTailMixerSaveInProgress) {
        return;
    }
    const inp = FC.MIXER_INPUTS?.[MIXER_INPUT_TAIL_INDEX];
    if (!inp || typeof inp.rate !== 'number') {
        return;
    }
    const dir = mixerInputDirectionSign(MIXER_INPUT_TAIL_INDEX);
    const deltaSign = increase ? 1 : -1;
    const curAbs = Math.abs(inp.rate);
    let nextAbs = curAbs + deltaSign * WIZARD_PITCH_CALIB_RATE_STEP;
    nextAbs = Math.max(
        WIZARD_TAIL_YAW_CALIB_RATE_ABS_MIN,
        Math.min(WIZARD_TAIL_YAW_CALIB_RATE_ABS_MAX, nextAbs),
    );
    if (nextAbs === curAbs) {
        return;
    }
    inp.rate = nextAbs * dir;
    wizardTailMixerSaveInProgress = true;
    wizardSendMixerInput3ThenEeprom(function () {
        wizardTailMixerSaveInProgress = false;
        updateWizardScreen10Live();
    });
}

/**
 * 第 10 页第 2 块：逆时针/左侧行程极限（`INPUTS[3].min`），与混控 `mixerTailRotorMinYaw` / `mixerTailMotorMinYaw` 显示一致。
 */
function applyWizardTailTravelMinAdjust(increase) {
    if (wizardTailMixerSaveInProgress) {
        return;
    }
    const inp = FC.MIXER_INPUTS?.[MIXER_INPUT_TAIL_INDEX];
    if (!inp || typeof inp.min !== 'number') {
        return;
    }
    const motor = FC.MIXER_CONFIG?.tail_rotor_mode > 0;
    const deltaSign = increase ? 1 : -1;
    const step = WIZARD_TAIL_TRAVEL_STEP_DISP;
    let nextMin;

    if (motor) {
        let d = -inp.min * 0.1;
        d += deltaSign * step;
        d = Math.max(0, Math.min(200, d));
        nextMin = Math.round(-d * 10);
    } else {
        let d = (-inp.min * 24) / 1000;
        d += deltaSign * step;
        d = Math.max(0, Math.min(60, d));
        nextMin = Math.round(-d * (1000 / 24));
    }
    if (nextMin === inp.min) {
        return;
    }
    inp.min = nextMin;
    wizardTailMixerSaveInProgress = true;
    wizardSendMixerInput3ThenEeprom(function () {
        wizardTailMixerSaveInProgress = false;
        updateWizardScreen10Live();
    });
}

/**
 * 第 10 页第 3 块：顺时针/右侧行程极限（`INPUTS[3].max`）。
 */
function applyWizardTailTravelMaxAdjust(increase) {
    if (wizardTailMixerSaveInProgress) {
        return;
    }
    const inp = FC.MIXER_INPUTS?.[MIXER_INPUT_TAIL_INDEX];
    if (!inp || typeof inp.max !== 'number') {
        return;
    }
    const motor = FC.MIXER_CONFIG?.tail_rotor_mode > 0;
    const deltaSign = increase ? 1 : -1;
    const step = WIZARD_TAIL_TRAVEL_STEP_DISP;
    let nextMax;

    if (motor) {
        let d = inp.max * 0.1;
        d += deltaSign * step;
        d = Math.max(0, Math.min(200, d));
        nextMax = Math.round(d * 10);
    } else {
        let d = (inp.max * 24) / 1000;
        d += deltaSign * step;
        d = Math.max(0, Math.min(60, d));
        nextMax = Math.round(d * (1000 / 24));
    }
    if (nextMax === inp.max) {
        return;
    }
    inp.max = nextMax;
    wizardTailMixerSaveInProgress = true;
    wizardSendMixerInput3ThenEeprom(function () {
        wizardTailMixerSaveInProgress = false;
        updateWizardScreen10Live();
    });
}

function applyWizardSwashTrimDelta(trimIndex, delta) {
    if (!FC.MIXER_CONFIG?.swash_trim || wizardSwashTrimSaveInProgress) {
        return;
    }
    const cur = FC.MIXER_CONFIG.swash_trim[trimIndex];
    if (typeof cur !== 'number') {
        return;
    }
    let next = cur + delta;
    next = Math.max(-WIZARD_SWASH_TRIM_ABS_MAX, Math.min(WIZARD_SWASH_TRIM_ABS_MAX, next));
    if (next === cur) {
        return;
    }
    FC.MIXER_CONFIG.swash_trim[trimIndex] = next;
    wizardSwashTrimSaveInProgress = true;
    MSP.send_message(MSPCodes.MSP_SET_MIXER_CONFIG, mspHelper.crunch(MSPCodes.MSP_SET_MIXER_CONFIG), false, function () {
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
            wizardSwashTrimSaveInProgress = false;
            updateWizardScreen6Live();
            updateWizardScreen7Live();
        });
    });
}

/** Refresh mixer config + inputs for wizard screens 6–10 (best-effort). */
function refreshWizardMixerData() {
    return MSP.promise(MSPCodes.MSP_MIXER_CONFIG)
        .then(() => MSP.promise(MSPCodes.MSP_MIXER_INPUTS))
        .catch(() => {});
}

/**
 * 进入「更多设置」前拉取最新混控配置，再按飞控实际值预选（顺时针/逆时针、正向/反向集体螺距）。
 * 避免内存中的 FC 与飞控不一致导致选错；拉取失败时仍用当前内存 best-effort 同步 UI。
 */
function refreshMixerConfigForMoreSettingsThenApply() {
    return MSP.promise(MSPCodes.MSP_MIXER_CONFIG)
        .then(() => MSP.promise(MSPCodes.MSP_MIXER_INPUTS))
        .then(() => {
            applyMoreSettingsUIFromFC();
        })
        .catch(() => {
            applyMoreSettingsUIFromFC();
        });
}

function goToScreen(index) {
    if (wizardQuickBasicIsWriting()) {
        return;
    }
    const i = Math.max(0, Math.min(LAST_INDEX, index));
    $('.tab-setup-wizard .wizard-screen').removeClass('active');
    $(`.tab-setup-wizard .wizard-screen[data-screen="${i}"]`).addClass('active');
    for (let s = 1; s <= 12; s++) {
        $(`.tab-setup-wizard .wizard-screen[data-screen="${s}"] .wizard-step-label`).text(
            i18n.getMessage('setupWizardStepProgress', { current: s, total: 12 }),
        );
    }
    if (i === 5 && !wizardDirSaveInProgress) {
        // Always reflect the current FC servo reverse state when entering Screen 5.
        patchServoDirIndexFromFC();
    }
    if (i === 3 && !wizardMoreSettingsSaveInProgress) {
        // 先用当前内存中的 FC 立即预选，避免短暂显示 HTML 默认项；再拉 MSP 与飞控对齐。
        applyMoreSettingsUIFromFC();
        refreshMixerConfigForMoreSettingsThenApply();
    }
    if (i === 4) {
        startWizardReceiverPolling();
    } else {
        stopWizardReceiverPolling();
    }
    if (i >= 6 && i <= 10) {
        refreshWizardMixerData().then(() => {
            updateWizardMixerLiveForScreen(i);
        });
    }
    resetPitchCalibScreenUI();
    resetTailZeroCalibUI();
    resetTailPitchScreenUI();
    persistPatch({ screenIndex: i });
    if (i >= 5 && i <= 10) {
        applyWizardMixerForScreen(i);
    } else {
        mspHelper.resetMixerOverrides();
    }
}

function applyPersistedWizardState() {
    const raw = readState();
    const st = { ...defaultState(), ...raw };
    const sv = Number(st.stateVersion);
    const oldLayout = !Number.isFinite(sv) || sv < WIZARD_STATE_VERSION;
    if (oldLayout) {
        const patch = { stateVersion: WIZARD_STATE_VERSION };
        const idx = Number(st.screenIndex);
        if (Number.isFinite(idx) && idx >= 10) {
            patch.screenIndex = idx + 1;
        }
        persistPatch(patch);
    }
    const st2 = { ...defaultState(), ...readState() };
    GUI.log(`[SetupWizard] applyPersistedWizardState: screenIndex=${st2.screenIndex}`);
    goToScreen(st2.screenIndex);
    if (Number(st2.screenIndex) !== 5) {
        const dir = Number.isFinite(st2.dirIndex) ? st2.dirIndex : 1;
        $('#wizard-dir-index').text(String(dir));
        persistPatch({ dirIndex: dir });
    }

    const $poles = $('#wizard-motor-poles');
    if ($poles.length) {
        $poles.val(st2.motorPoles || '');
    }

    const $swashNeutral = $('#wizard-swash-neutral-point');
    if ($swashNeutral.length) {
        if (st2.swashNeutralPoint) {
            $swashNeutral.val(st2.swashNeutralPoint);
        }
    }
    const $swashFrequency = $('#wizard-swash-frequency');
    if ($swashFrequency.length) {
        if (st2.swashFrequency) {
            $swashFrequency.val(st2.swashFrequency);
        }
    }
    const $tailNeutral = $('#wizard-tail-neutral-point');
    if ($tailNeutral.length) {
        if (st2.tailNeutralPoint) {
            $tailNeutral.val(st2.tailNeutralPoint);
        }
    }
    const $tailFrequency = $('#wizard-tail-frequency');
    if ($tailFrequency.length) {
        if (st2.tailFrequency) {
            $tailFrequency.val(st2.tailFrequency);
        }
    }

    const swash = normalizeSwashSelectionValue(st2.swash || '');
    const $swashInputs = $('.tab-setup-wizard input[name="swash"]');
    $swashInputs.prop('checked', false);
    if (swash) {
        $swashInputs.filter(function () {
            return $(this).val() === swash;
        }).prop('checked', true);
    }

    const install = st2.install || '';
    const $installInputs = $('.tab-setup-wizard input[name="install"]');
    $installInputs.prop('checked', false);
    if (install) {
        $installInputs.filter(function () {
            return $(this).val() === install;
        }).prop('checked', true);
    }
}

function switchToSetupTab() {
    $('#tabs ul.mode-connected .tab_setup a').trigger('click');
}

function openWizardHelp() {
    const $screen = $('.tab-setup-wizard .wizard-screen.active');
    if (!$screen.length) return;

    wizardHelpPrevScreenIndex = parseInt($screen.attr('data-screen'), 10);
    if (!Number.isFinite(wizardHelpPrevScreenIndex)) {
        wizardHelpPrevScreenIndex = 0;
    }

    const baseTitle = $screen.find('.wizard-title').first().text().trim();
    const helpSuffix = i18n.getMessage('setupWizardHelp');
    $('#wizard-help-title').text(`${baseTitle} - ${helpSuffix}`);

    // Placeholder: each screen uses its index so content is guaranteed different.
    $('#wizard-help-content').text(`SETUP_WIZARD_HELP_TODO_SCREEN_${wizardHelpPrevScreenIndex}`);

    if (wizardHelpPrevScreenIndex === 4) {
        stopWizardReceiverPolling();
    }

    $('.tab-setup-wizard .wizard-screen').removeClass('active');
    $('.tab-setup-wizard .wizard-help-screen').addClass('active');
    $('.tab-setup-wizard .wizard-help-screen.active .wizard-body').scrollTop(0);
}

function closeWizardHelp() {
    $('.tab-setup-wizard .wizard-help-screen').removeClass('active');
    goToScreen(wizardHelpPrevScreenIndex);
}

function populateMotorPolesOptions() {
    const $motorPoles = $('#wizard-motor-poles');
    if (!$motorPoles.length) {
        return;
    }
    for (let n = 2; n <= 20; n++) {
        $motorPoles.append($('<option></option>').val(String(n)).text(String(n)));
    }
}

const SERVO_NEUTRAL_POINT_OPTIONS = [
    { value: '1520', label: '1520us' },
    { value: '760', label: '760us' },
    { value: '960', label: '960us' },
];

const SERVO_FREQUENCY_OPTIONS = [50, 120, 165, 200, 333, 560].map((hz) => ({
    value: String(hz),
    label: `${hz}Hz`,
}));

function populateSelectOptions($select, options) {
    if (!$select.length) {
        return;
    }
    $select.empty();
    for (const opt of options) {
        $select.append($('<option></option>').val(opt.value).text(opt.label));
    }
}

function populateServoTypeOptions() {
    populateSelectOptions($('#wizard-swash-neutral-point'), SERVO_NEUTRAL_POINT_OPTIONS);
    populateSelectOptions($('#wizard-swash-frequency'), SERVO_FREQUENCY_OPTIONS);
    populateSelectOptions($('#wizard-tail-neutral-point'), SERVO_NEUTRAL_POINT_OPTIONS);
    populateSelectOptions($('#wizard-tail-frequency'), SERVO_FREQUENCY_OPTIONS);
}

function inferBestNeutralPointForIndices(servoIndices) {
    let bestKey = '1520';
    let bestScore = Number.POSITIVE_INFINITY;

    for (const key of Object.keys(SERVO_NEUTRAL_POINT_MAP)) {
        const preset = SERVO_NEUTRAL_POINT_MAP[key];
        let score = 0;

        for (const i of servoIndices) {
            const s = FC.SERVO_CONFIG?.[i];
            if (!s) continue;
            score += Math.abs(s.mid - preset.mid);
            score += Math.abs(s.min - preset.min);
            score += Math.abs(s.max - preset.max);
            score += Math.abs(s.rneg - preset.rneg);
            score += Math.abs(s.rpos - preset.rpos);
        }

        if (score < bestScore) {
            bestScore = score;
            bestKey = key;
        }
    }

    return bestKey;
}

function inferBestFrequencyForIndices(servoIndices) {
    let bestHz = SERVO_FREQUENCY_VALUES[0];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const hz of SERVO_FREQUENCY_VALUES) {
        let score = 0;
        for (const i of servoIndices) {
            const s = FC.SERVO_CONFIG?.[i];
            if (!s) continue;
            score += Math.abs(s.rate - hz);
        }
        if (score < bestScore) {
            bestScore = score;
            bestHz = hz;
        }
    }

    return String(bestHz);
}

function patchServoSelectionsFromFC() {
    if (!FC?.SERVO_CONFIG || !Array.isArray(FC.SERVO_CONFIG) || FC.SERVO_CONFIG.length === 0) {
        return;
    }

    const swashNeutralPoint = inferBestNeutralPointForIndices(SWASH_SERVO_INDICES);
    const swashFrequency = inferBestFrequencyForIndices(SWASH_SERVO_INDICES);

    const tailIndices = [TAIL_SERVO_INDEX];
    const tailNeutralPoint = inferBestNeutralPointForIndices(tailIndices);
    const tailFrequency = inferBestFrequencyForIndices(tailIndices);

    persistPatch({
        swashNeutralPoint,
        swashFrequency,
        tailNeutralPoint,
        tailFrequency,
    });
}

function getServoWizardSelectionFromUI() {
    return {
        swashNeutralPoint: $('#wizard-swash-neutral-point').val() || '',
        swashFrequency: $('#wizard-swash-frequency').val() || '',
        tailNeutralPoint: $('#wizard-tail-neutral-point').val() || '',
        tailFrequency: $('#wizard-tail-frequency').val() || '',
    };
}

function writeServoWizardSelectionToFC(selection) {
    const swashPreset = SERVO_NEUTRAL_POINT_MAP[selection.swashNeutralPoint];
    const tailPreset = SERVO_NEUTRAL_POINT_MAP[selection.tailNeutralPoint];

    const swashRate = parseInt(selection.swashFrequency, 10);
    const tailRate = parseInt(selection.tailFrequency, 10);

    // Save speed/flags as-is; only overwrite fields required by your mapping.
    for (const i of SWASH_SERVO_INDICES) {
        if (!FC.SERVO_CONFIG?.[i] || !swashPreset) continue;
        FC.SERVO_CONFIG[i].mid = swashPreset.mid;
        FC.SERVO_CONFIG[i].min = swashPreset.min;
        FC.SERVO_CONFIG[i].max = swashPreset.max;
        FC.SERVO_CONFIG[i].rneg = swashPreset.rneg;
        FC.SERVO_CONFIG[i].rpos = swashPreset.rpos;
        if (Number.isFinite(swashRate)) FC.SERVO_CONFIG[i].rate = swashRate;
    }

    if (FC.SERVO_CONFIG?.[TAIL_SERVO_INDEX] && tailPreset) {
        FC.SERVO_CONFIG[TAIL_SERVO_INDEX].mid = tailPreset.mid;
        FC.SERVO_CONFIG[TAIL_SERVO_INDEX].min = tailPreset.min;
        FC.SERVO_CONFIG[TAIL_SERVO_INDEX].max = tailPreset.max;
        FC.SERVO_CONFIG[TAIL_SERVO_INDEX].rneg = tailPreset.rneg;
        FC.SERVO_CONFIG[TAIL_SERVO_INDEX].rpos = tailPreset.rpos;
        if (Number.isFinite(tailRate)) FC.SERVO_CONFIG[TAIL_SERVO_INDEX].rate = tailRate;
    }
}

function computeNeedRebootForServoRates(selection) {
    const swashRate = parseInt(selection.swashFrequency, 10);
    const tailRate = parseInt(selection.tailFrequency, 10);

    // In `servos` tab, changing servo `rate` triggers reboot requirement.
    for (const i of SWASH_SERVO_INDICES) {
        const s = FC.SERVO_CONFIG?.[i];
        if (!s) continue;
        if (Number.isFinite(swashRate) && s.rate !== swashRate) return true;
    }

    const tail = FC.SERVO_CONFIG?.[TAIL_SERVO_INDEX];
    if (tail && Number.isFinite(tailRate) && tail.rate !== tailRate) return true;

    return false;
}

function clampServoDirIndex(dirIndex) {
    const n = parseInt(dirIndex, 10);
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(8, n));
}

/**
 * Mapping (dirIndex -> [S1,S2,S3] reversed):
 * 1 => 正正正
 * 2 => 正正反  (S3 toggles first)
 * ...以此类推...
 * 8 => 反反反
 */
function dirIndexToReversedFlags(dirIndex) {
    const n = clampServoDirIndex(dirIndex);
    const mask = n - 1; // 0..7

    // Bit assignment: keep S3 as least significant bit.
    return [
        // S1
        (mask & 4) !== 0,
        // S2
        (mask & 2) !== 0,
        // S3
        (mask & 1) !== 0,
    ];
}

function reversedFlagsToDirIndex(reversedFlags) {
    const rf = Array.isArray(reversedFlags) ? reversedFlags : [false, false, false];
    const s1Rev = !!rf[0];
    const s2Rev = !!rf[1];
    const s3Rev = !!rf[2];

    // Inverse of `dirIndexToReversedFlags`.
    let mask = 0;
    if (s1Rev) mask |= 4;
    if (s2Rev) mask |= 2;
    if (s3Rev) mask |= 1;
    return mask + 1;
}

function patchServoDirIndexFromFC() {
    try {
        const s1 = FC?.SERVO_CONFIG?.[SWASH_SERVO_INDICES[0]];
        const s2 = FC?.SERVO_CONFIG?.[SWASH_SERVO_INDICES[1]];
        const s3 = FC?.SERVO_CONFIG?.[SWASH_SERVO_INDICES[2]];

        if (!s1 || !s2 || !s3) return;

        const reversedFlags = [
            (s1.flags & SERVO_FLAG_REVERSE) !== 0,
            (s2.flags & SERVO_FLAG_REVERSE) !== 0,
            (s3.flags & SERVO_FLAG_REVERSE) !== 0,
        ];
        const dirIndex = reversedFlagsToDirIndex(reversedFlags);

        const $idx = $('#wizard-dir-index');
        if ($idx.length) $idx.text(String(dirIndex));

        persistPatch({ dirIndex });
    } catch {
        // best-effort only
    }
}

function setDirScreenSavingUI(saving) {
    const $group = $('.tab-setup-wizard .wizard-dir-group');
    if (!$group.length) return;

    if (saving) {
        $group.addClass('wizard-dir-saving');
    } else {
        $group.removeClass('wizard-dir-saving');
    }
}

function saveServoDirScheme(dirIndex) {
    if (wizardDirSaveInProgress) return;

    const nextDirIndex = clampServoDirIndex(dirIndex);
    const reversedFlags = dirIndexToReversedFlags(nextDirIndex); // [S1,S2,S3]

    wizardDirSaveInProgress = true;
    setDirScreenSavingUI(true);

    // Patch only the reverse flag bit; keep other servo settings as-is.
    for (let k = 0; k < 3; k++) {
        const servoIndex = SWASH_SERVO_INDICES[k];
        if (!FC?.SERVO_CONFIG?.[servoIndex]) continue;
        const cur = FC.SERVO_CONFIG[servoIndex].flags | 0;
        const newFlags = (cur & ~SERVO_FLAG_REVERSE) | (reversedFlags[k] ? SERVO_FLAG_REVERSE : 0);
        FC.SERVO_CONFIG[servoIndex].flags = newFlags;
    }

    mspHelper.sendServoConfigurations(function () {
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
            GUI.log(i18n.getMessage('eepromSaved'));
            wizardDirSaveInProgress = false;
            setDirScreenSavingUI(false);
            persistPatch({ dirIndex: nextDirIndex });
        });
    });
}

let wizardServoSaveInProgress = false;
let wizardDirSaveInProgress = false;

/** 程序化同步「更多设置」单选项时置位，避免触发 change 再次写入。 */
let wizardMoreSettingsApplying = false;
let wizardMoreSettingsSaveInProgress = false;

/** True while MSP_SET_MIXER_CONFIG + EEPROM for swash trim from wizard screens 6/7 is in flight. */
let wizardSwashTrimSaveInProgress = false;

/** True while MSP_SET_MIXER_INPUT + EEPROM for screen 8 pitch calibration adjust is in flight. */
let wizardPitchCalibSaveInProgress = false;

/** True while tail trim / mixer input 3 adjust from screens 9–10 is in flight. */
let wizardTailMixerSaveInProgress = false;

let wizardBaseSaveInProgress = false;
let wizardBaseDirty = false;
let wizardBaseBaseline = { swash: '', install: '' };

function setMoreSettingsSavingUI(saving) {
    const $inputs = $(
        '.tab-setup-wizard .wizard-screen[data-screen="3"] input[name="more_rotation_dir"], ' +
            '.tab-setup-wizard .wizard-screen[data-screen="3"] input[name="more_positive_pitch_dir"]',
    );
    if (!$inputs.length) return;
    $inputs.prop('disabled', !!saving);
}

/**
 * 从 FC 同步「更多设置」：主旋翼旋转方向、集体螺距控制方向（与混控页一致）。
 */
function applyMoreSettingsUIFromFC() {
    const $screen = $('.tab-setup-wizard .wizard-screen[data-screen="3"]');
    if (!$screen.length) return;

    wizardMoreSettingsApplying = true;
    try {
        // 与 `mixer.html` #mixerMainRotorDirection 一致：0 顺时针，1 逆时针（勿用 === 1，固件可能给字符串）
        const rotorDir = parseInt(FC?.MIXER_CONFIG?.main_rotor_dir, 10);
        const rotVal = rotorDir === 1 ? '1' : '0';
        $screen.find(`input[name="more_rotation_dir"][value="${rotVal}"]`).prop('checked', true);

        // 与混控页 #mixerCollectiveDirection 一致：集体输入 rate<0 为反向（向下），否则为正向（向上）
        const collRaw = FC?.MIXER_INPUTS?.[MIXER_INPUT_COLLECTIVE_INDEX]?.rate;
        const collRate = Number(collRaw);
        const pitchVal = Number.isFinite(collRate) && collRate < 0 ? 'negative' : 'positive';
        $screen.find(`input[name="more_positive_pitch_dir"][value="${pitchVal}"]`).prop('checked', true);
    } catch {
        /* ignore */
    } finally {
        wizardMoreSettingsApplying = false;
    }
}

/** 集体螺距：向上=正常(rate>=0)，向下=反向(rate<0)；保持绝对值不变（与 mixer 页逻辑一致）。 */
function writeCollectiveDirectionSignToFC(wantPositive) {
    const input = FC?.MIXER_INPUTS?.[MIXER_INPUT_COLLECTIVE_INDEX];
    if (!input) return false;
    const sign = wantPositive ? 1 : -1;
    input.rate = Math.abs(input.rate) * sign;
    return true;
}

function saveMoreSettingsMainRotorImmediate() {
    if (wizardMoreSettingsApplying || wizardMoreSettingsSaveInProgress) return;

    const val = $('.tab-setup-wizard input[name="more_rotation_dir"]:checked').val();
    const n = parseInt(val, 10);
    if (!Number.isFinite(n) || (n !== 0 && n !== 1)) return;

    FC.MIXER_CONFIG.main_rotor_dir = n;

    wizardMoreSettingsSaveInProgress = true;
    setMoreSettingsSavingUI(true);

    MSP.send_message(MSPCodes.MSP_SET_MIXER_CONFIG, mspHelper.crunch(MSPCodes.MSP_SET_MIXER_CONFIG), false, function () {
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
            GUI.log(i18n.getMessage('eepromSaved'));
            wizardMoreSettingsSaveInProgress = false;
            setMoreSettingsSavingUI(false);
        });
    });
}

function saveMoreSettingsCollectiveImmediate() {
    if (wizardMoreSettingsApplying || wizardMoreSettingsSaveInProgress) return;

    const val = $('.tab-setup-wizard input[name="more_positive_pitch_dir"]:checked').val();
    const wantPositive = val === 'positive';
    if (!writeCollectiveDirectionSignToFC(wantPositive)) return;

    wizardMoreSettingsSaveInProgress = true;
    setMoreSettingsSavingUI(true);

    mspHelper.sendMixerInput(MIXER_INPUT_COLLECTIVE_INDEX, function () {
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
            GUI.log(i18n.getMessage('eepromSaved'));
            wizardMoreSettingsSaveInProgress = false;
            setMoreSettingsSavingUI(false);
        });
    });
}

function setBaseScreenSavingUI(saving) {
    const $next = $('.tab-setup-wizard .wizard-screen[data-screen="2"] .wizard-btn-next');
    const $swashInputs = $('.tab-setup-wizard input[name="swash"]');
    const $installInputs = $('.tab-setup-wizard input[name="install"]');

    if (!$next.length) return;

    if (saving) {
        if (!$next.data('original-text')) {
            $next.data('original-text', $next.text() || i18n.getMessage('setupWizardNext'));
        }
        $next.addClass('wizard-next-saving').text('保存中…');
        $swashInputs.prop('disabled', true);
        $installInputs.prop('disabled', true);
    } else {
        $next.removeClass('wizard-next-saving').text($next.data('original-text') || i18n.getMessage('setupWizardNext'));
        $swashInputs.prop('disabled', false);
        $installInputs.prop('disabled', false);
    }
}

function getBaseWizardSelectionFromUI() {
    return {
        swash: $('.tab-setup-wizard input[name="swash"]:checked').val() || '',
        install: $('.tab-setup-wizard input[name="install"]:checked').val() || '',
    };
}

function syncWizardBaseBaselineFromUI() {
    wizardBaseBaseline = getBaseWizardSelectionFromUI();
    wizardBaseDirty = false;
}

function patchBaseWizardSelectionsFromFC() {
    try {
        // Swash selection: swash_type + elevator direction sign
        const swashType = FC?.MIXER_CONFIG?.swash_type;
        const aileronRate = FC?.MIXER_INPUTS?.[1]?.rate;
        const elevatorRate = FC?.MIXER_INPUTS?.[2]?.rate;

        let swash = '';
        const aileronDir = (typeof aileronRate === 'number' && aileronRate !== 0) ? Math.sign(aileronRate) : 0;
        const elevatorDir = (typeof elevatorRate === 'number' && elevatorRate !== 0) ? Math.sign(elevatorRate) : 0;

        if (swashType === 2) {
            if (aileronDir === 1 && elevatorDir === 1) swash = 'h3_120';
            else if (aileronDir === 1 && elevatorDir === -1) swash = 'hr3_120';
        } else if (swashType === 3) {
            if (aileronDir === 1 && elevatorDir === 1) swash = 'h3_135';
            else if (aileronDir === 1 && elevatorDir === -1) swash = 'hr3_135';
        } else if (swashType === 4) {
            if (aileronDir === 1 && elevatorDir === 1) swash = 'h3_140';
            else if (aileronDir === 1 && elevatorDir === -1) swash = 'hr3_140';
        }

        // Install orientation selection: BOARD_ALIGNMENT_CONFIG roll/pitch/yaw
        const roll = FC?.BOARD_ALIGNMENT_CONFIG?.roll;
        const pitch = FC?.BOARD_ALIGNMENT_CONFIG?.pitch;
        const yaw = FC?.BOARD_ALIGNMENT_CONFIG?.yaw;

        let install = '';
        if (parseInt(roll, 10) === 0 && parseInt(pitch, 10) === 180 && parseInt(yaw, 10) === 0) {
            install = '4';
        } else if (parseInt(roll, 10) === 180 && parseInt(pitch, 10) === 0 && parseInt(yaw, 10) === 0) {
            install = '3';
        } else if (parseInt(roll, 10) === 0 && parseInt(pitch, 10) === 0 && parseInt(yaw, 10) === 180) {
            install = '2';
        } else if (parseInt(roll, 10) === 0 && parseInt(pitch, 10) === 0 && parseInt(yaw, 10) === 0) {
            install = '1';
        }

        persistPatch({ swash, install });
    } catch {
        // best-effort only
    }
}

function writeBaseWizardSelectionToFC(selection) {
    const swashMap = SWASH_SELECTION_TO_MIXER_MAP[selection.swash];
    const installMap = INSTALL_TO_BOARD_ALIGNMENT_MAP[selection.install];

    if (!swashMap || !installMap) return;

    FC.MIXER_CONFIG.swash_type = swashMap.swashType;

    // Only flip direction sign; keep min/max/abs value as-is.
    if (FC.MIXER_INPUTS?.[1]) {
        FC.MIXER_INPUTS[1].rate = Math.abs(FC.MIXER_INPUTS[1].rate) * swashMap.aileronDir;
    }
    if (FC.MIXER_INPUTS?.[2]) {
        FC.MIXER_INPUTS[2].rate = Math.abs(FC.MIXER_INPUTS[2].rate) * swashMap.elevatorDir;
    }

    FC.BOARD_ALIGNMENT_CONFIG.roll = installMap.roll;
    FC.BOARD_ALIGNMENT_CONFIG.pitch = installMap.pitch;
    FC.BOARD_ALIGNMENT_CONFIG.yaw = installMap.yaw;
}

function saveBaseWizardSelectionAndNext(nextIndex) {
    const selection = getBaseWizardSelectionFromUI();
    if (!selection.swash || !selection.install) {
        GUI.log('请选择十字盘类型与安装方向');
        return;
    }

    const swashMap = SWASH_SELECTION_TO_MIXER_MAP[selection.swash];
    const installMap = INSTALL_TO_BOARD_ALIGNMENT_MAP[selection.install];
    if (!swashMap || !installMap) {
        GUI.log('基础设置参数无效');
        return;
    }

    // Persist chosen selections so reconnect can restore the same UI state.
    persistPatch({ swash: selection.swash, install: selection.install });

    writeBaseWizardSelectionToFC(selection);

    setBaseScreenSavingUI(true);
    wizardBaseSaveInProgress = true;
    wizardBaseDirty = false;

    const sendMixerInputIfPresent = (index, cb) => {
        if (FC.MIXER_INPUTS?.[index]) {
            mspHelper.sendMixerInput(index, cb);
        } else {
            cb?.();
        }
    };

    MSP.send_message(
        MSPCodes.MSP_SET_MIXER_CONFIG,
        mspHelper.crunch(MSPCodes.MSP_SET_MIXER_CONFIG),
        false,
        function () {
            sendMixerInputIfPresent(1, function () {
                sendMixerInputIfPresent(2, function () {
                    MSP.send_message(
                        MSPCodes.MSP_SET_BOARD_ALIGNMENT_CONFIG,
                        mspHelper.crunch(MSPCodes.MSP_SET_BOARD_ALIGNMENT_CONFIG),
                        false,
                        function () {
                            MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
                                GUI.log(i18n.getMessage('eepromSaved'));
                                persistPatch({ screenIndex: nextIndex });
                                GUI.log(i18n.getMessage('deviceRebooting'));
                                stageSetupWizardReconnectAfterReboot('base-wizard-reboot');
                                GUI.log('[SetupWizard] saveBase: MSP_SET_REBOOT + reinitialiseConnection');
                                MSP.send_message(MSPCodes.MSP_SET_REBOOT);
                                reinitialiseConnection();
                            });
                        },
                    );
                });
            });
        },
    );
}

function setServoScreenSavingUI(saving) {
    const $next = $('.tab-setup-wizard .wizard-screen[data-screen="1"] .wizard-btn-next');
    const $swashNeutral = $('#wizard-swash-neutral-point');
    const $swashFrequency = $('#wizard-swash-frequency');
    const $tailNeutral = $('#wizard-tail-neutral-point');
    const $tailFrequency = $('#wizard-tail-frequency');

    if (!$next.length) return;

    if (saving) {
        if (!$next.data('original-text')) {
            $next.data('original-text', $next.text() || i18n.getMessage('setupWizardNext'));
        }
        $next.addClass('wizard-next-saving').text('保存中…');
        $swashNeutral.prop('disabled', true);
        $swashFrequency.prop('disabled', true);
        $tailNeutral.prop('disabled', true);
        $tailFrequency.prop('disabled', true);
    } else {
        $next.removeClass('wizard-next-saving').text($next.data('original-text') || i18n.getMessage('setupWizardNext'));
        $swashNeutral.prop('disabled', false);
        $swashFrequency.prop('disabled', false);
        $tailNeutral.prop('disabled', false);
        $tailFrequency.prop('disabled', false);
    }
}

function saveServoWizardSelectionAndNext(nextIndex) {
    const selection = getServoWizardSelectionFromUI();
    const required = ['swashNeutralPoint', 'swashFrequency', 'tailNeutralPoint', 'tailFrequency'];
    const missing = required.filter((k) => !selection[k]);
    if (missing.length > 0) {
        GUI.log('请选择舵机中位点和频率');
        return;
    }

    // Capture whether `rate` needs reboot before overwriting FC.SERVO_CONFIG.
    const needReboot = computeNeedRebootForServoRates(selection);

    // Persist chosen selections so reconnect can restore the same UI state.
    persistPatch({
        swashNeutralPoint: selection.swashNeutralPoint,
        swashFrequency: selection.swashFrequency,
        tailNeutralPoint: selection.tailNeutralPoint,
        tailFrequency: selection.tailFrequency,
    });

    writeServoWizardSelectionToFC(selection);

    setServoScreenSavingUI(true);
    wizardServoSaveInProgress = true;

    GUI.log(`[SetupWizard] saveServo: needReboot=${needReboot} nextScreen=${nextIndex}`);
    mspHelper.sendServoConfigurations(function () {
        GUI.log('[SetupWizard] saveServo: sendServoConfigurations OK, EEPROM write…');
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
            GUI.log(i18n.getMessage('eepromSaved'));

            if (needReboot) {
                // Keep UI on Screen 1 until reconnect; then `applyPersistedWizardState()` will move to next screen.
                persistPatch({ screenIndex: nextIndex });
                GUI.log(i18n.getMessage('deviceRebooting'));
                stageSetupWizardReconnectAfterReboot('servo-rate-reboot');
                GUI.log('[SetupWizard] saveServo: MSP_SET_REBOOT + reinitialiseConnection');
                MSP.send_message(MSPCodes.MSP_SET_REBOOT);
                reinitialiseConnection();
                return;
            }

            wizardServoSaveInProgress = false;
            setServoScreenSavingUI(false);
            GUI.log(`[SetupWizard] saveServo: no reboot, goToScreen(${nextIndex})`);
            goToScreen(nextIndex);
        });
    });
}

function bindWizardEvents() {
    $('.tab-setup-wizard').off();

    $('.tab-setup-wizard').on('click', '.wizard-btn-quick-basic', function (e) {
        e.preventDefault();
        if (wizardQuickBasicUiState === 'done' || wizardQuickBasicUiState === 'writing') {
            return;
        }
        runWizardQuickBasicWrite();
    });

    $('.tab-setup-wizard').on('click', '.wizard-btn-back', function (e) {
        e.preventDefault();
        if (wizardQuickBasicIsWriting()) {
            return;
        }
        const $screen = $('.tab-setup-wizard .wizard-screen.active');
        const idx = parseInt($screen.attr('data-screen'), 10);
        if (idx <= 0) {
            switchToSetupTab();
        } else {
            goToScreen(idx - 1);
        }
    });

    $('.tab-setup-wizard').on('click', '.wizard-btn-next', function (e) {
        e.preventDefault();
        if (wizardQuickBasicIsWriting()) {
            return;
        }
        const $screen = $('.tab-setup-wizard .wizard-screen.active');
        const idx = parseInt($screen.attr('data-screen'), 10);
        if (idx === 5 && wizardDirSaveInProgress) return;
        if (idx === 1) {
            if (!wizardServoSaveInProgress && idx < LAST_INDEX) {
                saveServoWizardSelectionAndNext(idx + 1);
            }
            return;
        }
        if (idx === 2) {
            if (wizardBaseSaveInProgress) return;
            if (!wizardBaseDirty) {
                if (idx < LAST_INDEX) goToScreen(idx + 1);
                return;
            }
            if (idx < LAST_INDEX) saveBaseWizardSelectionAndNext(idx + 1);
            return;
        }

        if (idx < LAST_INDEX) goToScreen(idx + 1);
    });

    $('.tab-setup-wizard').on('click', '.wizard-btn-finish', function (e) {
        e.preventDefault();
        if (wizardQuickBasicIsWriting()) {
            return;
        }
        GUI.log(i18n.getMessage('setupWizardFinishDemo'));
        switchToSetupTab();
    });

    $('.tab-setup-wizard').on('click', '.wizard-screen .wizard-btn-help', function (e) {
        e.preventDefault();
        if (wizardQuickBasicIsWriting()) {
            return;
        }
        openWizardHelp();
    });

    $('.tab-setup-wizard').on('click', '.wizard-help-screen .wizard-btn-help--back', function (e) {
        e.preventDefault();
        if (wizardQuickBasicIsWriting()) {
            return;
        }
        closeWizardHelp();
    });

    $('.tab-setup-wizard').on('click', '.wizard-dir-prev', function (e) {
        e.preventDefault();
        if (wizardDirSaveInProgress) return;
        let dirIndex = parseInt($('#wizard-dir-index').text(), 10) || 1;
        dirIndex = dirIndex <= 1 ? 8 : dirIndex - 1;
        $('#wizard-dir-index').text(String(dirIndex));
        persistPatch({ dirIndex });
        saveServoDirScheme(dirIndex);
    });
    $('.tab-setup-wizard').on('click', '.wizard-dir-next', function (e) {
        e.preventDefault();
        if (wizardDirSaveInProgress) return;
        let dirIndex = parseInt($('#wizard-dir-index').text(), 10) || 1;
        dirIndex = dirIndex >= 8 ? 1 : dirIndex + 1;
        $('#wizard-dir-index').text(String(dirIndex));
        persistPatch({ dirIndex });
        saveServoDirScheme(dirIndex);
    });

    $('.tab-setup-wizard').on('change', '#wizard-motor-poles', function () {
        persistPatch({ motorPoles: $(this).val() || '' });
    });

    $('.tab-setup-wizard').on('change', '#wizard-swash-neutral-point', function () {
        persistPatch({ swashNeutralPoint: $(this).val() || '' });
    });
    $('.tab-setup-wizard').on('change', '#wizard-swash-frequency', function () {
        persistPatch({ swashFrequency: $(this).val() || '' });
    });
    $('.tab-setup-wizard').on('change', '#wizard-tail-neutral-point', function () {
        persistPatch({ tailNeutralPoint: $(this).val() || '' });
    });
    $('.tab-setup-wizard').on('change', '#wizard-tail-frequency', function () {
        persistPatch({ tailFrequency: $(this).val() || '' });
    });

    $('.tab-setup-wizard').on('change', 'input[name="swash"]', function () {
        const nextSwash = $(this).val() || '';
        persistPatch({ swash: nextSwash });
        const installNow = $('.tab-setup-wizard input[name="install"]:checked').val() || '';
        wizardBaseDirty = (String(nextSwash) !== String(wizardBaseBaseline.swash || '')) ||
                           (String(installNow) !== String(wizardBaseBaseline.install || ''));
    });

    $('.tab-setup-wizard').on('change', 'input[name="install"]', function () {
        const nextInstall = $(this).val() || '';
        persistPatch({ install: nextInstall });
        const swashNow = $('.tab-setup-wizard input[name="swash"]:checked').val() || '';
        wizardBaseDirty = (String(swashNow) !== String(wizardBaseBaseline.swash || '')) ||
                           (String(nextInstall) !== String(wizardBaseBaseline.install || ''));
    });

    $('.tab-setup-wizard').on('change', 'input[name="more_rotation_dir"]', function () {
        saveMoreSettingsMainRotorImmediate();
    });
    $('.tab-setup-wizard').on('change', 'input[name="more_positive_pitch_dir"]', function () {
        saveMoreSettingsCollectiveImmediate();
    });

    $('.tab-setup-wizard').on('click', '.wizard-zero-pitch-trim', function (e) {
        e.preventDefault();
        const mode = $(this).data('zero-trim');
        const sign = mixerInputDirectionSign(MIXER_INPUT_COLLECTIVE_INDEX);
        const delta =
            mode === 'increase'
                ? WIZARD_SWASH_TRIM_STEP * sign
                : -WIZARD_SWASH_TRIM_STEP * sign;
        applyWizardSwashTrimDelta(2, delta);
    });

    $('.tab-setup-wizard').on('click', '.wizard-dpad-btn', function (e) {
        e.preventDefault();
        const dir = $(this).data('dir');
        const step = WIZARD_SWASH_TRIM_STEP;
        if (dir === 'front') {
            applyWizardSwashTrimDelta(1, step * mixerInputDirectionSign(MIXER_INPUT_ELEVATOR_INDEX));
        } else if (dir === 'back') {
            applyWizardSwashTrimDelta(1, -step * mixerInputDirectionSign(MIXER_INPUT_ELEVATOR_INDEX));
        } else if (dir === 'right') {
            applyWizardSwashTrimDelta(0, step * mixerInputDirectionSign(MIXER_INPUT_AILERON_INDEX));
        } else if (dir === 'left') {
            applyWizardSwashTrimDelta(0, -step * mixerInputDirectionSign(MIXER_INPUT_AILERON_INDEX));
        }
    });

    $('.tab-setup-wizard').on(
        'click',
        '.wizard-calib-adjust .regular-button:not(.wizard-calib-pitch-adjust-btn):not(.wizard-calib-tail-zero-adjust-btn):not(.wizard-calib-tail-pitch22-adjust-btn):not(.wizard-calib-tail-travel-left-adjust-btn):not(.wizard-calib-tail-travel-right-adjust-btn)',
        function (e) {
            e.preventDefault();
            GUI.log(i18n.getMessage('setupWizardDemoAdjust'));
        },
    );

    $('.tab-setup-wizard').on('click', '.wizard-calib-pitch-zero-btn', function (e) {
        e.preventDefault();
        if ($(this).hasClass('disabled')) return;
        const $screen8 = $('.tab-setup-wizard .wizard-screen[data-screen="8"]');
        if ($screen8.hasClass('wizard-pitch-zero-test-mode')) {
            exitPitchZeroTestMode();
            return;
        }
        if (
            $screen8.hasClass('wizard-pitch-test-mode-collective') ||
            $screen8.hasClass('wizard-pitch-test-mode-cyclic')
        ) {
            return;
        }
        applyPitchZeroTestModeActive();
    });

    $('.tab-setup-wizard').on('click', '.wizard-calib-pitch-test-btn', function (e) {
        e.preventDefault();
        const $screen8 = $('.tab-setup-wizard .wizard-screen[data-screen="8"]');
        if ($screen8.hasClass('wizard-pitch-zero-test-mode')) {
            return;
        }
        const collective = $(this).closest('.wizard-calib-block').hasClass('wizard-calib-block--pitch-collective');
        const modeClass = collective ? 'wizard-pitch-test-mode-collective' : 'wizard-pitch-test-mode-cyclic';
        if ($screen8.hasClass(modeClass)) {
            resetPitchCalibScreenUI();
            syncWizardMixerScreen8Idle();
            return;
        }
        if (
            $screen8.hasClass('wizard-pitch-test-mode-collective') ||
            $screen8.hasClass('wizard-pitch-test-mode-cyclic')
        ) {
            return;
        }
        applyPitchCalibTestModeActive(collective);
    });

    $('.tab-setup-wizard').on('click', '.wizard-calib-pitch-adjust-btn', function (e) {
        e.preventDefault();
        if ($(this).hasClass('disabled')) return;
        const $adj = $(this).closest('.wizard-calib-adjust');
        const increase = $adj.find('.wizard-calib-pitch-adjust-btn').index($(this)) === 0;
        const collective = $(this).closest('.wizard-calib-block').hasClass('wizard-calib-block--pitch-collective');
        applyWizardPitchCalibrationAdjust(collective, increase);
    });

    $('.tab-setup-wizard').on('click', '.wizard-calib-tail-zero-test-btn', function (e) {
        e.preventDefault();
        const $s = $('.tab-setup-wizard .wizard-screen[data-screen="9"]');
        if ($s.hasClass('wizard-tail-zero-test-mode')) {
            resetTailZeroCalibUI();
            syncWizardMixerScreen9Idle();
            return;
        }
        applyTailZeroCalibTestModeActive();
    });

    $('.tab-setup-wizard').on('click', '.wizard-calib-tail-zero-adjust-btn', function (e) {
        e.preventDefault();
        if ($(this).hasClass('disabled')) return;
        const isRight =
            $(this).closest('.wizard-calib-adjust').find('.wizard-calib-tail-zero-adjust-btn').index($(this)) === 1;
        applyWizardTailCenterTrimAdjust(isRight);
    });

    $('.tab-setup-wizard').on(
        'click',
        '.wizard-calib-tail-pitch22-test-btn, .wizard-calib-tail-travel-left-test-btn, .wizard-calib-tail-travel-right-test-btn',
        function (e) {
            e.preventDefault();
            handleTailPitchScreenTestButtonClick($(this));
        },
    );

    $('.tab-setup-wizard').on(
        'click',
        '.wizard-calib-tail-pitch22-adjust-btn, .wizard-calib-tail-travel-left-adjust-btn, .wizard-calib-tail-travel-right-adjust-btn',
        function (e) {
            e.preventDefault();
            if ($(this).hasClass('disabled')) return;
            const $adj = $(this).closest('.wizard-calib-adjust');
            const increase = $adj.find('a.regular-button').index($(this)) === 0;
            if ($(this).hasClass('wizard-calib-tail-pitch22-adjust-btn')) {
                applyWizardTailYawCalibrationAdjust(increase);
            } else if ($(this).hasClass('wizard-calib-tail-travel-left-adjust-btn')) {
                applyWizardTailTravelMinAdjust(increase);
            } else if ($(this).hasClass('wizard-calib-tail-travel-right-adjust-btn')) {
                applyWizardTailTravelMaxAdjust(increase);
            }
        },
    );

    $('.tab-setup-wizard').on(
        'click',
        '.wizard-calib-side-btn:not(.wizard-calib-pitch-test-btn):not(.wizard-calib-pitch-zero-btn)',
        function (e) {
            e.preventDefault();
            GUI.log(i18n.getMessage('setupWizardDemoCalibBtn'));
        },
    );

    $('.tab-setup-wizard').on('click', '.wizard-calc-btn', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardDemoCalculator'));
    });

    $('.tab-setup-wizard').on('click', '.wizard-write-params', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardDemoWrite'));
    });
}

tab.onReconnect = function () {
    GUI.log('[SetupWizard] onReconnect: start');
    console.log('[SetupWizard] tab.onReconnect', {
        pendingBefore: GUI.setupWizardDisconnectPending,
        active_tab: GUI.active_tab,
    });
    setWizardQuickBasicUIState('idle');

    $('.tab-setup-wizard .wizard-help-screen').removeClass('active');
    applyPersistedWizardState();

    refreshWizardQuickBasicStatusFromFC();

    // Ensure strategy B UI is restored after reboot/connect.
    wizardServoSaveInProgress = false;
    setServoScreenSavingUI(false);
    wizardDirSaveInProgress = false;
    setDirScreenSavingUI(false);
    wizardMoreSettingsSaveInProgress = false;
    setMoreSettingsSavingUI(false);
    wizardSwashTrimSaveInProgress = false;
    wizardPitchCalibSaveInProgress = false;
    wizardTailMixerSaveInProgress = false;
    MSP.promise(MSPCodes.MSP_MIXER_CONFIG)
        .then(() => MSP.promise(MSPCodes.MSP_MIXER_INPUTS))
        .then(() => applyMoreSettingsUIFromFC())
        .catch(() => applyMoreSettingsUIFromFC());
    wizardBaseSaveInProgress = false;
    setBaseScreenSavingUI(false);
    syncWizardBaseBaselineFromUI();
    // Re-bind handlers in case disconnect/reconnect cleared them (e.g. via cleanup()).
    bindWizardEvents();
    GUI.log('[SetupWizard] onReconnect: done (servoSave cleared, events rebound)');
};

tab.initialize = function (callback) {
    $('#content').load("/src/tabs/setup_wizard.html", function () {
        clearPersistedWizardState();

        i18n.localizePage();

        populateServoTypeOptions();

        populateMotorPolesOptions();
        bindWizardEvents();
        // Load current servo configuration from FC and backfill Screen 1 selections (best-effort).
        Promise.resolve()
            .then(() => MSP.promise(MSPCodes.MSP_STATUS))
            .then(() => MSP.promise(MSPCodes.MSP_SERVO_CONFIGURATIONS))
            .then(() => patchServoSelectionsFromFC())
            .then(() => MSP.promise(MSPCodes.MSP_MIXER_CONFIG))
            .then(() => MSP.promise(MSPCodes.MSP_MIXER_INPUTS))
            .then(() => MSP.promise(MSPCodes.MSP_MIXER_OVERRIDE))
            .then(() => MSP.promise(MSPCodes.MSP_BOARD_ALIGNMENT_CONFIG))
            .then(() => patchBaseWizardSelectionsFromFC())
            .catch(() => {
                // Best-effort only; wizard still works with default/session values.
            })
            .finally(() => {
                applyPersistedWizardState();
                applyMoreSettingsUIFromFC();
                setServoScreenSavingUI(false);
                setBaseScreenSavingUI(false);
                syncWizardBaseBaselineFromUI();
                GUI.content_ready(callback);
                refreshWizardQuickBasicStatusFromFC();
            });
    });
};

tab.cleanup = function (callback) {
    stopWizardReceiverPolling();
    $('.tab-setup-wizard').off();
    // Forced disconnect (FC reboot / device_lost): serial is already dead; MSP callbacks never fire and
    // `handleConnectClick` would await forever before `finishClose`.
    if (!serial.connected || GUI.setupWizardDisconnectPending || GUI.reboot_in_progress) {
        callback?.();
        return;
    }
    mspHelper.resetMixerOverrides(callback);
};

TABS[tab.tabName] = tab;

if (import.meta.hot) {
    import.meta.hot.accept((newModule) => {
        if (newModule && GUI.active_tab === tab.tabName) {
            TABS[tab.tabName].initialize();
        }
    });

    import.meta.hot.dispose(() => {
        tab.cleanup();
    });
}
