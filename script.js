// ===== Pomodoro Timer =====
// 전역 오염을 막기 위해 전체를 즉시 실행 함수로 감쌉니다.
// (HTML의 onclick 대신 아래 bindEvents()에서 이벤트를 연결합니다.)
(() => {
  'use strict';

  /* -----------------------------
   * 상수
   * ---------------------------*/
  const TICK_MS = 250;            // 화면 갱신 주기
  const TOAST_MS = 2500;          // 토스트 표시 시간 (CSS 진행바 애니메이션과 동일)
  const ALARM_REPEAT = 4;         // 세션 종료 알람 반복 횟수
  const ALARM_GAP_MS = 150;       // 알람 사이 간격
  const DEFAULT_RAIN_VOLUME = 0.5;
  const STORAGE_KEY = 'pomodoro-state-v1';
  const DEFAULT_REPEAT = 4;       // 반복 횟수 기본값 (0 = 무한)
  const MAX_REPEAT = 99;

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

  /* -----------------------------
   * DOM
   * ---------------------------*/
  const $ = (id) => document.getElementById(id);

  const ui = {
    display: $('display'),
    tomato: $('tomato'),
    status: $('statusText'),
    repeatValue: $('repeatValue'),
    repeatMinus: $('repeatMinus'),
    repeatPlus: $('repeatPlus'),
    presetGroup: $('timePreset'),
    applyBtn: $('apply-btn'),
    resetBtn: $('reset-btn'),
    skipBtn: $('skip-btn'),
    setCounter: $('setCounter'),
    toast: $('toast'),
    alarm: $('alarmSound'),

    rainAudio: $('rainSound'),
    rainToggle: $('rainToggle'),
    muteToggle: $('muteToggle'),
    volumeSlider: $('volumeSlider'),
  };

  const clickSound = new Audio('effect.mp3');
  clickSound.preload = 'auto';

  /* -----------------------------
   * 상태
   * ---------------------------*/
  const settings = {
    focusMinutes: 25,
    restMinutes: 5,
    totalSets: 0,          // 0 = 무한 반복
    configured: false,
  };

  const timer = {
    running: false,
    isFocus: true,
    endAtMs: 0,            // 세션 종료 시각 (performance.now 기준)
    pausedRemainingMs: 0,  // 일시정지 시 남은 시간
    intervalId: null,
    completedSets: 0,
  };

  let repeatDraft = DEFAULT_REPEAT;   // − / + 로 고르는 중인 반복 횟수 ('적용' 전)

  // 집중/휴식 시간 토글 ('25-5' 또는 '50-10')
  const presetButtons = () => [...ui.presetGroup.querySelectorAll('[data-value]')];
  const getPreset = () =>
    (presetButtons().find((b) => b.getAttribute('aria-checked') === 'true') || presetButtons()[0]).dataset.value;

  function setPreset(value) {
    const buttons = presetButtons();
    if (!buttons.some((b) => b.dataset.value === value)) return false;
    buttons.forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    return true;
  }

  const isInfinite = () => settings.totalSets === 0;
  const hasNextSet = () => isInfinite() || timer.completedSets < settings.totalSets;

  /* -----------------------------
   * 유틸
   * ---------------------------*/
  const nowMs = () => performance.now();
  const minutesToMs = (min) => min * 60 * 1000;

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

  /* -----------------------------
   * 저장 / 복원 (새로고침해도 이어서)
   * ---------------------------*/
  function saveState() {
    const data = {
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
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // 사생활 보호 모드 등에서 저장이 막혀도 타이머는 그대로 동작
    }
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }

  /* -----------------------------
   * 사운드
   * ---------------------------*/
  function playClickSound() {
    clickSound.currentTime = 0;
    clickSound.play().catch(() => {});
  }

  let alarmRepeatTimer = null;
  let alarmEndedHandler = null;

  function stopAlarm() {
    if (!ui.alarm) return;

    clearTimeout(alarmRepeatTimer);
    alarmRepeatTimer = null;

    if (alarmEndedHandler) {
      ui.alarm.removeEventListener('ended', alarmEndedHandler);
      alarmEndedHandler = null;
    }

    ui.alarm.pause();
    ui.alarm.currentTime = 0;
  }

  function playAlarm(times = ALARM_REPEAT, gapMs = ALARM_GAP_MS) {
    if (!ui.alarm) return;
    stopAlarm();

    let played = 0;
    const playOnce = () => {
      // iOS/Safari 연속 재생 안정성을 위해 처음으로 되감기
      ui.alarm.currentTime = 0;
      ui.alarm.play().catch(() => {});
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

  /* -----------------------------
   * 렌더링
   * ---------------------------*/
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
    }, 200);
  }

  function renderRepeat() {
    ui.repeatValue.textContent = repeatDraft === 0 ? '∞ 무한' : `${repeatDraft}세트`;
    ui.repeatMinus.disabled = repeatDraft === 0;
    ui.repeatPlus.disabled = repeatDraft >= MAX_REPEAT;
  }

  function renderTomato() {
    ui.tomato.classList.toggle('running', timer.running);
    ui.tomato.classList.toggle('break', !timer.isFocus);
  }

  function renderSetCounter() {
    let total = '?';
    if (settings.configured) total = isInfinite() ? '∞' : `${settings.totalSets}세트`;
    ui.setCounter.textContent = `완료한 세트: ${timer.completedSets}세트 / ${total}`;
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

  /* -----------------------------
   * 타이머 루프
   * ---------------------------*/
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

  /* -----------------------------
   * 세션 전환
   * ---------------------------*/
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

  /* -----------------------------
   * 초기화
   * ---------------------------*/
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

  // 전체 초기화 (설정까지 지움)
  function resetAll() {
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
  }

  /* -----------------------------
   * 사용자 동작
   * ---------------------------*/
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

  // 지금 세션을 바로 끝내고 다음 단계(집중 → 휴식 → 다음 세트)로 넘어갑니다.
  function onSkipClick() {
    playClickSound();
    if (!ensureConfigured()) return;

    stopTickLoop();
    stopAlarm();
    onSessionFinished({ skipped: true });
  }

  function onApplyClick() {
    playClickSound();

    const repeat = repeatDraft;
    const [focus, rest] = getPreset().split('-').map(Number);
    settings.focusMinutes = focus;
    settings.restMinutes = rest;
    settings.totalSets = repeat;
    settings.configured = true;
    timer.completedSets = 0;

    stopAlarm();
    resetRuntime();
    renderSetCounter();
    renderStatus(MSG.ready, COLOR.red);
    showToast('✔️설정이 적용되었습니다!');
    saveState();
  }

  function onResetClick() {
    playClickSound();
    resetAll();
    showToast('✔️초기화 되었습니다!');
  }

  // 탭이 백그라운드에 있는 동안 브라우저가 setInterval을 늦추므로,
  // 다시 보일 때 즉시 시간을 맞춥니다.
  function onVisibilityChange() {
    if (timer.running) tick();
  }

  /* -----------------------------
   * 빗소리 플레이어
   * ---------------------------*/
  function initRainPlayer() {
    const { rainAudio, rainToggle, muteToggle, volumeSlider } = ui;
    if (!rainAudio || !rainToggle || !muteToggle || !volumeSlider) return;

    const toNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    function setSliderFill() {
      const min = toNumber(volumeSlider.min);
      const max = toNumber(volumeSlider.max) || 1;
      const p = ((toNumber(volumeSlider.value) - min) / (max - min)) * 100;
      volumeSlider.style.setProperty('--p', `${p}%`);
    }

    function setPlayingUI(isPlaying) {
      rainToggle.textContent = isPlaying ? '⏸' : '▶';
      rainToggle.setAttribute('aria-label', isPlaying ? '빗소리 정지' : '빗소리 재생');
    }

    // 오디오 상태 → UI(슬라이더/아이콘) 동기화
    function syncUIFromAudio() {
      volumeSlider.value = String(rainAudio.volume);
      const isSilent = rainAudio.muted || rainAudio.volume === 0;
      muteToggle.textContent = isSilent ? '🔇' : '🔊';
      muteToggle.setAttribute('aria-label', isSilent ? '음소거 해제' : '음소거');
      setSliderFill();
    }

    // 초기 볼륨: 슬라이더 기본값(HTML value) → 오디오
    const initialVolume = toNumber(volumeSlider.value);
    rainAudio.volume = initialVolume;
    rainAudio.muted = initialVolume === 0;
    syncUIFromAudio();
    setPlayingUI(!rainAudio.paused);

    // 볼륨 드롭다운: 스피커 버튼에 호버하면 열리고, 영역을 벗어나면 닫힘
    const volumeControl = muteToggle.closest('.volume-control');
    const volumeDropdown = volumeControl?.querySelector('.volume-dropdown');
    if (volumeControl && volumeDropdown) {
      let closeTimer = null;

      const open = () => {
        clearTimeout(closeTimer);
        volumeControl.classList.add('open');
      };
      const scheduleClose = () => {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => volumeControl.classList.remove('open'), 120);
      };

      muteToggle.addEventListener('mouseenter', open);
      volumeDropdown.addEventListener('mouseenter', open);
      volumeControl.addEventListener('mouseleave', scheduleClose);
    }

    rainToggle.addEventListener('click', () => {
      playClickSound();
      if (rainAudio.paused) {
        rainAudio.play().catch(() => showToast('브라우저에서 자동재생이 차단되었습니다.'));
      } else {
        rainAudio.pause();
      }
    });

    muteToggle.addEventListener('click', () => {
      playClickSound();
      rainAudio.muted = !rainAudio.muted;
      // 음소거를 풀었는데 볼륨이 0이면 들리지 않으므로 기본값으로 복구
      if (!rainAudio.muted && rainAudio.volume === 0) {
        rainAudio.volume = DEFAULT_RAIN_VOLUME;
      }
      syncUIFromAudio();
    });

    volumeSlider.addEventListener('input', (e) => {
      const v = toNumber(e.target.value);
      rainAudio.volume = v;
      rainAudio.muted = v === 0;
      syncUIFromAudio();
    });

    // 어떤 이유로든(브라우저/OS/코드) 상태가 바뀌면 UI가 따라오도록
    rainAudio.addEventListener('play', () => setPlayingUI(true));
    rainAudio.addEventListener('pause', () => setPlayingUI(false));
    rainAudio.addEventListener('volumechange', syncUIFromAudio);
  }

  /* -----------------------------
   * 복원
   * ---------------------------*/
  function restoreState() {
    const data = loadState();
    if (!data) return;

    setPreset(data.preset);
    if (!data.configured) return;

    const [focus, rest] = getPreset().split('-').map(Number);
    settings.focusMinutes = focus;
    settings.restMinutes = rest;
    settings.totalSets = Math.max(0, Number(data.totalSets) || 0);
    settings.configured = true;
    repeatDraft = Math.min(MAX_REPEAT, settings.totalSets);
    renderRepeat();

    timer.isFocus = data.isFocus !== false;
    timer.completedSets = Math.max(0, Number(data.completedSets) || 0);
    let leftMs = Math.max(0, Number(data.remainingMs) || 0);

    if (data.running) {
      // 페이지가 닫혀 있던 동안 흐른 시간만큼 세션을 진행시킴 (알람 없이)
      leftMs -= Date.now() - (Number(data.savedAt) || Date.now());
      let finished = false;
      while (leftMs <= 0) {
        if (timer.isFocus) {
          timer.isFocus = false;
        } else {
          timer.completedSets += 1;
          if (!hasNextSet()) { finished = true; break; }
          timer.isFocus = true;
        }
        leftMs += currentSessionMs();
      }

      renderSetCounter();
      if (finished) {
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

  /* -----------------------------
   * 시작
   * ---------------------------*/
  function isTypingTarget(el) {
    return el instanceof Element && !!el.closest('input, select, textarea, [contenteditable="true"]');
  }

  function bindEvents() {
    ui.tomato.addEventListener('click', onTomatoClick);
    // 키보드 사용자도 토마토를 시작/정지할 수 있도록 (Enter / Space)
    ui.tomato.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onTomatoClick();
      }
    });
    ui.applyBtn.addEventListener('click', onApplyClick);
    ui.resetBtn.addEventListener('click', onResetClick);
    ui.skipBtn.addEventListener('click', onSkipClick);
    ui.presetGroup.addEventListener('click', (e) => {
      const btn = e.target instanceof Element && e.target.closest('[data-value]');
      if (!btn) return;
      playClickSound();
      setPreset(btn.dataset.value);
    });
    // 키보드: 좌우 화살표로 선택 이동
    ui.presetGroup.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const buttons = presetButtons();
      const i = buttons.findIndex((b) => b.dataset.value === getPreset());
      const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      setPreset(next.dataset.value);
      next.focus();
    });
    ui.repeatMinus.addEventListener('click', () => {
      playClickSound();
      repeatDraft = Math.max(0, repeatDraft - 1);
      renderRepeat();
    });
    ui.repeatPlus.addEventListener('click', () => {
      playClickSound();
      repeatDraft = Math.min(MAX_REPEAT, repeatDraft + 1);
      renderRepeat();
    });
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 스페이스바로 시작/일시 정지 (입력칸에 글자를 칠 때나 버튼·토마토에 포커스가 있을 때는 제외)
    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.target instanceof Element && e.target.closest('button, [role="button"]')) return;
      e.preventDefault();
      onTomatoClick();
    });

    // 마우스로 버튼을 누른 뒤엔 포커스를 풀어서, 스페이스바가 그 버튼을 다시 누르지 않게 함
    document.addEventListener('click', (e) => {
      const btn = e.target instanceof Element && e.target.closest('button, [role="button"]');
      if (btn && e.detail > 0) btn.blur();
    });

    // 탭을 닫거나 새로고침하기 직전에도 저장
    window.addEventListener('pagehide', saveState);
  }

  bindEvents();
  renderTime(settings.focusMinutes * 60);
  renderSetCounter();
  renderRepeat();
  setPreset(getPreset());
  initRainPlayer();
  restoreState();
})();
