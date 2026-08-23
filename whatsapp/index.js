process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash Shield] Caught Uncaught Exception:', err.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash Shield] Caught Unhandled Rejection:', promise, 'reason:', reason);
});

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const readline = require('readline');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '', 10) || null;
const bridge = { qr: null, state: 'starting', user: null, events: [], pairCode: null, pairNumber: null };
let sock = null;

function evt(msg) {
    const line = String(msg);
    bridge.events.push(line.length > 120 ? line.slice(0, 120) : line);
    if (bridge.events.length > 40) bridge.events.shift();
    if (BRIDGE_PORT) console.log('[bridge]', line);
}

const AGENTIC_URL = (process.env.AGENTIC_URL || 'http://localhost:8000').replace(/\/+$/, '');
const AGENTIC_PASSWORD = process.env.AGENTIC_PASSWORD || 'test-pass';
const AGENTIC_MAX_MODELS = 40;
const AGENTIC_CHAT_TIMEOUT = 300000;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));
const qrcode = require('qrcode-terminal');
const sessions = {};
const botMessageIds = new Set();

let _agentToken = { token: null, at: 0 };

async function agentToken() {
    if (_agentToken.token && Date.now() - _agentToken.at < 60000) return _agentToken.token;
    try {
        const res = await fetch(AGENTIC_URL + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: AGENTIC_PASSWORD })
        });
        if (!res.ok) return null;
        const j = await res.json();
        _agentToken = { token: j.token, at: Date.now() };
        return j.token;
    } catch (e) { return null; }
}

async function agentApi(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = await agentToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(AGENTIC_URL + endpoint, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text };
}

async function agentProviders() {
    try {
        const r = await agentApi('/api/providers');
        if (r.status !== 200) return { error: `Cannot reach JARVIS at ${AGENTIC_URL} (HTTP ${r.status}).` };
        const providers = (r.json || []).filter(p => p && Array.isArray(p.models) && p.models.length > 0);
        if (!providers.length) return { error: 'No provider with models. Add one in Settings -> Models.' };
        return { providers };
    } catch (e) { return { error: `Cannot reach JARVIS: ${e.message}` }; }
}

function formatProviderList(providers) {
    return providers.map((p, i) => `${i + 1}. ${p.name} (${p.models.length} models)${p.api_key_set ? ' ✅' : ''}`).join('\n');
}

function formatModelList(models) {
    const shown = models.slice(0, AGENTIC_MAX_MODELS);
    const more = models.length > AGENTIC_MAX_MODELS ? `\n… and ${models.length - AGENTIC_MAX_MODELS} more` : '';
    return shown.map((m, i) => `${i + 1}. ${m}`).join('\n') + more;
}

async function runAgentTask(agentState, taskText) {
    const r = await agentApi('/api/sessions', 'POST', {});
    if (r.status !== 200) { agentState.progress = `JARVIS error: session failed (HTTP ${r.status})`; return null; }
    agentState.sessionId = r.json.id;

    const headers = { 'Content-Type': 'application/json' };
    const token = await agentToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
        res = await fetch(AGENTIC_URL + '/api/chat', {
            method: 'POST', headers,
            body: JSON.stringify({ session_id: agentState.sessionId, message: taskText, provider_id: agentState.providerId, model: agentState.model }),
            signal: AbortSignal.timeout(AGENTIC_CHAT_TIMEOUT)
        });
    } catch (e) { agentState.progress = 'JARVIS error: ' + e.message; return null; }
    if (!res.ok) { let d = ''; try { d = (await res.json()).detail || ''; } catch (e) {} agentState.progress = `JARVIS error: HTTP ${res.status} ${d}`; return null; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', full = '';

    while (!agentState.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            if (!raw.startsWith('data: ')) continue;
            let ev;
            try { ev = JSON.parse(raw.slice(6)); } catch (e) { continue; }
            if (ev.type === 'status') agentState.progress = ev.message || 'Thinking...';
            else if (ev.type === 'tool_call') agentState.progress = `Running: ${ev.name}`;
            else if (ev.type === 'tool_result') agentState.progress = `Result: ${ev.name}`;
            else if (ev.type === 'text') { full += ev.text; agentState.progress = 'Thinking...'; }
            else if (ev.type === 'done') full = ev.content || full;
            else if (ev.type === 'error') full = 'JARVIS error: ' + ev.message;
        }
    }
    if (agentState.aborted) return null;
    return full || 'JARVIS finished with no output.';
}

