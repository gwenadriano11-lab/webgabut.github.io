const { Telegraf, Markup } = require("telegraf");
const fs = require('fs-extra');
const pino = require('pino');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require("cors");
const moment = require('moment');

// ===== BAILEYS =====
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

// ==================== KONFIGURASI ====================
const { tokens, owner: OwnerId, ipvps: VPS, port: PORT } = config;
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static('public'));

// ==================== OWNER IDS ====================
const ownerIds = [OwnerId];

// ==================== BOT INIT ====================
let bot;
try {
    bot = new Telegraf(tokens);
    console.log(chalk.green("✓ ATOMIC CRASHER initialized"));
} catch (err) {
    console.error(chalk.red("❌ Gagal init bot:", err.message));
}

// ==================== SESSIONS ====================
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userSessionsPath = path.join(__dirname, "user_sessions.json");
const userEvents = new Map();
const pairingEvents = new Map();

// ==================== FUNGSI AKSES ====================
function loadAkses() {
    if (!fs.existsSync(file)) {
        const initData = { owners: [], akses: [], resellers: [], pts: [], moderators: [] };
        fs.writeFileSync(file, JSON.stringify(initData, null, 2));
        return initData;
    }
    let data = JSON.parse(fs.readFileSync(file));
    if (!data.resellers) data.resellers = [];
    if (!data.pts) data.pts = [];
    if (!data.moderators) data.moderators = [];
    return data;
}

function saveAkses(data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
    const data = loadAkses();
    return data.owners.includes(id.toString());
}

function isAuthorized(id) {
    const data = loadAkses();
    return isOwner(id) || data.akses.includes(id.toString()) ||
        data.resellers.includes(id.toString()) || data.pts.includes(id.toString()) ||
        data.moderators.includes(id.toString());
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function generateKey(length = 4) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
    const match = str.match(/^(\d+)([dh])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
    const filePath = path.join(__dirname, "database", "user.json");
    try {
        fs.writeFileSync(filePath, JSON.stringify(users, null, 2), "utf-8");
        console.log("✓ Data user berhasil disimpan.");
    } catch (err) {
        console.error("✗ Gagal menyimpan user:", err);
    }
}

function getUsers() {
    const filePath = path.join(__dirname, "database", "user.json");
    if (!fs.existsSync(filePath)) return [];
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
        console.error("✗ Gagal membaca file user.json:", err);
        return [];
    }
}

function loadUserSessions() {
    if (!fs.existsSync(userSessionsPath)) {
        fs.writeFileSync(userSessionsPath, JSON.stringify({}, null, 2));
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(userSessionsPath, "utf8"));
    } catch (err) {
        console.error("[SESSION] Error loading:", err);
        return {};
    }
}

function saveUserSessions(data) {
    try {
        fs.writeFileSync(userSessionsPath, JSON.stringify(data, null, 2));
        console.log(`[SESSION] Saved`);
    } catch (err) {
        console.error("Gagal menyimpan:", err);
    }
}

function sendEventToUser(username, eventData) {
    if (userEvents.has(username)) {
        const res = userEvents.get(username);
        try {
            res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        } catch (err) {
            userEvents.delete(username);
        }
    }
}

function sendPairingToWeb(username, data) {
    if (pairingEvents.has(username)) {
        const res = pairingEvents.get(username);
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (err) {
            pairingEvents.delete(username);
        }
    }
}

