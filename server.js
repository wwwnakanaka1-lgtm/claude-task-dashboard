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
const CLAUDE_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
const PROJECTS_DIR = path.dirname(SESSIONS_FILE);
const TODOS_DIR = path.join(CLAUDE_DIR, 'todos');
const STATS_FILE = path.join(CLAUDE_DIR, 'stats-cache.json');

// Cost cache - calculated from JSONL files on startup
let costCache = {
    dailyCosts: {},      // { 'YYYY-MM-DD': { tokens: {...}, cost: X } }
    monthlyCosts: {},    // { 'YYYY-MM': { tokens: {...}, cost: X, days: N } }
    sessionCosts: {},    // { sessionId: { tokens: {...}, cost: X, date: 'YYYY-MM-DD' } }
    lastUpdated: null,
    isReady: false
};

// Rate limit cache - rolling window of output tokens
let rateLimitCache = {
    outputTokens: [],    // [{ timestamp: ISO, tokens: N }]
    lastUpdated: null,
    windowHours: 5,
    estimatedLimit: 200000  // Estimated output token limit for 5-hour window
};

// Dashboard config file
const CONFIG_FILE = path.join(CLAUDE_DIR, 'dashboard-config.json');

// Anthropic API cache
let anthropicCache = {
    usage: null,
    rateLimit: null,
    lastUsageFetch: null,
    lastRateLimitFetch: null
};

// Load dashboard config
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('Error loading config:', err.message);
    }
    return { anthropicApiKey: null, keyType: null };
}

// Save dashboard config
function saveConfig(config) {
    try {
        // Detect key type
        if (config.anthropicApiKey) {
            if (config.anthropicApiKey.startsWith('sk-ant-admin')) {
                config.keyType = 'admin';
            } else if (config.anthropicApiKey.startsWith('sk-ant-api')) {
                config.keyType = 'standard';
            } else if (config.anthropicApiKey.startsWith('sk-ant-oat')) {
                config.keyType = 'oauth';  // OAuth Access Token (tied to Max plan)
            } else {
                config.keyType = 'unknown';
            }
        }
        config.updatedAt = new Date().toISOString();
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        return true;
    } catch (err) {
        console.error('Error saving config:', err.message);
        return false;
    }
}

