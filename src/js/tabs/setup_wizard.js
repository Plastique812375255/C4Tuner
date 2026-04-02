const tab = {
    tabName: 'setup_wizard',
};

const WIZARD_SCREENS = 11;
const LAST_INDEX = WIZARD_SCREENS - 1;

const STORAGE_KEY = 'rftuner_setup_wizard_state_v1';

function defaultState() {
    return {
        screenIndex: 0,
        dirIndex: 1,
        motorPoles: '',
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
    for (let s = 1; s <= 10; s++) {
        $(`.tab-setup-wizard .wizard-screen[data-screen="${s}"] .wizard-step-label`).text(
            i18n.getMessage('setupWizardStepProgress', { current: s, total: 10 }),
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

function populateMotorPolesOptions() {
    const $motorPoles = $('#wizard-motor-poles');
    if (!$motorPoles.length) {
        return;
    }
    for (let n = 2; n <= 20; n++) {
        $motorPoles.append($('<option></option>').val(String(n)).text(String(n)));
    }
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
        if (idx < LAST_INDEX) {
            goToScreen(idx + 1);
        }
    });

    $('.tab-setup-wizard').on('click', '.wizard-btn-finish', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardFinishDemo'));
        switchToSetupTab();
    });

    $('.tab-setup-wizard').on('click', '.wizard-btn-help', function (e) {
        e.preventDefault();
        GUI.log(i18n.getMessage('setupWizardHelpDemo'));
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
    applyPersistedWizardState();
};

tab.initialize = function (callback) {
    $('#content').load("/src/tabs/setup_wizard.html", function () {
        clearPersistedWizardState();

        i18n.localizePage();

        populateMotorPolesOptions();
        bindWizardEvents();
        applyPersistedWizardState();

        GUI.content_ready(callback);
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
