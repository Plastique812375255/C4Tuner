const tab = {
    tabName: 'setup_wizard',
};

const WIZARD_SCREENS = 11;
const LAST_INDEX = WIZARD_SCREENS - 1;

function goToScreen(index) {
    const i = Math.max(0, Math.min(LAST_INDEX, index));
    $('.tab-setup-wizard .wizard-screen').removeClass('active');
    $(`.tab-setup-wizard .wizard-screen[data-screen="${i}"]`).addClass('active');
    for (let s = 1; s <= 10; s++) {
        $(`.tab-setup-wizard .wizard-screen[data-screen="${s}"] .wizard-step-label`).text(
            i18n.getMessage('setupWizardStepProgress', { current: s, total: 10 }),
        );
    }
}

function switchToSetupTab() {
    $('#tabs ul.mode-connected .tab_setup a').trigger('click');
}

tab.initialize = function (callback) {
    $('#content').load("/src/tabs/setup_wizard.html", function () {
        i18n.localizePage();

        goToScreen(0);

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

        let dirIndex = 1;
        $('.tab-setup-wizard').on('click', '.wizard-dir-prev', function (e) {
            e.preventDefault();
            dirIndex = dirIndex <= 1 ? 8 : dirIndex - 1;
            $('#wizard-dir-index').text(dirIndex);
        });
        $('.tab-setup-wizard').on('click', '.wizard-dir-next', function (e) {
            e.preventDefault();
            dirIndex = dirIndex >= 8 ? 1 : dirIndex + 1;
            $('#wizard-dir-index').text(dirIndex);
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