// Fetch usage from Anthropic API (Admin key only)
async function fetchAnthropicUsage() {
    const config = loadConfig();
    if (!config.anthropicApiKey || config.keyType !== 'admin') {
        let errorMsg = 'Admin APIキーが必要です';
        if (config.keyType === 'oauth') {
            errorMsg = 'Maxプラン使用量はclaude.aiで確認';
        }
        return { error: errorMsg, keyType: config.keyType };
    }

    // Check cache (5 minute TTL)
    const now = Date.now();
    if (anthropicCache.usage && anthropicCache.lastUsageFetch &&
        (now - anthropicCache.lastUsageFetch) < 5 * 60 * 1000) {
        return anthropicCache.usage;
    }

    try {
        const https = require('https');

        // Get today and this month's usage
        const today = new Date();
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        const url = new URL('https://api.anthropic.com/v1/organizations/usage_report/messages');
        url.searchParams.set('starting_at', startOfMonth.toISOString());
        url.searchParams.set('ending_at', today.toISOString());
        url.searchParams.set('bucket_width', '1d');

        const response = await new Promise((resolve, reject) => {
            const req = https.request(url, {
                method: 'GET',
                headers: {
                    'x-api-key': config.anthropicApiKey,
                    'anthropic-version': '2023-06-01'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(data));
                    } else {
                        reject(new Error(`API error: ${res.statusCode} - ${data}`));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });

        // Process response
        const result = processUsageResponse(response, startOfDay);
        anthropicCache.usage = result;
        anthropicCache.lastUsageFetch = now;
        return result;

    } catch (err) {
        console.error('Anthropic API error:', err.message);
        return { error: err.message };
    }
}

// Process usage response from Anthropic API
function processUsageResponse(response, startOfDay) {
    const buckets = response.data || [];
    let todayTokens = { input: 0, output: 0 };
    let monthTokens = { input: 0, output: 0 };

    for (const bucket of buckets) {
        const bucketDate = new Date(bucket.bucket_start_time);
        const inputTokens = (bucket.uncached_input_tokens || 0) +
                           (bucket.cached_input_tokens || 0) +
                           (bucket.cache_creation_input_tokens || 0);
        const outputTokens = bucket.output_tokens || 0;

        monthTokens.input += inputTokens;
        monthTokens.output += outputTokens;

        if (bucketDate >= startOfDay) {
            todayTokens.input += inputTokens;
            todayTokens.output += outputTokens;
        }
    }

    // Calculate costs (Opus 4.5 pricing)
    const pricing = { input: 15, output: 75 }; // per 1M tokens
    const todayCost = (todayTokens.input / 1000000 * pricing.input) +
                      (todayTokens.output / 1000000 * pricing.output);
    const monthCost = (monthTokens.input / 1000000 * pricing.input) +
                      (monthTokens.output / 1000000 * pricing.output);

    return {
        today: {
            tokens: todayTokens,
            cost: todayCost
        },
        month: {
            tokens: monthTokens,
            cost: monthCost
        },
        source: 'anthropic-api',
        fetchedAt: new Date().toISOString()
    };
}

// Fetch rate limit from Anthropic API (any key type)
async function fetchAnthropicRateLimit() {
    const config = loadConfig();
    if (!config.anthropicApiKey) {
        return { error: 'API key not configured' };
    }

    // Check cache (30 second TTL for rate limits)
    const now = Date.now();
    if (anthropicCache.rateLimit && anthropicCache.lastRateLimitFetch &&
        (now - anthropicCache.lastRateLimitFetch) < 30 * 1000) {
        return anthropicCache.rateLimit;
    }

    try {
        const https = require('https');

        // Make a minimal API call to get rate limit headers
        const response = await new Promise((resolve, reject) => {
            const req = https.request('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': config.anthropicApiKey,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    // Extract rate limit headers
                    const headers = res.headers;
                    resolve({
                        statusCode: res.statusCode,
                        headers: {
                            tokensLimit: parseInt(headers['anthropic-ratelimit-tokens-limit']) || null,
                            tokensRemaining: parseInt(headers['anthropic-ratelimit-tokens-remaining']) || null,
                            tokensReset: headers['anthropic-ratelimit-tokens-reset'] || null,
                            requestsLimit: parseInt(headers['anthropic-ratelimit-requests-limit']) || null,
                            requestsRemaining: parseInt(headers['anthropic-ratelimit-requests-remaining']) || null,
                            requestsReset: headers['anthropic-ratelimit-requests-reset'] || null,
                            // Output tokens specific
                            outputTokensLimit: parseInt(headers['anthropic-ratelimit-output-tokens-limit']) || null,
                            outputTokensRemaining: parseInt(headers['anthropic-ratelimit-output-tokens-remaining']) || null,
                            outputTokensReset: headers['anthropic-ratelimit-output-tokens-reset'] || null
                        },
                        body: data
                    });
                });
            });
            req.on('error', reject);
            // Send minimal request (will likely fail but we get headers)
            req.write(JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'hi' }]
            }));
            req.end();
        });

        // Process rate limit info
        const h = response.headers;
        let usagePercent = 0;
        let resetTimeStr = '--';

        if (h.outputTokensLimit && h.outputTokensRemaining !== null) {
            usagePercent = Math.round((1 - h.outputTokensRemaining / h.outputTokensLimit) * 100);
        } else if (h.tokensLimit && h.tokensRemaining !== null) {
            usagePercent = Math.round((1 - h.tokensRemaining / h.tokensLimit) * 100);
        }

        if (h.outputTokensReset || h.tokensReset) {
            const resetTime = new Date(h.outputTokensReset || h.tokensReset);
            const diffMs = resetTime - new Date();
            if (diffMs > 0) {
                const hours = Math.floor(diffMs / (1000 * 60 * 60));
                const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                resetTimeStr = `${hours}時間${mins}分後にリセット`;
            }
        }

        const result = {
            usagePercent: usagePercent,
            outputTokensLimit: h.outputTokensLimit,
            outputTokensRemaining: h.outputTokensRemaining,
            tokensLimit: h.tokensLimit,
            tokensRemaining: h.tokensRemaining,
            resetTimeStr: resetTimeStr,
            source: 'anthropic-api',
            fetchedAt: new Date().toISOString()
        };

        anthropicCache.rateLimit = result;
        anthropicCache.lastRateLimitFetch = now;
        return result;

    } catch (err) {
        console.error('Anthropic rate limit API error:', err.message);
        return { error: err.message };
    }
}

