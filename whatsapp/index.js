// PRODUCTION APPARATUS ANTI-CRASH INTERCEPTORS
process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash Shield] Caught Uncaught Exception:', err.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Anti-Crash Shield] Caught Unhandled Rejection at:', promise, 'reason:', reason);
});

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { exec } = require('child_process');
const readline = require('readline');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Bridge mode: BRIDGE_PORT set -> serve the login QR/status over HTTP so the
// JARVIS web app can show the login QR (Settings -> Bots).
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '', 10) || null;
const bridge = { qr: null, state: 'starting', user: null, events: [], pairCode: null, pairNumber: null };
let sock = null;

function evt(msg) {
    const line = String(msg);
    bridge.events.push(line.length > 120 ? line.slice(0, 120) : line);
    if (bridge.events.length > 40) bridge.events.shift();
    if (BRIDGE_PORT) console.log('[bridge]', line);
}

// ============================================================
// JARVIS integration config
//   AGENTIC_URL      -> your JARVIS server (default localhost:8000)
//   AGENTIC_PASSWORD -> admin password for /api/auth/login
//   (if your server runs with OPEN_ACCESS=true, no password is needed)
// ============================================================
const AGENTIC_URL = (process.env.AGENTIC_URL || 'http://localhost:8000').replace(/\/+$/, '');
const AGENTIC_PASSWORD = process.env.AGENTIC_PASSWORD || 'test-pass';
const AGENTIC_MAX_MODELS = 40;   // cap the numbered model list per message
const AGENTIC_CHAT_TIMEOUT = 300000;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));
const qrcode = require('qrcode-terminal');
const sessions = {};
const botMessageIds = new Set(); // லூப் பிழைகளைத் தடுக்க தனித்துவமான மெசேஜ் ஐடி டிராக்கர்

// ---------- JARVIS helpers ----------
let _agentToken = { token: null, at: 0 };

async function agentToken() {
    if (_agentToken.token && Date.now() - _agentToken.at < 60000) return _agentToken.token;
    try {
        const res = await fetch(AGENTIC_URL + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: AGENTIC_PASSWORD })
        });
        if (!res.ok) return null; // OPEN_ACCESS server -> anonymous allowed
        const j = await res.json();
        _agentToken = { token: j.token, at: Date.now() };
        return j.token;
    } catch (e) {
        return null;
    }
}

async function agentApi(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const token = await agentToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(AGENTIC_URL + endpoint, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-json */ }
    return { status: res.status, json, text };
}

async function agentProviders() {
    try {
        const r = await agentApi('/api/providers');
        if (r.status !== 200) return { error: `Cannot reach JARVIS at ${AGENTIC_URL} (HTTP ${r.status}). Check AGENTIC_URL, password, and that the server is running.` };
        const providers = (r.json || []).filter(p => p && Array.isArray(p.models) && p.models.length > 0);
        if (!providers.length) return { error: 'JARVIS has no provider with models. Add a key in Settings -> Models first.' };
        return { providers };
    } catch (e) {
        return { error: `Cannot reach JARVIS at ${AGENTIC_URL}: ${e.message}` };
    }
}

function formatProviderList(providers) {
    return providers.map((p, i) => `${i + 1}. ${p.name} (${p.models.length} models)${p.api_key_set ? ' ✅' : ''}`).join('\n');
}

function formatModelList(models) {
    const shown = models.slice(0, AGENTIC_MAX_MODELS);
    const more = models.length > AGENTIC_MAX_MODELS ? `\n… and ${models.length - AGENTIC_MAX_MODELS} more` : '';
    return shown.map((m, i) => `${i + 1}. ${m}`).join('\n') + more;
}

function sendChunked(jid, text) {
    const parts = text.match(/[\s\S]{1,3900}/g) || [text];
    return Promise.all(parts.map(p => sendMessageSafe(jid, { text: p })));
}

