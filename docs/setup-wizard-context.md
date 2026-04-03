# 调机向导（Setup Wizard）— 对话上下文摘要

> **用途**：新对话中若需继续开发「调机向导」Tab，请先读本文。内容来自实现过程中的约定、文件位置与已解决问题，**非**完整产品文档。
>
> **完成度与控件清单**（已接 MSP / Demo 对照、后续 backlog）：见 [setup-wizard-completion.md](setup-wizard-completion.md)。

## 功能定位

- **名称**：调机向导（i18n：`tabSetupWizard`；代码 Tab 名：`setup_wizard`；侧栏 class：`tab_setup_wizard`）。
- **当前阶段**：**混合**——13 屏流程与大量校准 UI 已可用；**部分步骤已通过 MSP 写飞控并 `MSP_EEPROM_WRITE`**（舵机配置、混控/板装、主旋翼转向、集体方向、十字盘三舵反向等），**其余步骤仍为 Demo**（`GUI.log`、静态条、或未绑定控件）。细节以 [setup-wizard-completion.md](setup-wizard-completion.md) 为准。
- **入口**：需 **已连接飞控**（`mode-connected` + `GUI.defaultAllowedFCTabsWhenConnected` 含 `'setup_wizard'`）。

## 会话持久化策略

- **存储**：`sessionStorage` 键 `rftuner_setup_wizard_state_v1`。
- **行为**：每次从侧栏 **进入** 调机向导（`tab.initialize` 完整 load）会 **先清空** 会话，再按飞控 MSP 回填并显示默认步骤；在同一次向导会话内仍用 `persistPatch` 记录进度；**断线重连**时若 DOM 保留，可走 `onReconnect` 用 `sessionStorage` 恢复（不经过 `initialize` 的清空）。
- **注意**：若希望改为「切换 Tab 不丢进度」等行为，需产品确认后再改，避免与当前「每次进入清空」假设冲突。

## 原型与屏数

- 工程目录：`调机向导原型图/幻灯片1.png` …（原型张数与实现可不完全一致，以代码为准）。
- **实现**：`data-screen="0"` 为开始页（无「步骤 x/y」）；**1～12** 为带步骤标签的 12 步（界面显示 **步骤 1/12～12/12**），最后一屏为「参数预设」+「完成」。
- **布局版本**：`stateVersion`≥2 表示当前屏序；旧会话若 `screenIndex≥10` 会在恢复时 **+1**（尾部曾由一屏拆为两屏）。

## 核心文件（实现入口）

| 用途 | 路径 |
|------|------|
| 页面结构 | [`src/tabs/setup_wizard.html`](../src/tabs/setup_wizard.html) |
| 样式 | [`src/css/tabs/setup_wizard.css`](../src/css/tabs/setup_wizard.css) |
| 逻辑 | [`src/js/tabs/setup_wizard.js`](../src/js/tabs/setup_wizard.js) |
| 注册 Tab | [`src/js/tabs/index.js`](../src/js/tabs/index.js) — `import "./setup_wizard.js"` |
| 侧栏 + CSS 链接 | [`src/main.html`](../src/main.html) — `tab_setup_wizard`、`setup_wizard.css` |
| 连接后可见 | [`src/js/gui.js`](../src/js/gui.js) — `defaultAllowedFCTabsWhenConnected` 含 `'setup_wizard'` |
| 文案 | `locales/en/messages.json`、`locales/zh_CN/messages.json` — 键名前缀 `setupWizard*`、`tabSetupWizard` |

## 交互约定

- **屏幕索引**：内部 `data-screen="0"` … `"12"` 共 **13** 屏；`WIZARD_SCREENS=13`，`goToScreen()` 切换 `.wizard-screen.active`。
- **返回**：第 0 屏 → 切到 **设置** Tab（`tab_setup`）；其余 → 上一屏。
- **下一步 / 完成**：屏 1、屏 2 在满足条件时会 **写 EEPROM**（屏 2 在选项相对基准有改动时还会 **重启**）；最后一屏「完成」当前为日志 + 回设置 Tab（文案键仍含 Demo 字样时可后续改）。
- **电机级数**：`#wizard-motor-poles` 在 `initialize` 里 **JS 追加 2～20** 的 `<option>`（首项为「请选择」）；当前仅写入会话，未发 MSP。

## 已做的 UI/布局决策（避免重复踩坑）

1. **整体**：向导根节点用视口高度约束 + **仅 `.wizard-body` 滚动**，底栏「下一步/完成」固定可见；多处加 **`min-width: 0`** 防止 flex/grid 子项把横向撑破。
2. **深色主题**：不用无效的 `var(--borderColor)`；用 `--wizard-outline` 等；输入框用可见描边/内阴影。
3. **标签**：控件统一 **`wizard-control` + `wizard-label-text`**（上标签、下控件），分组用边框/背景区分。
4. **基础设置 · 安装方向**：四格 **`wizard-install-tile`** 横排（窄屏 2×2），**`wizard-install-tile-visual`** 预留给图片；选中态 `:has(input:checked)`。
5. **接收机校准**：左列 **方向舵 + 副翼**（横条）；右列 **`wizard-vertical-panel`** 内 **总距 + 升降** 两根竖条 **横排**，子框架带边框。
6. **舵机方向**：接线表 **字号与正文一致**（`1em`，勿单独小一号）。
7. **螺距校正**：三步骤用 **序号圆点 + 文案 + 右侧操作列** 的网格，压缩 padding；小屏再堆叠。
8. **尾部**：第 9 屏尾向 + 尾桨 0° 测试条（左侧竖条强调）；第 10 屏为尾桨 22° 与左/右行程三条校准行（序号 1–3、测试 + 增加 + 降低），样式较螺距页略紧凑，三行测试态互斥；**勿**与 screen 8 的 `wizard-calib-pitch-test-btn` 混用。
9. **定速器**：**KV / 级数 / 电压** 一行三列，使用 **`grid-template-columns: repeat(3, minmax(0, 1fr))`**，避免 flex+`space-between` 与 `<select>` 最小宽度导致 **第三列（电池电压）溢出**；该页为 `data-screen="11"`，**`wizard-form-stack`** 取消 640px 上限以拉满内容区（选择器须与 HTML 屏号一致）。

## 侧栏图标

- 当前使用 **`ic_wizzard`**（与 Presets 同类图标），若需区分可换 `ic_setup` 等（见 `main.html` 注释 spare icons）。

## 后续可接工作（未实现）

- 接收机实时条、零螺距/十字盘水平/螺距与尾桨校准、定速器与预设页的 **MSP 对接**（参考 Tab 与码表见 [setup-wizard-completion.md](setup-wizard-completion.md)）。
- 幻灯片 5 十字盘动画、帮助正文（`openWizardHelp` 仍为占位字符串）。
- 安装方向 `wizard-install-tile-visual` 内嵌图（屏 2 部分已有十字盘图）。
- 其他语言 locale 若需与 en/zh_CN 对齐，补全 `setupWizard*` 键。

## 验证方式

- 连接飞控后点侧栏「调机向导」，走通 **含开始页共 13 屏**（步骤 1/12～12/12）；定速器页（`data-screen="11"`）确认三列不溢出、窄屏变单列。
- 回归：屏 1「下一步」写舵机；屏 2 改选项后「下一步」重启；屏 3 改单选项写混控；屏 5 左右箭头写舵机反向；切换至其他 Tab 再回向导，应 **回到开始**（与每次进入清空 `sessionStorage` 一致）。

---
*本文档由会话整理生成，修改代码后请同步更新本节或删除过时句。*
