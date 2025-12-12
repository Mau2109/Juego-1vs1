const socket = io();
let myId = null;
let lastSeq = 0;
let lastPingSend = 0;
let pingMs = '—';
const interpBuffer = [];
const SPEED = 220;
const config = {
  type: Phaser.AUTO,
  width: window.innerWidth,  // Ajusta el tamaño del juego al tamaño de la ventana
  height: window.innerHeight, // Ajusta el tamaño del juego al tamaño de la ventana
  backgroundColor: '#111319',
  physics: { default: 'arcade' },
  scene: { preload, create, update }
};

let cursors, mousePointer;
let me = { id:null, x:480, y:270, angle:0, hp:100, score:0 };
let gfxMe, gfxOther, botsGfx = {}, textCenter;

// --- VARIABLES DE HUD Y BARRAS DE HP ---
let hpBarMe, hpBarOther, hpBarBots = {};
let timeTextGfx, scoreTextGfx;
// ---------------------------------------

let running=false, roundTimeLeft=0, arena={w:960,h:540};
const game = new Phaser.Game(config);

// Función de Interpolación Lineal (Lerp)
function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Función para clipear valores a un rango
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Función para dibujar barras de HP
function drawHPBar(graphics, x, y, hp, maxHp = 100) {
  const width = 50;  // Ancho de la barra de HP
  const height = 8;  // Alto de la barra de HP
  const offset = 30; // Desplazamiento vertical sobre el sprite
  const currentWidth = Math.max(0, (hp / maxHp) * width);

  // Calcula el color de la barra (de verde a rojo)
  const r = (1 - hp / maxHp) * 255;
  const g = (hp / maxHp) * 255;
  const color = (Math.round(r) << 16) + (Math.round(g) << 8) + 0;

  graphics.clear(); // Limpiar la barra antes de redibujarla
  // Fondo gris de la barra
  graphics.fillStyle(0x333333, 0.5);
  graphics.fillRect(x - width / 2, y - height / 2 - offset, width, height);
  // Barra de vida (color dinámico)
  graphics.fillStyle(color, 1);
  graphics.fillRect(x - width / 2, y - height / 2 - offset, currentWidth, height);
  // Borde de la barra
  graphics.lineStyle(1, 0x111111, 1);
  graphics.strokeRect(x - width / 2, y - height / 2 - offset, width, height);
}

function preload() {
  // Cargar imágenes y sprites
  this.load.image('spaceBackground', 'assets/spaceBackground.png');
  this.load.image('playerSprite', 'assets/playerSprite.png');
  this.load.image('enemySprite', 'assets/enemySprite.png');
  this.load.image('botSprite', 'assets/botSprite.png');
  this.load.image('explosionEffect', 'assets/explosionEffect.png');
}