// Streams an JARVIS chat task; keeps the session's agent state (progress)
// updated so `.pro` can show live status. Returns final text or null if aborted.
async function runAgentTask(agentState, taskText) {
    const r = await agentApi('/api/sessions', 'POST', {});
    if (r.status !== 200) {
        agentState.progress = `JARVIS error: cannot create session (HTTP ${r.status})`;
        return null;
    }
    agentState.sessionId = r.json.id;

    const headers = { 'Content-Type': 'application/json' };
    const token = await agentToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
        res = await fetch(AGENTIC_URL + '/api/chat', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                session_id: agentState.sessionId,
                message: taskText,
                provider_id: agentState.providerId,
                model: agentState.model
            }),
            signal: AbortSignal.timeout(AGENTIC_CHAT_TIMEOUT)
        });
    } catch (e) {
        agentState.progress = 'JARVIS error: ' + e.message;
        return null;
    }
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).detail || ''; } catch (e) {}
        agentState.progress = `JARVIS error: HTTP ${res.status} ${detail}`;
        return null;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';

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
            if (ev.type === 'status') {
                agentState.progress = ev.message || 'Thinking...';
            } else if (ev.type === 'tool_call') {
                agentState.progress = `Running command: ${ev.name} ${JSON.stringify(ev.arguments || {})}`;
            } else if (ev.type === 'tool_result') {
                agentState.progress = `Command result received (${ev.name})`;
            } else if (ev.type === 'text') {
                full += ev.text;
                agentState.progress = 'Thinking...';
            } else if (ev.type === 'done') {
                full = ev.content || full;
            } else if (ev.type === 'error') {
                full = 'JARVIS error: ' + ev.message;
            }
        }
    }
    if (agentState.aborted) return null;
    return full || 'JARVIS finished with no output.';
}

