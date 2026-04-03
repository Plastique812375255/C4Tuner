# 调机向导：未实现需求清单（Gap 分析）

本文档列出 **相对「校准/向导应对飞控产生真实效果」** 而言，当前代码中 **尚未完成或仅为占位** 的需求项。实现细节与已接入的 MSP 以 [setup-wizard-completion.md](setup-wizard-completion.md) 为准；背景约定见 [setup-wizard-context.md](setup-wizard-context.md)。

**说明**

- 依据来源：`src/js/tabs/setup_wizard.js`、`src/tabs/setup_wizard.html` 与上述 docs（截至文档生成时的仓库状态）。
- **屏 6 / 屏 7**：斜盘微调（`swash_trim`）已通过 `MSP_SET_MIXER_CONFIG` + `MSP_EEPROM_WRITE` 实现；旧版 completion 表格中仍写 Demo 的行仅作历史对照，**不作为未实现项重复列出**。
- 「未实现」包含：**无 MSP/无协议**、**仅 `GUI.log` / 占位**、**无事件绑定**、**仅会话 `persistPatch` 不落盘** 等。

---

## 1. 按屏：未实现或部分实现

### 屏 0（开始）

| 缺口 | 说明 |
|------|------|
| 无飞控侧需求 | 设计为入口与导航；无参数写入预期。 |

---

### 屏 1（舵机中位 / 频率）

| 缺口 | 说明 |
|------|------|
| 下拉变更即时写飞控 | 四个 `<select>` 仅 `change` → `persistPatch`；**真正写舵机**在点「下一步」时通过 `sendServoConfigurations` 等完成。若产品要求「改下拉立即落盘」，当前未满足。 |

---

### 屏 2（十字盘 + 安装）

| 缺口 | 说明 |
|------|------|
| `wizard-install-tile-visual` 配图 | [setup-wizard-context.md](setup-wizard-context.md) 记为预留；安装方向格子的内嵌图未全部与产品稿对齐（十字盘类型区已有 SVG，安装区视产品而定）。 |

---

### 屏 3（转向 + 集体正负）

| 缺口 | 说明 |
|------|------|
| — | 选项变更即写混控 + EEPROM；**无单独列出缺口**（与 completion 一致）。 |

---

### 屏 4（接收机）

| 缺口 | 说明 |
|------|------|
| 接收机类型 `<select>` | 无 `id`、无 `change` 委托；选项为静态示例（如 TBS CRSF），**未对接** `MSP_RX_CONFIG` 等与 [Receiver.svelte](../src/tabs/receiver/Receiver.svelte) 一致的配置流程。 |
| 通道映射 / 微调 | 若产品要求在本屏改映射或中位，当前未实现；仅 **显示** 通道与顶栏状态。 |
| 已实现（非缺口） | 进入屏 4 后轮询 `MSP_STATUS` → `MSP_RC` → `MSP_RC_COMMAND`；先拉 `MSP_MODE_RANGES` / `MSP_MODE_RANGES_EXTRA`；四通道条与 ARM/油门等顶栏为 **实时读显**。 |

---

### 屏 5（舵机方向方案）

| 缺口 | 说明 |
|------|------|
| 动画区 | completion 记为「动画区占位文案」；十字盘动画/幻灯片 5 级动效 **未做**（见 §3）。 |
| 左右箭头写反向 | **已实现** `saveServoDirScheme` → `sendServoConfigurations` + EEPROM（非缺口）。 |

---

### 屏 6（零螺距）

| 缺口 | 说明 |
|------|------|
| 超出 `swash_trim` 的零螺距流程 | 已实现：`.wizard-zero-pitch-trim` 调整集体轴 `swash_trim[2]`。若产品还要求 **舵机行程校准、专用校准 MSP、步骤化记录** 等，需另对接 [servos.js](../src/js/tabs/servos.js) 或固件协议（completion §4.4）。 |

---

### 屏 7（十字盘水平）

| 缺口 | 说明 |
|------|------|
| 同上 | 已实现：`.wizard-dpad-btn` 调整 `swash_trim[0]` / `[1]`。其它「水平仪类」扩展需求未在代码中体现。 |

---

### 屏 8（螺距校正）

| 缺口 | 说明 |
|------|------|
| 归零 / 增减按钮 | `.wizard-calib-side-btn`（非 pitch-test）、`.wizard-calib-pitch-adjust-btn` 等 → **`GUI.log`**（`setupWizardDemoAdjust` / `setupWizardDemoCalibBtn`）。 |
| 测试按钮 | `.wizard-calib-pitch-test-btn` 仅 **切换测试态 CSS**（`wizard-pitch-test-mode-*`），无 MSP 校准写参。 |
| 产品级螺距校准 | 需明确与混控/舵机字段的映射后，再对齐 `sendServoConfigurations` 或固件扩展 MSP。 |

---

### 屏 9（尾向 + 尾桨 0°）

