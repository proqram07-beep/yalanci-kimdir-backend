/**
 * =====================================================================
 *  YALANÇI KİMDİR? — Multiplayer Backend (Node.js + Express + Socket.io)
 * =====================================================================
 *  Telegram Mini App daxilində işləyən Spyfall / Mafia üslublu
 *  sosial deduksiya oyununun real-time serveri.
 *
 *  Əsas prinsiplər:
 *   1. Bütün oyun vəziyyəti (state) RAM-da, `rooms` obyektində saxlanılır.
 *   2. Server "tək həqiqət mənbəyidir" — client-ə heç vaxt güvənilmir.
 *      (məs: səs verənin kimliyi `socket.id`-dən götürülür, client-in
 *      göndərdiyi `voterPlayerId`-dən yox.)
 *   3. Rollar və gizli məkan YALNIZ `socket.emit('your_role')` ilə şəxsi
 *      göndərilir. `room_updated` event-i təmizlənmiş (sanitized) data
 *      yayır — orada role / isLiar / secretLocation YOXDUR.
 *
 *  Event-lər (client -> server):
 *    create_room, join_room, start_game, start_voting, vote_player,
 *    play_again, leave_room
 *  Event-lər (server -> client):
 *    room_created, room_updated, your_role, timer_tick, voting_started,
 *    game_results, error_message
 * =====================================================================
 */

'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------
// 1. KONFİQURASİYA
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

// İstehsalda (production) CORS_ORIGIN-i Mini App-in domeninə qoyun,
// məs: https://my-miniapp.vercel.app . "*" yalnız test üçündür.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const MIN_PLAYERS = 3; // Oyunu başlatmaq üçün minimum oyunçu sayı
const MAX_PLAYERS = 12; // Otaqda maksimum oyunçu sayı
const DEFAULT_GAME_SECONDS = 300; // Default oyun müddəti (5 dəqiqə)
const MAX_NAME_LENGTH = 24; // Ad / username üçün maksimum uzunluq

// Oyun məkanları (server tərəfindən random seçilir)
const LOCATIONS = [
  'Hava limanı',
  'Xəstəxana',
  'Məktəb',
  'Restoran',
  'Kinoteatr',
  'Çimərlik',
  'Bank',
  'Universitet',
  'Supermarket',
  'Qatar stansiyası',
  'Dəniz gəmisi',
  'Muzey',
  'Zoopark',
  'Otel',
  'Stadion',
  'Polis şöbəsi',
  'Kosmik stansiya',
  'Sirk',
  'Kitabxana',
  'Dağ evi',
];

// ---------------------------------------------------------------------
// 2. EXPRESS + HTTP + SOCKET.IO QURULUMU
// ---------------------------------------------------------------------
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Sadə sağlamlıq yoxlaması (hosting platformaları üçün faydalıdır)
app.get('/', (req, res) => {
  res.json({ status: 'ok', game: 'Yalançı Kimdir?', rooms: Object.keys(rooms).length });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

// ---------------------------------------------------------------------
// 3. GLOBAL STATE — aktiv otaqlar RAM-da
// ---------------------------------------------------------------------
/**
 * rooms[roomCode] = {
 *   roomCode, hostId,
 *   players: [{ id, telegramId, username, name, role, isLiar, hasVoted, votedFor }],
 *   status: 'LOBBY' | 'PLAYING' | 'VOTING' | 'GAME_OVER',
 *   secretLocation: string | null,
 *   timer: number,            // qalan saniyə
 *   votes: { [playerId]: number },
 *   _interval: Timeout | null // daxili — heç vaxt client-ə göndərilmir
 * }
 *
 * Qeyd: `votedFor` (kim kimə səs verib) və `_interval` daxili sahələrdir.
 * `sanitizeRoom()` onları client-ə çıxarmır.
 */
const rooms = {};

// ---------------------------------------------------------------------
// 4. KÖMƏKÇİ FUNKSİYALAR
// ---------------------------------------------------------------------

/** 6 rəqəmli unikal otaq kodu yaradır (100000–999999). */
function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms[code]); // mövcud kodla toqquşmanın qarşısı
  return code;
}

/** Massivdən random element seçir. */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Mətni təmizləyir: string olmalıdır, kənar boşluqlar silinir, uzunluq limitlənir. */
function cleanText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || fallback;
}