// ==================== CONNECT WHATSAPP ====================
async function connectToWhatsApp(BotNumber, chatId, ctx) {
    const sessionDir = sessionPath(BotNumber);
    
    if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`🗑️ Session lama ${BotNumber} dihapus`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    let statusMessage = await ctx.reply(
        `💥 <b>ATOMIC CRASHER PAIRING</b>\n\n` +
        `📱 Nomor: <code>${BotNumber}</code>\n` +
        `⏳ Menghubungkan...`,
        { parse_mode: "HTML" }
    );

    const editStatus = async (text) => {
        try {
            await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "HTML" });
        } catch (e) {
            console.error("Error edit:", e.message);
        }
    };

    const { version } = await fetchLatestBaileysVersion();

    const userSock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        version: version,
        printQRInTerminal: false,
        browser: ["ATOMIC CRASHER", "Chrome", "120.0.0"],
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        markOnlineOnConnect: true,
        patchMessageBeforeSending: (msg) => {
            const patch = {
                ...msg,
                message: {
                    ...msg.message,
                    ...(msg.message?.protocolMessage && {
                        protocolMessage: {
                            ...msg.message.protocolMessage,
                            type: 0,
                        }
                    })
                }
            };
            return patch;
        }
    });

    let isConnected = false;
    let pairingRequested = false;

    userSock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;

            if (code === DisconnectReason.loggedOut) {
                await editStatus(
                    `❌ <b>LOGGED OUT!</b>\n\n` +
                    `📱 Nomor: <code>${BotNumber}</code>\n` +
                    `🔄 Coba lagi: /addbot ${BotNumber}`
                );
                if (fs.existsSync(sessionDir)) {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                }
                return;
            }

            if (!isConnected) {
                await editStatus(
                    `❌ <b>CONNECTION FAILED</b>\n\n` +
                    `📱 Nomor: <code>${BotNumber}</code>\n` +
                    `⚠️ Kode: ${code || 'Unknown'}\n` +
                    `🔄 Coba lagi: /addbot ${BotNumber}`
                );
            }
            return;
        }

        if (connection === "open") {
            isConnected = true;
            sessions.set(BotNumber, userSock);
            saveActive(BotNumber);

            await userSock.sendPresenceUpdate('available');

            await editStatus(
                `✅ <b>ATOMIC CRASHER CONNECTED!</b>\n\n` +
                `📱 Nomor: <code>${BotNumber}</code>\n` +
                `🟢 Status: <b>ONLINE</b>`
            );
            return;
        }

        if (connection === "connecting") {
            await editStatus(
                `⏳ <b>CONNECTING...</b>\n\n` +
                `📱 Nomor: <code>${BotNumber}</code>\n` +
                `🔄 Menghubungkan ke WhatsApp...`
            );

            if (!fs.existsSync(`${sessionDir}/creds.json`) && !pairingRequested) {
                pairingRequested = true;

                try {
                    const code = await userSock.requestPairingCode(BotNumber);
                    const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

                    await editStatus(
                        `✅ <b>PAIRING CODE GENERATED!</b>\n\n` +
                        `📱 Nomor: <code>${BotNumber}</code>\n` +
                        `🔑 <b>Kode:</b> <code>${formattedCode}</code>\n\n` +
                        `📋 <b>Cara Pairing:</b>\n` +
                        `1️⃣ Buka WhatsApp di HP\n` +
                        `2️⃣ Tap ⋮ > Linked Devices > Link a Device\n` +
                        `3️⃣ Masukkan kode: <code>${formattedCode}</code>\n` +
                        `4️⃣ Kode berlaku 30 DETIK!\n\n` +
                        `⏳ Menunggu koneksi...`
                    );

                    console.log(chalk.green(`✅ PAIRING CODE for ${BotNumber}: ${formattedCode}`));

                } catch (err) {
                    console.error("Error pairing:", err.message);
                    
                    try {
                        const fullNumber = `${BotNumber}@s.whatsapp.net`;
                        const code = await userSock.requestPairingCode(fullNumber);
                        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;

                        await editStatus(
                            `✅ <b>PAIRING CODE GENERATED!</b>\n\n` +
                            `📱 Nomor: <code>${BotNumber}</code>\n` +
                            `🔑 <b>Kode:</b> <code>${formattedCode}</code>\n\n` +
                            `📋 <b>Cara Pairing:</b>\n` +
                            `1️⃣ Buka WhatsApp di HP\n` +
                            `2️⃣ Tap ⋮ > Linked Devices > Link a Device\n` +
                            `3️⃣ Masukkan kode: <code>${formattedCode}</code>\n` +
                            `4️⃣ Kode berlaku 30 DETIK!\n\n` +
                            `⏳ Menunggu koneksi...`
                        );

                        console.log(chalk.green(`✅ PAIRING CODE (fallback) for ${BotNumber}: ${formattedCode}`));

                    } catch (err2) {
                        await editStatus(
                            `❌ <b>PAIRING FAILED!</b>\n\n` +
                            `📱 Nomor: <code>${BotNumber}</code>\n` +
                            `⚠️ Error: ${err2.message}\n\n` +
                            `🔄 Coba lagi: /addbot ${BotNumber}`
                        );
                        console.error(chalk.red(`❌ All pairing attempts failed for ${BotNumber}`));
                    }
                }
            }
        }
    });

    userSock.ev.on("creds.update", saveCreds);
    return userSock;
}

