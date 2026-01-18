// ===== Pomodoro Timer (Refactor: 명확한 네이밍 + 정확도 유지) =====

/* -----------------------------
 * State (앱 상태: “무엇을 저장하는가”)
 * ---------------------------*/
let tickIntervalId = null;           // setInterval로 만든 “틱(갱신)” 루프 id (정지/재시작에 사용)

// 표시/호환용 상태 (UI에 직접 노출되는 값)
let remainingSeconds = 1500;         // 화면에 표시되는 남은 시간(초 단위)
let isFocusSession = true;           // 현재 세션이 집중(true) / 휴식(false)인지
let isTimerRunning = false;          // 현재 타이머가 실행 중인지

let focusMinutes = 25;               // 집중 세션 길이(분)
let restMinutes = 5;                 // 휴식 세션 길이(분)

let remainingSets = 0;               // 남은 세트 수(유한일 때만 감소)
let isSetInfinite = true;            // 세트 반복 무한 여부
let completedSetCount = 0;           // 완료된 세트 수
let configuredSetCount = 0;          // 설정된 총 세트 수
let isConfigured = false;            // 설정 적용 여부

// 정확도 상태
let sessionEndAtMs = 0;              // 이번 세션 종료 시각 (performance.now 기준)
let pausedRemainingMs = 0;           // 일시정지 시 남은 시간(ms)

/* -----------------------------
 * DOM
 * ---------------------------*/
const ui = {
  display: document.getElementById('display'),
  tomato: document.getElementById('tomato'),
  status: document.getElementById('statusText'),
  repeatInput: document.getElementById('repeatInput'),
  presetSelect: document.getElementById('timePreset'),
  setCounter: document.getElementById('setCounter'),
  toast: document.getElementById('toast'),

  // 빗소리 플레이어 UI (존재할 수도, 없을 수도 있음)
  rainAudio: document.getElementById('rainSound'),
  rainToggle: document.getElementById('rainToggle'),
  muteToggle: document.getElementById('muteToggle'),
  volumeSlider: document.getElementById('volumeSlider'),
};

const clickSound = new Audio('effect.mp3');
clickSound.preload = "auto";   // ✅ 미리 로드
// 🔔 알람 사운드
const alarmSound = document.getElementById('alarmSound');




/* -----------------------------
 * Small helpers
 * ---------------------------*/
const nowMs = () => performance.now();
const clampToZero = (n) => Math.max(0, n);

