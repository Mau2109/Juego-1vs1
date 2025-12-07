// public/game.js — cliente con efectos y bot render
const socket = io();
let myId = null;
let lastSeq = 0;
let lastPingSend = 0;
let pingMs = '—';
const interpBuffer = [];
// velocidad usada por la predicción local (debe concordar con el servidor)
const SPEED = 220;
const config = {
  type: Phaser.AUTO,
  width: 960,
  height: 540,
  backgroundColor: '#111319',
  physics: { default: 'arcade' },
  scene: { preload, create, update }
};

let cursors, mousePointer;
let me = { id:null, x:480, y:270, angle:0, hp:100, score:0 };
let gfxMe, gfxOther, botsGfx = {}, textCenter;
let running=false, roundTimeLeft=0, arena={w:960,h:540};
const game = new Phaser.Game(config);
function preload() {}
function create() {
  const s = this;
  // layers
  botsLayer = s.add.layer();
  playersLayer = s.add.layer();
  effectsLayer = s.add.layer();

  gfxMe = s.add.circle(me.x, me.y, 18, 0x7dd3fc);
  gfxOther = s.add.circle(me.x+80, me.y, 18, 0xfca5a5);
  playersLayer.add([gfxMe, gfxOther]);

  textCenter = s.add.text(config.width/2, 24, 'Esperando rival…', { fontSize: '18px', color:'#ffffff' }).setOrigin(0.5);

  cursors = s.input.keyboard.addKeys({ up: Phaser.Input.Keyboard.KeyCodes.W, down: Phaser.Input.Keyboard.KeyCodes.S, left: Phaser.Input.Keyboard.KeyCodes.A, right: Phaser.Input.Keyboard.KeyCodes.D });
  mousePointer = s.input.activePointer;

 (function(){
  const orig = socket.emit.bind(socket);
  socket.emit = function(ev, data){
    // no loguear pings para evitar spam; loguear solo inputs y cosas útiles
    if (ev === 'input' || ev === 'someImportantEvent') {
      console.log('EMIT', ev, data);
    }
    return orig(ev, data);
  };
})();

  setInterval(() => { lastPingSend = performance.now(); socket.emit('ping'); }, 1000);

  socket.on('connect', () => { myId = socket.id; document.getElementById('tagInfo').textContent = 'Conectado'; console.log('[CLIENT] connected', myId); });
  socket.on('pong', () => { /* ignore */ });

  // snapshot handler (server authoritative)
  socket.on('snapshot', (snap) => {
    running = snap.running;
    roundTimeLeft = snap.roundTimeLeft;
    arena = snap.arena || arena;

    // update players (reconciliation smooth)
    const mine = snap.players.find(p => p.id === myId);
    const opp = snap.players.find(p => p.id !== myId);

    if (mine) {
      // suaviza la corrección
      me.x = lerp(me.x, mine.x, 0.6);
      me.y = lerp(me.y, mine.y, 0.6);
      me.angle = mine.angle;
      me.hp = mine.hp;
      me.score = mine.score;
    }
    if (opp) {
      // coloca bola rival (interpolación simple por buffer)
      interpBuffer.push({ time: performance.now(), players: snap.players, bots: snap.bots, events: snap.events });
      // mantiene buffer pequeño
      while(interpBuffer.length > 5) interpBuffer.shift();
    }

    // actualizar bots inmediatamente (no interpolation necesaria para demo)
    if (snap.bots && snap.bots.length) {
      // recrear/actualizar bot graphics
      snap.bots.forEach(b => {
        if (!botsGfx[b.id]) {
          botsGfx[b.id] = this.add.circle(b.x, b.y, 14, 0xffd166); // amarillo
        }
        botsGfx[b.id].x = b.x;
        botsGfx[b.id].y = b.y;
        botsGfx[b.id].setScale(1);
        // hp visual (tint)
        if (b.hp <= 0) botsGfx[b.id].setAlpha(0.25); else botsGfx[b.id].setAlpha(1);
      });
    }

    // eventos (hits) -> mostrar efectos
    if (snap.events && snap.events.length) {
      snap.events.forEach(ev => {
        if (ev.type === 'hit') {
          // origen (shooter's last known pos): busco jugador source en players
          const source = snap.players.find(p=>p.id===ev.source);
          const targetPos = { x: ev.tx, y: ev.ty };
          // dibuja trazo desde source a target
          if (source) drawShotEffect(source.x, source.y, targetPos.x, targetPos.y, ev.bot);
          // dibuja flash en target
          drawHitFlash(targetPos.x, targetPos.y);
        }
      });
    }

    // HUD
    const myScore = mine ? mine.score : 0;
    const oppScore = opp ? opp.score : 0;
    document.getElementById('tagScore').textContent = `Score: ${myScore} - ${oppScore}`;
    document.getElementById('tagTime').textContent = `Tiempo: ${roundTimeLeft}s`;
    textCenter.setText(running ? '' : (snap.players.length === 2 ? '¡Nuevo round!' : 'Esperando rival…'));
  });
}