// ==================== BOT COMMANDS ====================
bot.command("start", async (ctx) => {
    const username = ctx.from.username || ctx.from.first_name || "User";
    const userId = ctx.from.id.toString();
    const isAdmin = isOwner(userId);

    await ctx.reply(`
💥 <b>ATOMIC CRASHER v5.0</b>

👋 Hai <b>${username}</b>!
👑 Role: <b>${isAdmin ? '🔥 OWNER' : '👤 USER'}</b>

📋 <b>COMMAND:</b>

┌─── ✦ <b>📱 PAIRING</b>
│ /addbot [nomor] - Pairing WA
│ /listbot - Lihat sender aktif
│ /sessions - Status sesi

${isAdmin ? `
┌─── ✦ <b>🔑 ADMIN</b>
│ /addkey [user,7d] - Buat Key
│ /listkey - Lihat Key
│ /delkey [user] - Hapus Key
│ /addowner [id] - Tambah Owner
│ /addacces [id] - Beri Akses
│ /delacces [id] - Cabut Akses
` : ''}

┌─── ✦ <b>🎨 FUN</b>
│ /anime - Random Anime
│ /meme - Random Meme
│ /quote - Quote Motivasi

┌─── ✦ <b>🌐 WEB</b>
│ http://localhost:3018

━━━━━━━━━━━━━━━━━━━━━━━━━━
💥 <i>ATOMIC CRASHER v5.0</i> 💥
    `, { parse_mode: "HTML" });
});

// ===== ADMIN COMMANDS =====
bot.command("addkey", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isOwner(userId) && !isAuthorized(userId)) {
        return ctx.reply("❌ Akses ditolak!", { parse_mode: "HTML" });
    }

    const args = ctx.message.text.split(" ").slice(1);
    if (args.length < 1 || !args[0].includes(",")) {
        return ctx.reply("❌ Format: /addkey username,7d", { parse_mode: "HTML" });
    }

    const parts = args[0].split(",");
    const username = parts[0].trim();
    const durasiStr = parts[1].trim();
    const customKey = parts[2] ? parts[2].trim() : null;

    const durationMs = parseDuration(durasiStr);
    if (!durationMs) return ctx.reply("❌ Format durasi salah! Gunakan: 7d / 1d / 12h", { parse_mode: "HTML" });

    const key = customKey || generateKey(4);
    const expired = Date.now() + durationMs;
    const users = getUsers();

    const userIndex = users.findIndex(u => u.username === username);
    if (userIndex !== -1) {
        users[userIndex] = { ...users[userIndex], key, expired };
    } else {
        users.push({ username, key, expired });
    }

    saveUsers(users);

    const expiredStr = new Date(expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
    });

    await ctx.reply(
        `✅ <b>Key berhasil dibuat!</b>\n\n` +
        `👤 Username: <code>${username}</code>\n` +
        `🔑 Key: <code>${key}</code>\n` +
        `⏰ Expired: ${expiredStr} WIB`,
        { parse_mode: "HTML" }
    );
});

bot.command("listkey", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isOwner(userId)) {
        return ctx.reply("❌ Akses ditolak!", { parse_mode: "HTML" });
    }

    const users = getUsers();
    if (users.length === 0) return ctx.reply("💢 Belum ada key.");

    let teks = `📋 <b>Daftar Key:</b>\n\n`;
    users.forEach((u, i) => {
        const exp = new Date(u.expired).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit"
        });
        teks += `${i+1}. ${u.username}\n   Key: ${u.key}\n   Expired: ${exp}\n\n`;
    });

    await ctx.reply(teks, { parse_mode: "HTML" });
});

bot.command("delkey", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isOwner(userId) && !isAuthorized(userId)) {
        return ctx.reply("❌ Akses ditolak!", { parse_mode: "HTML" });
    }

    const username = ctx.message.text.split(" ").slice(1).join(" ");
    if (!username) return ctx.reply("❌ Format: /delkey username", { parse_mode: "HTML" });

    const users = getUsers();
    const index = users.findIndex(u => u.username === username);
    if (index === -1) return ctx.reply(`❌ Username ${username} tidak ditemukan.`, { parse_mode: "HTML" });

    users.splice(index, 1);
    saveUsers(users);
    ctx.reply(`✅ Key ${username} berhasil dihapus.`, { parse_mode: "HTML" });
});