/** Client-ə xəta mesajı göndərir (həm event, həm də varsa ack callback ilə). */
function sendError(socket, message, ack) {
  socket.emit('error_message', { message });
  if (typeof ack === 'function') ack({ ok: false, error: message });
}

/** Otaqda socket.id-yə görə oyunçunu tapır. */
function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

/**
 * Otağın CLIENT-Ə GÖNDƏRİLƏ BİLƏN versiyası.
 * TƏHLÜKƏSİZLİK: role, isLiar, secretLocation, votedFor burada YOXDUR.
 * Yalnız oyun bitəndə (GAME_OVER) yalançı və məkan açıqlanır.
 */
function sanitizeRoom(room) {
  const revealed = room.status === 'GAME_OVER';
  return {
    roomCode: room.roomCode,
    hostId: room.hostId,
    status: room.status,
    timer: room.timer,
    players: room.players.map((p) => ({
      id: p.id,
      telegramId: p.telegramId,
      username: p.username,
      name: p.name,
      hasVoted: p.hasVoted,
      // Rol yalnız oyun bitdikdən sonra hamıya görünür
      ...(revealed ? { isLiar: p.isLiar } : {}),
    })),
    ...(revealed ? { secretLocation: room.secretLocation } : {}),
  };
}

/** Otaqdakı bütün oyunçulara təmizlənmiş vəziyyəti yayır. */
function broadcastRoom(room) {
  io.to(room.roomCode).emit('room_updated', sanitizeRoom(room));
}

/** Oyunçuya ŞƏXSİ rolunu göndərir (yalnız həmin socket-ə). */
function sendRole(room, player) {
  io.to(player.id).emit('your_role', {
    roomCode: room.roomCode,
    role: player.role, // 'LIAR' | 'CIVILIAN'
    isLiar: player.isLiar,
    // Yalançıya məkan GİZLİ qalır (null), dincə isə göndərilir
    location: player.isLiar ? null : room.secretLocation,
  });
}

/** Taymeri dayandırır (memory leak olmasın deyə vacibdir). */
function stopTimer(room) {
  if (room._interval) {
    clearInterval(room._interval);
    room._interval = null;
  }
}

/** Səsləri sıfırlayır (yeni oyun və ya yeni səsvermə üçün). */
function resetVotes(room) {
  room.votes = {};
  room.players.forEach((p) => {
    p.hasVoted = false;
    p.votedFor = null;
  });
}

/** `votes` obyektini oyunçuların `votedFor` sahələrindən yenidən hesablayır. */
function recountVotes(room) {
  room.votes = {};
  room.players.forEach((p) => {
    if (p.votedFor) room.votes[p.votedFor] = (room.votes[p.votedFor] || 0) + 1;
  });
}

// ---------------------------------------------------------------------
// 5. OYUN AXINI FUNKSİYALARI
// ---------------------------------------------------------------------

/** Oyun taymerini başladır. Hər saniyə `timer_tick` göndərir. */
function startTimer(room) {
  stopTimer(room);
  room._interval = setInterval(() => {
    room.timer -= 1;
    io.to(room.roomCode).emit('timer_tick', { roomCode: room.roomCode, timer: room.timer });

    // Vaxt bitdi -> avtomatik səsverməyə keç
    if (room.timer <= 0) {
      stopTimer(room);
      beginVoting(room);
    }
  }, 1000);
}

/** Səsvermə mərhələsinə keçid. */
function beginVoting(room) {
  if (room.status !== 'PLAYING') return;
  stopTimer(room);
  room.status = 'VOTING';
  resetVotes(room);
  io.to(room.roomCode).emit('voting_started', { roomCode: room.roomCode });
  broadcastRoom(room);
}

/**
 * Oyunu bitirir, nəticəni hesablayıb `game_results` yayır.
 * @param {object} room
 * @param {'CIVILIANS'|'LIAR'} winner
 * @param {string} reason - nəticənin səbəbi (client-də göstərmək üçün)
 */
function endGame(room, winner, reason) {
  stopTimer(room);
  room.status = 'GAME_OVER';

  const liar = room.players.find((p) => p.isLiar);

  io.to(room.roomCode).emit('game_results', {
    roomCode: room.roomCode,
    winner,
    reason,
    secretLocation: room.secretLocation,
    liar: liar ? { id: liar.id, name: liar.name, username: liar.username } : null,
    // Hər oyunçunun neçə səs aldığı (ad ilə birlikdə)
    votes: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      voteCount: room.votes[p.id] || 0,
    })),
  });

  broadcastRoom(room); // artıq GAME_OVER — isLiar və məkan açılır
}

