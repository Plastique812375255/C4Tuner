import { reinitialiseConnection } from "@/js/serial_backend.js";

const tab = {
    tabName: 'setup_wizard',
};

const WIZARD_SCREENS = 12;
const LAST_INDEX = WIZARD_SCREENS - 1;

const STORAGE_KEY = 'rftuner_setup_wizard_state_v1';

let wizardHelpPrevScreenIndex = 0;

const SWASH_SERVO_INDICES = [0, 1, 2];
const TAIL_SERVO_INDEX = 3;

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
    // H3: 120° + elevator reverse + aileron normal
    h3: { swashType: 2, elevatorDir: -1, aileronDir: 1 },
    // HR3: 120° + elevator normal + aileron normal
    hr3: { swashType: 2, elevatorDir: 1, aileronDir: 1 },
    // Crossplate 135° + normal cyclic direction
    135: { swashType: 3, elevatorDir: 1, aileronDir: 1 },
    // Crossplate 140° + normal cyclic direction
    140: { swashType: 4, elevatorDir: 1, aileronDir: 1 },
};

function defaultState() {
    return {
        screenIndex: 0,
        dirIndex: 1,
        motorPoles: '',
        // Defaults for screen 1 (servo type selection)
        swashNeutralPoint: '1520',
        swashFrequency: '50',
        tailNeutralPoint: '760',
        tailFrequency: '50',
        swash: 'h3',
        install: '1',
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

function goToScreen(index) {
    const i = Math.max(0, Math.min(LAST_INDEX, index));
    $('.tab-setup-wizard .wizard-screen').removeClass('active');
    $(`.tab-setup-wizard .wizard-screen[data-screen="${i}"]`).addClass('active');
    for (let s = 1; s <= 11; s++) {
        $(`.tab-setup-wizard .wizard-screen[data-screen="${s}"] .wizard-step-label`).text(
            i18n.getMessage('setupWizardStepProgress', { current: s, total: 11 }),
        );
    }
    persistPatch({ screenIndex: i });
}

function applyPersistedWizardState() {
    const st = { ...defaultState(), ...readState() };
    goToScreen(st.screenIndex);
    const dir = Number.isFinite(st.dirIndex) ? st.dirIndex : 1;
    $('#wizard-dir-index').text(String(dir));
    persistPatch({ dirIndex: dir });

    const $poles = $('#wizard-motor-poles');
    if ($poles.length) {
        $poles.val(st.motorPoles || '');
    }

    const $swashNeutral = $('#wizard-swash-neutral-point');
    if ($swashNeutral.length) {
        if (st.swashNeutralPoint) {
            $swashNeutral.val(st.swashNeutralPoint);
        }
    }
    const $swashFrequency = $('#wizard-swash-frequency');
    if ($swashFrequency.length) {
        if (st.swashFrequency) {
            $swashFrequency.val(st.swashFrequency);
        }
    }
    const $tailNeutral = $('#wizard-tail-neutral-point');
    if ($tailNeutral.length) {
        if (st.tailNeutralPoint) {
            $tailNeutral.val(st.tailNeutralPoint);
        }
    }
    const $tailFrequency = $('#wizard-tail-frequency');
    if ($tailFrequency.length) {
        if (st.tailFrequency) {
            $tailFrequency.val(st.tailFrequency);
        }
    }

    const swash = st.swash || 'h3';
    $('.tab-setup-wizard input[name="swash"]').filter(function () {
        return $(this).val() === swash;
    }).prop('checked', true);

    const install = st.install || '1';
    $('.tab-setup-wizard input[name="install"]').filter(function () {
        return $(this).val() === install;
    }).prop('checked', true);
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

let wizardServoSaveInProgress = false;

let wizardBaseSaveInProgress = false;

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

function patchBaseWizardSelectionsFromFC() {
    try {
        // Swash selection: swash_type + elevator direction sign
        const swashType = FC?.MIXER_CONFIG?.swash_type;
        const elevatorRate = FC?.MIXER_INPUTS?.[2]?.rate;

        let swash = 'h3';
        if (swashType === 2) {
            swash = (typeof elevatorRate === 'number' && elevatorRate < 0) ? 'h3' : 'hr3';
        } else if (swashType === 3) {
            swash = '135';
        } else if (swashType === 4) {
            swash = '140';
        }

        // Install orientation selection: BOARD_ALIGNMENT_CONFIG roll/pitch/yaw
        const roll = FC?.BOARD_ALIGNMENT_CONFIG?.roll;
        const pitch = FC?.BOARD_ALIGNMENT_CONFIG?.pitch;
        const yaw = FC?.BOARD_ALIGNMENT_CONFIG?.yaw;

        let install = '1';
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

    mspHelper.sendServoConfigurations(function () {
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, function () {
            GUI.log(i18n.getMessage('eepromSaved'));

            if (needReboot) {
                // Keep UI on Screen 1 until reconnect; then `applyPersistedWizardState()` will move to next screen.
                persistPatch({ screenIndex: nextIndex });
                GUI.log(i18n.getMessage('deviceRebooting'));
                MSP.send_message(MSPCodes.MSP_SET_REBOOT);
                reinitialiseConnection();
                return;
            }

            wizardServoSaveInProgress = false;
            setServoScreenSavingUI(false);
            goToScreen(nextIndex);
        });
    });
}

function bindWizardEvents() {
    $('.tab-setup-wizard').off();

    $('.tab-setup-wizard').on('click', '.wizard-btn-back', function (e) {
        e.preventDefault();
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
        const $screen = $('.tab-setup-wizard .wizard-screen.active');
        const idx = parseInt($screen.attr('data-screen'), 10);
        if (idx === 1) {
            if (!wizardServoSaveInProgress && idx < LAST_INDEX) {
                saveServoWizardSelectionAndNext(idx + 1);
            }
            return;
        }
        if (idx === 2) {
            if (!wizardBaseSaveInProgress && idx < LAST_INDEX) {
                saveBaseWizardSelectionAndNext(idx + 1);
            }
            return;
        }

        if (idx < LAST_INDEX) goToScreen(idx + 1);
    });

    $('.tab-setup-wizard').on('click', '.wizard-btn-finish', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardFinishDemo'));
        switchToSetupTab();
    });

    $('.tab-setup-wizard').on('click', '.wizard-screen .wizard-btn-help', function (e) {
        e.preventDefault();
        openWizardHelp();
    });

    $('.tab-setup-wizard').on('click', '.wizard-help-screen .wizard-btn-help--back', function (e) {
        e.preventDefault();
        closeWizardHelp();
    });

    $('.tab-setup-wizard').on('click', '.wizard-dir-prev', function (e) {
        e.preventDefault();
        let dirIndex = parseInt($('#wizard-dir-index').text(), 10) || 1;
        dirIndex = dirIndex <= 1 ? 8 : dirIndex - 1;
        $('#wizard-dir-index').text(dirIndex);
        persistPatch({ dirIndex });
    });
    $('.tab-setup-wizard').on('click', '.wizard-dir-next', function (e) {
        e.preventDefault();
        let dirIndex = parseInt($('#wizard-dir-index').text(), 10) || 1;
        dirIndex = dirIndex >= 8 ? 1 : dirIndex + 1;
        $('#wizard-dir-index').text(dirIndex);
        persistPatch({ dirIndex });
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
        persistPatch({ swash: $(this).val() });
    });

    $('.tab-setup-wizard').on('change', 'input[name="install"]', function () {
        persistPatch({ install: $(this).val() });
    });

    $('.tab-setup-wizard').on('click', '.wizard-demo-pitch', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardDemoPitch'));
    });

    $('.tab-setup-wizard').on('click', '.wizard-dpad-btn', function (e) {
        e.preventDefault();
        const dir = $(this).data('dir');
        GUI.log(i18n.getMessage('setupWizardDemoDpad', { dir }));
    });

    $('.tab-setup-wizard').on('click', '.wizard-calib-adjust .regular-button, .wizard-tail-limits .regular-button', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardDemoAdjust'));
    });

    $('.tab-setup-wizard').on('click', '.wizard-calib-side-btn', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardDemoCalibBtn'));
    });

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
    $('.tab-setup-wizard .wizard-help-screen').removeClass('active');
    applyPersistedWizardState();

    // Ensure strategy B UI is restored after reboot/connect.
    wizardServoSaveInProgress = false;
    setServoScreenSavingUI(false);
    wizardBaseSaveInProgress = false;
    setBaseScreenSavingUI(false);
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
            .then(() => MSP.promise(MSPCodes.MSP_BOARD_ALIGNMENT_CONFIG))
            .then(() => patchBaseWizardSelectionsFromFC())
            .catch(() => {
                // Best-effort only; wizard still works with default/session values.
            })
            .finally(() => {
                applyPersistedWizardState();
                setServoScreenSavingUI(false);
                setBaseScreenSavingUI(false);
                GUI.content_ready(callback);
            });
    });
};

tab.cleanup = function (callback) {
    $('.tab-setup-wizard').off();
    callback?.();
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