async function startBot() {
    let phoneNumber = "";
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    if (!state.creds || !state.creds.registered) {
        if (!BRIDGE_PORT) {
            console.clear();
            console.log('Login options:\n  1) WhatsApp Web style: press Enter now and scan the QR code that prints below\n  2) Pairing code: type your WhatsApp number with country code, then enter the code in the app');
            phoneNumber = await question('👉 Enter your WhatsApp number with country code (or just press Enter for QR login):\n');
            phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
        } else {
            console.log('[bridge] Waiting for QR scan (see the web app: Settings -> Bots)');
        }
    }

    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Mac OS", "Chrome", "10.15.7"],
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
            console.error(`[Safe Send Bypass] Intercepted socket send failure:`, e.message);
            return null;
        }
    };

    if (!sock.authState.creds.registered && phoneNumber) {
        const requestPairing = async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n🔑 YOUR VALID PAIRING CODE IS: \x1b[1;32m${code}\x1b[0m`);
            } catch (e) { console.error(e.message || e); }
        };
        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'open') requestPairing();
        });
    }

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        if (BRIDGE_PORT) {
            bridge.state = update.connection || bridge.state;
            if (sock.user) bridge.user = sock.user.id || null;
            if (update.connection === 'open') {
                bridge.qr = null;
                bridge.pairCode = null;
                evt('Connected. Bot ready (use .agent, .run, ... in WhatsApp).');
            }
        }
        if (update.qr) {
            console.log('\n📱 SCAN THIS QR CODE (WhatsApp -> Linked Devices). It refreshes automatically if it expires:\n');
            qrcode.generate(update.qr, { small: true });
            if (BRIDGE_PORT) {
                evt('New login QR generated — scan it in the web app or on the terminal.');
                try {
                    require('qrcode').toDataURL(update.qr, { errorCorrectionLevel: 'L', margin: 1, width: 260 }, (err, url) => {
                        bridge.qr = err ? null : url;
                    });
                } catch (e) { /* qrcode lib missing -> CLI only */ }
            }
            return;
        }
        if (update.connection === 'open') console.log('\n✅ System Connected Securely! Infinite Loop Shield Active.');
        if (update.connection === 'close') startBot();
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            for (const msg of m.messages) {
                if (!msg || !msg.message) continue;

                // முதற்கட்ட பாதுகாப்பு: பாட் அனுப்பிய மெசேஜ் ஐடி என்றால் உடனடியாகப் புறக்கணிக்கவும்
                if (msg.key && msg.key.id && botMessageIds.has(msg.key.id)) {
                    continue;
                }

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

                // இரண்டாம் கட்ட பாதுகாப்பு (Fallback Text Filter)
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
                    let helpText = `📖 *TCZone AI - Command Guide* 📖\n\n` +
                                   `🤖 *Available Core Modes & Examples:*\n\n` +
                                   `💻 *1. RUN MODE (Linux Terminal)*\n` +
                                   `• Format: \`.run <command>\`\n` +
                                   `• Example: \`.run ls -la\` or \`.run node -v\`\n\n` +
                                   `📁 *2. SEND MODE (File Downloader)*\n` +
                                   `• Format: \`.send <file_name>\`\n` +
                                   `• Example: \`.send video.mp4\`\n\n` +
                                   `📥 *3. GET MODE (File Uploader)*\n` +
                                   `• Format: Send media with caption \`<save_path>\`\n\n` +
                                   `🌐 *4. BROWSE MODE (Web Screenshot & Custom Controls)*\n` +
                                   `• Format: \`.brows <url> [-p scroll_value] [-d delay_ms]\`\n` +
                                   `• Example 1: \`.brows youtube.com -p 50% -d 6000\`\n` +
                                   `• Example 2: \`.brows google.com -p 2000 -d 3000\`\n` +
                                   `• *Flags Definition:*\n` +
                                   `  \`-p\` : ஸ்க்ரோல் அளவு (e.g., \`40%\` அல்லது \`3000\`. Default: \`30%\`)\n` +
                                   `  \`-d\` : லோடிங் தாமதம் மில்லிசெகண்டில் (Default: \`2000\`)\n\n` +
                                   `🤖 *5. AGENT MODE (JARVIS)*\n` +
                                   `• Format: \`.agent\`\n` +
                                   `• Picks a provider -> picks a model (by id) -> describe a task\n` +
                                   `• Replies with the agent's final output\n` +
                                   `• \`.pro\` shows live status (Thinking / Running command: ...)\n` +
                                   `• \`.kill\` aborts the running task\n\n` +
                                   `⚙️ *Task Control (Isolated per Mode):*\n` +
                                   `• \`.pro\` - Check active background tasks progress\n` +
                                   `• \`.kill\` - Stop running processes in current mode safely\n` +
                                   `• \`.stop\` - Exit interactive mode and reset to normal\n\n` +
                                   `💡 *Note:* Target paths/files default to \`/home/ubuntu\` if not specified.`;
                    
                    await sendMessageSafe(from, { text: helpText });
                    continue;
                }

                if (text === '.pro') {
                    // AGENT MODE: live status of the JARVIS task
                    if (currentSession.mode === 'agent') {
                        const a = currentSession.agent;
                        if (a.busy) {
                            await sendMessageSafe(from, { text: `🧠 *Agent Status:*\n${a.progress || 'Thinking...'}` });
                        } else if (a.step !== 'idle') {
                            const stepMap = { provider: 'Pick a provider (reply with a number)', model: 'Pick a model (reply with a number)', task: 'Describe your task' };
                            await sendMessageSafe(from, { text: `📋 *Agent Step:* ${stepMap[a.step] || a.step}` });
                        } else {
                            await sendMessageSafe(from, { text: '🧠 *Agent:* No active task. Send \`.agent\` to start.' });
                        }
                        continue;
                    }
                    const modeTasks = currentSession.tasks.filter(t => t.mode === currentSession.mode);
                    if (modeTasks.length > 0) {
                        let out = `📊 *Active Tasks (${currentSession.mode.toUpperCase()} MODE):*`;
                        modeTasks.forEach(t => {
                            out += `\n• \`${t.name}\` - *${t.progress}%*`;
                        });
                        await sendMessageSafe(from, { text: out });
                    } else {
                        await sendMessageSafe(from, { text: `📊 *Progress:* No active background tasks running in *${currentSession.mode}* mode.` });
                    }
                    continue;
                }

                if (text === '.kill') {
                    // AGENT MODE: abort the running JARVIS task
                    if (currentSession.mode === 'agent') {
                        const a = currentSession.agent;
                        if (a.busy) {
                            a.aborted = true;
                            await sendMessageSafe(from, { text: '❌ *Agent task aborted.*' });
                        } else {
                            await sendMessageSafe(from, { text: '📊 *Kill:* No active agent task to abort.' });
                        }
                        continue;
                    }
                    const modeTasks = currentSession.tasks.filter(t => t.mode === currentSession.mode);
                    if (modeTasks.length > 0) {
                        let killedNames = [];
                        for (const t of modeTasks) {
                            t.wasKilled = true;
                            killedNames.push(`\`${t.name}\``);
                            if (t.stream) { try { t.stream.destroy(); } catch(e){} }
                            if (t.browser) { try { await t.browser.close(); } catch(e){} }
                        }
                        currentSession.tasks = currentSession.tasks.filter(t => t.mode !== currentSession.mode);
                        await sendMessageSafe(from, { text: `❌ *Tasks Terminated:* Killed processes inside *${currentSession.mode}* mode: ${killedNames.join(', ')}` });
                    } else {
                        await sendMessageSafe(from, { text: `📊 *Kill:* No active background tasks found to kill in *${currentSession.mode}* mode.` });
                    }
                    continue;
                }

                if (text === '.stop') {
                    if (currentSession.mode === 'agent') currentSession.agent.aborted = true;
                    currentSession.mode = 'normal';
                    await sendMessageSafe(from, { text: `✅ *MODE TERMINATED*\nInteractive mode reset.` });
                    continue;
                }

                if (text) {
                    if (text === '.run' || text.startsWith('.run ')) {
                        currentSession.mode = 'run';
                        if (text === '.run') {
                            await sendMessageSafe(from, { text: `💻 *RUN MODE ACTIVATED*\n📂 CWD: \`${currentSession.cwd}\`` });
                            continue;
                        }
                        text = text.slice(5).trim();
                    }
                    else if (text === '.send' || text.startsWith('.send ')) {
                        currentSession.mode = 'send';
                        if (text === '.send') {
                            await sendMessageSafe(from, { text: `📁 *SEND MODE ACTIVATED*\nSend file name to download.` });
                            continue;
                        }
                        text = text.slice(6).trim();
                    }
                    else if (text === '.get' || text.startsWith('.get ')) {
                        currentSession.mode = 'get';
                        if (text === '.get') {
                            await sendMessageSafe(from, { text: `📥 *GET MODE ACTIVATED*\nSend media with caption to upload.` });
                            continue;
                        }
                        text = text.slice(4).trim();
                    }
                    else if (text === '.brows' || text.startsWith('.brows ')) {
                        currentSession.mode = 'brows';
                        if (text === '.brows') {
                            await sendMessageSafe(from, { text: `🌐 *BROWSE MODE ACTIVATED*\nSend URL now.` });
                            continue;
                        }
                        text = text.slice(7).trim();
                    }
                    else if (text === '.agent' || text.startsWith('.agent ')) {
                        // ================= AGENT MODE (JARVIS) =================
                        currentSession.mode = 'agent';
                        const a = currentSession.agent;
                        a.aborted = false;
                        a.busy = false;
                        a.task = null;
                        a.sessionId = null;
                        a.progress = 'Loading model list...';
                        await sendMessageSafe(from, { text: `🤖 *AGENT MODE ACTIVATED*\nConnecting to JARVIS at \`${AGENTIC_URL}\` ...` });

                        const { providers, error } = await agentProviders();
                        if (error) {
                            currentSession.mode = 'normal';
                            await sendMessageSafe(from, { text: `❌ ${error}\n\n✅ MODE TERMINATED.` });
                            continue;
                        }
                        a.providers = providers;
                        a.step = 'provider';
                        await sendMessageSafe(from, {
                            text: `🏷️ *Choose a provider (reply with the number):*\n\n${formatProviderList(providers)}`
                        });
                        continue;
                    }
                }

                // ================= AGENT MODE step machine =================
                if (currentSession.mode === 'agent') {
                    const a = currentSession.agent;
                    if (a.busy) {
                        await sendMessageSafe(from, { text: `⏳ Task still running... use \`.pro\` for status or \`.kill\` to abort.` });
                        continue;
                    }
                    if (a.step === 'provider') {
                        const n = parseInt(text, 10);
                        if (!n || n < 1 || n > a.providers.length) {
                            await sendMessageSafe(from, { text: `❌ Invalid id. Reply with a number 1-${a.providers.length}.` });
                            continue;
                        }
                        a.providerId = String(a.providers[n - 1].id);
                        a.models = a.providers[n - 1].models;
                        a.step = 'model';
                        await sendMessageSafe(from, {
                            text: `🏷️ *${a.providers[n - 1].name}* — choose a model (reply with the number):\n\n${formatModelList(a.models)}`
                        });
                        continue;
                    }
                    if (a.step === 'model') {
                        const n = parseInt(text, 10);
                        if (!n || n < 1 || n > a.models.length) {
                            await sendMessageSafe(from, { text: `❌ Invalid id. Reply with a number 1-${a.models.length}.` });
                            continue;
                        }
                        a.model = a.models[n - 1];
                        a.step = 'task';
                        await sendMessageSafe(from, { text: `🎯 Model *${a.model}* selected.\n\n📝 Now describe the task for JARVIS:\n(e.g. "create a python script that prints fibonacci")` });
                        continue;
                    }
                    if (a.step === 'task' && text) {
                        a.task = text;
                        a.step = 'idle';
                        a.busy = true;
                        a.aborted = false;
                        a.progress = 'Starting...';
                        await sendMessageSafe(from, { text: `🚀 *Agent running:*\nModel: \`${a.model}\`\nTask: ${text}\n\nUse \`.pro\` for live status, \`.kill\` to abort.` });

                        (async () => {
                            try {
                                const output = await runAgentTask(a, text);
                                if (a.aborted) return;
                                if (output === null) {
                                    await sendMessageSafe(from, { text: `❌ *Agent Failed:* ${a.progress || 'unknown error'}` });
                                } else {
                                    await sendMessageSafe(from, { text: `✅ *Agent Done!*\n\n${output}` });
                                }
                            } catch (e) {
                                if (!a.aborted) {
                                    await sendMessageSafe(from, { text: `❌ *Agent Failed:* ${e.message}` });
                                }
                            } finally {
                                a.busy = false;
                                a.aborted = false;
                                a.step = 'task'; // ready for the next task
                                await sendMessageSafe(from, { text: `Send another task to continue, or \`.stop\` to exit agent mode.` });
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
                        const feedback = cleanStdout || stderr || err?.message || 'Executed with no output.';
                        await sendMessageSafe(from, { text: `💻 *Directory:* \`${currentSession.cwd}\`\n\n${feedback}` });
                    });
                    continue;
                }

                if (currentSession.mode === 'send') {
                    const normalizedInput = text.replace(/['"]/g, '');
                    const filePath = path.isAbsolute(normalizedInput) ? normalizedInput : path.join(currentSession.cwd, normalizedInput);
                    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
                        await sendMessageSafe(from, { text: `❌ File not found: \`${filePath}\`` });
                        continue;
                    }
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
                                const liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                                if (!liveTask || liveTask.wasKilled) return; 
                                liveTask.progress = Math.round((fileBuffer.length / totalBytes) * 100);
                            }
                            
                            let opts = { document: fileBuffer, fileName: fileName, mimetype: 'application/octet-stream' };
                            if (/\.(jpg|jpeg|png)$/i.test(fileName)) opts = { image: fileBuffer, caption: fileName };
                            else if (/\.(mp4|3gp|mkv)$/i.test(fileName)) opts = { video: fileBuffer, caption: fileName };
                            else if (/\.(mp3|wav|m4a|ogg)$/i.test(fileName)) opts = { audio: fileBuffer, mimetype: 'audio/mp4' };
                            
                            const liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (liveTask && !liveTask.wasKilled) {
                                await sendMessageSafe(from, opts);
                            }
                        } catch (e) {
                            const liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (liveTask && !liveTask.wasKilled) {
                                await sendMessageSafe(from, { text: '❌ *Send Failed:* ' + e.message });
                            }
                        } finally {
                            currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId);
                        }
                    })();
                    continue;
                }

                if (currentSession.mode === 'get') {
                    if (!streamType) {
                        await sendMessageSafe(from, { text: '❌ Please send a valid media/document attachment.' });
                        continue;
                    }

                    let dest = text.replace(/['"]/g, '');
                    const mediaMessage = msgContent[streamType + 'Message'];
                    const defaultName = mediaMessage.fileName || `file_${Date.now()}.${mediaMessage.mimetype?.split('/')[1]?.split(';')[0] || 'bin'}`;
                    const totalBytes = parseInt(mediaMessage.fileLength || 0);
                    const currentTaskId = Date.now();

                    let finalPath;
                    if (!dest) {
                        finalPath = path.join('/home/ubuntu', defaultName);
                    } else {
                        finalPath = path.isAbsolute(dest) ? dest : path.join(currentSession.cwd || '/home/ubuntu', dest);
                        if (!path.extname(finalPath)) {
                            if (!fs.existsSync(finalPath)) fs.mkdirSync(finalPath, { recursive: true });
                            finalPath = path.join(finalPath, defaultName);
                        } else {
                            const dir = path.dirname(finalPath);
                            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        }
                    }

                    const stream = await downloadContentFromMessage(mediaMessage, streamType);
                    const taskObj = { id: currentTaskId, name: path.basename(finalPath), progress: 0, stream: stream, browser: null, wasKilled: false, mode: 'get' };
                    currentSession.tasks.push(taskObj);

                    (async () => {
                        let buffer = Buffer.from([]);
                        try {
                            for await (const chunk of stream) {
                                buffer = Buffer.concat([buffer, chunk]);
                                const liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                                if (!liveTask || liveTask.wasKilled) return;
                                if (totalBytes > 0) {
                                    liveTask.progress = Math.round((buffer.length / totalBytes) * 100);
                                }
                            }
                            fs.writeFileSync(finalPath, buffer);
                            await sendMessageSafe(from, { text: `✅ File captured inside: \`${finalPath}\`` });
                        } catch (e) {
                            const liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (liveTask && !liveTask.wasKilled) {
                                await sendMessageSafe(from, { text: '❌ *Get Failed:* ' + e.message });
                            }
                        } finally {
                            currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId);
                        }
                    })();
                    continue;
                }

                if (currentSession.mode === 'brows') {
                    const tokens = text.split(/\s+/);
                    let targetUrl = tokens[0];
                    let scrollParam = '30%';
                    let delayParam = 2000;

                    for (let i = 1; i < tokens.length; i++) {
                        if (tokens[i] === '-p' && tokens[i + 1]) {
                            scrollParam = tokens[i + 1];
                            i++;
                        } else if (tokens[i] === '-d' && tokens[i + 1]) {
                            delayParam = parseInt(tokens[i + 1]) || 2000;
                            i++;
                        } else if (i === 1 && !tokens[i].startsWith('-')) {
                            scrollParam = tokens[i];
                        }
                    }

                    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
                    await sendMessageSafe(from, { text: `⏳ *Capturing:* ${targetUrl}\n📜 Scroll: ${scrollParam}\n⏱️ Delay: ${delayParam}ms` });
                    
                    const currentTaskId = Date.now();
                    const taskObj = { id: currentTaskId, name: targetUrl, progress: 10, stream: null, browser: null, wasKilled: false, mode: 'brows' };
                    currentSession.tasks.push(taskObj);
                    
                    (async () => {
                        let browser;
                        try {
                            const puppeteer = require('puppeteer');
                            let liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (liveTask && !liveTask.wasKilled) liveTask.progress = 30;
                            
                            browser = await puppeteer.launch({ 
                                headless: true, 
                                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'] 
                            });
                            
                            liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (!liveTask || liveTask.wasKilled) { if(browser) await browser.close(); return; }
                            
                            liveTask.browser = browser;
                            liveTask.progress = 50;
                            
                            const page = await browser.newPage();
                            await page.evaluateOnNewDocument(() => {
                                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                            });
                            
                            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
                            await page.setViewport({ width: 1280, height: 800 });
                            
                            try {
                                await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                            } catch (e) {
                                console.log(`[Bypass Log] Render enforced for: ${targetUrl}`);
                            }
                            
                            liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (!liveTask || liveTask.wasKilled) { if(browser) await browser.close(); return; }
                            liveTask.progress = 70;
                            
                            await page.evaluate(async (scrollParam) => {
                                await new Promise((resolve) => {
                                    let totalHeight = 0;
                                    const distance = 400;
                                    const fullHeight = document.body.scrollHeight;
                                    let maxScroll;

                                    if (scrollParam.includes('%')) {
                                        const percent = parseInt(scrollParam) || 30;
                                        maxScroll = (fullHeight * percent) / 100;
                                    } else {
                                        maxScroll = parseInt(scrollParam) || 3200;
                                    }
                                    
                                    const timer = setInterval(() => {
                                        window.scrollBy(0, distance);
                                        totalHeight += distance;

                                        if (totalHeight >= document.body.scrollHeight || totalHeight >= maxScroll) {
                                            clearInterval(timer);
                                            resolve();
                                        }
                                    }, 200);
                                });
                            }, scrollParam);
                            
                            await new Promise(r => setTimeout(r, delayParam));
                            
                            liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (!liveTask || liveTask.wasKilled) { if(browser) await browser.close(); return; }
                            liveTask.progress = 90;
                            
                            const buf = await page.screenshot();
                            await browser.close();
                            
                            liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (liveTask && !liveTask.wasKilled) {
                                await sendMessageSafe(from, { image: buf, caption: `🌐 *Result:* ${targetUrl}` });
                            }
                        } catch (e) {
                            if (browser) try { await browser.close(); } catch(err){}
                            const liveTask = currentSession.tasks.find(t => t.id === currentTaskId);
                            if (liveTask && !liveTask.wasKilled) {
                                await sendMessageSafe(from, { text: '❌ *Browse Failed:* ' + e.message });
                            }
                        } finally {
                            currentSession.tasks = currentSession.tasks.filter(t => t.id !== currentTaskId);
                        }
                    })();
                    continue;
                }
            }
        } catch (error) {
            console.error(error);
        }
    });
}
startBot();

