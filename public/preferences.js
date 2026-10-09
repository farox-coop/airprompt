// public/preferences.js — Preferences panel (dictation macro enable/disable).
// Owns the gear button + modal. Macro data comes from DictationMacros and
// i18n labels from Dictation.

(function () {
  'use strict';

  const Dictation = window.Dictation;
  const Macros = window.DictationMacros;

  const prefsBtn = document.getElementById('prefs-btn');
  const prefsModal = document.getElementById('preferences-modal');
  const prefsTitle = document.getElementById('pref-title');
  const enableAll = document.getElementById('pref-enable-all');
  const shrinkImagesLabel = document.getElementById('pref-shrink-images-label');
  const enableAllLabel = document.getElementById('pref-enable-all-label');
  const macroList = document.getElementById('pref-macro-list');
  const closeBtn = document.getElementById('pref-close');

  function tr(key) {
    return Dictation.tr(key);
  }

  // One macro row: [checkbox] trigger text … value.
  function buildRow(item) {
    const label = document.createElement('label');
    label.className = 'pref-macro-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'pref-macro-checkbox';
    checkbox.checked = item.enabled;
    checkbox.addEventListener('change', function () {
      Macros.setEnabledByKey(item.key, checkbox.checked);
    });

    const trigger = document.createElement('span');
    trigger.className = 'pref-trigger';
    trigger.textContent = item.triggerText;

    const value = document.createElement('span');
    value.className = 'pref-value';
    value.textContent = item.valueLabel;

    label.appendChild(checkbox);
    label.appendChild(trigger);
    label.appendChild(value);
    return label;
  }

  function buildList() {
    const items = Macros.getMacroList(Dictation.getLang());
    macroList.innerHTML = '';

    const sections = {};
    items.forEach(function (item) {
      if (!sections[item.category]) sections[item.category] = [];
      sections[item.category].push(item);
    });

    ['inline', 'stateful'].forEach(function (category) {
      const rows = sections[category];
      if (!rows || !rows.length) return;
      const col = document.createElement('div');
      col.className = 'pref-col';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'pref-section';
      header.textContent = tr(category);
      header.setAttribute('aria-expanded', 'false');

      const body = document.createElement('div');
      body.className = 'pref-col-body collapsed';
      rows.forEach(function (item) {
        body.appendChild(buildRow(item));
      });

      header.addEventListener('click', function () {
        const collapsed = body.classList.toggle('collapsed');
        header.setAttribute('aria-expanded', String(!collapsed));
      });

      col.appendChild(header);
      col.appendChild(body);
      macroList.appendChild(col);
    });

    updateMacroCheckboxDisabled();
  }

  function updateMacroCheckboxDisabled() {
    const disabled = !enableAll.checked;
    macroList.querySelectorAll('.pref-macro-checkbox').forEach(function (cb) {
      cb.disabled = disabled;
    });
  }

  function render() {
    prefsTitle.textContent = tr('preferences');
    enableAllLabel.textContent = tr('enableAllMacros');
    // The checkbox itself belongs to upload.js; only its label is ours to
    // translate, because render() runs on every open (so it follows the language).
    if (shrinkImagesLabel) shrinkImagesLabel.textContent = tr('shrinkImages');
    closeBtn.textContent = tr('close');
    enableAll.checked = Macros.getGlobalEnabled();
    buildList();
  }

  function openPrefs() {
    render();
    prefsModal.classList.add('open');
  }

  function closePrefs() {
    prefsModal.classList.remove('open');
  }

  if (prefsBtn) {
    prefsBtn.title = tr('preferences');
    prefsBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openPrefs();
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', closePrefs);

  if (prefsModal) {
    prefsModal.addEventListener('click', function (e) {
      if (e.target === prefsModal) closePrefs();
    });
  }

  if (enableAll) {
    enableAll.addEventListener('change', function () {
      // Global toggle only. Per-macro checkboxes are disabled (not re-checked)
      // so their individual values survive untouched.
      Macros.setGlobalEnabled(enableAll.checked);
      updateMacroCheckboxDisabled();
    });
  }
})();