// CORS headers
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

// Parse JSONL file to get token usage
function getSessionTokenUsage(jsonlPath) {
    try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreationTokens = 0;

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'assistant' && entry.message && entry.message.usage) {
                    const usage = entry.message.usage;
                    inputTokens += usage.input_tokens || 0;
                    outputTokens += usage.output_tokens || 0;
                    cacheReadTokens += usage.cache_read_input_tokens || 0;
                    cacheCreationTokens += usage.cache_creation_input_tokens || 0;
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        return {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
        };
    } catch (err) {
        return null;
    }
}

// Calculate estimated cost (USD)
function calculateCost(tokens, model) {
    // Pricing per 1M tokens (approximate)
    const pricing = {
        'claude-opus-4-5-20251101': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
        'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
        'default': { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 }
    };

    const price = pricing[model] || pricing['default'];

    const inputCost = (tokens.inputTokens / 1000000) * price.input;
    const outputCost = (tokens.outputTokens / 1000000) * price.output;
    const cacheReadCost = (tokens.cacheReadTokens / 1000000) * price.cacheRead;
    const cacheCreateCost = (tokens.cacheCreationTokens / 1000000) * price.cacheCreate;

    return inputCost + outputCost + cacheReadCost + cacheCreateCost;
}

// Parse JSONL file to get token usage with timestamps
function getSessionTokenUsageWithDates(jsonlPath) {
    try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');

        // Group by date
        const dailyUsage = {};
        let sessionTotal = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0
        };

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'assistant' && entry.message && entry.message.usage) {
                    const usage = entry.message.usage;
                    const timestamp = entry.timestamp || entry.message.created_at;
                    const date = timestamp ? timestamp.split('T')[0] : new Date().toISOString().split('T')[0];

                    if (!dailyUsage[date]) {
                        dailyUsage[date] = {
                            inputTokens: 0,
                            outputTokens: 0,
                            cacheReadTokens: 0,
                            cacheCreationTokens: 0
                        };
                    }

                    const input = usage.input_tokens || 0;
                    const output = usage.output_tokens || 0;
                    const cacheRead = usage.cache_read_input_tokens || 0;
                    const cacheCreate = usage.cache_creation_input_tokens || 0;

                    dailyUsage[date].inputTokens += input;
                    dailyUsage[date].outputTokens += output;
                    dailyUsage[date].cacheReadTokens += cacheRead;
                    dailyUsage[date].cacheCreationTokens += cacheCreate;

                    sessionTotal.inputTokens += input;
                    sessionTotal.outputTokens += output;
                    sessionTotal.cacheReadTokens += cacheRead;
                    sessionTotal.cacheCreationTokens += cacheCreate;
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        return { dailyUsage, sessionTotal };
    } catch (err) {
        return null;
    }
}

// Get output tokens with timestamps from JSONL (for rate limit calculation)
function getOutputTokensWithTimestamps(jsonlPath) {
    try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');
        const entries = [];

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'assistant' && entry.message && entry.message.usage) {
                    const usage = entry.message.usage;
                    const outputTokens = usage.output_tokens || 0;
                    const timestamp = entry.timestamp || entry.message.created_at;

                    if (timestamp && outputTokens > 0) {
                        entries.push({
                            timestamp: timestamp,
                            tokens: outputTokens
                        });
                    }
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        return entries;
    } catch (err) {
        return [];
    }
}

// Build rate limit cache (rolling 5-hour window)
function buildRateLimitCache() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - rateLimitCache.windowHours * 60 * 60 * 1000);
    const allTokenEntries = [];

    try {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const entries = parsed.entries || [];

        for (const entry of entries) {
            try {
                let jsonlPath = entry.fullPath;
                if (!fs.existsSync(jsonlPath)) {
                    jsonlPath = jsonlPath.replace(/c--Users-wwwhi/i, 'C--Users-wwwhi');
                }
                if (!fs.existsSync(jsonlPath)) continue;

                const tokenEntries = getOutputTokensWithTimestamps(jsonlPath);
                for (const te of tokenEntries) {
                    const entryTime = new Date(te.timestamp);
                    if (entryTime >= windowStart) {
                        allTokenEntries.push(te);
                    }
                }
            } catch (e) {
                // Skip problematic sessions
            }
        }

        rateLimitCache.outputTokens = allTokenEntries.sort((a, b) =>
            new Date(a.timestamp) - new Date(b.timestamp)
        );
        rateLimitCache.lastUpdated = now.toISOString();

    } catch (err) {
        console.error('Error building rate limit cache:', err.message);
    }
}

