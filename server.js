const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function getRoom(code) {
  return rooms.get(code);
}

function createRoom(hostSocketId) {
  const code = generateRoomCode();
  const room = {
    code,
    hostSocketId,
    state: 'lobby',
    players: new Map(),
    roundNumber: 0,
    roundDuration: 15,
    roundTimer: null,
    twitchClient: null,
    twitchChannel: null,
    overlays: new Set()
  };
  rooms.set(code, room);
  return room;
}

function getAlivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive);
}

function getAlivePlayerCount(room) {
  return getAlivePlayers(room).length;
}

function broadcastPlayerList(room) {
  const playerList = [...room.players.values()].map(p => ({
    name: p.name,
    type: p.type,
    alive: p.alive
  }));
  const data = { players: playerList, playerCount: room.players.size };
  io.to(room.hostSocketId).emit('player-list', data);
  room.overlays.forEach(sid => io.to(sid).emit('player-list', data));
}

function determineOutcome(choice1, choice2) {
  if (choice1 === choice2) return 'draw';
  if (
    (choice1 === 'rock' && choice2 === 'scissors') ||
    (choice1 === 'scissors' && choice2 === 'paper') ||
    (choice1 === 'paper' && choice2 === 'rock')
  ) return 'win';
  return 'lose';
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startRound(room) {
  room.state = 'playing';
  room.roundNumber++;

  const alive = getAlivePlayers(room);
  alive.forEach(p => { p.choice = null; });

  const mode = 'pvp';
  room.currentMode = mode;

  const roundData = {
    roundNumber: room.roundNumber,
    duration: room.roundDuration,
    alivePlayers: alive.map(p => ({ name: p.name, type: p.type })),
    mode
  };

  io.to(room.hostSocketId).emit('round-started', roundData);
  room.overlays.forEach(sid => io.to(sid).emit('round-started', roundData));

  alive.forEach(p => {
    if (p.socketId) {
      io.to(p.socketId).emit('round-started', roundData);
    }
  });

  let remaining = room.roundDuration;

  const tick = () => {
    if (remaining < 0 || room.state !== 'playing') return;

    const tickData = { remaining };
    io.to(room.hostSocketId).emit('timer-tick', tickData);
    room.overlays.forEach(sid => io.to(sid).emit('timer-tick', tickData));
    alive.forEach(p => {
      if (p.socketId) io.to(p.socketId).emit('timer-tick', tickData);
    });

    if (remaining === 0) {
      endRound(room);
      return;
    }
    remaining--;
    room.roundTimer = setTimeout(tick, 1000);
  };

  tick();

  updateVoteCount(room);
}

function updateVoteCount(room) {
  const alive = getAlivePlayers(room);
  const voted = alive.filter(p => p.choice !== null).length;
  const total = alive.length;
  const data = { voted, total };

  io.to(room.hostSocketId).emit('vote-count-updated', data);
  room.overlays.forEach(sid => io.to(sid).emit('vote-count-updated', data));

  if (voted === total && room.state === 'playing') {
    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }
    endRound(room);
  }
}

function endRound(room) {
  if (room.state !== 'playing') return;
  room.state = 'results';

  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }

  const alive = getAlivePlayers(room);
  const noVote = [];
  const eliminated = [];

  alive.forEach(p => {
    if (!p.choice) {
      p.alive = false;
      noVote.push({ name: p.name, type: p.type });
      eliminated.push({ name: p.name, type: p.type, reason: 'no-vote' });
      if (p.socketId) {
        io.to(p.socketId).emit('your-result', {
          mode: room.currentMode,
          yourChoice: null,
          outcome: 'eliminated'
        });
        io.to(p.socketId).emit('you-eliminated', {
          roundsSurvived: room.roundNumber
        });
      }
    }
  });

  endRoundPvP(room, alive, noVote, eliminated);
}

