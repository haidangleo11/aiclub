const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 100_000;
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

function loadLocalEnv() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) return;

    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || match[1] in process.env) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
    }
}

loadLocalEnv();

function sendJson(res, status, body, extraHeaders = {}) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    res.end(JSON.stringify(body));
}

function setCors(req, res) {
    const allowedOrigin = process.env.ALLOWED_ORIGIN;
    const origin = req.headers.origin;
    if (allowedOrigin && origin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('PAYLOAD_TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function normaliseMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 12) return null;
    const safeMessages = messages.map(message => {
        if (!message || !['system', 'user', 'assistant'].includes(message.role)) return null;
        if (typeof message.content !== 'string' || message.content.length > 4_000) return null;
        return { role: message.role, content: message.content };
    });
    return safeMessages.every(Boolean) ? safeMessages : null;
}

async function proxyGroq(req, res) {
    setCors(req, res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: { message: 'Method not allowed' } });
        return;
    }

    const allowedOrigin = process.env.ALLOWED_ORIGIN;
    if (allowedOrigin && req.headers.origin !== allowedOrigin) {
        sendJson(res, 403, { error: { message: 'Origin không được phép.' } });
        return;
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        sendJson(res, 503, { error: { message: 'Server chưa được cấu hình GROQ_API_KEY.' } });
        return;
    }

    try {
        const payload = JSON.parse(await readBody(req));
        const messages = normaliseMessages(payload?.messages);
        if (!messages) {
            sendJson(res, 400, { error: { message: 'Payload không hợp lệ.' } });
            return;
        }

        const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: process.env.GROQ_MODEL || DEFAULT_MODEL,
                messages
            }),
            signal: AbortSignal.timeout(30_000)
        });

        const responseBody = await upstream.text();
        res.writeHead(upstream.status, {
            'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(responseBody);
    } catch (error) {
        const status = error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 502;
        sendJson(res, status, { error: { message: 'Không thể kết nối dịch vụ AI.' } });
    }
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { message: 'Method not allowed' } });
        return;
    }

    const requestedPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.resolve(ROOT, `.${requestedPath}`);
    const relativePath = path.relative(ROOT, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        sendJson(res, 403, { error: { message: 'Forbidden' } });
        return;
    }

    fs.stat(filePath, (error, stat) => {
        if (error || !stat.isFile()) {
            sendJson(res, 404, { error: { message: 'Not found' } });
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        fs.createReadStream(filePath).pipe(res);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/chat') {
        await proxyGroq(req, res);
        return;
    }
    serveStatic(req, res, url);
});

server.listen(PORT, () => {
    console.log(`HVT AI Club đang chạy tại http://localhost:${PORT}`);
});