// Count messages for a specific date from JSONL
function countMessagesForDate(jsonlPath, targetDate) {
    try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');
        let count = 0;

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                // Count both user and assistant messages
                if (entry.type === 'user' || entry.type === 'assistant') {
                    const timestamp = entry.timestamp || (entry.message && entry.message.created_at);
                    if (timestamp && timestamp.startsWith(targetDate)) {
                        count++;
                    }
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        return count;
    } catch (err) {
        return 0;
    }
}

// Count unique assistant messages since a specific timestamp (for rate limit estimation)
function countMessagesSince(jsonlPath, sinceTimestamp) {
    try {
        const content = fs.readFileSync(jsonlPath, 'utf8');
        const lines = content.trim().split('\n');
        const seenMessageIds = new Set();
        const sinceTime = new Date(sinceTimestamp);

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                // Only count unique assistant messages (by message ID)
                if (entry.type === 'assistant' && entry.message && entry.message.id) {
                    const timestamp = entry.timestamp || entry.message.created_at;
                    if (timestamp && new Date(timestamp) > sinceTime) {
                        seenMessageIds.add(entry.message.id);
                    }
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        return seenMessageIds.size;
    } catch (err) {
        return 0;
    }
}

// Get message count since sync time from all JSONL files
function getMessagesSinceSyncTime(syncedAt) {
    let totalMessages = 0;

    try {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const entries = parsed.entries || [];

        for (const entry of entries) {
            try {
                let jsonlPath = entry.fullPath;
                if (!fs.existsSync(jsonlPath)) {
                    jsonlPath = jsonlPath.replace(/c--Users-wwwhi/i, 'C--Users-wwwhi');
                }
                if (!fs.existsSync(jsonlPath)) continue;

                totalMessages += countMessagesSince(jsonlPath, syncedAt);
            } catch (e) {
                // Skip problematic sessions
            }
        }
    } catch (err) {
        console.error('Error counting messages since sync:', err.message);
    }

    return totalMessages;
}

// Get today's message count from all JSONL files
function getTodayMessageCount() {
    const today = new Date().toISOString().split('T')[0];
    let totalMessages = 0;

    try {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const entries = parsed.entries || [];

        for (const entry of entries) {
            try {
                let jsonlPath = entry.fullPath;
                if (!fs.existsSync(jsonlPath)) {
                    jsonlPath = jsonlPath.replace(/c--Users-wwwhi/i, 'C--Users-wwwhi');
                }
                if (!fs.existsSync(jsonlPath)) continue;

                totalMessages += countMessagesForDate(jsonlPath, today);
            } catch (e) {
                // Skip problematic sessions
            }
        }
    } catch (err) {
        console.error('Error counting today messages:', err.message);
    }

    return totalMessages;
}

// Get rate limit status (estimated only - JSONL doesn't contain accurate token data)
function getRateLimitStatus() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - rateLimitCache.windowHours * 60 * 60 * 1000);

    // Filter to current window
    const recentTokens = rateLimitCache.outputTokens.filter(t =>
        new Date(t.timestamp) >= windowStart
    );

    // Sum output tokens (note: these are very rough estimates from JSONL streaming data)
    const totalOutputTokens = recentTokens.reduce((sum, t) => sum + t.tokens, 0);
    const usagePercent = Math.min(100, Math.round((totalOutputTokens / rateLimitCache.estimatedLimit) * 100));

    // Calculate time until reset (find oldest entry in window)
    let resetTimeMs = 0;
    if (recentTokens.length > 0) {
        const oldestEntry = new Date(recentTokens[0].timestamp);
        const resetTime = new Date(oldestEntry.getTime() + rateLimitCache.windowHours * 60 * 60 * 1000);
        resetTimeMs = Math.max(0, resetTime.getTime() - now.getTime());
    }

    // Format reset time
    const resetHours = Math.floor(resetTimeMs / (1000 * 60 * 60));
    const resetMinutes = Math.floor((resetTimeMs % (1000 * 60 * 60)) / (1000 * 60));
    const resetTimeStr = resetTimeMs > 0
        ? `${resetHours}時間${resetMinutes}分後にリセット`
        : '制限なし';

    return {
        outputTokens: totalOutputTokens,
        limit: rateLimitCache.estimatedLimit,
        usagePercent: usagePercent,
        resetTimeMs: resetTimeMs,
        resetTimeStr: resetTimeStr,
        windowHours: rateLimitCache.windowHours,
        entryCount: recentTokens.length,
        lastUpdated: rateLimitCache.lastUpdated,
        isEstimated: true
    };
}