/**
 * Bütün səslər toplanıbsa nəticəni hesablayır.
 * Qayda: ən çox səs alan oyunçu yalançıdırsa -> dinclər qalib.
 *        Səsvermə bərabərlikdədirsə və ya səhv şəxs seçilibsə -> yalançı qalib.
 */
function checkAllVoted(room) {
  if (room.status !== 'VOTING') return;
  if (!room.players.every((p) => p.hasVoted)) return;

  const liar = room.players.find((p) => p.isLiar);
  const maxVotes = Math.max(0, ...Object.values(room.votes));
  const topIds = Object.keys(room.votes).filter((id) => room.votes[id] === maxVotes);

  if (topIds.length === 1 && liar && topIds[0] === liar.id) {
    endGame(room, 'CIVILIANS', 'Yalançı düzgün tapıldı!');
  } else if (topIds.length > 1) {
    endGame(room, 'LIAR', 'Səslər bərabər bölündü — yalançı qalib gəldi!');
  } else {
    endGame(room, 'LIAR', 'Səhv şəxs seçildi — yalançı qalib gəldi!');
  }
}

// ---------------------------------------------------------------------
// 6. SOCKET.IO EVENT-LƏRİ
// ---------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[+] Qoşuldu: ${socket.id}`);

  // Bu socket-in hazırda hansı otaqda olduğunu yadda saxlayırıq
  // (disconnect zamanı otağı tez tapmaq üçün).
  socket.data.roomCode = null;

  // ------------------------------------------------------------------
  // create_room — { telegramId, username, name }
  // ------------------------------------------------------------------
  socket.on('create_room', (data = {}, ack) => {
    if (socket.data.roomCode) return sendError(socket, 'Siz artıq otaqdasınız.', ack);

    const roomCode = generateRoomCode();
    const host = {
      id: socket.id,
      telegramId: data.telegramId ?? null,
      username: cleanText(data.username),
      name: cleanText(data.name, 'Oyunçu'),
      role: null,
      isLiar: false,
      hasVoted: false,
      votedFor: null,
    };

    rooms[roomCode] = {
      roomCode,
      hostId: socket.id,
      players: [host],
      status: 'LOBBY',
      secretLocation: null,
      timer: DEFAULT_GAME_SECONDS,
      votes: {},
      _interval: null,
    };

    socket.join(roomCode); // Socket.io "otağına" qoşuluruq
    socket.data.roomCode = roomCode;

    socket.emit('room_created', { roomCode });
    if (typeof ack === 'function') ack({ ok: true, roomCode });
    broadcastRoom(rooms[roomCode]);
    console.log(`[Otaq] Yaradıldı: ${roomCode} (host: ${host.name})`);
  });

  // ------------------------------------------------------------------
  // join_room — { roomCode, telegramId, username, name }
  // ------------------------------------------------------------------
  socket.on('join_room', (data = {}, ack) => {
    const roomCode = String(data.roomCode || '').trim();
    const room = rooms[roomCode];

    if (!room) return sendError(socket, 'Belə otaq tapılmadı.', ack);
    if (socket.data.roomCode) return sendError(socket, 'Siz artıq otaqdasınız.', ack);

    // Eyni Telegram istifadəçisi yenidən qoşulursa (məs: şəbəkə qopub bərpa olub),
    // köhnə "kölgə" qeydi yeni socket.id-yə bağlayırıq.
    const existing =
      data.telegramId != null
        ? room.players.find((p) => String(p.telegramId) === String(data.telegramId))
        : null;

    if (existing) {
      const oldId = existing.id;
      existing.id = socket.id;
      if (room.hostId === oldId) room.hostId = socket.id;
      // Köhnə id ilə verilmiş səsləri də yenisinə köçürürük
      room.players.forEach((p) => {
        if (p.votedFor === oldId) p.votedFor = socket.id;
      });
      if (room.votes[oldId] !== undefined) {
        room.votes[socket.id] = room.votes[oldId];
        delete room.votes[oldId];
      }
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      if (typeof ack === 'function') ack({ ok: true, roomCode, rejoined: true });
      broadcastRoom(room);
      if (room.status === 'PLAYING' || room.status === 'VOTING') sendRole(room, existing);
      return;
    }

    // Yeni oyunçu yalnız LOBBY-də qoşula bilər (gedişatda olan oyuna girmək olmaz)
    if (room.status !== 'LOBBY') return sendError(socket, 'Oyun artıq başlayıb.', ack);
    if (room.players.length >= MAX_PLAYERS) return sendError(socket, 'Otaq doludur.', ack);

    room.players.push({
      id: socket.id,
      telegramId: data.telegramId ?? null,
      username: cleanText(data.username),
      name: cleanText(data.name, 'Oyunçu'),
      role: null,
      isLiar: false,
      hasVoted: false,
      votedFor: null,
    });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    if (typeof ack === 'function') ack({ ok: true, roomCode });
    broadcastRoom(room); // bütün otaq oyunçularına update
  });

  // ------------------------------------------------------------------
  // start_game — { roomCode } — YALNIZ HOST
  // ------------------------------------------------------------------
  socket.on('start_game', (data = {}, ack) => {
    const room = rooms[String(data.roomCode || '')];
    if (!room) return sendError(socket, 'Otaq tapılmadı.', ack);
    if (room.hostId !== socket.id) return sendError(socket, 'Oyunu yalnız host başlada bilər.', ack);
    if (room.status !== 'LOBBY') return sendError(socket, 'Oyun artıq başlayıb.', ack);
    if (room.players.length < MIN_PLAYERS) {
      return sendError(socket, `Oyunu başlatmaq üçün ən azı ${MIN_PLAYERS} oyunçu lazımdır.`, ack);
    }

    // Məkan və yalançı SERVER tərəfindən seçilir
    room.secretLocation = pickRandom(LOCATIONS);
    const liar = pickRandom(room.players);

    room.players.forEach((p) => {
      p.isLiar = p.id === liar.id;
      p.role = p.isLiar ? 'LIAR' : 'CIVILIAN';
    });

    resetVotes(room);
    room.timer = DEFAULT_GAME_SECONDS;
    room.status = 'PLAYING';

    // ŞƏXSİ rol göndərilməsi — hər oyunçuya yalnız öz məlumatı
    room.players.forEach((p) => sendRole(room, p));

    broadcastRoom(room); // təmizlənmiş vəziyyət (rol / məkan YOXDUR)
    startTimer(room);

    if (typeof ack === 'function') ack({ ok: true });
    console.log(`[Oyun] Başladı: ${room.roomCode}`);
  });

  // ------------------------------------------------------------------
  // start_voting — { roomCode } — YALNIZ HOST (vaxtdan əvvəl səsverməyə keçid)
  // ------------------------------------------------------------------
  socket.on('start_voting', (data = {}, ack) => {
    const room = rooms[String(data.roomCode || '')];
    if (!room) return sendError(socket, 'Otaq tapılmadı.', ack);
    if (room.hostId !== socket.id) return sendError(socket, 'Səsverməni yalnız host başlada bilər.', ack);
    if (room.status !== 'PLAYING') return sendError(socket, 'Hazırda səsverməyə keçmək olmaz.', ack);

    beginVoting(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ------------------------------------------------------------------
  // vote_player — { roomCode, targetPlayerId, voterPlayerId }
  // ------------------------------------------------------------------
  socket.on('vote_player', (data = {}, ack) => {
    const room = rooms[String(data.roomCode || '')];
    if (!room) return sendError(socket, 'Otaq tapılmadı.', ack);
    if (room.status !== 'VOTING') return sendError(socket, 'Hazırda səsvermə getmir.', ack);

    // TƏHLÜKƏSİZLİK: səs verən HƏMİŞƏ socket.id-dir.
    // Client başqasının adından səs verməyə çalışsa (voterPlayerId uyğun deyilsə) rədd edirik.
    if (data.voterPlayerId && data.voterPlayerId !== socket.id) {
      return sendError(socket, 'Başqasının adından səs vermək olmaz.', ack);
    }

    const voter = findPlayer(room, socket.id);
    const target = findPlayer(room, data.targetPlayerId);

    if (!voter) return sendError(socket, 'Siz bu otağın oyunçusu deyilsiniz.', ack);
    if (!target) return sendError(socket, 'Seçilən oyunçu tapılmadı.', ack);
    if (voter.hasVoted) return sendError(socket, 'Siz artıq səs vermisiniz.', ack); // ikiqat səs bloku
    if (voter.id === target.id) return sendError(socket, 'Özünüzə səs verə bilməzsiniz.', ack);

    voter.hasVoted = true;
    voter.votedFor = target.id;
    room.votes[target.id] = (room.votes[target.id] || 0) + 1;

    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room); // kimin səs verdiyi (hasVoted) görünür, kimə verdiyi yox

    checkAllVoted(room); // hamı səs veribsə -> nəticə
  });

  // ------------------------------------------------------------------
  // play_again — { roomCode } — YALNIZ HOST (oyun bitdikdən sonra lobiyə qayıt)
  // ------------------------------------------------------------------
  socket.on('play_again', (data = {}, ack) => {
    const room = rooms[String(data.roomCode || '')];
    if (!room) return sendError(socket, 'Otaq tapılmadı.', ack);
    if (room.hostId !== socket.id) return sendError(socket, 'Bunu yalnız host edə bilər.', ack);
    if (room.status !== 'GAME_OVER') return sendError(socket, 'Oyun hələ bitməyib.', ack);

    stopTimer(room);
    room.status = 'LOBBY';
    room.secretLocation = null;
    room.timer = DEFAULT_GAME_SECONDS;
    room.players.forEach((p) => {
      p.role = null;
      p.isLiar = false;
    });
    resetVotes(room);

    if (typeof ack === 'function') ack({ ok: true });
    broadcastRoom(room);
  });

  // ------------------------------------------------------------------
  // leave_room — könüllü çıxış (disconnect ilə eyni təmizləmə məntiqi)
  // ------------------------------------------------------------------
  socket.on('leave_room', () => handleLeave(socket));

  // ------------------------------------------------------------------
  // disconnect — bağlantı kəsildi
  // ------------------------------------------------------------------
  socket.on('disconnect', () => {
    console.log(`[-] Ayrıldı: ${socket.id}`);
    handleLeave(socket);
  });
});

