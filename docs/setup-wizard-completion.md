# 调机向导：完成度报告与 MSP 对接索引

本文档与 [setup-wizard-context.md](setup-wizard-context.md) 配套，记录 **已实现 MSP**、**仍为 Demo 的控件**，以及屏 4 / 6–12 对接时可复用的 Tab 与 MSP 入口。

## 1. 按屏摘要（相对「按钮应通过 MSP 改参数」）

| 屏 `data-screen` | 主题 | 已写飞控 / EEPROM | 仍为 Demo 或仅本地 |
|------------------|------|-------------------|---------------------|
| 0 | 开始 | 无 | 仅导航 |
| 1 | 舵机中位/频率 | 下一步 → `sendServoConfigurations` + `MSP_EEPROM_WRITE`（频率变更可能触发重启） | 下拉仅 `persistPatch`，落盘在点「下一步」 |
| 2 | 十字盘 + 安装 | 有改动时 `MSP_SET_MIXER_CONFIG`、`sendMixerInput(1,2)`、`MSP_SET_BOARD_ALIGNMENT_CONFIG`、EEPROM、重启 | 与基准一致时只翻页 |
| 3 | 转向 + 集体正负 | `MSP_SET_MIXER_CONFIG`（`main_rotor_dir`）、`sendMixerInput(4)` + EEPROM | — |
| 4 | 接收机 | 无 | 四通道条 + 顶栏四格（ARM / 油门 / Bank / 电机）：轮询 `MSP_STATUS`、`MSP_RC`、`MSP_RC_COMMAND`（仅读）；接收机类型 `<select>` 无绑定 |
| 5 | 舵机方向方案 | `saveServoDirScheme` → `sendServoConfigurations` + EEPROM | 动画区占位文案 |
| 6 | 零螺距 | 无 | `.wizard-demo-pitch` → `GUI.log` |
| 7 | 十字盘水平 | 无 | `.wizard-dpad-btn` → `GUI.log` |
| 8 | 螺距校正 | 无（仅测试态 UI） | 归零/增减多为 `GUI.log` |
| 9 | 尾向 + 尾桨 0° | 无 | `name="taildir"` 无 JS；测试/左右 → `GUI.log` |
| 10 | 尾桨 22° / 行程 | 无（仅测试态 UI） | 增减 → `GUI.log` |
| 11 | 定速器 | 无 | `#wizard-motor-poles` 仅 `persistPatch`；其余输入/下拉无 MSP |
| 12 | 预设 / 完成 | 无 | `wizard-write-params`、`wizard-btn-finish` → `GUI.log` 后回设置 Tab（会话清空由 `initialize` 每次进入时执行，见 context 文档） |

## 2. 已实现 MSP 消息（归纳）

实现位置：[src/js/tabs/setup_wizard.js](../src/js/tabs/setup_wizard.js)。

- `MSP_SET_MIXER_CONFIG`（`mspHelper.crunch`）：屏 2 十字盘类型、屏 3 主旋翼转向。
- `mspHelper.sendMixerInput`：通道 1、2（副翼/升降符号）；索引 4（集体正负）。
- `MSP_SET_BOARD_ALIGNMENT_CONFIG`：屏 2 安装方向。
- `mspHelper.sendServoConfigurations`：屏 1 舵机字段、屏 5 反向位。
- `MSP_EEPROM_WRITE`、`MSP_SET_REBOOT`：上述流程部分使用。
- 读取：`MSP_STATUS`、`MSP_SERVO_CONFIGURATIONS`、`MSP_MIXER_CONFIG`、`MSP_MIXER_INPUTS`、`MSP_BOARD_ALIGNMENT_CONFIG`（`tab.initialize` 内）。
- 读取（屏 4 显示时轮询）：进入屏 4 时先拉 `MSP_MODE_RANGES` / `MSP_MODE_RANGES_EXTRA`，再定时 `MSP_STATUS`（`profile`/`rateProfile`）、`MSP_RC`、`MSP_RC_COMMAND`。ARM 格为 **模式页范围 + 当前 RC** 判定开关是否在 ARM 位（非 `FC.CONFIG.mode` 实际解锁）；油门百分比同状态 Tab 通道 4：`/10+50`。