// Build cost cache from all JSONL files
function buildCostCache() {
    console.log('Building cost cache from JSONL files...');
    const startTime = Date.now();

    const newCache = {
        dailyCosts: {},
        monthlyCosts: {},
        sessionCosts: {},
        lastUpdated: new Date().toISOString(),
        isReady: false
    };

    try {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const entries = parsed.entries || [];

        let processedCount = 0;

        for (const entry of entries) {
            try {
                let jsonlPath = entry.fullPath;
                if (!fs.existsSync(jsonlPath)) {
                    jsonlPath = jsonlPath.replace(/c--Users-wwwhi/i, 'C--Users-wwwhi');
                }
                if (!fs.existsSync(jsonlPath)) continue;

                const result = getSessionTokenUsageWithDates(jsonlPath);
                if (!result) continue;

                const { dailyUsage, sessionTotal } = result;
                const sessionCost = calculateCost(sessionTotal, 'claude-opus-4-5-20251101');

                // Store session cost
                const sessionDate = entry.created ? entry.created.split('T')[0] : Object.keys(dailyUsage)[0];
                newCache.sessionCosts[entry.sessionId] = {
                    tokens: sessionTotal,
                    cost: sessionCost,
                    date: sessionDate
                };

                // Aggregate daily costs
                for (const [date, tokens] of Object.entries(dailyUsage)) {
                    if (!newCache.dailyCosts[date]) {
                        newCache.dailyCosts[date] = {
                            inputTokens: 0,
                            outputTokens: 0,
                            cacheReadTokens: 0,
                            cacheCreationTokens: 0,
                            cost: 0
                        };
                    }

                    newCache.dailyCosts[date].inputTokens += tokens.inputTokens;
                    newCache.dailyCosts[date].outputTokens += tokens.outputTokens;
                    newCache.dailyCosts[date].cacheReadTokens += tokens.cacheReadTokens;
                    newCache.dailyCosts[date].cacheCreationTokens += tokens.cacheCreationTokens;
                    newCache.dailyCosts[date].cost += calculateCost(tokens, 'claude-opus-4-5-20251101');
                }

                processedCount++;
            } catch (e) {
                // Skip problematic sessions
            }
        }

        // Aggregate monthly costs from daily
        for (const [date, daily] of Object.entries(newCache.dailyCosts)) {
            const monthKey = date.substring(0, 7);
            if (!newCache.monthlyCosts[monthKey]) {
                newCache.monthlyCosts[monthKey] = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    cost: 0,
                    days: 0
                };
            }

            newCache.monthlyCosts[monthKey].inputTokens += daily.inputTokens;
            newCache.monthlyCosts[monthKey].outputTokens += daily.outputTokens;
            newCache.monthlyCosts[monthKey].cacheReadTokens += daily.cacheReadTokens;
            newCache.monthlyCosts[monthKey].cacheCreationTokens += daily.cacheCreationTokens;
            newCache.monthlyCosts[monthKey].cost += daily.cost;
            newCache.monthlyCosts[monthKey].days += 1;
        }

        newCache.isReady = true;
        costCache = newCache;

        const elapsed = Date.now() - startTime;
        console.log(`Cost cache built: ${processedCount} sessions processed in ${elapsed}ms`);

    } catch (err) {
        console.error('Error building cost cache:', err.message);
    }
}

// Refresh cost cache periodically (every 5 minutes)
function startCacheRefresh() {
    setInterval(() => {
        buildCostCache();
        buildRateLimitCache();
    }, 5 * 60 * 1000);

    // Also refresh rate limit more frequently (every 30 seconds)
    setInterval(() => {
        buildRateLimitCache();
    }, 30 * 1000);
}