| 缺口 | 说明 |
|------|------|
| `input[name="taildir"]` | **无任何 JS 绑定**；前/尾向不写入 `FC`。 |
| 尾桨 0° 测试 / 左右微调 | `.wizard-calib-tail-zero-test-btn`、`-adjust-btn`：测试态 UI + **`GUI.log`**。 |
| 字段语义 | completion §4.5：与 `MIXER_CONFIG` / 尾桨混控的对应关系 **待对照固件与** [mixer.js](../src/js/tabs/mixer.js) **后定义**。 |

---

### 屏 10（尾桨 22° / 行程）

| 缺口 | 说明 |
|------|------|
| 三类测试 / 增减 | `.wizard-calib-tail-pitch22-*`、`-travel-left-*`、`-travel-right-*`：多为 **测试态 UI** + 调整键 **`GUI.log`**。 |
| 无 MSP 写参 | 与屏 8 类似，需产品定义目标参数后再接协议。 |

---

### 屏 11（定速器）

| 缺口 | 说明 |
|------|------|
| 定速模式 `<select>` | 无绑定；未加载/保存 `MSP_GOVERNOR_CONFIG` 等。 |
| KV、电压、传动比 `<input>` | 无 `name`/`id`、无事件；未与 `FC.GOVERNOR` 对齐。 |
| `#wizard-motor-poles` | 仅 `persistPatch` + 选项由 JS 填充；**未发 MSP**（context 已说明）。 |
| `.wizard-calc-btn` | **`GUI.log`**（`setupWizardDemoCalculator`）。 |
| 底部状态文案 | `wizard-governor-status` 为静态 i18n 文案；**无实时油门/RPM 显示**（若产品需要，应对齐 Governor Tab 数据源）。 |

**复用建议**：与 [Governor.svelte](../src/tabs/governor/Governor.svelte) 同一套加载/保存流程（completion §4.2）。

---

### 屏 12（预设 / 完成）

| 缺口 | 说明 |
|------|------|
| 预设四个 `<select>` | 无绑定；选项多为占位。 |
| 右侧列表 | 硬编码示例机型名；无与 Preset 仓库或 CLI 的联动。 |
| `.wizard-write-params` | **`GUI.log`**（`setupWizardDemoWrite`）；未调用 [presets.js](../src/js/tabs/presets.js) 或导航到 Presets Tab。 |
| `.wizard-btn-finish` | **`GUI.log`**（`setupWizardFinishDemo`）后回设置 Tab；**无**真正「完成向导」的批量确认或 EEPROM 摘要。 |

**复用建议**：completion §4.3 — 批量写参更适合复用 Preset/CLI 流程，而非在向导内重复实现。

---

## 2. 跨屏 / 全局未实现

| 缺口 | 代码位置 / 说明 |
|------|----------------|
| **向导内帮助正文** | `openWizardHelp()` 将 `#wizard-help-content` 设为占位串 `SETUP_WIZARD_HELP_TODO_SCREEN_${屏号}`（见 `setup_wizard.js`）。需替换为真实 i18n 或按屏加载的帮助 HTML。 |
| **「一键基础」若仅当日志** | `wizard-btn-quick-basic` 走 `runWizardQuickBasicWrite()`：若其中仍有仅日志分支，以源码为准；与「完整写参」产品定义核对。 |
| **屏 1 / 屏 2 校验失败提示** | 部分路径仍 `GUI.log('请选择…')` 等**硬编码中文**（非 i18n），若多语言为需求则需补齐。 |
| **侧栏图标** | context：当前 `ic_wizzard`；若需与 Presets 区分，属产品视觉项。 |
| **其它语言 locale** | 除 en/zh_CN 外，`setupWizard*` 键若未对齐则属缺口。 |
| **会话策略** | 每次进入向导 `initialize` 会 **清空** `sessionStorage`；若产品要求「切 Tab 保留进度」需另行设计（context 已提示）。 |

---

## 3. 内容与体验（非 MSP）

| 缺口 | 说明 |
|------|------|
| 十字盘舵机方向屏动画 | 幻灯片级动画 / 产品稿动效未实现。 |
| 安装方向格子内嵌图 | 部分屏已有图，其余以产品稿为准。 |

---

## 4. 建议优先级（供排期参考）

1. **高**：屏 4 接收机类型与 RX 配置对齐；屏 11 定速器与 Governor 对齐（连接向导与真实调参）。  
2. **中**：屏 8–10 校准按钮与舵机/混控/尾桨参数定义 + MSP；屏 9 `taildir` 语义确定后绑定。  
3. **中**：屏 12 与 Presets/「写入参数」产品流一致（跳转或复用 CLI）。  
4. **低但影响体验**：帮助正文、完成按钮去 Demo 文案、硬编码 log 改 i18n、屏 11 状态区实时数据。

---

## 5. 相关文件索引

| 用途 | 路径 |
|------|------|
| 向导逻辑 | [src/js/tabs/setup_wizard.js](../src/js/tabs/setup_wizard.js) |
| 向导结构 | [src/tabs/setup_wizard.html](../src/tabs/setup_wizard.html) |

---

*文档生成时间（UTC）：2026-04-03 09:51:49 UTC。代码变更后请同步更新本节与缺口表。*