async function startBot() {
    let phoneNumber = "";
    let pendingPairing = false;
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    const needsLogin = !state.creds || !state.creds.registered;

    if (needsLogin && !BRIDGE_PORT) {
        console.clear();
        console.log('Login options:\n  1) QR code: press Enter\n  2) Pairing code: type your number with country code');
        phoneNumber = await question('👉 Enter your WhatsApp number (or press Enter for QR):\n');
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (phoneNumber) pendingPairing = true;
    } else if (needsLogin && BRIDGE_PORT) {
        console.log('[bridge] Waiting for QR/pairing via web app...');
    }

    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version, auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "14.4.1"],
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: undefined,
        connectTimeoutMs: 60000
    });

    const sendMessageSafe = async (jid, content, options = {}) => {
        try {
            const res = await sock.sendMessage(jid, content, options);
            if (res && res.key && res.key.id) {
                botMessageIds.add(res.key.id);
                if (botMessageIds.size > 2000) {
                    const nextDel = botMessageIds.values().next().value;
                    botMessageIds.delete(nextDel);
                }
            }
            return res;
        } catch (e) {
            console.error(`[Safe Send]`, e.message);
            return null;
        }
    };

    let connectionOpened = false;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (BRIDGE_PORT) {
            bridge.state = connection || bridge.state;
            if (sock.user) bridge.user = sock.user.id || null;
            if (connection === 'open') {
                bridge.qr = null;
                bridge.pairCode = null;
                evt('Connected. Bot ready.');
            }
        }

        if (qr) {
            console.log('\n📱 SCAN THIS QR CODE (WhatsApp -> Linked Devices):\n');
            qrcode.generate(qr, { small: true });
            if (BRIDGE_PORT) {
                evt('New QR generated — scan in web app.');
                try {
                    require('qrcode').toDataURL(qr, { errorCorrectionLevel: 'L', margin: 1, width: 260 }, (err, url) => {
                        bridge.qr = err ? null : url;
                    });
                } catch (e) {}
            }
        }

        if (connection === 'open') {
            connectionOpened = true;
            console.log('\n✅ WhatsApp Connected!');
            evt('Connected.');

            if (pendingPairing && phoneNumber && !sock.authState.creds.registered) {
                try {
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`\n🔑 YOUR PAIRING CODE: \x1b[1;32m${code}\x1b[0m`);
                    console.log('Open WhatsApp -> Linked Devices -> Link with phone number -> Enter the code above');
                    evt(`Pairing code for +${phoneNumber}: ${code}`);
                } catch (e) {
                    console.error('Pairing code error:', e.message || e);
                }
                pendingPairing = false;
            }
        }

        if (connection === 'close') {
            connectionOpened = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== 401;
            console.log(`\n⚠️ Connection closed (code: ${statusCode}). ${shouldReconnect ? 'Reconnecting...' : 'Logged out.'}`);
            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            for (const msg of m.messages) {
                if (!msg || !msg.message) continue;
                if (msg.key && msg.key.id && botMessageIds.has(msg.key.id)) continue;

                const from = msg.key.remoteJid;
                let msgContent = msg.message;

                if (msgContent.ephemeralMessage) msgContent = msgContent.ephemeralMessage.message;
                if (msgContent.viewOnceMessage) msgContent = msgContent.viewOnceMessage.message;
                if (msgContent.viewOnceMessageV2) msgContent = msgContent.viewOnceMessageV2.message;
                if (msgContent.documentWithCaptionMessage) msgContent = msgContent.documentWithCaptionMessage.message;

                if (!msgContent) continue;

                const streamType = msgContent.imageMessage ? 'image' :
                                   msgContent.videoMessage ? 'video' :
                                   msgContent.audioMessage ? 'audio' :
                                   msgContent.documentMessage ? 'document' : null;

                let text = (msgContent.conversation ||
                            msgContent.extendedTextMessage?.text ||
                            msgContent.imageMessage?.caption ||
                            msgContent.videoMessage?.caption ||
                            msgContent.documentMessage?.caption || '').trim();

                if (!text && !streamType) continue;

                if (msg.key.fromMe) {
                    const cleanText = text.replace(/[*_`~]/g, '');
                    const isBotReply = cleanText.includes('MODE ACTIVATED') ||
                                       cleanText.includes('MODE TERMINATED') ||
                                       cleanText.includes('Capturing:') ||
                                       cleanText.includes('Scroll:') ||
                                       cleanText.includes('Delay:') ||
                                       cleanText.includes('Result:') ||
                                       cleanText.includes('Failed:') ||
                                       cleanText.includes('Directory:') ||
                                       cleanText.includes('File not found') ||
                                       cleanText.includes('File captured') ||
                                       cleanText.includes('Progress:') ||
                                       cleanText.includes('Active Tasks') ||
                                       cleanText.includes('Tasks Terminated:') ||
                                       cleanText.includes('Command Guide') ||
                                       cleanText.includes('Kill:') ||
                                       cleanText.includes('valid media/document') ||
                                       cleanText.includes('Executed with no output');
                    if (isBotReply) continue;
                }

                if (!sessions[from]) sessions[from] = { mode: 'normal', cwd: '/home/ubuntu', tasks: [], agent: { step: 'idle', providers: [], providerId: null, model: null, task: null, progress: '', aborted: false, busy: false, sessionId: null } };
                const currentSession = sessions[from];

                if (text === '.help') {
                    let helpText = `📖 *JARVIS - Command Guide* 📖\n\n` +
                                   `💻 *.run <command>* — Run Linux command\n` +
                                   `📁 *.send <file>* — Download file from server\n` +
                                   `📥 *.get* — Send media with caption to upload\n` +
                                   `🌐 *.brows <url>* — Web screenshot\n` +
                                   `🤖 *.agent* — AI agent mode\n\n` +
                                   `⚙️ *.pro* — Task status | *.kill* — Stop task | *.stop* — Reset mode\n\n` +
                                   `💡 Paths default to \`/home/ubuntu\``;
                    await sendMessageSafe(from, { text: helpText });
                    continue;
                }

                if (text === '.pro') {
                    if (currentSession.mode === 'agent') {
                        const a = currentSession.agent;
                        if (a.busy) await sendMessageSafe(from, { text: `🧠 *Agent:* ${a.progress || 'Thinking...'}` });
                        else if (a.step !== 'idle') await sendMessageSafe(from, { text: `📋 *Step:* ${a.step}` });
                        else await sendMessageSafe(from, { text: '🧠 *Agent:* Idle. Send `.agent` to start.' });
                        continue;
                    }
                    const modeTasks = currentSession.tasks.filter(t => t.mode === currentSession.mode);
                    if (modeTasks.length > 0) {
                        let out = `📊 *Tasks (${currentSession.mode.toUpperCase()}):*`;
                        modeTasks.forEach(t => { out += `\n• \`${t.name}\` - *${t.progress}%*`; });
                        await sendMessageSafe(from, { text: out });
                    } else {
                        await sendMessageSafe(from, { text: `📊 No active tasks in *${currentSession.mode}* mode.` });
                    }
                    continue;
                }

                if (text === '.kill') {
                    if (currentSession.mode === 'agent') {
                        const a = currentSession.agent;
                        if (a.busy) { a.aborted = true; await sendMessageSafe(from, { text: '❌ Agent aborted.' }); }
                        else await sendMessageSafe(from, { text: '📊 No active agent task.' });
                        continue;
                    }
                    const modeTasks = currentSession.tasks.filter(t => t.mode === currentSession.mode);
                    if (modeTasks.length > 0) {
                        for (const t of modeTasks) {
                            t.wasKilled = true;
                            if (t.stream) try { t.stream.destroy(); } catch(e) {}
                            if (t.browser) try { await t.browser.close(); } catch(e) {}
                        }
                        currentSession.tasks = currentSession.tasks.filter(t => t.mode !== currentSession.mode);
                        await sendMessageSafe(from, { text: `❌ Tasks killed in *${currentSession.mode}* mode.` });
                    } else {
                        await sendMessageSafe(from, { text: `📊 No tasks to kill.` });
                    }
                    continue;
                }

                if (text === '.stop') {
                    if (currentSession.mode === 'agent') currentSession.agent.aborted = true;
                    currentSession.mode = 'normal';
                    await sendMessageSafe(from, { text: '✅ Mode reset.' });
                    continue;
                }

                if (text) {
                    if (text === '.run' || text.startsWith('.run ')) {
                        currentSession.mode = 'run';
                        if (text === '.run') { await sendMessageSafe(from, { text: `💻 *RUN MODE*\n📂 \`${currentSession.cwd}\`` }); continue; }
                        text = text.slice(5).trim();
                    } else if (text === '.send' || text.startsWith('.send ')) {
                        currentSession.mode = 'send';
                        if (text === '.send') { await sendMessageSafe(from, { text: '📁 *SEND MODE*\nSend file name.' }); continue; }
                        text = text.slice(6).trim();
                    } else if (text === '.get' || text.startsWith('.get ')) {
                        currentSession.mode = 'get';
                        if (text === '.get') { await sendMessageSafe(from, { text: '📥 *GET MODE*\nSend media with caption.' }); continue; }
                        text = text.slice(4).trim();
                    } else if (text === '.brows' || text.startsWith('.brows ')) {
                        currentSession.mode = 'brows';
                        if (text === '.brows') { await sendMessageSafe(from, { text: '🌐 *BROWSE MODE*\nSend URL.' }); continue; }
                        text = text.slice(7).trim();
                    } else if (text === '.agent' || text.startsWith('.agent ')) {
                        currentSession.mode = 'agent';
                        const a = currentSession.agent;
                        a.aborted = false; a.busy = false; a.task = null; a.sessionId = null;
                        a.progress = 'Loading providers...';
                        await sendMessageSafe(from, { text: `🤖 *AGENT MODE*\nConnecting to JARVIS...` });

                        const { providers, error } = await agentProviders();
                        if (error) {
                            currentSession.mode = 'normal';
                            await sendMessageSafe(from, { text: `❌ ${error}` });
                            continue;
                        }
                        a.providers = providers; a.step = 'provider';
                        await sendMessageSafe(from, { text: `🏷️ *Choose provider:*\n\n${formatProviderList(providers)}` });
                        continue;
                    }
                }

                if (currentSession.mode === 'agent') {
                    const a = currentSession.agent;
                    if (a.busy) { await sendMessageSafe(from, { text: `⏳ Running... \`.pro\` or \`.kill\`` }); continue; }
                    if (a.step === 'provider') {
                        const n = parseInt(text, 10);
                        if (!n || n < 1 || n > a.providers.length) { await sendMessageSafe(from, { text: `❌ Enter 1-${a.providers.length}` }); continue; }
                        a.providerId = String(a.providers[n - 1].id);
                        a.models = a.providers[n - 1].models; a.step = 'model';
                        await sendMessageSafe(from, { text: `🏷️ *${a.providers[n - 1].name}* — choose model:\n\n${formatModelList(a.models)}` });
                        continue;
                    }
                    if (a.step === 'model') {
                        const n = parseInt(text, 10);
                        if (!n || n < 1 || n > a.models.length) { await sendMessageSafe(from, { text: `❌ Enter 1-${a.models.length}` }); continue; }
                        a.model = a.models[n - 1]; a.step = 'task';
                        await sendMessageSafe(from, { text: `🎯 Model *${a.model}*\n\n📝 Describe your task:` });
                        continue;
                    }
                    if (a.step === 'task' && text) {
                        a.task = text; a.step = 'idle'; a.busy = true; a.aborted = false; a.progress = 'Starting...';
                        await sendMessageSafe(from, { text: `🚀 Running: \`${a.model}\`\nTask: ${text}` });
                        (async () => {
                            try {
                                const output = await runAgentTask(a, text);
                                if (a.aborted) return;
                                await sendMessageSafe(from, { text: output ? `✅ *Done!*\n\n${output}` : `❌ ${a.progress}` });
                            } catch (e) {
                                if (!a.aborted) await sendMessageSafe(from, { text: `❌ ${e.message}` });
                            } finally {
                                a.busy = false; a.aborted = false; a.step = 'task';
                                await sendMessageSafe(from, { text: `Send another task or \`.stop\` to exit.` });
                            }
                        })();
                        continue;
                    }
                }

                if (currentSession.mode === 'normal') continue;
                if (!text && currentSession.mode !== 'get') continue;

                if (currentSession.mode === 'run') {
                    const wrappedCommand = `cd '${currentSession.cwd.replace(/'/g, "'\\''")}' && ${text} ; echo "___CWD_TOKEN___" ; pwd`;
                    exec(wrappedCommand, { shell: '/bin/bash' }, async (err, stdout, stderr) => {
                        let cleanStdout = stdout;
                        if (stdout.includes('___CWD_TOKEN___')) {
                            const parts = stdout.split('___CWD_TOKEN___');
                            cleanStdout = parts[0] ? parts[0].trim() : '';
                            const parsedCwd = parts[1] ? parts[1].trim() : currentSession.cwd;
                            if (fs.existsSync(parsedCwd)) currentSession.cwd = parsedCwd;
                        }
                        await sendMessageSafe(from, { text: `💻 *${currentSession.cwd}*\n\n${cleanStdout || stderr || err?.message || 'No output.'}` });
                    });
                    continue;
                }

                if (currentSession.mode === 'send') {
                    const filePath = path.isAbsolute(text) ? text : path.join(currentSession.cwd, text);
                    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) { await sendMessageSafe(from, { text: `❌ Not found: \`${filePath}\`` }); continue; }
                    const fileName = path.basename(filePath);
                    const totalBytes = fs.statSync(filePath).size;
                    const currentTaskId = Date.now();
                    const readStream = fs.createReadStream(filePath);
                    const taskObj = { id: currentTaskId, name: fileName, progress: 0, stream: readStream, browser: null, wasKilled: false, mode: 'send' };
                    currentSession.tasks.push(taskObj);
                    (async () => {
                        let fileBuffer = Buffer.from([]);
                        try {
                            for await (const chunk of readStream) {
                                fileBuffer = Buffer.concat([fileBuffer, chunk]);
                                const lt = currentSession.tasks.find(t => t.id === currentTaskId);
                                if (!lt || lt.wasKilled) return;
                                lt.progress = Math.round((fileBuffer.length / totalBytes) * 100);
                            }
                            let opts = { document: fileBuffer, fileName, mimetype: 'application/octet-stream' };
                            if (/\.(jpg|jpeg|png)$/i.test(fileName)) opts = { image: fileBuffer, caption: fileName };
                            else if (/\.(mp4|3gp|mkv)$/i.test(fileName)) opts = { video: fileBuffer, caption: fileName };
                            else if (/\.(mp3|wav|m4a|ogg)$/i.test(fileName)) opts = { audio: fileBuffer, mimetype: 'audio/mp4' };
                            const lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (lt && !lt.wasKilled) await sendMessageSafe(from, opts);
                        } catch (e) {
                            const lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (lt && !lt.wasKilled) await sendMessageSafe(from, { text: '❌ Send failed: ' + e.message });
                        } finally { currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId); }
                    })();
                    continue;
                }

                if (currentSession.mode === 'get') {
                    if (!streamType) { await sendMessageSafe(from, { text: '❌ Send media/document.' }); continue; }
                    let dest = text.replace(/['"]/g, '');
                    const mediaMessage = msgContent[streamType + 'Message'];
                    const defaultName = mediaMessage.fileName || `file_${Date.now()}.${mediaMessage.mimetype?.split('/')[1]?.split(';')[0] || 'bin'}`;
                    const totalBytes = parseInt(mediaMessage.fileLength || 0);
                    const currentTaskId = Date.now();
                    let finalPath;
                    if (!dest) { finalPath = path.join('/home/ubuntu', defaultName); }
                    else {
                        finalPath = path.isAbsolute(dest) ? dest : path.join(currentSession.cwd || '/home/ubuntu', dest);
                        if (!path.extname(finalPath)) {
                            if (!fs.existsSync(finalPath)) fs.mkdirSync(finalPath, { recursive: true });
                            finalPath = path.join(finalPath, defaultName);
                        } else { const dir = path.dirname(finalPath); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
                    }
                    const stream = await downloadContentFromMessage(mediaMessage, streamType);
                    const taskObj = { id: currentTaskId, name: path.basename(finalPath), progress: 0, stream, browser: null, wasKilled: false, mode: 'get' };
                    currentSession.tasks.push(taskObj);
                    (async () => {
                        let buffer = Buffer.from([]);
                        try {
                            for await (const chunk of stream) {
                                buffer = Buffer.concat([buffer, chunk]);
                                const lt = currentSession.tasks.find(t => t.id === currentTaskId);
                                if (!lt || lt.wasKilled) return;
                                if (totalBytes > 0) lt.progress = Math.round((buffer.length / totalBytes) * 100);
                            }
                            fs.writeFileSync(finalPath, buffer);
                            await sendMessageSafe(from, { text: `✅ Saved: \`${finalPath}\`` });
                        } catch (e) {
                            const lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (lt && !lt.wasKilled) await sendMessageSafe(from, { text: '❌ Get failed: ' + e.message });
                        } finally { currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId); }
                    })();
                    continue;
                }

                if (currentSession.mode === 'brows') {
                    const tokens = text.split(/\s+/);
                    let targetUrl = tokens[0];
                    let scrollParam = '30%';
                    let delayParam = 2000;
                    for (let i = 1; i < tokens.length; i++) {
                        if (tokens[i] === '-p' && tokens[i + 1]) { scrollParam = tokens[i + 1]; i++; }
                        else if (tokens[i] === '-d' && tokens[i + 1]) { delayParam = parseInt(tokens[i + 1]) || 2000; i++; }
                    }
                    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
                    await sendMessageSafe(from, { text: `⏳ *Capturing:* ${targetUrl}` });
                    const currentTaskId = Date.now();
                    const taskObj = { id: currentTaskId, name: targetUrl, progress: 10, stream: null, browser: null, wasKilled: false, mode: 'brows' };
                    currentSession.tasks.push(taskObj);
                    (async () => {
                        let browser;
                        try {
                            const puppeteer = require('puppeteer');
                            let lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (lt) lt.progress = 30;
                            browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
                            lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (!lt || lt.wasKilled) { await browser.close(); return; }
                            lt.browser = browser; lt.progress = 50;
                            const page = await browser.newPage();
                            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36');
                            await page.setViewport({ width: 1280, height: 800 });
                            try { await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 }); } catch (e) {}
                            lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (!lt || lt.wasKilled) { await browser.close(); return; }
                            lt.progress = 70;
                            await page.evaluate(async (sp) => {
                                await new Promise((resolve) => {
                                    let total = 0; const dist = 400;
                                    const max = sp.includes('%') ? (document.body.scrollHeight * (parseInt(sp) || 30)) / 100 : (parseInt(sp) || 3200);
                                    const timer = setInterval(() => { window.scrollBy(0, dist); total += dist; if (total >= document.body.scrollHeight || total >= max) { clearInterval(timer); resolve(); } }, 200);
                                });
                            }, scrollParam);
                            await new Promise(r => setTimeout(r, delayParam));
                            lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (!lt || lt.wasKilled) { await browser.close(); return; }
                            lt.progress = 90;
                            const buf = await page.screenshot();
                            await browser.close();
                            lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (lt && !lt.wasKilled) await sendMessageSafe(from, { image: buf, caption: `🌐 ${targetUrl}` });
                        } catch (e) {
                            if (browser) try { await browser.close(); } catch(err) {}
                            const lt = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (lt && !lt.wasKilled) await sendMessageSafe(from, { text: '❌ Browse failed: ' + e.message });
                        } finally { currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId); }
                    })();
                    continue;
                }
            }
        } catch (error) { console.error(error); }
    });
}

