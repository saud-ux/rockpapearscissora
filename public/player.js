const socket = io();

const screens = {
  join: document.getElementById('screen-join'),
  waiting: document.getElementById('screen-waiting'),
  play: document.getElementById('screen-play'),
  result: document.getElementById('screen-result'),
  eliminated: document.getElementById('screen-eliminated'),
  won: document.getElementById('screen-won'),
  closed: document.getElementById('screen-closed')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

const choiceEmoji = { rock: '✊ حجر', paper: '✋ ورقة', scissors: '✌️ مقص' };

let currentChoice = null;
let isEliminated = false;

const params = new URLSearchParams(window.location.search);
if (params.get('room')) {
  document.getElementById('room-code-input').value = params.get('room');
}

document.getElementById('btn-join').addEventListener('click', () => {
  const roomCode = document.getElementById('room-code-input').value.trim();
  const playerName = document.getElementById('player-name-input').value.trim();

  if (!roomCode || roomCode.length !== 4) {
    showError('ادخل كود الغرفة (4 أرقام)');
    return;
  }
  if (!playerName) {
    showError('ادخل اسمك');
    return;
  }

  socket.emit('join-room', { roomCode, playerName });
});

document.getElementById('player-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

socket.on('joined-room', (data) => {
  showScreen('waiting');
  document.getElementById('room-code-waiting').textContent = data.roomCode;
  document.getElementById('player-count-waiting').textContent = data.playerCount;
});

socket.on('join-error', (data) => {
  showError(data.message);
});

socket.on('player-joined', (data) => {
  document.getElementById('player-count-waiting').textContent = data.playerCount;
});

socket.on('player-left', (data) => {
  document.getElementById('player-count-waiting').textContent = data.playerCount;
});

document.getElementById('btn-leave').addEventListener('click', () => {
  socket.emit('leave-room');
  showScreen('join');
  isEliminated = false;
});

socket.on('round-started', (data) => {
  if (isEliminated) return;
  currentChoice = null;
  showScreen('play');
  document.getElementById('round-number-player').textContent = data.roundNumber;
  document.getElementById('current-choice-display').textContent = '';
  document.querySelectorAll('.choice-btn').forEach(btn => btn.classList.remove('selected'));
  document.getElementById('timer-player').textContent = '--';
  document.getElementById('timer-player').classList.remove('urgent');
});

socket.on('timer-tick', (data) => {
  const el = document.getElementById('timer-player');
  if (el) {
    el.textContent = `⏱ ${data.remaining}`;
    if (data.remaining <= 3) {
      el.classList.add('urgent');
    } else {
      el.classList.remove('urgent');
    }
  }
});

document.querySelectorAll('.choice-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const choice = btn.dataset.choice;
    currentChoice = choice;
    socket.emit('submit-choice', { choice });

    document.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

socket.on('choice-confirmed', (data) => {
  document.getElementById('current-choice-display').textContent =
    `اختيارك: ${choiceEmoji[data.choice]} (تقدر تغير)`;
});

socket.on('your-result', (data) => {
  if (data.outcome === 'eliminated') {
    return;
  }

  showScreen('result');

  document.getElementById('pc-choice-player').textContent = choiceEmoji[data.computerChoice];
  document.getElementById('my-choice-player').textContent = data.yourChoice ? choiceEmoji[data.yourChoice] : '❓';

  const emojiEl = document.getElementById('result-emoji-player');
  const textEl = document.getElementById('result-text-player');

  if (data.outcome === 'win') {
    emojiEl.textContent = '✅';
    textEl.textContent = 'فزت!';
    textEl.className = 'result-text win';
  } else if (data.outcome === 'draw') {
    emojiEl.textContent = '🔄';
    textEl.textContent = 'تعادل!';
    textEl.className = 'result-text draw';
  } else {
    emojiEl.textContent = '❌';
    textEl.textContent = 'خسرت!';
    textEl.className = 'result-text lose';
  }
});

socket.on('round-result-summary', (data) => {
  if (isEliminated) return;
  document.getElementById('alive-count-player').textContent =
    `${data.aliveCount}/${data.totalPlayers}`;
});

socket.on('you-eliminated', (data) => {
  isEliminated = true;
  showScreen('eliminated');
  document.getElementById('rounds-survived').textContent = data.roundsSurvived;
});

socket.on('you-won', (data) => {
  showScreen('won');
  document.getElementById('rounds-won').textContent = data.roundsSurvived;
});

socket.on('game-reset', () => {
  isEliminated = false;
  currentChoice = null;
  showScreen('waiting');
});

socket.on('room-closed', () => {
  showScreen('closed');
});

function showError(msg) {
  const el = document.getElementById('join-error');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3000);
}