function formatAsMMSS(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function parsePresetMinutes(value) {
  const [focus, rest] = value.split('-').map(v => parseInt(v, 10));
  return { focus, rest };
}

function getCurrentSessionMinutes() {
  return isFocusSession ? focusMinutes : restMinutes;
}

function getCurrentSessionDurationMs() {
  return getCurrentSessionMinutes() * 60 * 1000;
}

function getRemainingMs() {
  return clampToZero(sessionEndAtMs - nowMs());
}

function msToCeilSeconds(ms) {
  return Math.ceil(ms / 1000);
}

/* -----------------------------
 * UI helpers
 * ---------------------------*/
function playClickSound() {
  clickSound.currentTime = 0;
  clickSound.play().catch(err => console.log('오디오 재생 오류:', err));
}

function renderTime(seconds) {
  ui.display.textContent = formatAsMMSS(seconds);
}

function renderStatus(text, color) {
  ui.status.textContent = text;
  ui.status.style.color = color;
}

function renderTomato({ running, restMode }) {
  ui.tomato.classList.toggle('running', !!running);
  ui.tomato.classList.toggle('break', !!restMode);
}

function showToast(message) {
  if (!ui.toast) return;

  // ✅ 안전하게 텍스트 이스케이프 + \n을 <br>로 변환
  const escaped = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  ui.toast.innerHTML = escaped.replace(/\n/g, "<br>");

  ui.toast.classList.add('show');
  setTimeout(() => ui.toast.classList.remove('show'), 2500);
}


function renderSetCounter() {
  if (!ui.setCounter) return;

  if (!isConfigured) {
    ui.setCounter.textContent = `완료한 세트: ${completedSetCount}세트 / ?`;
    return;
  }

  if (isSetInfinite) {
    ui.setCounter.textContent = `완료한 세트: ${completedSetCount}세트 / ∞`;
    return;
  }

  ui.setCounter.textContent =
    `완료한 세트: ${completedSetCount}세트 / ${configuredSetCount}세트`;
}

/* -----------------------------
 * Time sync (accuracy core)
 * ---------------------------*/
function syncRemainingSecondsFromDeadline() {
  const remainMs = getRemainingMs();
  remainingSeconds = msToCeilSeconds(remainMs);
  renderTime(remainingSeconds);
  return remainMs;
}

/* -----------------------------
 * Tick loop
 * ---------------------------*/
function stopTickLoop() {
  clearInterval(tickIntervalId);
  tickIntervalId = null;
}

function startTickLoop() {
  stopTickLoop();

  const onTick = () => {
    const remainMs = syncRemainingSecondsFromDeadline();
    if (remainMs <= 0) {
      stopTickLoop();
      onSessionFinished();
    }
  };

  onTick();
  tickIntervalId = setInterval(onTick, 250);
}

/* -----------------------------
 * Session lifecycle
 * ---------------------------*/
function renderRunningState() {
  isTimerRunning = true;
  renderTomato({ running: true, restMode: !isFocusSession });

  if (isFocusSession) {
    renderStatus("집중 중🔥", "var(--tomato-red)");
  } else {
    renderStatus("휴식 중☕", "var(--tomato-green)");
  }
}

function renderPausedState() {
  isTimerRunning = false;
  renderTomato({ running: false, restMode: !isFocusSession });
  renderStatus("일시 정지", "#888");
}

function beginSessionWithDuration(durationMs) {
  sessionEndAtMs = nowMs() + durationMs;
  startTickLoop();
}

function getStartDurationMs() {
  const duration = pausedRemainingMs > 0
    ? pausedRemainingMs
    : getCurrentSessionDurationMs();

  pausedRemainingMs = 0;
  return duration;
}

function startTimer() {
  renderRunningState();
  beginSessionWithDuration(getStartDurationMs());
}

function pauseTimer() {
  stopTickLoop();
  pausedRemainingMs = getRemainingMs();
  renderPausedState();
  syncRemainingSecondsFromDeadline();
}

/* -----------------------------
 * Guards / actions
 * ---------------------------*/
function ensureConfiguredOrNotify() {
  if (isConfigured) return true;
  showToast("😭먼저 반복 횟수를 입력하고 '적용' 버튼을 눌러주세요!");
  return false;
}

function toggleTimer() {
  playClickSound();
  if (!ensureConfiguredOrNotify()) return;

  if (isTimerRunning) pauseTimer();
  else startTimer();
}

/* -----------------------------
 * Session transitions
 * ---------------------------*/
function startRestSession() {
  isFocusSession = false;
  pausedRemainingMs = 0;
  showToast("집중 종료! 휴식 시작☕");
  startTimer();
}

function recordCompletedSet() {
  completedSetCount++;
  renderSetCounter();
  if (!isSetInfinite) remainingSets--;
}

function hasNextSet() {
  return isSetInfinite || remainingSets > 0;
}

function startNextFocusSession() {
  isFocusSession = true;
  pausedRemainingMs = 0;
  showToast(`${completedSetCount}세트 완료! 다시 집중🔥`);
  startTimer();
}

function finishAllSessions() {
  isTimerRunning = false;
  stopTickLoop();
  renderTomato({ running: false, restMode: false });
  renderStatus("🎉완료!", "var(--tomato-red)");
  showToast(`모든 세션이 끝났습니다! 총 ${completedSetCount}세트 완료!`);
  resetTimer(false, false);
}

function onSessionFinished() {
  playAlarmRepeat(4, 150); // 🔔 세션 종료 알람
  if (isFocusSession) {
    startRestSession();
    return;
  }

  recordCompletedSet();

  if (hasNextSet()) startNextFocusSession();
  else finishAllSessions();
}

/* -----------------------------
 * Settings parsing / validation
 * ---------------------------*/
function getRepeatInputText() {
  return (ui.repeatInput.value ?? "").trim();
}

function blockDecimalRepeatInput(raw) {
  if (!raw.includes('.')) return false;
  showToast("😭반복 횟수는 정수만 입력 가능합니다!");
  ui.repeatInput.value = Math.floor(parseFloat(raw));
  return true;
}

function parseRepeatAsNonNegativeInt(raw) {
  const val = parseInt(raw, 10);
  if (Number.isNaN(val) || val < 0) return null;
  return val;
}

function applyRepeatSettings(repeatVal) {
  isSetInfinite = (repeatVal === 0);
  remainingSets = repeatVal;
  configuredSetCount = repeatVal;
}

function applyPresetSettings() {
  const { focus, rest } = parsePresetMinutes(ui.presetSelect.value);
  focusMinutes = focus;
  restMinutes = rest;
}

function applySettings() {
  playClickSound();

  const raw = getRepeatInputText();
  if (blockDecimalRepeatInput(raw)) return;

  const repeatVal = parseRepeatAsNonNegativeInt(raw);
  if (repeatVal === null) {
    showToast("😭올바른 반복 횟수를 입력해주세요!");
    return;
  }

  applyPresetSettings();
  applyRepeatSettings(repeatVal);

  isConfigured = true;

  resetTimer(false, false);
  renderSetCounter();
  renderStatus("🔫준비 완료! 토마토를 클릭해주세요.", "var(--tomato-red)");
  showToast("설정이 적용되었습니다!");
}

/* -----------------------------
 * Reset
 * ---------------------------*/
function resetRuntimeState() {
  stopTickLoop();
  isTimerRunning = false;
  isFocusSession = true;
  pausedRemainingMs = 0;
  sessionEndAtMs = 0;
  remainingSeconds = focusMinutes * 60;
}

function resetRuntimeUI() {
  renderTomato({ running: false, restMode: false });
  renderTime(remainingSeconds);
}

function resetConfigurationState() {
  ui.repeatInput.value = "";
  completedSetCount = 0;
  configuredSetCount = 0;
  isSetInfinite = true;
  isConfigured = false;
  remainingSets = 0;
}

function resetConfigurationUI() {
  renderSetCounter();
  renderStatus("멋쟁이 토마토가 당신을 기다리고 있어요!", "var(--tomato-red)");
}

function resetTimer(showToastMsg = true, fullReset = true) {
  if (showToastMsg) playClickSound();
  stopAlarm(); // ✅ 알람 중지 추가
  resetRuntimeState();
  resetRuntimeUI();

  if (fullReset) {
    resetConfigurationState();
    resetConfigurationUI();
  }

  if (showToastMsg) showToast("✔️초기화 되었습니다!");
}

/* -----------------------------
 * Visibility correction
 * ---------------------------*/
function onVisibilityChange() {
  if (!isTimerRunning) return;

  const remainMs = syncRemainingSecondsFromDeadline();
  if (remainMs <= 0) {
    stopTickLoop();
    onSessionFinished();
  }
}

document.addEventListener("visibilitychange", onVisibilityChange);



/* -----------------------------
 * alarm Sound
 * ---------------------------*/

let alarmRepeatTimer = null;
let alarmEndedHandler = null;

function stopAlarm() {
  if (!alarmSound) return;

  // 반복 타이머 정리
  if (alarmRepeatTimer) {
    clearTimeout(alarmRepeatTimer);
    alarmRepeatTimer = null;
  }

  // ended 핸들러 정리
  if (alarmEndedHandler) {
    alarmSound.removeEventListener('ended', alarmEndedHandler);
    alarmEndedHandler = null;
  }

  alarmSound.pause();
  alarmSound.currentTime = 0;
}

function playAlarmRepeat(times = 4, gapMs = 150) {
  if (!alarmSound) return;

  // 혹시 이전 알람이 남아있으면 정리
  stopAlarm();

  let played = 0;

  const playOnce = () => {
    // iOS/Safari에서 연속 재생 안정성 위해 currentTime 리셋
    alarmSound.currentTime = 0;
    alarmSound.play().catch(()=>{});
  };

  alarmEndedHandler = () => {
    played += 1;

    if (played >= times) {
      stopAlarm();
      return;
    }

    // 알람 사이에 살짝 텀을 주면 끊김/먹통 방지에 도움됨
    alarmRepeatTimer = setTimeout(playOnce, gapMs);
  };

  alarmSound.addEventListener('ended', alarmEndedHandler);

  // 첫 회 재생 시작
  playOnce();
}


/* -----------------------------
 * Rain Sound Player (HTML에 존재할 때만 동작)
 * ---------------------------*/
function initRainPlayer() {
  const { rainAudio, rainToggle, muteToggle, volumeSlider } = ui;

  if (!rainAudio || !rainToggle || !muteToggle || !volumeSlider) return;

  function setSliderFillFromValue() {
    const min = Number(volumeSlider.min || 0);
    const max = Number(volumeSlider.max || 1);
    const val = Number(volumeSlider.value || 0);
    const p = ((val - min) / (max - min)) * 100;
    volumeSlider.style.setProperty('--p', `${p}%`);
  }

  // HTML에 빗소리 UI가 없으면 아무것도 하지 않음 (호환성 확보)
  if (!rainAudio || !rainToggle || !muteToggle || !volumeSlider) return;

  // 값 안전 변환 (input.value는 문자열)
  const toNumber = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  function setPlayingUI(isPlaying) {
    rainToggle.textContent = isPlaying ? "⏸" : "▶";
  }

  // ✅ (핵심) 오디오 상태 -> UI(슬라이더/아이콘) 동기화
  function syncUIFromAudio() {
    // volume(0~1)을 슬라이더에 반영
    volumeSlider.value = String(rainAudio.volume);

    // muted 또는 volume==0이면 🔇
    const isSilent = rainAudio.muted || rainAudio.volume === 0;
    muteToggle.textContent = isSilent ? "🔇" : "🔊";

    setSliderFillFromValue(); // ✅ 추가
  }

// ✅ (핵심) 초기 볼륨: 슬라이더 기본값(HTML value="0.5") -> 오디오에 적용
const initialVolume = toNumber(volumeSlider.value); // 0~1
rainAudio.volume = initialVolume;
rainAudio.muted = (initialVolume === 0);

// 그 다음 "오디오 상태 -> UI" 동기화
syncUIFromAudio();

  // ============================
  // ✅ 드롭다운 열림/유지 제어 (확성기 먼저 → 슬라이더 유지)
  // ============================
  const volumeControl = muteToggle.closest('.volume-control');
  const volumeDropdown = volumeControl?.querySelector('.volume-dropdown');
  if (volumeControl && volumeDropdown) {
    let closeTimer = null;

    const openDropdown = () => {
      if (closeTimer) clearTimeout(closeTimer);
      volumeControl.classList.add('open'); // ✅ CSS에서 .open일 때만 보이게
    };

    const scheduleClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        volumeControl.classList.remove('open');
      }, 120); // 이동 중 깜빡임 방지
    };

    // ✅ "확성기 버튼"을 먼저 호버해야 open
    muteToggle.addEventListener('mouseenter', openDropdown);

    // ✅ 열린 상태에서 슬라이더 영역으로 이동해도 유지
    volumeDropdown.addEventListener('mouseenter', openDropdown);

    // ✅ volume-control 영역을 벗어나면 닫기
    volumeControl.addEventListener('mouseleave', scheduleClose);
  }


  // 재생/정지
  rainToggle.addEventListener('click', () => {
     playClickSound(); // ✅ 효과음

    if (rainAudio.paused) {
      rainAudio.play().catch(() => showToast("브라우저에서 자동재생이 차단되었습니다."));
    } else {
      rainAudio.pause();
    }
  });

  // 뮤트 토글
  muteToggle.addEventListener('click', () => {
     playClickSound(); // ✅ 효과음

    rainAudio.muted = !rainAudio.muted;

    // 뮤트 해제했는데 볼륨이 0이면 사용성이 안 좋아서 기본값 복구(원치 않으면 삭제)
    if (!rainAudio.muted && rainAudio.volume === 0) {
      rainAudio.volume = 0.5;
    }

    syncUIFromAudio();
  });

  // 슬라이더 조절 -> 오디오 반영
volumeSlider.addEventListener('input', (e) => {
  const v = toNumber(e.target.value);
  rainAudio.volume = v;
  rainAudio.muted = (v === 0);

  syncUIFromAudio(); // 이 안에서 setSliderFillFromValue()까지 같이 처리됨
});


  // 오디오 이벤트로 UI 동기화 (가장 중요)
  rainAudio.addEventListener('play', () => { setPlayingUI(true); syncUIFromAudio(); });
  rainAudio.addEventListener('pause', () => setPlayingUI(false));

  // ✅ 어떤 이유로든(브라우저/OS/코드) 볼륨이나 뮤트가 바뀌면 UI가 따라오게
  rainAudio.addEventListener('volumechange', syncUIFromAudio);

  // 최초 버튼 상태
  setPlayingUI(!rainAudio.paused);
}


/* -----------------------------
 * Init
 * ---------------------------*/
renderTime(remainingSeconds);
renderSetCounter();
initRainPlayer();

// NOTE: HTML에서 버튼 onClick이 toggleTimer/applySettings/resetTimer 등을 호출하는 구조