function endRoundPvP(room, alive, noVote, eliminated) {
  const voters = alive.filter(p => p.choice);
  shuffleArray(voters);

  const pairs = [];
  const survivors = [];
  let soloPlayer = null;

  for (let i = 0; i < voters.length; i += 2) {
    if (i + 1 < voters.length) {
      const p1 = voters[i];
      const p2 = voters[i + 1];
      const outcome = determineOutcome(p1.choice, p2.choice);

      let pairResult;
      if (outcome === 'win') {
        pairResult = 'player1';
        p2.alive = false;
        eliminated.push({ name: p2.name, type: p2.type, choice: p2.choice });
        survivors.push({ name: p1.name, type: p1.type, choice: p1.choice, outcome: 'win' });
      } else if (outcome === 'lose') {
        pairResult = 'player2';
        p1.alive = false;
        eliminated.push({ name: p1.name, type: p1.type, choice: p1.choice });
        survivors.push({ name: p2.name, type: p2.type, choice: p2.choice, outcome: 'win' });
      } else {
        pairResult = 'draw';
        survivors.push({ name: p1.name, type: p1.type, choice: p1.choice, outcome: 'draw' });
        survivors.push({ name: p2.name, type: p2.type, choice: p2.choice, outcome: 'draw' });
      }

      pairs.push({
        player1: { name: p1.name, type: p1.type, choice: p1.choice },
        player2: { name: p2.name, type: p2.type, choice: p2.choice },
        outcome: pairResult
      });

      const p1Outcome = pairResult === 'player1' ? 'win' : pairResult === 'player2' ? 'lose' : 'draw';
      const p2Outcome = pairResult === 'player2' ? 'win' : pairResult === 'player1' ? 'lose' : 'draw';

      if (p1.socketId) {
        io.to(p1.socketId).emit('your-result', {
          mode: 'pvp',
          yourChoice: p1.choice,
          opponentName: p2.name,
          opponentChoice: p2.choice,
          outcome: p1Outcome
        });
        if (p1Outcome === 'lose') {
          io.to(p1.socketId).emit('you-eliminated', { roundsSurvived: room.roundNumber });
        }
      }
      if (p2.socketId) {
        io.to(p2.socketId).emit('your-result', {
          mode: 'pvp',
          yourChoice: p2.choice,
          opponentName: p1.name,
          opponentChoice: p1.choice,
          outcome: p2Outcome
        });
        if (p2Outcome === 'lose') {
          io.to(p2.socketId).emit('you-eliminated', { roundsSurvived: room.roundNumber });
        }
      }
    } else {
      const p = voters[i];
      const choices = ['rock', 'paper', 'scissors'];
      const computerChoice = choices[Math.floor(Math.random() * 3)];
      const outcome = determineOutcome(p.choice, computerChoice);

      soloPlayer = {
        name: p.name, type: p.type, choice: p.choice,
        computerChoice, outcome
      };

      if (outcome === 'lose') {
        p.alive = false;
        eliminated.push({ name: p.name, type: p.type, choice: p.choice });
      } else {
        survivors.push({ name: p.name, type: p.type, choice: p.choice, outcome });
      }

      if (p.socketId) {
        io.to(p.socketId).emit('your-result', {
          mode: 'vs-computer',
          yourChoice: p.choice,
          computerChoice,
          outcome
        });
        if (outcome === 'lose') {
          io.to(p.socketId).emit('you-eliminated', { roundsSurvived: room.roundNumber });
        }
      }
    }
  }

  const allVoterResults = voters.map(v => ({ name: v.name, type: v.type, choice: v.choice }));
  const choiceStats = {
    rock: allVoterResults.filter(r => r.choice === 'rock').length,
    paper: allVoterResults.filter(r => r.choice === 'paper').length,
    scissors: allVoterResults.filter(r => r.choice === 'scissors').length
  };

  const roundResult = {
    mode: 'pvp',
    roundNumber: room.roundNumber,
    pairs,
    soloPlayer,
    eliminated,
    survivors,
    noVote,
    choiceStats,
    aliveCount: getAlivePlayerCount(room)
  };

  io.to(room.hostSocketId).emit('round-result', roundResult);
  room.overlays.forEach(sid => io.to(sid).emit('round-result', roundResult));
  getAlivePlayers(room).forEach(p => {
    if (p.socketId) {
      io.to(p.socketId).emit('round-result-summary', {
        mode: 'pvp',
        aliveCount: getAlivePlayerCount(room),
        totalPlayers: room.players.size,
        roundNumber: room.roundNumber
      });
    }
  });

  checkGameEnd(room);
}

function checkGameEnd(room) {
  const aliveCount = getAlivePlayerCount(room);

  if (aliveCount <= 1) {
    room.state = 'finished';
    const alive = getAlivePlayers(room);

    let gameOverData;
    if (aliveCount === 1) {
      const winner = alive[0];
      gameOverData = {
        winner: { name: winner.name, type: winner.type },
        roundsSurvived: room.roundNumber,
        totalPlayers: room.players.size
      };
      if (winner.socketId) {
        io.to(winner.socketId).emit('you-won', {
          roundsSurvived: room.roundNumber
        });
      }
    } else {
      gameOverData = {
        winner: null,
        tie: true,
        roundsSurvived: room.roundNumber,
        totalPlayers: room.players.size
      };
    }

    io.to(room.hostSocketId).emit('game-over', gameOverData);
    room.overlays.forEach(sid => io.to(sid).emit('game-over', gameOverData));
  }
}

