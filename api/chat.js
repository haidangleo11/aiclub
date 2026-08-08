const MAX_BODY_BYTES = 100_000;
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

function setCors(req, res) {
    const allowedOrigin = process.env.ALLOWED_ORIGIN;
    const origin = req.headers.origin;
    if (allowedOrigin && origin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
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

module.exports = async function handler(req, res) {
    setCors(req, res);

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ error: { message: 'Method not allowed' } });
        return;
    }

    const allowedOrigin = process.env.ALLOWED_ORIGIN;
    if (allowedOrigin && req.headers.origin !== allowedOrigin) {
        res.status(403).json({ error: { message: 'Origin không được phép.' } });
        return;
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        res.status(503).json({ error: { message: 'Backend chưa được cấu hình GROQ_API_KEY.' } });
        return;
    }

    try {
        const rawSize = Buffer.byteLength(JSON.stringify(req.body || {}));
        if (rawSize > MAX_BODY_BYTES) {
            res.status(413).json({ error: { message: 'Payload quá lớn.' } });
            return;
        }

        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const messages = normaliseMessages(payload?.messages);
        if (!messages) {
            res.status(400).json({ error: { message: 'Payload không hợp lệ.' } });
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
        res.status(upstream.status);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
        res.send(responseBody);
    } catch (error) {
        res.status(502).json({ error: { message: 'Không thể kết nối dịch vụ AI.' } });
    }
};
