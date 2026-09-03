const socket = io();

const screens = {
  lobby: document.getElementById('screen-lobby'),
  playing: document.getElementById('screen-playing'),
  results: document.getElementById('screen-results'),
  gameover: document.getElementById('screen-gameover')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

const choiceEmoji = { rock: '✊ حجر', paper: '✋ ورقة', scissors: '✌️ مقص' };
const choiceEmojiShort = { rock: '✊', paper: '✋', scissors: '✌️' };

let roomCode = '';
let players = [];

socket.emit('create-room');

socket.on('room-created', (data) => {
  roomCode = data.roomCode;
  document.getElementById('room-code').textContent = roomCode;
});

document.getElementById('btn-copy-link').addEventListener('click', () => {
  const url = `${window.location.origin}/play?room=${roomCode}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-copy-link');
    btn.textContent = 'تم النسخ!';
    setTimeout(() => { btn.textContent = 'نسخ الرابط'; }, 2000);
  });
});

document.getElementById('btn-twitch-connect').addEventListener('click', () => {
  const channel = document.getElementById('twitch-channel').value.trim();
  if (!channel) return;
  socket.emit('connect-twitch', { channel });
  document.getElementById('btn-twitch-connect').disabled = true;
  document.getElementById('twitch-status').innerHTML = 'جاري الاتصال...';
});

socket.on('twitch-connected', (data) => {
  document.getElementById('twitch-status').innerHTML =
    `<span class="status-dot connected"></span> متصل بـ ${data.channel}`;
  document.getElementById('btn-twitch-connect').textContent = 'قطع الاتصال';
  document.getElementById('btn-twitch-connect').className = 'btn btn-danger';
  document.getElementById('btn-twitch-connect').disabled = false;
  document.getElementById('btn-twitch-connect').onclick = () => {
    socket.emit('disconnect-twitch');
  };
});

socket.on('twitch-disconnected', () => {
  document.getElementById('twitch-status').innerHTML = 'غير متصل';
  const btn = document.getElementById('btn-twitch-connect');
  btn.textContent = 'اتصال';
  btn.className = 'btn btn-twitch';
  btn.disabled = false;
  btn.onclick = () => {
    const channel = document.getElementById('twitch-channel').value.trim();
    if (!channel) return;
    socket.emit('connect-twitch', { channel });
  };
});

socket.on('twitch-error', (data) => {
  document.getElementById('twitch-status').innerHTML =
    `<span style="color:var(--red);">خطأ: ${data.error}</span>`;
  document.getElementById('btn-twitch-connect').disabled = false;
});

socket.on('player-joined', (data) => {
  updateStartButton();
});

socket.on('player-left', (data) => {
  updateStartButton();
});

socket.on('player-list', (data) => {
  players = data.players;
  renderPlayerListLobby();
  renderPlayerListPlaying();
  document.getElementById('player-count-lobby').textContent = data.playerCount;
  updateStartButton();
});

function renderPlayerListLobby() {
  const container = document.getElementById('player-list-lobby');
  container.innerHTML = players.map(p => {
    const icon = p.type === 'twitch' ? '🟣' : '🌐';
    const cls = p.type === 'twitch' ? 'twitch' : 'browser';
    return `<span class="player-tag ${cls}"><span class="player-icon">${icon}</span> ${escapeHtml(p.name)}</span>`;
  }).join('');
}

function renderPlayerListPlaying() {
  const container = document.getElementById('player-list-playing');
  if (!container) return;
  container.innerHTML = players.filter(p => p.alive).map(p => {
    const icon = p.type === 'twitch' ? '🟣' : '🌐';
    return `<span class="player-tag"><span class="player-icon">${icon}</span> ${escapeHtml(p.name)}</span>`;
  }).join('');
}

function updateStartButton() {
  const count = players.length;
  const btn = document.getElementById('btn-start');
  const hint = document.getElementById('start-hint');
  if (count >= 2) {
    btn.disabled = false;
    hint.style.display = 'none';
  } else {
    btn.disabled = true;
    hint.style.display = 'block';
  }
}

document.getElementById('round-duration').addEventListener('change', (e) => {
  socket.emit('set-duration', { duration: parseInt(e.target.value) });
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start-round');
});

socket.on('round-started', (data) => {
  showScreen('playing');
  document.getElementById('round-number-play').textContent = data.roundNumber;
  document.getElementById('alive-count-play').textContent = data.alivePlayers.length;
  document.getElementById('voted-count').textContent = '0';
  document.getElementById('total-count').textContent = data.alivePlayers.length;
  document.getElementById('timer-play').textContent = '--';
  document.getElementById('timer-play').classList.remove('urgent');
});

socket.on('timer-tick', (data) => {
  const el = document.getElementById('timer-play');
  if (el) {
    el.textContent = `⏱ ${data.remaining}`;
    if (data.remaining <= 3) {
      el.classList.add('urgent');
    } else {
      el.classList.remove('urgent');
    }
  }
});

socket.on('vote-count-updated', (data) => {
  document.getElementById('voted-count').textContent = data.voted;
  document.getElementById('total-count').textContent = data.total;
});

socket.on('round-result', (data) => {
  showScreen('results');
  document.getElementById('round-number-result').textContent = data.roundNumber;
  document.getElementById('computer-choice-display').textContent = choiceEmoji[data.computerChoice];
  document.getElementById('alive-after-round').textContent = data.aliveCount;

  const container = document.getElementById('results-container');
  let html = '';

  const winners = data.results.filter(r => r.outcome === 'win');
  const draws = data.results.filter(r => r.outcome === 'draw');
  const losers = data.results.filter(r => r.outcome === 'lose');

  if (winners.length > 0) {
    const choice = choiceEmoji[winners[0].choice];
    html += `<div class="result-group winners">
      <div class="result-group-header">${choice} (${winners.length} لاعبين) — فازوا ✅</div>
      <div class="result-names">${winners.map(w => escapeHtml(w.name)).join('، ')}</div>
    </div>`;
  }

  if (draws.length > 0) {
    const choice = choiceEmoji[draws[0].choice];
    html += `<div class="result-group draw">
      <div class="result-group-header">${choice} (${draws.length} لاعبين) — تعادل 🔄</div>
      <div class="result-names">${draws.map(d => escapeHtml(d.name)).join('، ')}</div>
    </div>`;
  }

  if (losers.length > 0) {
    const choice = choiceEmoji[losers[0].choice];
    html += `<div class="result-group losers">
      <div class="result-group-header">${choice} (${losers.length} لاعبين) — خسروا ❌</div>
      <div class="result-names">${losers.map(l => escapeHtml(l.name)).join('، ')}</div>
    </div>`;
  }

  if (data.noVote && data.noVote.length > 0) {
    html += `<div class="result-group no-vote">
      <div class="result-group-header">⚠️ لم يصوّت (${data.noVote.length}) — مُستبعد</div>
      <div class="result-names">${data.noVote.map(n => escapeHtml(n.name)).join('، ')}</div>
    </div>`;
  }

  container.innerHTML = html;
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  socket.emit('next-round');
});

document.getElementById('btn-reset-from-results').addEventListener('click', () => {
  socket.emit('reset-game');
});

socket.on('game-over', (data) => {
  showScreen('gameover');
  if (data.winner) {
    document.getElementById('winner-name').textContent = data.winner.name;
    document.getElementById('winner-rounds').textContent = `نجا ${data.roundsSurvived} جولات!`;
  } else {
    document.getElementById('winner-name').textContent = 'تعادل!';
    document.getElementById('winner-rounds').textContent = 'الكل خسر بنفس الجولة';
  }
  launchConfetti();
});

document.getElementById('btn-new-game').addEventListener('click', () => {
  socket.emit('reset-game');
});

socket.on('game-reset', () => {
  showScreen('lobby');
});

socket.on('error-msg', (data) => {
  alert(data.message);
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function launchConfetti() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = ['#f39c12', '#4ecca3', '#e74c3c', '#3498db', '#9146ff', '#fff'];

  for (let i = 0; i < 120; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 10 + 5,
      h: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * 3 + 2,
      rot: Math.random() * 360,
      rv: (Math.random() - 0.5) * 10
    });
  }

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.rv;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    frame++;
    if (frame < 180) {
      requestAnimationFrame(animate);
    } else {
      canvas.remove();
    }
  }
  animate();
}
