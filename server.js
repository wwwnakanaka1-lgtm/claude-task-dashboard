// Claude Session Monitor Server
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
// Find sessions-index.json (handle case variations)
function findSessionsFile() {
    const baseDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');
    const variations = ['C--Users-wwwhi', 'c--Users-wwwhi'];
    for (const dir of variations) {
        const filePath = path.join(baseDir, dir, 'sessions-index.json');
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }
    return path.join(baseDir, 'C--Users-wwwhi', 'sessions-index.json');
}

const SESSIONS_FILE = findSessionsFile();

// CORS headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

// Read sessions from file with real file timestamps
function readSessions() {
    try {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const entries = parsed.entries || [];

        // Get real file modification times from JSONL files
        return entries.map(entry => {
            try {
                // Normalize path for Windows (handle case variations)
                let jsonlPath = entry.fullPath;
                if (!fs.existsSync(jsonlPath)) {
                    // Try with different case
                    jsonlPath = jsonlPath.replace(/c--Users-wwwhi/i, 'C--Users-wwwhi');
                }
                const stats = fs.statSync(jsonlPath);
                return {
                    ...entry,
                    realModified: stats.mtime.toISOString()
                };
            } catch (e) {
                return {
                    ...entry,
                    realModified: entry.modified
                };
            }
        });
    } catch (err) {
        console.error('Error reading sessions:', err.message);
        return [];
    }
}

// Format session data for frontend
function formatSessions(sessions) {
    return sessions.map(s => {
        // Extract task name from firstPrompt
        let name = s.firstPrompt || 'No prompt';
        // Remove IDE tags
        name = name.replace(/<[^>]+>/g, '').trim();
        // Truncate if too long
        if (name.length > 100) {
            name = name.substring(0, 100) + '...';
        }
        if (name === '' || name === 'No prompt') {
            name = 'Untitled Session';
        }

        // Use real file modification time instead of index timestamp
        const modifiedTime = new Date(s.realModified || s.modified).getTime();
        const now = Date.now();
        const minutesAgo = (now - modifiedTime) / 1000 / 60;

        let status = 'completed';
        if (minutesAgo < 5) {
            status = 'in_progress';
        } else if (minutesAgo < 60) {
            status = 'pending';
        }

        return {
            id: s.sessionId,
            name: name,
            messageCount: s.messageCount,
            created: s.created,
            modified: s.realModified || s.modified,
            projectPath: s.projectPath,
            status: status,
            minutesAgo: Math.round(minutesAgo)
        };
    }).sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

// Serve static files
function serveStatic(filePath, res) {
    const ext = path.extname(filePath);
    const contentTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript'
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentTypes[ext] || 'text/plain',
            ...corsHeaders
        });
        res.end(data);
    });
}

// Create server
const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // API endpoint
    if (url.pathname === '/api/sessions') {
        const sessions = readSessions();
        // Debug: log first session's realModified
        if (sessions.length > 0) {
            console.log('First session realModified:', sessions[0].realModified);
        }
        const formatted = formatSessions(sessions);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...corsHeaders
        });
        res.end(JSON.stringify(formatted));
        return;
    }

    // Static files
    let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
    serveStatic(filePath, res);
});

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║   Claude Task Dashboard Server                 ║
╠════════════════════════════════════════════════╣
║   URL: http://localhost:${PORT}                   ║
║   API: http://localhost:${PORT}/api/sessions      ║
╚════════════════════════════════════════════════╝

Monitoring: ${SESSIONS_FILE}
Press Ctrl+C to stop.
`);
});
