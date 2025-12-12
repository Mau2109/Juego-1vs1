// server.js — servidor 1v1 con BOT y eventos de hit
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const ARENA_W = 960, ARENA_H = 540;
const SPEED = 220;
const BULLET_COOLDOWN = 0.25;
const ROUND_TIME = 90;
const BOT_COUNT = 1;

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server);

let players = {};   // players map
let sockets = {};
let bots = {};      // bots map
let gameState = { running: false, roundTimeLeft: ROUND_TIME, lastTick: Date.now() };

function spawnBot(id, x, y) {
  bots[id] = {
    id,
    x, y,
    vx: (Math.random()*2-1) * 40,
    vy: (Math.random()*2-1) * 40,
    hp: 60,
    lastDirChange: Date.now()
  };
}

function ensureBots() {
  if (Object.keys(bots).length === 0) {
    for (let i=0;i<BOT_COUNT;i++) {
      const id = 'bot' + (i+1);
      spawnBot(id, ARENA_W*0.5 + (i*60-30), ARENA_H*0.3 + i*20);
    }
  }
}

function spawnPositions() {
  return [
    { x: ARENA_W * 0.20, y: ARENA_H * 0.5, angle: 0 },
    { x: ARENA_W * 0.80, y: ARENA_H * 0.5, angle: Math.PI }
  ];
}

function resetMatch() {
  gameState.running = false;
  gameState.roundTimeLeft = ROUND_TIME;
  const ids = Object.keys(players);
  if (ids.length === 2) {
    const sp = spawnPositions();
    ids.forEach((id, i) => {
      players[id] = {
        id,
        x: sp[i].x,
        y: sp[i].y,
        angle: sp[i].angle,
        vx: 0, vy: 0,
        hp: 100,
        score: players[id]?.score ?? 0,
        input: { up:false,down:false,left:false,right:false,shoot:false,mx:0,my:0 },
        lastSeq:0, lastShotAt:0
      };
    });
    gameState.running = true;
    // Notificar a ambos jugadores que el juego ha comenzado
    io.emit('gameStarted');
  }
}


io.on('connection', (socket) => {
  const id = socket.id;
  console.log('[SERVER] CLIENT CONNECTED', id);
  sockets[id] = socket;

  // Añadir el jugador al mapa
  players[id] = {
    id, x: Math.random() * ARENA_W, y: Math.random() * ARENA_H, angle: 0,
    vx: 0, vy: 0, hp: 100, score: 0,
    input: { up: false, down: false, left: false, right: false, shoot: false, mx: 0, my: 0 },
    lastSeq: 0, lastShotAt: 0
  };

  ensureBots();
  // Iniciar el juego si ya hay 2 jugadores conectados
  if (Object.keys(players).length === 2) {
    resetMatch();
  }

  // Manejar el evento de inputs
  socket.on('input', (data) => {
    const p = players[id];
    if (!p) return;
    if (data && data.inputs) {
      p.input = data.inputs;
      p.lastSeq = data.seq ?? p.lastSeq;
      if (typeof data.angle === 'number') p.angle = data.angle;
    }
  });

  socket.on('ping', () => socket.emit('pong'));

  socket.on('disconnect', () => {
    console.log('[SERVER] CLIENT DISCONNECTED', id);
    delete sockets[id];
    delete players[id];
    gameState.running = false;
  });
});



function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }

function lineHit(ax,ay,bx,by,tx,ty,radius=20){
  const abx = bx-ax, aby = by-ay;
  const apx = tx-ax, apy = ty-ay;
  const ab2 = abx*abx + aby*aby;
  const t = ab2 ? clamp((apx*abx + apy*aby)/ab2, 0, 1) : 0;
  const cx = ax + abx*t, cy = ay + aby*t;
  const dx = tx - cx, dy = ty - cy;
  return (dx*dx + dy*dy) <= (radius*radius);
}

function tick() {
  const now = Date.now();
  const dt = DT;
  ensureBots();

  // update bots simple AI (random wander)
  for (const bid of Object.keys(bots)) {
    const b = bots[bid];
    // change direction occasionally
    if (now - b.lastDirChange > 1000 + Math.random()*1500) {
      b.vx = (Math.random()*2-1)*80;
      b.vy = (Math.random()*2-1)*80;
      b.lastDirChange = now;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    // bounds
    if (b.x < 20 || b.x > ARENA_W - 20) b.vx *= -1;
    if (b.y < 20 || b.y > ARENA_H - 20) b.vy *= -1;
  }

  // time
  if (Object.keys(players).length === 2) {
    if (gameState.running) {
      gameState.roundTimeLeft -= dt;
      if (gameState.roundTimeLeft <= 0) resetMatch();
    }
  }

  const events = [];
  const ids = Object.keys(players);

  // process inputs and shooting
  for (const id of ids) {
    const p = players[id];
    if (!p) continue;
    // movement
    let dx = 0, dy = 0;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    const len = Math.hypot(dx,dy) || 1;
    dx /= len; dy /= len;
    p.x += dx * SPEED * dt;
    p.y += dy * SPEED * dt;
    p.x = clamp(p.x, 20, ARENA_W-20);
    p.y = clamp(p.y, 20, ARENA_H-20);

    // shoot (server authoritative)
    if (p.input.shoot && gameState.running) {
      const since = (now - p.lastShotAt)/1000;
      if (since >= BULLET_COOLDOWN) {
        p.lastShotAt = now;
        const L = 420;
        const ax = p.x, ay = p.y;
        const bx = p.x + Math.cos(p.angle) * L;
        const by = p.y + Math.sin(p.angle) * L;
        // check players
        for (const oid of ids) {
          if (oid === id) continue;
          const o = players[oid];
          if (!o || o.hp <= 0) continue;
          if (lineHit(ax,ay,bx,by,o.x,o.y,22)) {
            o.hp = Math.max(0,o.hp - 20);
            events.push({ type:'hit', target: oid, source: id, damage:20, tx:o.x, ty:o.y, bot:false });
            if (o.hp === 0) {
              p.score = (p.score||0) + 1;
              resetMatch();
            }
          }
        }
        // check bots
        for (const bid of Object.keys(bots)) {
          const b = bots[bid];
          if (b.hp > 0 && lineHit(ax,ay,bx,by,b.x,b.y,20)) {
            b.hp = Math.max(0, b.hp - 20);
            events.push({ type:'hit', target: bid, source: id, damage:20, tx:b.x, ty:b.y, bot:true });
            if (b.hp === 0) {
              p.score = (p.score||0) + 1;
              // respawn bot after short delay
              setTimeout(() => {
                spawnBot(bid, Math.random()*(ARENA_W-80)+40, Math.random()*(ARENA_H-80)+40);
              }, 1200);
            }
          }
        }
      }
    }
  }

  // build snapshot
  const snapshot = {
    type:'snapshot',
    tick: now,
    running: gameState.running,
    roundTimeLeft: Math.max(0, Math.round(gameState.roundTimeLeft)),
    players: ids.map(pid => {
      const s = players[pid];
      return { id:s.id, x:s.x, y:s.y, angle:s.angle, hp:s.hp, score:s.score, lastSeq:s.lastSeq };
    }),
    bots: Object.keys(bots).map(bid => {
      const b = bots[bid];
      return { id: b.id, x: b.x, y: b.y, hp: b.hp };
    }),
    events,
    arena:{ w:ARENA_W, h:ARENA_H }
  };

  // emit snapshot
  for (const sid of Object.keys(sockets)) {
    sockets[sid].emit('snapshot', snapshot);
  }
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor 1v1 en http://localhost:${PORT}`));