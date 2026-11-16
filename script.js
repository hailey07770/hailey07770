// ===== Pomodoro Timer =====
// 전역 오염을 막기 위해 전체를 즉시 실행 함수로 감쌉니다.
// 구성: 상수 → DOM → 저장소 → 상태 → 사운드 → 화면 그리기 → 타이머 → 세션 전환
//       → 사용자 동작 → 설정 바(드롭다운·반복 횟수·접기) → 유튜브 플레이어 → 복원 → 시작
(() => {
  'use strict';

  /* =========================================================
   * 상수
   * ======================================================= */
  const TICK_MS = 250;              // 화면 갱신 주기
  const TOAST_MS = 2500;            // 토스트 표시 시간 (CSS 진행바 애니메이션과 동일)
  const STATUS_SWAP_MS = 200;       // 상태 문구가 흐려졌다 바뀌는 시간 (CSS와 동일)
  const ALARM_REPEAT = 4;           // 세션 종료 알람 반복 횟수
  const ALARM_GAP_MS = 150;         // 알람 사이 간격
  const DEFAULT_REPEAT = 0;         // 반복 횟수 기본값: 0 = 무한(∞)
  const MAX_REPEAT = 99;
  const DEFAULT_MUSIC_VOLUME = 0.5;
  const DEFAULT_ALARM_VOLUME = 1;
  const MOBILE_QUERY = '(max-width: 768px)';

  const STORAGE_KEYS = {
    timer: 'pomodoro-state-v1',
    music: 'pomodoro-music-v1',
    settingsCollapsed: 'pomodoro-settings-collapsed',
    alarmVolume: 'pomodoro-alarm-volume',
  };

  const MSG = {
    idle: '귀여운 토마토가 당신을 기다리고 있어요!',
    ready: '🔫준비 완료! 토마토를 클릭해주세요.',
    focus: '집중 중🔥',
    rest: '휴식 중☕',
    paused: '일시 정지',
    done: '🎉완료!',
  };

  const COLOR = {
    red: 'var(--tomato-red)',
    green: 'var(--tomato-green)',
    gray: '#888',
  };

  /* =========================================================
   * DOM
   * ======================================================= */
  const $ = (id) => document.getElementById(id);

  const ui = {
    // 타이머
    display: $('display'),
    tomato: $('tomato'),
    status: $('statusText'),
    setCounter: $('setCounter'),
    skipBtn: $('skip-btn'),
    toast: $('toast'),
    alarm: $('alarmSound'),
    alarmStop: $('alarmStop'),

    // 설정 바
    settings: $('settings'),
    settingsSummary: $('settingsSummary'),
    settingsSummaryText: $('settingsSummaryText'),
    presetDropdown: $('timePreset'),
    presetToggle: $('presetToggle'),
    presetLabel: $('presetLabel'),
    presetMenu: $('presetMenu'),
    repeatValue: $('repeatValue'),
    repeatMinus: $('repeatMinus'),
    repeatPlus: $('repeatPlus'),
    alarmVolume: $('alarmVolume'),
    alarmVolToggle: $('alarmVolToggle'),
    alarmVolLabel: $('alarmVolLabel'),
    alarmVolValue: $('alarmVolValue'),
    alarmVolSlider: $('alarmVolSlider'),
    alarmVolTest: $('alarmVolTest'),
    applyBtn: $('apply-btn'),
    resetBtn: $('reset-btn'),

    // 유튜브 플레이어
    musicPlayer: $('musicPlayer'),
    musicToggle: $('musicToggle'),
    muteToggle: $('muteToggle'),
    volumeSlider: $('volumeSlider'),
    linkToggle: $('linkToggle'),
    musicForm: $('musicForm'),
    musicUrl: $('musicUrl'),
    musicNow: $('musicNow'),
  };

  const clickSound = new Audio('effect.mp3');
  clickSound.preload = 'auto';

  /* =========================================================
   * 저장소 (사생활 보호 모드 등에서 막혀도 앱은 그대로 동작)
   * ======================================================= */
  const storage = {
    getRaw(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    getJSON(key) {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      } catch {
        // 저장만 안 될 뿐 동작에는 영향 없음
      }
    },
  };

  /* =========================================================
   * 상태
   * ======================================================= */
  const settings = {
    focusMinutes: 25,
    restMinutes: 5,
    totalSets: 0,          // 0 = 무한 반복
    configured: false,     // '적용'을 눌렀는지
  };

  const timer = {
    running: false,
    isFocus: true,
    endAtMs: 0,            // 세션 종료 시각 (performance.now 기준)
    pausedRemainingMs: 0,  // 일시정지 시 남은 시간
    intervalId: null,
    completedSets: 0,
  };

  let repeatDraft = DEFAULT_REPEAT;  // −/+ 로 고르는 중인 반복 횟수 ('적용' 전)
  let repeatEditing = false;         // 반복 횟수를 숫자키로 직접 입력하는 중인지

  const isInfinite = () => settings.totalSets === 0;
  const hasNextSet = () => isInfinite() || timer.completedSets < settings.totalSets;

  /* =========================================================
   * 유틸
   * ======================================================= */
  const nowMs = () => performance.now();
  const minutesToMs = (min) => min * 60 * 1000;
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const isMobileLayout = () => window.matchMedia(MOBILE_QUERY).matches;
  const repeatLabel = (n) => (n === 0 ? '∞' : `${n}세트`);
  const parsePreset = (value) => value.split('-').map(Number);   // '25-5' → [25, 5]

  function formatAsMMSS(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function currentSessionMs() {
    return minutesToMs(timer.isFocus ? settings.focusMinutes : settings.restMinutes);
  }

  function remainingMs() {
    return Math.max(0, timer.endAtMs - nowMs());
  }

  /* =========================================================
   * 타이머 저장 (새로고침해도 이어서)
   * ======================================================= */
  function saveState() {
    storage.set(STORAGE_KEYS.timer, {
      // 적용된 설정을 저장 (선택만 바꾸고 '적용'을 안 눌렀을 때와 섞이지 않게)
      preset: settings.configured
        ? `${settings.focusMinutes}-${settings.restMinutes}`
        : getPreset(),
      totalSets: settings.totalSets,
      configured: settings.configured,
      isFocus: timer.isFocus,
      running: timer.running,
      completedSets: timer.completedSets,
      remainingMs: timer.running ? remainingMs() : timer.pausedRemainingMs,
      savedAt: Date.now(),
    });
  }

  /* =========================================================
   * 사운드
   * ======================================================= */
  function playClickSound() {
    clickSound.currentTime = 0;
    clickSound.play().catch(() => {});
  }

  let alarmRepeatTimer = null;
  let alarmEndedHandler = null;

  // '알람 끄기' 버튼은 알람이 실제로 울리는 동안에만 보임
  function setAlarmStopVisible(visible) {
    ui.alarmStop.hidden = !visible;
    document.body.classList.toggle('alarm-ringing', visible);
  }

  function stopAlarm() {
    clearTimeout(alarmRepeatTimer);
    alarmRepeatTimer = null;

    if (alarmEndedHandler) {
      ui.alarm.removeEventListener('ended', alarmEndedHandler);
      alarmEndedHandler = null;
    }

    ui.alarm.pause();
    ui.alarm.currentTime = 0;
    setAlarmStopVisible(false);
  }

  function playAlarm(times = ALARM_REPEAT, gapMs = ALARM_GAP_MS) {
    stopAlarm();

    let played = 0;
    const playOnce = () => {
      // iOS/Safari 연속 재생 안정성을 위해 처음으로 되감기
      ui.alarm.currentTime = 0;
      ui.alarm.play()
        .then(() => setAlarmStopVisible(true))
        .catch(() => setAlarmStopVisible(false)); // 브라우저가 소리를 막으면 버튼도 숨김
    };

    alarmEndedHandler = () => {
      played += 1;
      if (played >= times) {
        stopAlarm();
        return;
      }
      alarmRepeatTimer = setTimeout(playOnce, gapMs);
    };

    ui.alarm.addEventListener('ended', alarmEndedHandler);
    playOnce();
  }

  /* =========================================================
   * 화면 그리기
   * ======================================================= */
  function renderTime(seconds) {
    ui.display.textContent = formatAsMMSS(seconds);
  }

  let statusSwapTimer = null;

  // 상태 문구가 바뀔 때 살짝 흐려졌다가 새 문구로 교체
  function renderStatus(text, color = COLOR.red) {
    clearTimeout(statusSwapTimer);
    if (ui.status.textContent === text && ui.status.style.color === color) {
      ui.status.classList.remove('is-swapping');
      return;
    }
    ui.status.classList.add('is-swapping');
    statusSwapTimer = setTimeout(() => {
      ui.status.textContent = text;
      ui.status.style.color = color;
      ui.status.classList.remove('is-swapping');
    }, STATUS_SWAP_MS);
  }

  function renderTomato() {
    ui.tomato.classList.toggle('running', timer.running);
  }

  function renderSetCounter() {
    const total = settings.configured ? repeatLabel(settings.totalSets) : '?';
    ui.setCounter.textContent = `완료한 세트: ${timer.completedSets}세트 / ${total}`;
  }

  function renderRepeat() {
    // 입력 중일 때는 사용자가 치는 숫자를 덮어쓰지 않음
    if (!repeatEditing) ui.repeatValue.value = repeatLabel(repeatDraft);
    ui.repeatMinus.disabled = repeatDraft === 0;
    ui.repeatPlus.disabled = repeatDraft >= MAX_REPEAT;
    renderSettingsSummary();
  }

  // 모바일 설정 접기 버튼에 보이는 요약: '25분 집중 / 5분 휴식 · ∞'
  function renderSettingsSummary() {
    ui.settingsSummaryText.textContent = `${ui.presetLabel.textContent} · ${repeatLabel(repeatDraft)}`;
  }

  let toastTimer = null;

  function showToast(message) {
    // innerHTML 대신 텍스트 노드 + <br>로 구성 (XSS 걱정 없음)
    ui.toast.replaceChildren();
    String(message).split('\n').forEach((line, i) => {
      if (i > 0) ui.toast.appendChild(document.createElement('br'));
      ui.toast.appendChild(document.createTextNode(line));
    });

    // 연속으로 토스트가 뜨면 이전 타이머를 지우고 진행바도 처음부터 다시 시작
    clearTimeout(toastTimer);
    ui.toast.classList.remove('show');
    void ui.toast.offsetWidth; // reflow로 애니메이션 재시작
    ui.toast.classList.add('show');
    toastTimer = setTimeout(() => ui.toast.classList.remove('show'), TOAST_MS);
  }

  /* =========================================================
   * 타이머
   * ======================================================= */
  function stopTickLoop() {
    clearInterval(timer.intervalId);
    timer.intervalId = null;
  }

  // 남은 시간을 화면에 반영하고, 세션이 끝났으면 다음 단계로 넘어갑니다.
  function tick() {
    const ms = remainingMs();
    renderTime(Math.ceil(ms / 1000));
    if (ms <= 0) {
      stopTickLoop();
      onSessionFinished();
    }
  }

  function startTimer() {
    const duration = timer.pausedRemainingMs > 0 ? timer.pausedRemainingMs : currentSessionMs();
    timer.pausedRemainingMs = 0;
    timer.endAtMs = nowMs() + duration;
    timer.running = true;

    renderTomato();
    if (timer.isFocus) renderStatus(MSG.focus, COLOR.red);
    else renderStatus(MSG.rest, COLOR.green);

    stopTickLoop();
    tick();
    timer.intervalId = setInterval(tick, TICK_MS);
    saveState();
  }

  function pauseTimer() {
    stopTickLoop();
    timer.pausedRemainingMs = remainingMs();
    timer.running = false;

    renderTomato();
    renderStatus(MSG.paused, COLOR.gray);
    renderTime(Math.ceil(timer.pausedRemainingMs / 1000));
    saveState();
  }

  // 진행 중인 세션만 초기화 (설정과 완료 세트 수는 유지)
  function resetRuntime() {
    stopTickLoop();
    timer.running = false;
    timer.isFocus = true;
    timer.pausedRemainingMs = 0;
    timer.endAtMs = 0;

    renderTomato();
    renderTime(settings.focusMinutes * 60);
  }

  /* =========================================================
   * 세션 전환 (집중 → 휴식 → 다음 세트)
   * ======================================================= */
  function onSessionFinished({ skipped = false } = {}) {
    if (!skipped) playAlarm();
    timer.pausedRemainingMs = 0;

    if (timer.isFocus) {
      timer.isFocus = false;
      showToast(skipped ? '⏭집중을 건너뛰었어요. 휴식 시작☕' : '집중 종료! 휴식 시작☕');
      startTimer();
      return;
    }

    timer.completedSets += 1;
    renderSetCounter();

    if (hasNextSet()) {
      timer.isFocus = true;
      showToast(skipped
        ? `⏭휴식을 건너뛰었어요. ${timer.completedSets}세트 완료! 다시 집중🔥`
        : `${timer.completedSets}세트 완료! 다시 집중🔥`);
      startTimer();
    } else {
      finishAllSessions();
    }
  }

  function finishAllSessions() {
    resetRuntime();
    renderStatus(MSG.done, COLOR.red);
    showToast(`모든 세션이 끝났습니다! 총 ${timer.completedSets}세트 완료!`);
    saveState();
  }

  /* =========================================================
   * 사용자 동작
   * ======================================================= */
  function ensureConfigured() {
    if (settings.configured) return true;
    showToast("😭먼저 반복 횟수를 고르고 '적용' 버튼을 눌러주세요!");
    return false;
  }

  function onTomatoClick() {
    playClickSound();
    if (!ensureConfigured()) return;

    if (timer.running) pauseTimer();
    else startTimer();
  }

  // 지금 세션을 바로 끝내고 다음 단계로 넘어갑니다 (알람 없음).
  function onSkipClick() {
    playClickSound();
    if (!ensureConfigured()) return;

    stopTickLoop();
    stopAlarm();
    onSessionFinished({ skipped: true });
  }

  function applyPresetToSettings() {
    [settings.focusMinutes, settings.restMinutes] = parsePreset(getPreset());
  }

  function onApplyClick() {
    playClickSound();

    applyPresetToSettings();
    settings.totalSets = repeatDraft;
    settings.configured = true;
    timer.completedSets = 0;

    stopAlarm();
    resetRuntime();
    renderSetCounter();
    renderStatus(MSG.ready, COLOR.red);
    showToast('✔️설정이 적용되었습니다!');
    if (isMobileLayout()) setSettingsCollapsed(true);
    saveState();
  }

  // 전체 초기화 (설정까지 지움)
  function onResetClick() {
    playClickSound();
    stopAlarm();
    resetRuntime();

    repeatDraft = DEFAULT_REPEAT;
    renderRepeat();
    settings.totalSets = 0;
    settings.configured = false;
    timer.completedSets = 0;

    renderSetCounter();
    renderStatus(MSG.idle, COLOR.red);
    saveState();
    showToast('✔️초기화 되었습니다!');
  }

  function onAlarmStopClick() {
    stopAlarm();
    showToast('🔕알람을 껐어요');
  }

  /* =========================================================
   * 설정 바 ① 집중/휴식 시간 드롭다운
   * ======================================================= */
  const presetOptions = () => [...ui.presetMenu.querySelectorAll('[data-value]')];

  // 지금 선택된 값 ('10-2' / '25-5' / '50-10')
  const getPreset = () =>
    (presetOptions().find((o) => o.getAttribute('aria-selected') === 'true') || presetOptions()[0]).dataset.value;

  function setPreset(value) {
    const options = presetOptions();
    const picked = options.find((o) => o.dataset.value === value);
    if (!picked) return;
    options.forEach((o) => o.setAttribute('aria-selected', String(o === picked)));
    ui.presetLabel.textContent = picked.textContent;
    renderSettingsSummary();
  }

  function initPresetDropdown() {
    const { presetDropdown: root, presetToggle: toggle, presetMenu: menu } = ui;
    let activeIndex = 0;

    const isOpen = () => root.classList.contains('open');
    const optionFromEvent = (e) => e.target instanceof Element && e.target.closest('[data-value]');

    function highlight(i) {
      const options = presetOptions();
      activeIndex = (i + options.length) % options.length;
      options.forEach((o, k) => o.classList.toggle('active', k === activeIndex));
    }

    function open() {
      root.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      highlight(presetOptions().findIndex((o) => o.dataset.value === getPreset()));
      menu.focus({ preventScroll: true });
    }

    function close({ focusToggle = false } = {}) {
      if (!isOpen()) return;
      root.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      if (focusToggle) toggle.focus({ preventScroll: true });
    }

    function choose(i) {
      setPreset(presetOptions()[i].dataset.value);
      close({ focusToggle: true });
    }

    toggle.addEventListener('click', () => {
      playClickSound();
      if (isOpen()) close();
      else open();
    });

    menu.addEventListener('click', (e) => {
      const option = optionFromEvent(e);
      if (!option) return;
      playClickSound();
      choose(presetOptions().indexOf(option));
    });

    menu.addEventListener('mousemove', (e) => {
      const option = optionFromEvent(e);
      if (option) highlight(presetOptions().indexOf(option));
    });

    // 키보드: 닫혀 있을 때 ↑↓로 열기
    toggle.addEventListener('keydown', (e) => {
      if (!isOpen() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        e.stopPropagation();   // 여는 키가 아래 '열려 있을 때' 처리로 한 칸 더 움직이지 않게
        open();
      }
    });

    // 열려 있을 때: ↑↓ 이동, Enter/Space 선택, Esc 닫기, Tab 닫기
    // (마우스로 연 뒤엔 포커스가 메뉴 밖에 있을 수 있어서 문서 전체에서 받음)
    document.addEventListener('keydown', (e) => {
      if (!isOpen()) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        highlight(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();   // 스페이스바 타이머 단축키와 겹치지 않게
        choose(activeIndex);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close({ focusToggle: true });
      } else if (e.key === 'Tab') {
        close();
      }
    });

    // 바깥을 누르면 닫기
    document.addEventListener('pointerdown', (e) => {
      if (isOpen() && !root.contains(e.target)) close();
    });
  }

  /* =========================================================
   * 설정 바 ② 반복 횟수 (−/+ 버튼, 숫자 클릭 후 직접 입력)
   * ======================================================= */
  function setRepeatDraft(n) {
    repeatDraft = clamp(n, 0, MAX_REPEAT);
    renderRepeat();
  }

  function initRepeatStepper() {
    const input = ui.repeatValue;
    let canceled = false;
    let justFocused = false;

    ui.repeatMinus.addEventListener('click', () => {
      playClickSound();
      setRepeatDraft(repeatDraft - 1);
    });

    ui.repeatPlus.addEventListener('click', () => {
      playClickSound();
      setRepeatDraft(repeatDraft + 1);
    });

    // 숫자를 클릭하면 숫자키로 직접 입력 (Enter/바깥 클릭으로 확정, Esc로 취소, 0 또는 비우면 ∞)
    input.addEventListener('focus', () => {
      repeatEditing = true;
      canceled = false;
      justFocused = true;
      input.value = repeatDraft === 0 ? '' : String(repeatDraft);
      input.placeholder = '∞';
      input.select();   // 바로 덮어쓰며 입력할 수 있게 전체 선택
    });

    // 클릭으로 들어올 때 마우스를 떼는 순간 선택이 풀리지 않게
    input.addEventListener('mouseup', (e) => {
      if (justFocused) e.preventDefault();
      justFocused = false;
    });

    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 2);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        canceled = true;
        input.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const n = parseInt(input.value, 10) || 0;
        const next = clamp(n + (e.key === 'ArrowUp' ? 1 : -1), 0, MAX_REPEAT);
        input.value = next === 0 ? '' : String(next);
      }
    });

    input.addEventListener('blur', () => {
      repeatEditing = false;
      input.placeholder = '';
      if (canceled) {
        renderRepeat();
        return;
      }
      const n = parseInt(input.value, 10);
      setRepeatDraft(Number.isNaN(n) ? 0 : n);
    });
  }

  /* =========================================================
   * 설정 바 ③ 접기/펴기 (모바일 전용, PC에서는 요약 버튼이 안 보임)
   * ======================================================= */
  function setSettingsCollapsed(collapsed) {
    ui.settings.classList.toggle('collapsed', collapsed);
    ui.settingsSummary.setAttribute('aria-expanded', String(!collapsed));
    storage.set(STORAGE_KEYS.settingsCollapsed, collapsed ? '1' : '0');
  }

  function initSettingsCollapse() {
    ui.settingsSummary.addEventListener('click', () => {
      playClickSound();
      setSettingsCollapsed(!ui.settings.classList.contains('collapsed'));
    });

    // 처음엔 접힌 상태로 시작 (사용자가 편 적이 있으면 그 상태 유지)
    const saved = storage.getRaw(STORAGE_KEYS.settingsCollapsed);
    setSettingsCollapsed(saved === null ? true : saved === '1');
  }

  /* =========================================================
   * 설정 바 ④ 알람 소리 크기 (바꾸면 바로 적용·저장)
   * ======================================================= */
  function initAlarmVolume() {
    const { alarmVolume: root, alarmVolToggle: toggle, alarmVolSlider: slider } = ui;

    const isOpen = () => root.classList.contains('open');

    function setAlarmVolume(v, { save = true } = {}) {
      const volume = clamp(Number.isFinite(v) ? v : DEFAULT_ALARM_VOLUME, 0, 1);
      ui.alarm.volume = volume;
      const text = `${Math.round(volume * 100)}%`;
      ui.alarmVolLabel.textContent = text;
      ui.alarmVolValue.textContent = text;
      slider.value = String(volume);
      slider.style.setProperty('--p', `${volume * 100}%`);
      root.classList.toggle('is-muted', volume === 0);
      toggle.setAttribute('aria-label', `알람 소리 크기 ${text}`);
      if (save) storage.set(STORAGE_KEYS.alarmVolume, String(volume));
    }

    function open() {
      root.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
    }

    function close() {
      root.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', () => {
      playClickSound();
      if (isOpen()) close();
      else open();
    });

    slider.addEventListener('input', () => setAlarmVolume(Number(slider.value)));

    // 미리 듣기: 지금 크기로 알람을 한 번 울림 (울리는 중이면 처음부터)
    ui.alarmVolTest.addEventListener('click', () => {
      stopAlarm();
      ui.alarm.currentTime = 0;
      ui.alarm.play().catch(() => {});
    });

    // 바깥을 누르거나 Esc를 누르면 닫기
    document.addEventListener('pointerdown', (e) => {
      if (isOpen() && !root.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        close();
        toggle.focus({ preventScroll: true });
      }
    });

    const saved = parseFloat(storage.getRaw(STORAGE_KEYS.alarmVolume));
    setAlarmVolume(Number.isNaN(saved) ? DEFAULT_ALARM_VOLUME : saved, { save: false });
  }

  /* =========================================================
   * 유튜브 플레이어 (링크를 넣으면 배경음악처럼 반복 재생)
   * ======================================================= */

  // 여러 형태의 유튜브 주소에서 영상 ID / 재생목록 ID / 시작 시간을 꺼냄
  function parseYouTubeUrl(input) {
    const text = String(input || '').trim();
    if (!text) return null;

    // 영상 ID만 붙여넣은 경우
    if (/^[\w-]{11}$/.test(text)) return { videoId: text, listId: null, start: 0 };

    let url;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }

    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let videoId = null;

    if (host === 'youtu.be') {
      videoId = url.pathname.slice(1).split('/')[0];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      videoId = url.searchParams.get('v');
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (!videoId && m) videoId = m[1];
    } else {
      return null;
    }

    let listId = url.searchParams.get('list');
    // 유튜브 자동 믹스(RD...)는 다른 사이트에서 재생되지 않으므로 영상만 사용
    if (listId && /^RD/.test(listId) && videoId) listId = null;
    if (videoId && !/^[\w-]{11}$/.test(videoId)) videoId = null;
    if (!videoId && !listId) return null;

    // t=90, t=1m30s, start=90 형태 지원
    const t = url.searchParams.get('t') || url.searchParams.get('start') || '';
    let start = 0;
    const hms = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
    if (hms) start = (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);

    return { videoId, listId, start };
  }

  // 유튜브 IFrame API를 한 번만 불러옴
  let ytApiPromise = null;

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytApiPromise) return ytApiPromise;

    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve(window.YT);
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => {
        ytApiPromise = null;
        reject(new Error('youtube api load failed'));
      };
      document.head.appendChild(tag);
    });
    return ytApiPromise;
  }

  function initMusicPlayer() {
    const { musicPlayer: root, musicToggle, muteToggle, volumeSlider, linkToggle, musicForm, musicUrl, musicNow } = ui;

    const toNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // 저장된 설정 (마지막 링크, 볼륨, 음소거)
    const saved = storage.getJSON(STORAGE_KEYS.music) || {};

    const state = {
      volume: Number.isFinite(saved.volume) ? saved.volume : DEFAULT_MUSIC_VOLUME,
      muted: !!saved.muted,
      source: null,     // { videoId, listId, start }
      url: '',
      player: null,
      ready: false,
      playing: false,
      pendingAutoplay: false,
    };

    const isSilent = () => state.muted || state.volume === 0;

    function saveMusic() {
      storage.set(STORAGE_KEYS.music, { url: state.url, volume: state.volume, muted: state.muted });
    }

    /* ---- 화면 ---- */
    function setSliderFill() {
      const min = toNumber(volumeSlider.min);
      const max = toNumber(volumeSlider.max) || 1;
      const p = ((toNumber(volumeSlider.value) - min) / (max - min)) * 100;
      volumeSlider.style.setProperty('--p', `${p}%`);
    }

    function setPlayingUI(isPlaying) {
      state.playing = isPlaying;
      musicToggle.classList.toggle('is-playing', isPlaying);
      musicToggle.setAttribute('aria-label', isPlaying ? '일시 정지' : '재생');
    }

    function syncVolumeUI() {
      volumeSlider.value = String(state.volume);
      muteToggle.classList.toggle('is-muted', isSilent());
      muteToggle.setAttribute('aria-label', isSilent() ? '음소거 해제' : '음소거');
      setSliderFill();
    }

    function applyVolumeToPlayer() {
      if (!state.ready) return;
      state.player.setVolume(Math.round(state.volume * 100));
      if (isSilent()) state.player.mute();
      else state.player.unMute();
    }

    function setNowText(text) {
      musicNow.textContent = text;
      musicNow.title = text;
    }

    function updateNowPlaying() {
      if (!state.ready) return;
      const title = state.player.getVideoData?.().title;
      if (title) setNowText(`♪ ${title}`);
    }

    /* ---- 링크 패널 · 볼륨 조절 (둘이 겹치지 않게 한 번에 하나만 보임) ---- */
    const volumeControl = muteToggle.closest('.volume-control');
    const volumeDropdown = volumeControl.querySelector('.volume-dropdown');
    let volumeCloseTimer = null;

    const isPanelOpen = () => root.classList.contains('panel-open');

    function openVolume() {
      clearTimeout(volumeCloseTimer);
      volumeControl.classList.add('open');
      root.classList.add('volume-open');   // 열려 있는 링크 패널은 잠깐 숨김
    }

    function closeVolume() {
      clearTimeout(volumeCloseTimer);
      volumeControl.classList.remove('open');
      root.classList.remove('volume-open');
    }

    function scheduleCloseVolume() {
      clearTimeout(volumeCloseTimer);
      volumeCloseTimer = setTimeout(closeVolume, 120);
    }

    function openPanel() {
      closeVolume();
      root.classList.add('panel-open');
      linkToggle.setAttribute('aria-expanded', 'true');
      if (!state.source) setTimeout(() => musicUrl.focus({ preventScroll: true }), 50);
    }

    function closePanel() {
      root.classList.remove('panel-open');
      linkToggle.setAttribute('aria-expanded', 'false');
    }

    /* ---- 유튜브 플레이어 이벤트 ---- */
    function onPlayerStateChange(e) {
      const S = window.YT.PlayerState;
      if (e.data === S.PLAYING) {
        setPlayingUI(true);
        updateNowPlaying();
      } else if (e.data === S.PAUSED || e.data === S.CUED) {
        setPlayingUI(false);
        updateNowPlaying();
      } else if (e.data === S.ENDED) {
        // 배경음악처럼 계속 반복
        if (state.source && !state.source.listId) {
          state.player.seekTo(state.source.start || 0, true);
          state.player.playVideo();
        } else {
          setPlayingUI(false);
        }
      }
    }

    function onPlayerError(e) {
      setPlayingUI(false);
      const msg = (e.data === 101 || e.data === 150)
        ? '이 영상은 다른 사이트에서 재생할 수 없도록 막혀 있어요'
        : '이 링크는 재생할 수 없어요';
      setNowText(msg);
      showToast(`😭${msg}`);
    }

    function onPlayerReady(source) {
      state.ready = true;
      applyVolumeToPlayer();
      if (source.listId) state.player.setLoop(true);
      if (state.pendingAutoplay) state.player.playVideo();
      else setNowText('▶를 누르면 재생돼요');
      updateNowPlaying();
    }

    async function loadSource(source, { autoplay }) {
      state.source = source;
      root.classList.add('has-video');
      setNowText('불러오는 중…');

      let YT;
      try {
        YT = await loadYouTubeApi();
      } catch {
        setNowText('유튜브에 연결하지 못했어요. 인터넷 연결을 확인해 주세요');
        showToast('😭유튜브에 연결하지 못했어요');
        return;
      }

      // 이미 플레이어가 있으면 영상만 바꿈
      if (state.player && state.ready) {
        if (source.listId) {
          const listOpts = { listType: 'playlist', list: source.listId, index: 0, startSeconds: source.start };
          if (autoplay) state.player.loadPlaylist(listOpts);
          else state.player.cuePlaylist(listOpts);
          state.player.setLoop(true);
        } else {
          const videoOpts = { videoId: source.videoId, startSeconds: source.start };
          if (autoplay) state.player.loadVideoById(videoOpts);
          else state.player.cueVideoById(videoOpts);
        }
        return;
      }

      state.pendingAutoplay = autoplay;
      const playerVars = { playsinline: 1, rel: 0, start: source.start || undefined };
      if (source.listId) {
        playerVars.listType = 'playlist';
        playerVars.list = source.listId;
        playerVars.loop = 1;
      }

      state.player = new YT.Player('ytPlayer', {
        width: '100%',
        height: '100%',
        videoId: source.videoId || undefined,
        playerVars,
        events: {
          onReady: () => onPlayerReady(source),
          onStateChange: onPlayerStateChange,
          onError: onPlayerError,
        },
      });
    }

    /* ---- 사용자 동작 ---- */
    musicForm.addEventListener('submit', (e) => {
      e.preventDefault();
      playClickSound();
      const source = parseYouTubeUrl(musicUrl.value);
      if (!source) {
        showToast('😭올바른 유튜브 링크를 넣어주세요');
        musicUrl.focus();
        return;
      }
      state.url = musicUrl.value.trim();
      saveMusic();
      loadSource(source, { autoplay: true });
    });

    linkToggle.addEventListener('click', () => {
      playClickSound();
      if (isPanelOpen()) closePanel();
      else openPanel();
    });

    musicToggle.addEventListener('click', () => {
      playClickSound();
      if (!state.source) {
        showToast('🔗먼저 유튜브 링크를 넣어주세요');
        openPanel();
        return;
      }
      if (!state.ready) {
        state.pendingAutoplay = true;
        return;
      }
      if (state.playing) state.player.pauseVideo();
      else state.player.playVideo();
    });

    muteToggle.addEventListener('click', () => {
      playClickSound();
      state.muted = !state.muted;
      // 음소거를 풀었는데 볼륨이 0이면 들리지 않으므로 기본값으로 복구
      if (!state.muted && state.volume === 0) state.volume = DEFAULT_MUSIC_VOLUME;
      syncVolumeUI();
      applyVolumeToPlayer();
      saveMusic();
    });

    volumeSlider.addEventListener('input', (e) => {
      state.volume = toNumber(e.target.value);
      state.muted = state.volume === 0;
      syncVolumeUI();
      applyVolumeToPlayer();
      saveMusic();
    });

    // 볼륨: 스피커 버튼에 마우스를 올리면 열리고, 영역을 벗어나면 닫힘
    muteToggle.addEventListener('mouseenter', openVolume);
    volumeDropdown.addEventListener('mouseenter', openVolume);
    volumeControl.addEventListener('mouseleave', scheduleCloseVolume);

    // 링크 패널: 바깥을 누르거나 Esc를 누르면 닫기 (재생은 계속됨)
    document.addEventListener('pointerdown', (e) => {
      if (isPanelOpen() && !root.contains(e.target)) closePanel();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isPanelOpen()) {
        closePanel();
        linkToggle.focus({ preventScroll: true });
      }
    });

    /* ---- 시작 ---- */
    syncVolumeUI();
    setPlayingUI(false);

    // 지난번에 넣은 링크가 있으면 미리 불러둠 (자동재생은 브라우저가 막으므로 ▶로 재생)
    const savedSource = saved.url && parseYouTubeUrl(saved.url);
    if (savedSource) {
      state.url = saved.url;
      musicUrl.value = saved.url;
      loadSource(savedSource, { autoplay: false });
    }
  }

  /* =========================================================
   * 복원 (새로고침·재방문 시 이어서)
   * ======================================================= */
  // 페이지가 닫혀 있던 동안 흐른 시간만큼 세션을 진행시킴 (알람 없이)
  // 반환값: 모든 세트가 끝났으면 null, 아니면 지금 세션의 남은 시간(ms)
  function catchUpElapsed(leftMs) {
    while (leftMs <= 0) {
      if (timer.isFocus) {
        timer.isFocus = false;
      } else {
        timer.completedSets += 1;
        if (!hasNextSet()) return null;
        timer.isFocus = true;
      }
      leftMs += currentSessionMs();
    }
    return leftMs;
  }

  function restoreState() {
    const data = storage.getJSON(STORAGE_KEYS.timer);
    if (!data) return;

    setPreset(data.preset);
    if (!data.configured) return;

    applyPresetToSettings();
    settings.totalSets = Math.max(0, Number(data.totalSets) || 0);
    settings.configured = true;
    setRepeatDraft(settings.totalSets);

    timer.isFocus = data.isFocus !== false;
    timer.completedSets = Math.max(0, Number(data.completedSets) || 0);
    let leftMs = Math.max(0, Number(data.remainingMs) || 0);

    if (data.running) {
      leftMs -= Date.now() - (Number(data.savedAt) || Date.now());
      leftMs = catchUpElapsed(leftMs);
      renderSetCounter();

      if (leftMs === null) {
        resetRuntime();
        renderStatus(MSG.done, COLOR.red);
        saveState();
        return;
      }
      timer.pausedRemainingMs = leftMs;
      startTimer();
      return;
    }

    // 멈춰 있던 상태 복원
    timer.pausedRemainingMs = leftMs;
    renderTomato();
    renderSetCounter();
    if (leftMs > 0) {
      renderTime(Math.ceil(leftMs / 1000));
      renderStatus(MSG.paused, COLOR.gray);
    } else {
      renderTime(Math.ceil(currentSessionMs() / 1000));
      const done = !isInfinite() && timer.completedSets >= settings.totalSets;
      renderStatus(done ? MSG.done : MSG.ready, COLOR.red);
    }
  }

  /* =========================================================
   * 키보드 단축키
   * ======================================================= */
  const isTypingTarget = (el) =>
    el instanceof Element && !!el.closest('input, select, textarea, [contenteditable="true"]');

  function initKeyboard() {
    // 토마토에 포커스가 있을 때 Enter / Space
    ui.tomato.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onTomatoClick();
      }
    });

    document.addEventListener('keydown', (e) => {
      // Esc: 울리는 알람 끄기
      if (e.key === 'Escape' && !ui.alarmStop.hidden) {
        stopAlarm();
        return;
      }

      // Space: 시작/일시 정지
      // (입력칸에 글자를 칠 때, 버튼·토마토·드롭다운에 포커스가 있을 때는 제외)
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest('.dropdown, button, [role="button"]')) return;
      e.preventDefault();
      onTomatoClick();
    });

    // 마우스로 버튼을 누른 뒤엔 포커스를 풀어서, 스페이스바가 그 버튼을 다시 누르지 않게 함
    document.addEventListener('click', (e) => {
      const btn = e.target instanceof Element && e.target.closest('button, [role="button"]');
      if (btn && e.detail > 0) btn.blur();
    });
  }

  /* =========================================================
   * 시작
   * ======================================================= */
  function init() {
    ui.tomato.addEventListener('click', onTomatoClick);
    ui.applyBtn.addEventListener('click', onApplyClick);
    ui.resetBtn.addEventListener('click', onResetClick);
    ui.skipBtn.addEventListener('click', onSkipClick);
    ui.alarmStop.addEventListener('click', onAlarmStopClick);

    // 탭이 백그라운드에 있는 동안 브라우저가 setInterval을 늦추므로, 다시 보일 때 즉시 시간을 맞춤
    document.addEventListener('visibilitychange', () => {
      if (timer.running) tick();
    });
    // 탭을 닫거나 새로고침하기 직전에도 저장
    window.addEventListener('pagehide', saveState);

    initPresetDropdown();
    initRepeatStepper();
    initSettingsCollapse();
    initAlarmVolume();
    initKeyboard();

    renderTime(settings.focusMinutes * 60);
    renderSetCounter();
    renderRepeat();
    setPreset(getPreset());

    initMusicPlayer();
    restoreState();
  }

  init();
})();