## 3. 控件清单 vs `bindWizardEvents`（测试用）

下列为 [setup_wizard.html](../src/tabs/setup_wizard.html) 中与交互相关的主要选择器，以及 [setup_wizard.js](../src/js/tabs/setup_wizard.js) 是否处理。

| 区域 | 选择器 / 元素 | 行为 |
|------|----------------|------|
| 全局 | `#button-documentation` | 由 [gui.js](../src/js/gui.js) 统一挂帮助，非向导内逻辑 |
| 0 | `.wizard-btn-back` / `.wizard-btn-next` / `.wizard-btn-help` | 导航 / 帮助壳 |
| 1 | `#wizard-swash-neutral-point` 等 4 个 `<select>` | `change` → `persistPatch`；**下一步** → MSP 写舵机 |
| 2 | `input[name="swash"]` / `input[name="install"]` | `change` → `persistPatch` + `wizardBaseDirty`；**下一步** → 有条件 MSP + 重启 |
| 3 | `input[name="more_rotation_dir"]` / `more_positive_pitch_dir` | `change` → 立即 MSP + EEPROM |
| 4 | `.wizard-select`（接收机类型）、通道条 | **无**专门委托；条为静态 HTML |
| 5 | `.wizard-dir-prev` / `.wizard-dir-next` | MSP 写 S1–S3 reverse |
| 6 | `.wizard-demo-pitch` | `GUI.log` |
| 7 | `.wizard-dpad-btn` | `GUI.log` |
| 8 | `.wizard-calib-side-btn`（步 1 归零） | `GUI.log`（`:not(.wizard-calib-pitch-test-btn)` 分支） |
| 8 | `.wizard-calib-pitch-test-btn` | 仅切换测试态 CSS |
| 8 | `.wizard-calib-pitch-adjust-btn` | `GUI.log` |
| 9 | `input[name="taildir"]` | **无绑定** |
| 9 | `.wizard-calib-tail-zero-test-btn` / `-adjust-btn` | 测试态 UI / `GUI.log` |
| 10 | `.wizard-calib-tail-*-test-btn` / `-adjust-btn` | 测试态 UI / `GUI.log` |
| 11 | `#wizard-motor-poles` | `change` → `persistPatch` |
| 11 | 定速模式 `<select>`、KV、电压、传动比、`.wizard-calc-btn` | **无绑定** |
| 12 | 预设区多个 `.wizard-select` | **无绑定** |
| 12 | `.wizard-write-params` | `GUI.log` |
| 12 | `.wizard-btn-finish` | `GUI.log` + 回设置 Tab（**下次**侧栏进入向导时 `initialize` 会清空会话） |

**说明**：`.wizard-calib-adjust` 内部分按钮通过「排除列表」落到通用 demo 处理器；以 `setup_wizard.js` 中 `bindWizardEvents` 为准做回归。

## 4. 屏 4 / 6–12：建议复用的代码与 MSP（优先级 backlog）

### 4.1 接收机实时通道（屏 4）

- **参考**：[src/js/tabs/status.js](../src/js/tabs/status.js) — `MSP_RC`、`MSP_RC_COMMAND` 轮询与 UI 更新思路；[src/js/msp/MSPHelper.js](../src/js/msp/MSPHelper.js) — `MSP_RC` 解析写入 `FC.RC.channels`。
- **补充**：接收机配置/映射见 [src/tabs/receiver/Receiver.svelte](../src/tabs/receiver/Receiver.svelte)（经 [receiver.js](../src/js/tabs/receiver.js) 挂载）；向导内若需改 RX 类型，应对齐该 Tab 使用的 MSP（如 `MSP_RX_CONFIG` 等，以 Svelte 内实际调用为准）。

