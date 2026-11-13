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
  const DEFAULT_MUSIC_VOLUME = 0.5;
  const MUSIC_KEY = 'pomodoro-music-v1';
  const STORAGE_KEY = 'pomodoro-state-v1';
  const DEFAULT_REPEAT = 0;       // 반복 횟수 기본값: 0 = 무한(∞)
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
    presetDropdown: $('timePreset'),
    presetToggle: $('presetToggle'),
    presetLabel: $('presetLabel'),
    presetMenu: $('presetMenu'),
    applyBtn: $('apply-btn'),
    resetBtn: $('reset-btn'),
    skipBtn: $('skip-btn'),
    setCounter: $('setCounter'),
    toast: $('toast'),
    alarm: $('alarmSound'),
    alarmStop: $('alarmStop'),

    musicPlayer: $('musicPlayer'),
    musicToggle: $('musicToggle'),
    linkToggle: $('linkToggle'),
    musicForm: $('musicForm'),
    musicUrl: $('musicUrl'),
    musicNow: $('musicNow'),
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

  // 집중/휴식 시간 드롭다운 ('25-5' 또는 '50-10')
  const presetOptions = () => [...ui.presetMenu.querySelectorAll('[data-value]')];
  const getPreset = () =>
    (presetOptions().find((o) => o.getAttribute('aria-selected') === 'true') || presetOptions()[0]).dataset.value;

  function setPreset(value) {
    const options = presetOptions();
    const picked = options.find((o) => o.dataset.value === value);
    if (!picked) return false;
    options.forEach((o) => o.setAttribute('aria-selected', String(o === picked)));
    ui.presetLabel.textContent = picked.textContent;
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
    setAlarmStopVisible(false);
  }

  // '알람 끄기' 버튼은 알람이 실제로 울리는 동안에만 보임
  function setAlarmStopVisible(visible) {
    if (!ui.alarmStop) return;
    ui.alarmStop.hidden = !visible;
    document.body.classList.toggle('alarm-ringing', visible);
  }

  function playAlarm(times = ALARM_REPEAT, gapMs = ALARM_GAP_MS) {
    if (!ui.alarm) return;
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
    ui.repeatValue.textContent = repeatDraft === 0 ? '∞' : `${repeatDraft}세트`;
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
   * 유튜브 플레이어 (링크를 넣으면 배경음악처럼 반복 재생)
   * ---------------------------*/

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

  function initMusicPlayer() {
    const { musicPlayer: root, musicToggle, muteToggle, volumeSlider, linkToggle, musicForm, musicUrl, musicNow } = ui;
    if (!root || !musicToggle || !muteToggle || !volumeSlider) return;

    const toNumber = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // 저장된 설정 (마지막 링크, 볼륨, 음소거)
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(MUSIC_KEY)) || {};
    } catch {
      saved = {};
    }

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

    function saveMusic() {
      try {
        localStorage.setItem(MUSIC_KEY, JSON.stringify({ url: state.url, volume: state.volume, muted: state.muted }));
      } catch {
        // 저장이 막혀도 재생은 그대로
      }
    }

    /* ---- UI ---- */
    function setSliderFill() {
      const min = toNumber(volumeSlider.min);
      const max = toNumber(volumeSlider.max) || 1;
      const p = ((toNumber(volumeSlider.value) - min) / (max - min)) * 100;
      volumeSlider.style.setProperty('--p', `${p}%`);
    }

    function setPlayingUI(isPlaying) {
      state.playing = isPlaying;
      musicToggle.textContent = isPlaying ? '⏸' : '▶';
      musicToggle.setAttribute('aria-label', isPlaying ? '일시 정지' : '재생');
    }

    function syncVolumeUI() {
      volumeSlider.value = String(state.volume);
      const isSilent = state.muted || state.volume === 0;
      muteToggle.textContent = isSilent ? '🔇' : '🔊';
      muteToggle.setAttribute('aria-label', isSilent ? '음소거 해제' : '음소거');
      setSliderFill();
    }

    function applyVolumeToPlayer() {
      if (!state.ready) return;
      state.player.setVolume(Math.round(state.volume * 100));
      if (state.muted || state.volume === 0) state.player.mute();
      else state.player.unMute();
    }

    function setNowText(text) {
      musicNow.textContent = text;
      musicNow.title = text;
    }

    /* ---- 패널 열기/닫기 ---- */
    const isPanelOpen = () => root.classList.contains('panel-open');

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

    /* ---- 유튜브 API ---- */
    let apiPromise = null;

    function loadYouTubeApi() {
      if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
      if (apiPromise) return apiPromise;

      apiPromise = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
          if (typeof prev === 'function') prev();
          resolve(window.YT);
        };
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.async = true;
        tag.onerror = () => {
          apiPromise = null;
          reject(new Error('youtube api load failed'));
        };
        document.head.appendChild(tag);
      });
      return apiPromise;
    }

    function updateNowPlaying() {
      if (!state.ready) return;
      const title = state.player.getVideoData?.().title;
      if (title) setNowText(`♪ ${title}`);
    }

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

      const listOpts = source.listId
        ? { listType: 'playlist', list: source.listId, index: 0, startSeconds: source.start }
        : null;

      // 이미 플레이어가 있으면 영상만 바꿈
      if (state.player && state.ready) {
        if (listOpts) {
          if (autoplay) state.player.loadPlaylist(listOpts);
          else state.player.cuePlaylist(listOpts);
          state.player.setLoop(true);
        } else if (autoplay) {
          state.player.loadVideoById({ videoId: source.videoId, startSeconds: source.start });
        } else {
          state.player.cueVideoById({ videoId: source.videoId, startSeconds: source.start });
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
          onReady: () => {
            state.ready = true;
            applyVolumeToPlayer();
            if (source.listId) state.player.setLoop(true);
            if (state.pendingAutoplay) state.player.playVideo();
            if (!state.pendingAutoplay) setNowText('▶를 누르면 재생돼요');
            updateNowPlaying();
          },
          onStateChange: onPlayerStateChange,
          onError: onPlayerError,
        },
      });
    }

    /* ---- 이벤트 ---- */
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

    // 패널 바깥을 누르거나 Esc를 누르면 닫기 (재생은 계속됨)
    document.addEventListener('pointerdown', (e) => {
      if (isPanelOpen() && !root.contains(e.target)) closePanel();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isPanelOpen()) {
        closePanel();
        linkToggle.focus({ preventScroll: true });
      }
    });

    // 볼륨 드롭다운: 스피커 버튼에 호버하면 열리고, 영역을 벗어나면 닫힘
    // 링크 패널과 겹치지 않도록, 볼륨이 열려 있는 동안은 패널을 잠깐 숨김
    const volumeControl = muteToggle.closest('.volume-control');
    const volumeDropdown = volumeControl?.querySelector('.volume-dropdown');
    let volumeCloseTimer = null;

    function openVolume() {
      clearTimeout(volumeCloseTimer);
      volumeControl.classList.add('open');
      root.classList.add('volume-open');
    }

    function closeVolume() {
      clearTimeout(volumeCloseTimer);
      volumeControl?.classList.remove('open');
      root.classList.remove('volume-open');
    }

    if (volumeControl && volumeDropdown) {
      const scheduleClose = () => {
        clearTimeout(volumeCloseTimer);
        volumeCloseTimer = setTimeout(closeVolume, 120);
      };
      muteToggle.addEventListener('mouseenter', openVolume);
      volumeDropdown.addEventListener('mouseenter', openVolume);
      volumeControl.addEventListener('mouseleave', scheduleClose);
    }

    /* ---- 시작 ---- */
    syncVolumeUI();
    setPlayingUI(false);

    // 지난번에 넣은 링크가 있으면 미리 불러둠 (자동재생은 브라우저가 막으므로 ▶로 재생)
    if (saved.url) {
      const source = parseYouTubeUrl(saved.url);
      if (source) {
        state.url = saved.url;
        musicUrl.value = saved.url;
        loadSource(source, { autoplay: false });
      }
    }
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
   * 집중/휴식 시간 드롭다운
   * ---------------------------*/
  function initPresetDropdown() {
    const { presetDropdown: root, presetToggle: toggle, presetMenu: menu } = ui;
    let activeIndex = 0;

    const isOpen = () => root.classList.contains('open');

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
      const option = e.target instanceof Element && e.target.closest('[data-value]');
      if (!option) return;
      playClickSound();
      choose(presetOptions().indexOf(option));
    });

    menu.addEventListener('mousemove', (e) => {
      const option = e.target instanceof Element && e.target.closest('[data-value]');
      if (option) highlight(presetOptions().indexOf(option));
    });

    // 키보드: ↑↓로 이동, Enter/Space로 선택, Esc로 닫기
    root.addEventListener('keydown', (e) => {
      if (!isOpen()) {
        if (e.target === toggle && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          open();
        }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        highlight(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
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
    ui.alarmStop.addEventListener('click', () => {
      stopAlarm();
      showToast('🔕알람을 껐어요');
    });
    // Esc로도 알람 끄기
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !ui.alarmStop.hidden) stopAlarm();
    });
    initPresetDropdown();
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
      if (e.target instanceof Element && e.target.closest('.dropdown')) return;
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
  initMusicPlayer();
  restoreState();
})();