let lastAckSeq = 0;
const INPUT_RATE = 60;
let inputAccumulator = 0;

function update(time, delta) {
  const dt = delta / 1000;
  // inputs
  const inputs = {
    up: cursors.up.isDown,
    down: cursors.down.isDown,
    left: cursors.left.isDown,
    right: cursors.right.isDown,
    shoot: this.input.activePointer.isDown,
    mx: this.input.x,
    my: this.input.y
  };
  const ang = Math.atan2(inputs.my - me.y, inputs.mx - me.x);
  me.angle = ang;

  // predicción local
  let dx = 0, dy = 0;
  if (inputs.up) dy -= 1;
  if (inputs.down) dy += 1;
  if (inputs.left) dx -= 1;
  if (inputs.right) dx += 1;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  me.x = clamp(me.x + dx * SPEED * dt, 20, arena.w-20);
  me.y = clamp(me.y + dy * SPEED * dt, 20, arena.h-20);

  // enviar inputs rate-limited
  inputAccumulator += dt;
  const sendEvery = 1 / INPUT_RATE;
  if (inputAccumulator >= sendEvery) {
    inputAccumulator -= sendEvery;
    const toSend = { type:'input', seq: ++lastSeq, tick: Date.now(), inputs, angle: ang };
    socket.emit('input', toSend);
  }

  // render players (me y rival interpolado)
  gfxMe.x = me.x; gfxMe.y = me.y; gfxMe.rotation = me.angle;

  // interpolar rival usando buffer (suavizado temporal ~100ms)
  const renderDelay = 100;
  const renderTime = performance.now() - renderDelay;
  while (interpBuffer.length >= 2 && interpBuffer[1].time <= renderTime) interpBuffer.shift();
  if (interpBuffer.length >= 2) {
    const A = interpBuffer[0], B = interpBuffer[1];
    const t = (renderTime - A.time) / (B.time - A.time);
    const Aopp = A.players.find(p => p.id !== myId);
    const Bopp = B.players.find(p => p.id !== myId);
    if (Aopp && Bopp) {
      const ox = lerp(Aopp.x, Bopp.x, t);
      const oy = lerp(Aopp.y, Bopp.y, t);
      gfxOther.setVisible(true);
      gfxOther.x = ox; gfxOther.y = oy;
    }
  }

  // ping HUD
  if (lastPingSend) {
    pingMs = Math.round(performance.now() - lastPingSend);
    document.getElementById('tagPing').textContent = `Ping: ${pingMs} ms`;
    lastPingSend = 0;
  }
}

// --- Efectos (drawShotEffect, drawHitFlash)
function drawShotEffect(ax, ay, bx, by, isBot=false) {
  // trazo rápido que desaparece
  const scene = game.scene.scenes[0];
  const g = scene.add.graphics();
  g.lineStyle(3, isBot?0xffff66:0xffffff, 0.95);
  g.beginPath();
  g.moveTo(ax, ay); g.lineTo(bx, by); g.strokePath();
  // fade out
  scene.tweens.add({
    targets: g, alpha: 0, duration: 140, onComplete: ()=> g.destroy()
  });
  // pequeño flash en el origen (muzzle)
  const muzzle = scene.add.circle(ax, ay, 6, 0xfff2cc).setDepth(20);
  scene.tweens.add({ targets: muzzle, scale: 1.8, alpha:0, duration:140, onComplete: ()=> muzzle.destroy() });
}

function drawHitFlash(x,y) {
  const scene = game.scene.scenes[0];
  const c = scene.add.circle(x,y,6,0xff6b6b).setDepth(21);
  scene.tweens.add({ targets: c, scale: 3, alpha: 0, duration: 300, onComplete: ()=> c.destroy() });
  // ring
  const ring = scene.add.circle(x,y,12).setStrokeStyle(2,0xffadad).setDepth(20);
  scene.tweens.add({ targets: ring, scale: 2.5, alpha:0, duration: 400, onComplete: ()=> ring.destroy() });
}

// helpers
function lerp(a,b,t){return a+(b-a)*t;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