function parseTwitchChoice(msg) {
  const lower = msg.trim().toLowerCase();
  if (lower === 'حجر' || lower === '1') return 'rock';
  if (lower === 'ورقة' || lower === '2') return 'paper';
  if (lower === 'مقص' || lower === '3') return 'scissors';
  return null;
}

function connectTwitch(room, channel) {
  if (room.twitchClient) {
    room.twitchClient.disconnect();
    room.twitchClient = null;
  }

  const client = new tmi.Client({
    channels: [channel]
  });

  client.connect().then(() => {
    room.twitchChannel = channel;
    room.twitchClient = client;
    io.to(room.hostSocketId).emit('twitch-connected', { channel });
    room.overlays.forEach(sid => io.to(sid).emit('twitch-connected', { channel }));
  }).catch(err => {
    io.to(room.hostSocketId).emit('twitch-error', { error: err.message });
  });

  client.on('message', (ch, tags, message) => {
    const username = tags['display-name'] || tags.username;
    const msg = message.trim();

    if (msg === '!join' || msg === '!انضم') {
      if (room.state !== 'lobby') return;
      const playerId = `twitch:${username}`;
      if (room.players.has(playerId)) return;

      room.players.set(playerId, {
        id: playerId,
        name: username,
        type: 'twitch',
        alive: true,
        choice: null,
        socketId: null
      });

      const joinData = {
        name: username,
        type: 'twitch',
        playerCount: room.players.size
      };
      io.to(room.hostSocketId).emit('player-joined', joinData);
      room.overlays.forEach(sid => io.to(sid).emit('player-joined', joinData));
      broadcastPlayerList(room);
      return;
    }

    if (msg === '!leave' || msg === '!انسحب') {
      const playerId = `twitch:${username}`;
      if (!room.players.has(playerId)) return;
      room.players.delete(playerId);
      const leaveData = { name: username, playerCount: room.players.size };
      io.to(room.hostSocketId).emit('player-left', leaveData);
      room.overlays.forEach(sid => io.to(sid).emit('player-left', leaveData));
      broadcastPlayerList(room);
      return;
    }

    if (room.state === 'playing') {
      const playerId = `twitch:${username}`;
      const player = room.players.get(playerId);
      if (!player || !player.alive) return;

      const choice = parseTwitchChoice(msg);
      if (choice) {
        player.choice = choice;
        updateVoteCount(room);
      }
    }
  });
}

function disconnectTwitch(room) {
  if (room.twitchClient) {
    room.twitchClient.disconnect();
    room.twitchClient = null;
    room.twitchChannel = null;
    io.to(room.hostSocketId).emit('twitch-disconnected');
  }
}