bot.command("addowner", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isOwner(userId)) {
        return ctx.reply("❌ Akses ditolak!", { parse_mode: "HTML" });
    }

    const id = ctx.message.text.split(" ").slice(1).join(" ");
    if (!id) return ctx.reply("❌ Format: /addowner 123456789", { parse_mode: "HTML" });

    const data = loadAkses();
    if (data.owners.includes(id)) return ctx.reply("✅ Sudah owner.");

    data.owners.push(id);
    saveAkses(data);
    ctx.reply(`✅ Owner ${id} berhasil ditambahkan.`, { parse_mode: "HTML" });
});

bot.command("addacces", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isOwner(userId)) {
        return ctx.reply("❌ Akses ditolak!", { parse_mode: "HTML" });
    }

    const id = ctx.message.text.split(" ").slice(1).join(" ");
    if (!id) return ctx.reply("❌ Format: /addacces 123456789", { parse_mode: "HTML" });

    const data = loadAkses();
    if (data.akses.includes(id)) return ctx.reply("✅ Sudah punya akses.");

    data.akses.push(id);
    saveAkses(data);
    ctx.reply(`✅ Akses untuk ${id} berhasil ditambahkan.`, { parse_mode: "HTML" });
});

bot.command("delacces", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!isOwner(userId)) {
        return ctx.reply("❌ Akses ditolak!", { parse_mode: "HTML" });
    }

    const id = ctx.message.text.split(" ").slice(1).join(" ");
    if (!id) return ctx.reply("❌ Format: /delacces 123456789", { parse_mode: "HTML" });

    const data = loadAkses();
    if (!data.akses.includes(id)) return ctx.reply("❌ User tidak ditemukan.");

    data.akses = data.akses.filter(uid => uid !== id);
    saveAkses(data);
    ctx.reply(`✅ Akses untuk ${id} berhasil dihapus.`, { parse_mode: "HTML" });
});

// ==================== WEB ROUTES ====================
function requireAuth(req, res, next) {
    const username = req.cookies.sessionUser;
    if (!username) return res.redirect("/login?msg=Silakan login");
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    if (!currentUser) return res.redirect("/login?msg=User tidak ditemukan");
    if (Date.now() > currentUser.expired) return res.redirect("/login?msg=Session expired");
    next();
}

// ===== LOGIN & AUTH =====
app.get("/", (req, res) => {
    const filePath = path.join(__dirname, "INDICTIVE", "Login.html");
    res.sendFile(filePath);
});

app.get("/login", (req, res) => {
    const msg = req.query.msg || "";
    const filePath = path.join(__dirname, "INDICTIVE", "Login.html");
    res.sendFile(filePath);
});

app.post("/auth", (req, res) => {
    const { username, key } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username && u.key === key);
    if (!user) {
        return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
    }
    res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
    res.cookie("sessionKey", key, { maxAge: 60 * 60 * 1000 });
    res.redirect("/dashboard");
});

// ===== DASHBOARD =====
app.get("/dashboard", requireAuth, (req, res) => {
    const username = req.cookies.sessionUser;
    const filePath = path.join(__dirname, "INDICTIVE", "dashboard.html");
    
    fs.readFile(filePath, "utf8", (err, html) => {
        if (err) return res.status(500).send("❌ File tidak ditemukan");
        
        const users = getUsers();
        const currentUser = users.find(u => u.username === username);
        const role = isOwner(username) ? "Owner" : "Member";
        const expired = currentUser ? new Date(currentUser.expired).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit"
        }) : "-";
        
        let displayRole = role;
        if (isOwner(username)) displayRole = "🔥 OWNER";
        else if (isReseller(username)) displayRole = "🛒 RESELLER";
        else if (isPT(username)) displayRole = "🏢 PT";
        else if (isModerator(username)) displayRole = "🛡️ MOD";
        
        const htmlReplaced = html
            .replace(/\$\{username\}/g, username)
            .replace(/\$\{rawRole\}/g, role)
            .replace(/\$\{displayRole\}/g, displayRole)
            .replace(/\$\{formattedTime\}/g, expired)
            .replace(/\$\{password\}/g, currentUser?.key || "********")
            .replace(/\$\{activeConnections\}/g, sessions.size);
        
        res.send(htmlReplaced);
    });
});

// ===== API =====
app.get("/api/dashboard-data", requireAuth, (req, res) => {
    const username = req.cookies.sessionUser;
    const users = getUsers();
    const currentUser = users.find(u => u.username === username);
    if (!currentUser) return res.status(404).json({ error: "User not found" });

    let role = "User";
    const userId = req.cookies.sessionUser;
    if (isOwner(userId)) role = "Owner";
    else if (isModerator(userId)) role = "Moderator";
    else if (isPT(userId)) role = "PT";
    else if (isReseller(userId)) role = "Reseller";
    else if (isAuthorized(userId)) role = "Authorized";

    const expired = new Date(currentUser.expired).toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit"
    });

    res.json({
        username: currentUser.username,
        role: role,
        activeSenders: sessions.size,
        expired: expired,
        daysRemaining: Math.max(0, Math.floor((currentUser.expired - Date.now()) / (1000 * 60 * 60 * 24)))
    });
});