// Find unindexed sessions (directories that exist but aren't in sessions-index.json)
function findUnindexedSessions(indexedSessionIds) {
    const unindexedSessions = [];

    try {
        const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });

        for (const entry of entries) {
            // Skip non-directories and non-UUID-like names
            if (!entry.isDirectory()) continue;
            if (!entry.name.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) continue;

            const sessionId = entry.name;
            if (indexedSessionIds.has(sessionId)) continue;

            const sessionDir = path.join(PROJECTS_DIR, sessionId);

            // Look for JSONL files (main or subagents)
            let jsonlFile = null;
            let latestMtime = null;
            let firstPrompt = null;
            let messageCount = 0;

            // Check for main JSONL file (at PROJECTS_DIR level, not inside session dir)
            const mainJsonl = path.join(PROJECTS_DIR, `${sessionId}.jsonl`);
            if (fs.existsSync(mainJsonl)) {
                const mainStats = fs.statSync(mainJsonl);
                jsonlFile = mainJsonl;
                latestMtime = mainStats.mtime;
            }

            // Also check inside session directory
            const altMainJsonl = path.join(sessionDir, `${sessionId}.jsonl`);
            if (fs.existsSync(altMainJsonl)) {
                const altStats = fs.statSync(altMainJsonl);
                if (!latestMtime || altStats.mtime > latestMtime) {
                    jsonlFile = altMainJsonl;
                    latestMtime = altStats.mtime;
                }
            }

            // Check subagents directory (only use if newer than main file)
            const subagentsDir = path.join(sessionDir, 'subagents');
            if (fs.existsSync(subagentsDir)) {
                const subagentFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
                for (const sf of subagentFiles) {
                    const sfPath = path.join(subagentsDir, sf);
                    const stats = fs.statSync(sfPath);
                    if (!latestMtime || stats.mtime > latestMtime) {
                        latestMtime = stats.mtime;
                        jsonlFile = sfPath;
                    }
                }
            }

            if (!jsonlFile) continue;

            // Read first user prompt and count messages
            try {
                const content = fs.readFileSync(jsonlFile, 'utf8');
                const lines = content.trim().split('\n');
                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        if (entry.type === 'user' && entry.message?.content && !firstPrompt) {
                            firstPrompt = entry.message.content.substring(0, 200);
                        }
                        if (entry.type === 'user' || entry.type === 'assistant') {
                            messageCount++;
                        }
                    } catch (e) {}
                }
            } catch (e) {}

            const stats = fs.statSync(jsonlFile);
            const tokenUsage = getSessionTokenUsage(jsonlFile);
            const cost = tokenUsage ? calculateCost(tokenUsage, 'claude-opus-4-5-20251101') : 0;

            unindexedSessions.push({
                sessionId: sessionId,
                fullPath: jsonlFile,
                firstPrompt: firstPrompt || 'Subagent Session',
                messageCount: Math.floor(messageCount / 2),
                created: stats.birthtime?.toISOString() || stats.mtime.toISOString(),
                modified: stats.mtime.toISOString(),
                realModified: stats.mtime.toISOString(),
                tokenUsage: tokenUsage,
                estimatedCost: cost,
                isUnindexed: true
            });
        }
    } catch (err) {
        console.error('Error finding unindexed sessions:', err.message);
    }

    return unindexedSessions;
}

// Read sessions from file with real file timestamps
function readSessions() {
    try {
        const data = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        const entries = parsed.entries || [];

        // Track indexed session IDs
        const indexedSessionIds = new Set(entries.map(e => e.sessionId));

        // Get real file modification times from JSONL files
        const indexedSessions = entries.map(entry => {
            try {
                // Normalize path for Windows (handle case variations)
                let jsonlPath = entry.fullPath;
                if (!fs.existsSync(jsonlPath)) {
                    // Try with different case
                    jsonlPath = jsonlPath.replace(/c--Users-wwwhi/i, 'C--Users-wwwhi');
                }
                const stats = fs.statSync(jsonlPath);
                const tokenUsage = getSessionTokenUsage(jsonlPath);
                const cost = tokenUsage ? calculateCost(tokenUsage, 'claude-opus-4-5-20251101') : 0;

                return {
                    ...entry,
                    realModified: stats.mtime.toISOString(),
                    tokenUsage: tokenUsage,
                    estimatedCost: cost
                };
            } catch (e) {
                return {
                    ...entry,
                    realModified: entry.modified,
                    tokenUsage: null,
                    estimatedCost: 0
                };
            }
        });

        // Find and add unindexed sessions
        const unindexedSessions = findUnindexedSessions(indexedSessionIds);

        return [...indexedSessions, ...unindexedSessions];
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
            minutesAgo: Math.round(minutesAgo),
            tokenUsage: s.tokenUsage,
            estimatedCost: s.estimatedCost
        };
    }).sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