// Bridge HTTP server (used by the web app: Settings -> Bots -> WhatsApp)
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
                return res.end(JSON.stringify({
                    ok: true,
                    state: bridge.state,
                    connected: bridge.state === 'open',
                    user: bridge.user,
                    qr: bridge.qr,
                    pairCode: bridge.pairCode,
                    pairNumber: bridge.pairNumber,
                    events: bridge.events,
                }));
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
                        bridge.pairCode = code;
                        bridge.pairNumber = num;
                        evt(`Pairing code for +${num}: ${code}`);
                        return res.end(JSON.stringify({ ok: true, code }));
                    } catch (e) {
                        return res.end(JSON.stringify({ ok: false, error: e.message }));
                    }
                });
            }
            if (url === '/logout') {
                try { await sock.logout(); } catch (e) {}
                bridge.qr = null;
                bridge.state = 'logged-out';
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({ ok: true }));
            }
            res.statusCode = 404;
            return res.end('{}');
        } catch (e) {
            res.statusCode = 500;
            return res.end(JSON.stringify({ error: e.message }));
        }
    }).listen(BRIDGE_PORT, () => {
        console.log(`[bridge] WhatsApp bridge on http://127.0.0.1:${BRIDGE_PORT} (web app: Settings -> Bots)`);
    });
}