app.get("/api/list-accounts", requireAuth, (req, res) => {
    const users = getUsers();
    const allUsers = users.map(u => ({
        username: u.username,
        role: isOwner(u.username) ? "Owner" : isReseller(u.username) ? "Reseller" : "Member",
        expired: new Date(u.expired).toLocaleString("id-ID", {
            timeZone: "Asia/Jakarta",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit"
        })
    }));
    res.json(allUsers);
});

app.post("/api/create-account", requireAuth, async (req, res) => {
    const { username, customKey, duration, role } = req.body;
    
    if (!username) {
        return res.json({ success: false, message: "Username harus diisi!" });
    }
    
    const users = getUsers();
    if (users.find(u => u.username === username)) {
        return res.json({ success: false, message: "Username sudah digunakan!" });
    }
    
    const key = customKey || generateKey(4);
    const durationMs = parseDuration(duration || "30d");
    const expired = Date.now() + durationMs;
    
    users.push({ username, key, expired });
    saveUsers(users);
    
    const data = loadAkses();
    if (role === "owner") {
        if (!data.owners.includes(username)) data.owners.push(username);
    } else if (role === "reseller") {
        if (!data.resellers.includes(username)) data.resellers.push(username);
    } else if (role === "pt") {
        if (!data.pts.includes(username)) data.pts.push(username);
    } else if (role === "moderator") {
        if (!data.moderators.includes(username)) data.moderators.push(username);
    } else {
        if (!data.akses.includes(username)) data.akses.push(username);
    }
    saveAkses(data);
    
    res.json({
        success: true,
        message: `Akun ${username} berhasil dibuat!`,
        username,
        key,
        expired: new Date(expired).toLocaleString("id-ID")
    });
});