// Read todos for a session (merge all matching files)
function readTodos(sessionId) {
    try {
        const files = fs.readdirSync(TODOS_DIR);
        // Find ALL files matching sessionId pattern
        const matchingFiles = files.filter(f => f.startsWith(sessionId));

        if (matchingFiles.length === 0) {
            return [];
        }

        // Collect all todos from matching files
        const allTodos = new Map(); // Use Map to deduplicate by content

        for (const file of matchingFiles) {
            try {
                const data = fs.readFileSync(path.join(TODOS_DIR, file), 'utf8');
                const todos = JSON.parse(data);
                for (const todo of todos) {
                    // Use content as key to avoid duplicates
                    const key = todo.content || todo.activeForm;
                    if (key && (!allTodos.has(key) || todo.status !== 'pending')) {
                        // Prefer non-pending status (completed > in_progress > pending)
                        allTodos.set(key, todo);
                    }
                }
            } catch (e) {
                // Skip invalid files
            }
        }

        return Array.from(allTodos.values());
    } catch (err) {
        return [];
    }
}

// Read all todos (for overview)
function readAllTodos() {
    try {
        const files = fs.readdirSync(TODOS_DIR);
        const allTodos = [];

        for (const file of files.slice(-50)) { // Last 50 files
            try {
                const data = fs.readFileSync(path.join(TODOS_DIR, file), 'utf8');
                const todos = JSON.parse(data);
                if (todos.length > 0) {
                    const sessionId = file.split('-agent-')[0];
                    allTodos.push({
                        sessionId,
                        todos,
                        stats: {
                            total: todos.length,
                            completed: todos.filter(t => t.status === 'completed').length,
                            inProgress: todos.filter(t => t.status === 'in_progress').length,
                            pending: todos.filter(t => t.status === 'pending').length
                        }
                    });
                }
            } catch (e) {}
        }
        return allTodos;
    } catch (err) {
        return [];
    }
}