### 4.2 定速器 / 电机相关（屏 11）

- **参考**：[src/tabs/governor/Governor.svelte](../src/tabs/governor/Governor.svelte) — 加载 `MSP_GOVERNOR_CONFIG`、`MSP_FEATURE_CONFIG`、`MSP_RX_CONFIG`、`MSP_RC_CONFIG`、`MSP_RX_MAP`、`MSP_RX_CHANNELS`；保存 `MSP_SET_GOVERNOR_CONFIG`、`MSP_SET_FEATURE_CONFIG`、`MSP_EEPROM_WRITE`，部分路径 `MSP_SET_REBOOT`。
- **对接建议**：向导页字段与 `FC.GOVERNOR` / feature 位对齐后再调用同一套 `mspHelper`/`MSP.send_message` 模式。

### 4.3 预设 / 批量写参（屏 12）

- **参考**：[src/js/tabs/presets.js](../src/js/tabs/presets.js) — CLI、`diff`/`dump`、Preset 应用流程；与飞控交互以 CLI 为主而非单条 MSP。
- **对接建议**：「写入参数」更可能复用 Preset 应用或显式导航到 Presets Tab，而非在向导内重写协议。

### 4.4 舵机微调 / 校准（屏 6–8、10）

- **参考**：[src/js/tabs/servos.js](../src/js/tabs/servos.js) — `sendServoConfigurations`、反向与行程等；若固件有专用校准 MSP，需在 [MSPCodes](../src/js/msp/MSPCodes.js) 与 MSPHelper 中核对后再接。

### 4.5 尾向（屏 9）

- **待定义**：与 `MIXER_CONFIG` / 尾桨混控相关字段的对应关系需对照固件与 [mixer.js](../src/js/tabs/mixer.js) 后再绑定 `taildir`。

---

*随实现推进请更新本节表格与「无绑定」行，避免与代码脱节。*

---

## 修订记录

### 2026-04-03 — 屏 6 / 屏 7 斜盘微调（`swash_trim`）

- **屏 6（零螺距）**：选择器 `.wizard-zero-pitch-trim`（`data-zero-trim="increase|decrease"`，i18n「增加」「降低」）→ 按混控**集体**控制方向调整 `FC.MIXER_CONFIG.swash_trim[2]`，步进 **0.2%**（固件内部单位 ±2，与混控页 `#mixerSwashCollectiveTrim` 一致），`MSP_SET_MIXER_CONFIG` + `MSP_EEPROM_WRITE`。方向符号与混控页相同：`FC.MIXER_INPUTS[4].rate` 为负视为反向（见 [mixer.js](../src/js/tabs/mixer.js) `data_to_form` 中 `collDir`）。
- **屏 7（倾斜盘水平）**：`.wizard-dpad-btn`（`data-dir="front|back|left|right"`，**上为前**）→ **前/后** 写 `swash_trim[1]`（俯仰/升降），**左/右** 写 `swash_trim[0]`（横滚/副翼）；同上步进与保存。方向：`MIXER_INPUTS[2]`（升降）、`MIXER_INPUTS[1]`（副翼）。
- **进入屏 6 或 7**：`goToScreen` 内会 best-effort 调用 `MSP_MIXER_CONFIG`、`MSP_MIXER_INPUTS`，减少在他 Tab 修改混控后仍用内存旧值的问题。
- **实现位置**：[setup_wizard.js](../src/js/tabs/setup_wizard.js) 中 `applyWizardSwashTrimDelta`、`mixerInputDirectionSign`、`refreshWizardMixerDataForSwashTrim`；UI 文案键 `setupWizardSwashFront` / `Back` / `Left` / `Right`。

**对照说明**：上文 **§1、§3** 表格里屏 6、7 仍保留原「Demo / `GUI.log`」描述，**未删除**，便于对照历史；自 **2026-04-03** 起以本修订与源码为准。