app.post("/api/track-ip", requireAuth, async (req, res) => {
    const { ip } = req.body;
    
    if (!ip) return res.json({ status: 'error', message: 'IP diperlukan!' });
    
    try {
        const response = await axios.get(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,isp,org,lat,lon,timezone`);
        const data = response.data;
        
        if (data.status === 'success') {
            res.json({
                status: 'success',
                country: data.country || 'Unknown',
                regionName: data.regionName || 'Unknown',
                city: data.city || 'Unknown',
                isp: data.isp || 'Unknown',
                org: data.org || 'Unknown',
                lat: data.lat || 0,
                lon: data.lon || 0,
                timezone: data.timezone || 'Unknown'
            });
        } else {
            res.json({ status: 'error', message: data.message || 'IP tidak ditemukan!' });
        }
    } catch (error) {
        res.json({ status: 'error', message: 'Gagal melacak IP!' });
    }
});

app.post("/api/pairing", requireAuth, async (req, res) => {
    const username = req.cookies.sessionUser;
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.json({ status: 'error', message: 'Nomor HP wajib diisi!' });
    }

    const cleanNumber = phoneNumber.replace(/\D/g, '');
    if (!cleanNumber.startsWith('62') || cleanNumber.length < 10) {
        return res.json({ status: 'error', message: 'Format nomor salah! Harus 62xxxxxxxxxx' });
    }

    try {
        const sessionDir = path.join(sessions_dir, "users", username, `device${cleanNumber}`);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: "silent" }),
            version: version,
            printQRInTerminal: false,
            browser: ["ATOMIC CRASHER", "Chrome", "120.0.0"],
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            generateHighQualityLinkPreview: true,
            syncFullHistory: true,
            markOnlineOnConnect: true,
            patchMessageBeforeSending: (msg) => {
                const patch = {
                    ...msg,
                    message: {
                        ...msg.message,
                        ...(msg.message?.protocolMessage && {
                            protocolMessage: {
                                ...msg.message.protocolMessage,
                                type: 0,
                            }
                        })
                    }
                };
                return patch;
            }
        });

        let pairingCode = null;
        let codeSent = false;

        sock.ev.on("connection.update", async (update) => {
            const { connection } = update;

            if (connection === "open") {
                sessions.set(cleanNumber, sock);
                saveActive(cleanNumber);
                await sock.sendPresenceUpdate('available');
                return;
            }

            if (connection === "connecting") {
                if (!fs.existsSync(`${sessionDir}/creds.json`) && !codeSent) {
                    codeSent = true;
                    try {
                        const code = await sock.requestPairingCode(cleanNumber);
                        pairingCode = code.match(/.{1,4}/g)?.join('-') || code;
                        sendPairingToWeb(username, {
                            type: 'pairing_code',
                            message: 'Kode Pairing Digenerate!',
                            number: cleanNumber,
                            code: pairingCode,
                            status: 'waiting_pairing'
                        });
                        console.log(chalk.green(`✅ PAIRING CODE for ${cleanNumber}: ${pairingCode}`));
                    } catch (err) {
                        console.error("Error pairing:", err.message);
                        sendPairingToWeb(username, {
                            type: 'error',
                            message: `Gagal pairing: ${err.message}`,
                            number: cleanNumber,
                            status: 'error'
                        });
                    }
                }
            }
        });

        sock.ev.on("creds.update", saveCreds);

        let attempts = 0;
        while (!pairingCode && attempts < 15) {
            await sleep(2000);
            attempts++;
        }

        if (pairingCode) {
            return res.json({
                status: 'success',
                code: pairingCode,
                message: 'Kode pairing berhasil digenerate!'
            });
        } else {
            return res.json({
                status: 'error',
                message: 'Gagal mendapatkan kode pairing. Coba lagi!'
            });
        }

    } catch (error) {
        console.error("Pairing error:", error);
        return res.json({
            status: 'error',
            message: error.message || 'Terjadi kesalahan!'
        });
    }
});

app.get("/api/events", requireAuth, (req, res) => {
    const username = req.cookies.sessionUser;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    userEvents.set(username, res);
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (err) { clearInterval(heartbeat); }
    }, 30000);
    req.on('close', () => { clearInterval(heartbeat); userEvents.delete(username); });
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'ATOMIC CRASHER STREAM CONNECTED' })}\n\n`);
});

app.get("/api/pairing-events", requireAuth, (req, res) => {
    const username = req.cookies.sessionUser;
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    pairingEvents.set(username, res);
    const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch (err) { clearInterval(heartbeat); }
    }, 15000);
    req.on('close', () => { clearInterval(heartbeat); pairingEvents.delete(username); });
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'ATOMIC CRASHER PAIRING READY' })}\n\n`);
});

app.get("/logout", (req, res) => {
    res.clearCookie("sessionUser");
    res.clearCookie("sessionKey");
    res.redirect("/login");
});

// ==================== START SERVER ====================
console.clear();
console.log(chalk.cyanBright(`
╔═══════════════════════════════════╗
║  💥 ATOMIC CRASHER v5.0          ║
║  📱 WHATSAPP BUG EXECUTOR        ║
║  🔥 100% WORK                    ║
║  👤 OWNER: ${OwnerId}              ║
╚═══════════════════════════════════╝
`));

// ==================== LAUNCH BOT ====================
async function launchBot() {
    try {
        const me = await bot.telegram.getMe();
        console.log(chalk.green(`✓ ATOMIC CRASHER BOT: @${me.username}`));
        try { await bot.telegram.setWebhook({ url: '' }); } catch (e) {}
        await sleep(2000);
        bot.launch({ polling: { timeout: 30, limit: 100, retryTimeout: 5000 } });
        console.log(chalk.green('✓ BOT LAUNCHED'));
    } catch (err) {
        if (err.response?.error_code === 409) {
            console.log(chalk.yellow('⚠️ Conflict detected, reset...'));
            try { await bot.telegram.setWebhook({ url: '' }); } catch (e) {}
            await sleep(5000);
            bot.launch({ polling: { timeout: 30, limit: 100, retryTimeout: 5000 } });
            console.log(chalk.green('✓ BOT LAUNCHED'));
        } else {
            console.error(chalk.red('❌ Bot launch failed:'), err.message);
        }
    }
}

setTimeout(() => { console.log('🔄 Starting bot...'); launchBot(); }, 3000);

// ==================== START WEB SERVER ====================
app.listen(PORT, () => {
    console.log(`✓ Web panel: http://localhost:${PORT}`);
    console.log(chalk.green(`🌐 Login: http://localhost:${PORT}/login`));
});

module.exports = {
    loadAkses,
    saveAkses,
    isOwner,
    isAuthorized,
    saveUsers,
    getUsers
};