// ---------------------------------------------------------------------
// 7. OYUNÇU ÇIXIŞI (disconnect / leave_room üçün ümumi məntiq)
// ---------------------------------------------------------------------
function handleLeave(socket) {
  const roomCode = socket.data.roomCode;
  const room = rooms[roomCode];
  socket.data.roomCode = null;
  if (!room) return;

  socket.leave(roomCode);

  const leaver = findPlayer(room, socket.id);
  if (!leaver) return;

  // 1) Oyunçunu siyahıdan silirik
  room.players = room.players.filter((p) => p.id !== socket.id);

  // 2) Otaq boşdursa — tamamilə silirik (RAM təmizliyi)
  if (room.players.length === 0) {
    stopTimer(room);
    delete rooms[roomCode];
    console.log(`[Otaq] Silindi (boş): ${roomCode}`);
    return;
  }

  // 3) Host çıxıbsa — yeni host təyin edirik (siyahıdakı ilk oyunçu)
  if (room.hostId === socket.id) {
    room.hostId = room.players[0].id;
    console.log(`[Otaq] ${roomCode}: yeni host -> ${room.players[0].name}`);
  }

  // 4) Gedişatda olan oyunda çıxışın nəticələri
  if (room.status === 'PLAYING' || room.status === 'VOTING') {
    // Yalançı çıxıbsa -> dinclər qalib
    if (leaver.isLiar) {
      recountVotes(room);
      return endGame(room, 'CIVILIANS', 'Yalançı oyunu tərk etdi!');
    }
    // Oyunçu sayı minimumdan azalıbsa -> oyun davam edə bilməz
    if (room.players.length < MIN_PLAYERS) {
      recountVotes(room);
      return endGame(room, 'LIAR', 'Kifayət qədər oyunçu qalmadı.');
    }
  }

  // 5) Səsvermə zamanı çıxış: çıxanın verdiyi / aldığı səsləri yenidən hesablayırıq
  if (room.status === 'VOTING') {
    room.players.forEach((p) => {
      if (p.votedFor === socket.id) {
        // Çıxan oyunçuya verilmiş səs etibarsızdır -> həmin oyunçu yenidən səs verə bilər
        p.votedFor = null;
        p.hasVoted = false;
      }
    });
    recountVotes(room);
    broadcastRoom(room);
    return checkAllVoted(room); // qalanlar artıq hamısı səs veribsə -> nəticə
  }

  broadcastRoom(room);
}

// ---------------------------------------------------------------------
// 8. SERVERİ İŞƏ SAL
// ---------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Yalançı Kimdir? serveri ${PORT} portunda işləyir`);
});