function create() {
  const s = this;
  
  // 1. Fondo de Arena
  s.add.image(config.width / 2, config.height / 2, 'spaceBackground').setScale(config.width / 960).setDepth(-10);

  // layers
  botsLayer = s.add.layer();
  playersLayer = s.add.layer();
  effectsLayer = s.add.layer();

  // 2. Jugador Local y Rival (Inicializar Sprites)
  gfxMe = s.add.sprite(me.x, me.y, 'playerSprite').setScale(0.2).setAngle(90).setDepth(1); // Ajustado el tamaño a 0.2
  gfxOther = s.add.sprite(me.x + 80, me.y, 'enemySprite').setScale(0.2).setAngle(90).setDepth(1); // Ajustado el tamaño a 0.2
  playersLayer.add([gfxMe, gfxOther]);

  // 3. Inicialización de Barras de HP (Gráficos)
  hpBarMe = s.add.graphics().setDepth(2);
  hpBarOther = s.add.graphics().setDepth(2);

  // 4. HUD en la Escena (Tiempo y Puntuación)
  timeTextGfx = s.add.text(config.width / 2, 50, 'TIEMPO: 90s', { fontSize: '28px', color: '#ffcc00', stroke: '#000000', strokeThickness: 4 }).setOrigin(0.5).setDepth(10);
  scoreTextGfx = s.add.text(config.width / 2, 90, 'SCORE: 0 - 0', { fontSize: '20px', color: '#ffffff', stroke: '#000000', strokeThickness: 3 }).setOrigin(0.5).setDepth(10);
  
  // Texto central (matchmaking/reset)
  textCenter = s.add.text(config.width / 2, config.height / 2, 'Esperando rival…', { fontSize: '32px', color: '#fcc200' }).setOrigin(0.5).setDepth(10);

  cursors = s.input.keyboard.addKeys({ up: Phaser.Input.Keyboard.KeyCodes.W, down: Phaser.Input.Keyboard.KeyCodes.S, left: Phaser.Input.Keyboard.KeyCodes.A, right: Phaser.Input.Keyboard.KeyCodes.D });
  mousePointer = s.input.activePointer;

  // Debugging de emit
  (function(){
    const orig = socket.emit.bind(socket);
    socket.emit = function(ev, data){
      if (ev === 'input' || ev === 'someImportantEvent') {
        // console.log('EMIT', ev, data); // Descomentar para debug
      }
      return orig(ev, data);
    };
  })();

  // Ping
  setInterval(() => { lastPingSend = performance.now(); socket.emit('ping'); }, 1000);

  socket.on('connect', () => { myId = socket.id; document.getElementById('tagInfo').textContent = 'Conectado'; console.log('[CLIENT] connected', myId); });
  socket.on('pong', () => { /* ignore */ });

  // snapshot handler (server authoritative)
  socket.on('snapshot', (snap) => {
    running = snap.running;
    roundTimeLeft = snap.roundTimeLeft;
    arena = snap.arena || arena;

    // actualizar jugadores (reconciliation smooth)
    const mine = snap.players.find(p => p.id === myId);
    const opp = snap.players.find(p => p.id !== myId);

    if (mine) {
      // Aplicar corrección suave a la posición local (Mantiene la funcionalidad de predicción)
      me.x = lerp(me.x, mine.x, 0.6);
      me.y = lerp(me.y, mine.y, 0.6);
      me.angle = mine.angle;
      me.hp = mine.hp;
      me.score = mine.score;
    }
    if (opp) {
      // Almacenar para interpolación (Mantiene la funcionalidad de interpolación)
      interpBuffer.push({ time: performance.now(), players: snap.players, bots: snap.bots, events: snap.events });
      // mantiene buffer pequeño
      while (interpBuffer.length > 5) interpBuffer.shift();
    }

    // actualizar bots (Gráficos + HP)
    if (snap.bots && snap.bots.length) {
      snap.bots.forEach(b => {
        if (!botsGfx[b.id]) {
          // Crea el sprite del bot si no existe
          botsGfx[b.id] = this.add.sprite(b.x, b.y, 'botSprite').setScale(0.15).setDepth(1);  // Ajustado el tamaño de los bots
          hpBarBots[b.id] = this.add.graphics().setDepth(2);
        }
        botsGfx[b.id].x = b.x;
        botsGfx[b.id].y = b.y;

        // Actualizar HP visual del bot (opacidad si está muerto)
        const alpha = b.hp <= 0 ? 0.25 : 1;
        botsGfx[b.id].setAlpha(alpha);

        // Renderizar barra de HP del bot
        if (b.hp > 0) {
          drawHPBar(hpBarBots[b.id], b.x, b.y, b.hp, 60); // Max HP 60 del server
        } else {
          hpBarBots[b.id].clear();
        }
      });
      // Cleanup de bots eliminados
      Object.keys(botsGfx).forEach(id => {
        if (!snap.bots.find(b => b.id === id)) {
          botsGfx[id].destroy();
          delete botsGfx[id];
          hpBarBots[id].destroy();
          delete hpBarBots[id];
        }
      });
    }

    // eventos (hits) -> mostrar efectos
    if (snap.events && snap.events.length) {
      snap.events.forEach(ev => {
        if (ev.type === 'hit') {
          const source = snap.players.find(p => p.id === ev.source);
          const targetPos = { x: ev.tx, y: ev.ty };
          // dibuja trazo desde source a target
          if (source) drawShotEffect(source.x, source.y, targetPos.x, targetPos.y, ev.bot);
          // dibuja flash en target
          drawHitFlash(targetPos.x, targetPos.y);
        }
      });
    }

    // HUD de Phaser (Puntuación y Tiempo)
    const myScore = mine ? mine.score : 0;
    const oppScore = opp ? opp.score : 0;
    scoreTextGfx.setText(`SCORE: ${myScore} - ${oppScore}`);
    timeTextGfx.setText(`TIEMPO: ${roundTimeLeft}s`);
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

  // Si el jugador mueve el mouse, actualiza la posición
  const sendEvery = 1 / 60;  // Envía entradas cada 1/60 segundos
  inputAccumulator += dt;
  if (inputAccumulator >= sendEvery) {
    inputAccumulator -= sendEvery;
    const toSend = { type: 'input', seq: ++lastSeq, tick: Date.now(), inputs, angle: ang };
    socket.emit('input', toSend);
  }

  // Predicción de movimiento local
  let dx = 0, dy = 0;
  if (inputs.up) dy -= 1;
  if (inputs.down) dy += 1;
  if (inputs.left) dx -= 1;
  if (inputs.right) dx += 1;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  me.x = clamp(me.x + dx * SPEED * dt, 20, arena.w - 20);
  me.y = clamp(me.y + dy * SPEED * dt, 20, arena.h - 20);

  // Actualización de la nave y barra de HP
  gfxMe.x = me.x;
  gfxMe.y = me.y;
  gfxMe.rotation = me.angle + Math.PI / 2;
  drawHPBar(hpBarMe, me.x, me.y, me.hp); // Actualizar barra de HP

  // Interpolación y actualización del rival
  updateOpponent();
}

// Función para manejar la actualización del rival y la interpolación
function updateOpponent() {
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
      gfxOther.x = ox;
      gfxOther.y = oy;
      gfxOther.rotation = Bopp.angle + Math.PI / 2;
      drawHPBar(hpBarOther, ox, oy, Bopp.hp);
    }
  } else {
    gfxOther.setVisible(false);
    hpBarOther.clear();
  }
}