io.on('connection', (socket) => {

  socket.on('create-room', () => {
    const room = createRoom(socket.id);
    socket.join(room.code);
    socket.emit('room-created', { roomCode: room.code });
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = getRoom(roomCode);
    if (!room) {
      socket.emit('join-error', { message: 'الغرفة غير موجودة' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('join-error', { message: 'اللعبة بدأت بالفعل' });
      return;
    }

    const playerId = `browser:${socket.id}`;
    if ([...room.players.values()].some(p => p.name === playerName)) {
      socket.emit('join-error', { message: 'الاسم مستخدم، اختر اسم ثاني' });
      return;
    }

    room.players.set(playerId, {
      id: playerId,
      name: playerName,
      type: 'browser',
      alive: true,
      choice: null,
      socketId: socket.id
    });

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.playerId = playerId;

    socket.emit('joined-room', {
      roomCode,
      playerName,
      playerCount: room.players.size
    });

    const joinData = {
      name: playerName,
      type: 'browser',
      playerCount: room.players.size
    };
    io.to(room.hostSocketId).emit('player-joined', joinData);
    room.overlays.forEach(sid => io.to(sid).emit('player-joined', joinData));
    broadcastPlayerList(room);
  });

  socket.on('submit-choice', ({ choice }) => {
    const room = getRoom(socket.roomCode);
    if (!room || room.state !== 'playing') return;

    const player = room.players.get(socket.playerId);
    if (!player || !player.alive) return;

    if (['rock', 'paper', 'scissors'].includes(choice)) {
      player.choice = choice;
      socket.emit('choice-confirmed', { choice });
      updateVoteCount(room);
    }
  });

  socket.on('leave-room', () => {
    const room = getRoom(socket.roomCode);
    if (!room) return;

    const player = room.players.get(socket.playerId);
    if (!player) return;

    room.players.delete(socket.playerId);
    const leaveData = { name: player.name, playerCount: room.players.size };
    io.to(room.hostSocketId).emit('player-left', leaveData);
    room.overlays.forEach(sid => io.to(sid).emit('player-left', leaveData));
    broadcastPlayerList(room);
    socket.leave(socket.roomCode);
  });

  socket.on('start-round', () => {
    const room = [...rooms.values()].find(r => r.hostSocketId === socket.id);
    if (!room) return;

    if (room.state === 'lobby' || room.state === 'results' || room.state === 'finished') {
      if (room.state === 'finished') {
        room.roundNumber = 0;
        room.players.forEach(p => { p.alive = true; p.choice = null; });
        room.state = 'lobby';
      }
      if (getAlivePlayerCount(room) < 2) {
        socket.emit('error-msg', { message: 'يحتاج 2 لاعبين على الأقل' });
        return;
      }
      startRound(room);
    }
  });

  socket.on('next-round', () => {
    const room = [...rooms.values()].find(r => r.hostSocketId === socket.id);
    if (!room || room.state !== 'results') return;
    startRound(room);
  });

  socket.on('reset-game', () => {
    const room = [...rooms.values()].find(r => r.hostSocketId === socket.id);
    if (!room) return;

    if (room.roundTimer) {
      clearTimeout(room.roundTimer);
      room.roundTimer = null;
    }

    room.state = 'lobby';
    room.roundNumber = 0;
    room.players.forEach(p => { p.alive = true; p.choice = null; });

    const resetData = { playerCount: room.players.size };
    io.to(room.hostSocketId).emit('game-reset', resetData);
    room.overlays.forEach(sid => io.to(sid).emit('game-reset', resetData));
    room.players.forEach(p => {
      if (p.socketId) io.to(p.socketId).emit('game-reset', resetData);
    });
    broadcastPlayerList(room);
  });

  socket.on('set-duration', ({ duration }) => {
    const room = [...rooms.values()].find(r => r.hostSocketId === socket.id);
    if (!room) return;
    if ([10, 15, 20].includes(duration)) {
      room.roundDuration = duration;
    }
  });

  socket.on('connect-twitch', ({ channel }) => {
    const room = [...rooms.values()].find(r => r.hostSocketId === socket.id);
    if (!room) return;
    connectTwitch(room, channel.replace('#', '').trim());
  });

  socket.on('disconnect-twitch', () => {
    const room = [...rooms.values()].find(r => r.hostSocketId === socket.id);
    if (!room) return;
    disconnectTwitch(room);
  });

  socket.on('join-overlay', ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) {
      const firstRoom = [...rooms.values()][0];
      if (firstRoom) {
        firstRoom.overlays.add(socket.id);
        socket.roomCode = firstRoom.code;
        socket.emit('overlay-joined', { roomCode: firstRoom.code });
        broadcastPlayerList(firstRoom);
      } else {
        socket.emit('overlay-error', { message: 'لا توجد غرف نشطة' });
      }
      return;
    }
    room.overlays.add(socket.id);
    socket.roomCode = roomCode;
    socket.emit('overlay-joined', { roomCode });
    broadcastPlayerList(room);
  });

  socket.on('disconnect', () => {
    for (const [code, room] of rooms) {
      if (room.hostSocketId === socket.id) {
        if (room.roundTimer) clearTimeout(room.roundTimer);
        disconnectTwitch(room);
        room.players.forEach(p => {
          if (p.socketId) {
            io.to(p.socketId).emit('room-closed');
          }
        });
        room.overlays.forEach(sid => io.to(sid).emit('room-closed'));
        rooms.delete(code);
        return;
      }

      room.overlays.delete(socket.id);

      if (socket.playerId && room.players.has(socket.playerId)) {
        const player = room.players.get(socket.playerId);
        room.players.delete(socket.playerId);
        const leaveData = { name: player.name, playerCount: room.players.size };
        io.to(room.hostSocketId).emit('player-left', leaveData);
        room.overlays.forEach(sid => io.to(sid).emit('player-left', leaveData));
        broadcastPlayerList(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