startBot();

if (BRIDGE_PORT) {
    const http = require('http');
    http.createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
        const url = (req.url || '/').split('?')[0];
        try {
            if (url === '/status') {
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ ok: true, state: bridge.state, connected: bridge.state === 'open', user: bridge.user, qr: bridge.qr, pairCode: bridge.pairCode, pairNumber: bridge.pairNumber, events: bridge.events }));
            }
            if (url === '/pair') {
                let body = '';
                req.on('data', (c) => { body += c; });
                return req.on('end', async () => {
                    let num = '';
                    try { num = String(JSON.parse(body || '{}').number || '').replace(/[^0-9]/g, ''); } catch (e) {}
                    res.setHeader('Content-Type', 'application/json');
                    if (!num) return res.end(JSON.stringify({ ok: false, error: 'number required' }));
                    try {
                        if (sock && sock.authState && sock.authState.creds.registered) {
                            return res.end(JSON.stringify({ ok: true, code: null, message: 'already logged in' }));
                        }
                        const code = await sock.requestPairingCode(num);
                        bridge.pairCode = code; bridge.pairNumber = num;
                        evt(`Pairing code for +${num}: ${code}`);
                        return res.end(JSON.stringify({ ok: true, code }));
                    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
                });
            }
            if (url === '/logout') {
                try { await sock.logout(); } catch (e) {}
                bridge.qr = null; bridge.state = 'logged-out';
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ ok: true }));
            }
            res.statusCode = 404; return res.end('{}');
        } catch (e) { res.statusCode = 500; return res.end(JSON.stringify({ error: e.message })); }
    }).listen(BRIDGE_PORT, () => { console.log(`[bridge] WhatsApp bridge on http://127.0.0.1:${BRIDGE_PORT}`); });
}