// Read stats (using cost cache from JSONL files)
function readStats() {
    try {
        // Read basic stats from stats-cache.json
        const data = fs.readFileSync(STATS_FILE, 'utf8');
        const stats = JSON.parse(data);

        // Use cost cache for accurate token/cost data
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];

        // Calculate week start (Monday)
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay() + (today.getDay() === 0 ? -6 : 1));
        const weekStartStr = weekStart.toISOString().split('T')[0];

        // Calculate month start
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const monthStartStr = monthStart.toISOString().split('T')[0];

        // Calculate last month key
        const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

        // Build daily history and calculate period totals from cache
        const dailyHistory = [];
        let todayCost = 0;
        let weekCost = 0;
        let monthCost = 0;
        let lastMonthCost = 0;

        // Sort dates and build history
        const sortedDates = Object.keys(costCache.dailyCosts).sort();
        for (const date of sortedDates) {
            const daily = costCache.dailyCosts[date];
            dailyHistory.push({
                date: date,
                tokens: daily.inputTokens + daily.outputTokens + daily.cacheReadTokens + daily.cacheCreationTokens,
                cost: daily.cost
            });

            if (date === todayStr) {
                todayCost = daily.cost;
            }
            if (date >= weekStartStr) {
                weekCost += daily.cost;
            }
            if (date >= monthStartStr) {
                monthCost += daily.cost;
            }
        }

        // Get last month cost from monthly cache
        if (costCache.monthlyCosts[lastMonthKey]) {
            lastMonthCost = costCache.monthlyCosts[lastMonthKey].cost;
        }

        // Build monthly summary from cache
        const monthlyArray = Object.entries(costCache.monthlyCosts)
            .map(([month, data]) => ({
                month,
                tokens: data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens,
                inputTokens: data.inputTokens,
                outputTokens: data.outputTokens,
                cacheReadTokens: data.cacheReadTokens,
                cacheCreationTokens: data.cacheCreationTokens,
                days: data.days,
                costUSD: data.cost
            }))
            .sort((a, b) => a.month.localeCompare(b.month));

        // Calculate totals
        let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
        for (const monthly of monthlyArray) {
            totalInput += monthly.inputTokens;
            totalOutput += monthly.outputTokens;
            totalCacheRead += monthly.cacheReadTokens;
            totalCacheCreate += monthly.cacheCreationTokens;
        }

        // Get today's message count from JSONL files (more accurate than stats-cache.json)
        const todayMessageCount = getTodayMessageCount();

        return {
            totalSessions: stats.totalSessions || 0,
            totalMessages: stats.totalMessages || 0,
            dailyActivity: (stats.dailyActivity || []).slice(-7),
            todayMessageCount: todayMessageCount,
            modelUsage: stats.modelUsage || {},
            longestSession: stats.longestSession || null,
            cacheReady: costCache.isReady,
            cacheLastUpdated: costCache.lastUpdated,
            tokens: {
                totalInput: totalInput,
                totalOutput: totalOutput,
                totalCacheRead: totalCacheRead,
                totalCacheCreate: totalCacheCreate,
                todayCost: todayCost,
                weekCost: weekCost,
                monthCost: monthCost,
                lastMonthCost: lastMonthCost
            },
            dailyHistory: dailyHistory,
            monthlySummary: monthlyArray
        };
    } catch (err) {
        return {
            totalSessions: 0,
            totalMessages: 0,
            dailyActivity: [],
            modelUsage: {},
            tokens: {},
            dailyHistory: [],
            monthlySummary: [],
            cacheReady: costCache.isReady
        };
    }
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

    // API: Sessions
    if (url.pathname === '/api/sessions') {
        const sessions = readSessions();
        const formatted = formatSessions(sessions);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(formatted));
        return;
    }

    // API: Todos for specific session
    if (url.pathname.startsWith('/api/todos/')) {
        const sessionId = url.pathname.replace('/api/todos/', '');
        const todos = readTodos(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(todos));
        return;
    }

    // API: All todos overview
    if (url.pathname === '/api/todos') {
        const allTodos = readAllTodos();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(allTodos));
        return;
    }

    // API: Stats
    if (url.pathname === '/api/stats') {
        const stats = readStats();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(stats));
        return;
    }

    // API: Rate Limit Status (with message-based estimation)
    if (url.pathname === '/api/ratelimit') {
        const syncedAt = url.searchParams.get('syncedAt');
        const status = getRateLimitStatus();

        // Add message count since sync for estimation
        if (syncedAt) {
            const syncTime = new Date(parseInt(syncedAt));
            status.messagesSinceSync = getMessagesSinceSyncTime(syncTime.toISOString());
        }

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(status));
        return;
    }

    // API: Get Config (masked key)
    if (url.pathname === '/api/config' && req.method === 'GET') {
        const config = loadConfig();
        // Mask the API key for display
        const maskedKey = config.anthropicApiKey
            ? config.anthropicApiKey.substring(0, 12) + '...' + config.anthropicApiKey.slice(-4)
            : null;
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
            hasApiKey: !!config.anthropicApiKey,
            maskedKey: maskedKey,
            keyType: config.keyType,
            updatedAt: config.updatedAt
        }));
        return;
    }

    // API: Save Config
    if (url.pathname === '/api/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const success = saveConfig({ anthropicApiKey: data.apiKey });
                // Clear cache when key changes
                anthropicCache = { usage: null, rateLimit: null, lastUsageFetch: null, lastRateLimitFetch: null };
                res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success, keyType: loadConfig().keyType }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // API: Delete Config
    if (url.pathname === '/api/config' && req.method === 'DELETE') {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                fs.unlinkSync(CONFIG_FILE);
            }
            anthropicCache = { usage: null, rateLimit: null, lastUsageFetch: null, lastRateLimitFetch: null };
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // API: Anthropic Usage (Admin key only)
    if (url.pathname === '/api/anthropic/usage') {
        fetchAnthropicUsage().then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify(result));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // API: Anthropic Rate Limit
    if (url.pathname === '/api/anthropic/ratelimit') {
        fetchAnthropicRateLimit().then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify(result));
        }).catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // Static files
    let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
    serveStatic(filePath, res);
});

// Build caches on startup
buildCostCache();
buildRateLimitCache();
startCacheRefresh();

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║   Claude Task Dashboard Server                 ║
╠════════════════════════════════════════════════╣
║   URL: http://localhost:${PORT}                   ║
║   API: http://localhost:${PORT}/api/sessions      ║
╚════════════════════════════════════════════════╝

Monitoring: ${SESSIONS_FILE}
Cost cache: ${costCache.isReady ? 'Ready' : 'Building...'}
Press Ctrl+C to stop.
`);
});
