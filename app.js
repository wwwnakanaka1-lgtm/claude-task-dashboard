// Task Dashboard Application

const API_BASE = 'http://localhost:3456/api';
const REFRESH_INTERVAL = 10000; // 10 seconds

class TaskDashboard {
    constructor() {
        this.tasks = this.loadTasks();
        this.sessions = [];
        this.previousSessions = [];
        this.editingTaskId = null;
        this.serverConnected = false;
        this.customTitles = this.loadCustomTitles();
        this.editingSessionId = null;
        this.rateLimitSync = this.loadRateLimitSync();
        this.currentSyncedPercent = null;  // Store current displayed percent for modal
        this.hasApiKey = false;
        this.isRenderingSessions = false;  // Prevent concurrent session renders
        this.todosCache = {};  // Cache todos by session ID

        this.initElements();
        this.bindEvents();
        this.requestNotificationPermission();
        this.render();
        this.fetchSessions();
        this.fetchStats();
        this.fetchRateLimit();
        this.fetchConfig();  // Check for API key and fetch API data
        this.startAutoRefresh();
        this.startRateLimitTimer();
    }

    initElements() {
        // Modal elements
        this.modal = document.getElementById('taskModal');
        this.modalTitle = document.getElementById('modalTitle');
        this.taskNameInput = document.getElementById('taskName');
        this.taskDescInput = document.getElementById('taskDescription');
        this.taskStatusSelect = document.getElementById('taskStatus');
        this.deleteBtn = document.getElementById('deleteTaskBtn');

        // Manual task containers
        this.inProgressContainer = document.getElementById('inProgressTasks');
        this.pendingContainer = document.getElementById('pendingTasks');
        this.completedContainer = document.getElementById('completedTasks');

        this.inProgressCount = document.getElementById('inProgressCount');
        this.pendingCount = document.getElementById('pendingCount');
        this.completedCount = document.getElementById('completedCount');

        this.progressFill = document.getElementById('progressFill');
        this.progressText = document.getElementById('progressText');

        // Session containers
        this.activeContainer = document.getElementById('activeSessions');
        this.recentContainer = document.getElementById('recentSessions');
        this.oldContainer = document.getElementById('oldSessions');

        this.activeCount = document.getElementById('activeCount');
        this.recentCount = document.getElementById('recentCount');
        this.oldCount = document.getElementById('oldCount');

        this.lastUpdate = document.getElementById('lastUpdate');
        this.serverStatus = document.getElementById('serverStatus');
        this.refreshBtn = document.getElementById('refreshBtn');

        // Session detail modal
        this.sessionModal = document.getElementById('sessionModal');
        this.sessionModalTitle = document.getElementById('sessionModalTitle');
        this.sessionInfo = document.getElementById('sessionInfo');
        this.taskList = document.getElementById('taskList');
        this.taskProgressFill = document.getElementById('taskProgressFill');
        this.taskProgressText = document.getElementById('taskProgressText');

        // Stats elements
        this.statMessages = document.getElementById('statMessages');
        this.statTodayTokens = document.getElementById('statTodayTokens');
        this.statWeekTokens = document.getElementById('statWeekTokens');
        this.statMonthTokens = document.getElementById('statMonthTokens');
        this.statLastMonthTokens = document.getElementById('statLastMonthTokens');

        // History elements
        this.monthlyChart = document.getElementById('monthlyChart');
        this.dailyChart = document.getElementById('dailyChart');
        this.monthlyTable = document.getElementById('monthlyTable');

        // Title edit modal
        this.titleModal = document.getElementById('titleModal');
        this.editTitleInput = document.getElementById('editTitleInput');
        this.originalTitle = document.getElementById('originalTitle');

        // Rate limit elements
        this.rateLimitContainer = document.getElementById('rateLimitContainer');
        this.rateLimitFill = document.getElementById('rateLimitFill');
        this.rateLimitPercent = document.getElementById('rateLimitPercent');
        this.rateLimitReset = document.getElementById('rateLimitReset');
        this.rateLimitTokens = document.getElementById('rateLimitTokens');
        this.rateLimitTitle = document.getElementById('rateLimitTitle');

        // Rate limit sync modal
        this.rateLimitModal = document.getElementById('rateLimitModal');
        this.syncPercentInput = document.getElementById('syncPercent');
        this.syncHoursInput = document.getElementById('syncHours');
        this.syncMinutesInput = document.getElementById('syncMinutes');

        // API Usage elements
        this.apiUsageSection = document.getElementById('apiUsageSection');
        this.apiRateLimitValue = document.getElementById('apiRateLimitValue');
        this.apiRateLimitReset = document.getElementById('apiRateLimitReset');
        this.apiRateFill = document.getElementById('apiRateFill');
        this.apiTodayCost = document.getElementById('apiTodayCost');
        this.apiTodayTokens = document.getElementById('apiTodayTokens');
        this.apiMonthCost = document.getElementById('apiMonthCost');
        this.apiMonthTokens = document.getElementById('apiMonthTokens');
        this.apiUsageStatus = document.getElementById('apiUsageStatus');

        // Config modal elements
        this.configModal = document.getElementById('configModal');
        this.apiKeyInput = document.getElementById('apiKeyInput');
        this.configKeyStatus = document.getElementById('configKeyStatus');
    }

    bindEvents() {
        // Manual task events
        document.getElementById('addTaskBtn').addEventListener('click', () => this.openModal());
        document.getElementById('saveTaskBtn').addEventListener('click', () => this.saveTask());
        document.getElementById('cancelBtn').addEventListener('click', () => this.closeModal());
        document.getElementById('deleteTaskBtn').addEventListener('click', () => this.deleteTask());

        // Refresh button
        this.refreshBtn.addEventListener('click', () => this.fetchSessions());

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Collapsible sections
        document.querySelectorAll('.collapsible').forEach(h2 => {
            h2.addEventListener('click', () => {
                h2.closest('.task-section').classList.toggle('collapsed');
            });
        });

        // Modal events
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });

        // Session modal events
        this.sessionModal.addEventListener('click', (e) => {
            if (e.target === this.sessionModal) this.closeSessionModal();
        });
        document.getElementById('closeSessionBtn').addEventListener('click', () => this.closeSessionModal());

        // Title edit modal events
        this.titleModal.addEventListener('click', (e) => {
            if (e.target === this.titleModal) this.closeTitleModal();
        });
        document.getElementById('saveTitleBtn').addEventListener('click', () => this.saveCustomTitle());
        document.getElementById('cancelTitleBtn').addEventListener('click', () => this.closeTitleModal());
        document.getElementById('resetTitleBtn').addEventListener('click', () => this.resetCustomTitle());

        // Rate limit sync modal events
        document.getElementById('syncRateLimitBtn').addEventListener('click', () => this.openRateLimitModal());
        document.getElementById('saveSyncBtn').addEventListener('click', () => this.saveRateLimitSync());
        document.getElementById('cancelSyncBtn').addEventListener('click', () => this.closeRateLimitModal());
        document.getElementById('resetSyncBtn').addEventListener('click', () => this.resetRateLimitSync());
        this.rateLimitModal.addEventListener('click', (e) => {
            if (e.target === this.rateLimitModal) this.closeRateLimitModal();
        });

        // Config modal events
        document.getElementById('configBtn').addEventListener('click', () => this.openConfigModal());
        document.getElementById('saveConfigBtn').addEventListener('click', () => this.saveConfig());
        document.getElementById('cancelConfigBtn').addEventListener('click', () => this.closeConfigModal());
        document.getElementById('deleteConfigBtn').addEventListener('click', () => this.deleteConfig());
        this.configModal.addEventListener('click', (e) => {
            if (e.target === this.configModal) this.closeConfigModal();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
                this.closeSessionModal();
                this.closeTitleModal();
                this.closeRateLimitModal();
                this.closeConfigModal();
            }
            if (e.key === 'Enter' && this.modal.classList.contains('active')) {
                e.preventDefault();
                this.saveTask();
            }
        });
    }

    switchTab(tabName) {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}Tab`).classList.add('active');
    }

    // ==================== Session Management ====================

    async fetchSessions() {
        this.refreshBtn.classList.add('spinning');

        try {
            const response = await fetch(`${API_BASE}/sessions`);
            if (!response.ok) throw new Error('Server error');

            this.previousSessions = [...this.sessions];
            this.sessions = await response.json();

            this.setServerConnected(true);
            await this.renderSessions();
            this.checkForNewActivity();

            this.lastUpdate.textContent = `最終更新: ${new Date().toLocaleTimeString()}`;
        } catch (err) {
            console.error('Failed to fetch sessions:', err);
            this.setServerConnected(false);
        } finally {
            this.refreshBtn.classList.remove('spinning');
        }
    }

    setServerConnected(connected) {
        this.serverConnected = connected;
        this.serverStatus.className = `server-status ${connected ? 'connected' : 'disconnected'}`;
        this.serverStatus.textContent = connected ? 'サーバー接続中' : 'サーバー未接続';
    }

    startAutoRefresh() {
        setInterval(() => {
            if (this.serverConnected || !this.sessions.length) {
                this.fetchSessions();
                this.fetchStats();
                this.fetchRateLimit();
                // Refresh API data if configured (admin key only)
                if (this.hasApiKey && this.keyType === 'admin') {
                    this.fetchAnthropicRateLimit();
                    this.fetchAnthropicUsage();
                }
            }
        }, REFRESH_INTERVAL);
    }

    // ==================== Stats ====================

    async fetchStats() {
        try {
            const response = await fetch(`${API_BASE}/stats`);
            if (!response.ok) return;

            const stats = await response.json();
            this.renderStats(stats);
        } catch (err) {
            console.error('Failed to fetch stats:', err);
        }
    }

    async fetchRateLimit() {
        try {
            // Include syncedAt for message counting
            let url = `${API_BASE}/ratelimit`;
            if (this.rateLimitSync && this.rateLimitSync.syncedAt) {
                url += `?syncedAt=${this.rateLimitSync.syncedAt}`;
            }

            const response = await fetch(url);
            if (!response.ok) return;

            const status = await response.json();
            this.renderRateLimit(status);
        } catch (err) {
            console.error('Failed to fetch rate limit:', err);
        }
    }

    renderRateLimit(status) {
        // Check if we have a manual sync
        const syncData = this.getSyncedRateLimit();

        if (syncData) {
            // Use manually synced data with message-based estimation
            this.renderSyncedRateLimit(syncData, status);
        } else if (status) {
            // Use estimated data from server
            this.renderEstimatedRateLimit(status);
        }
    }

    renderEstimatedRateLimit(status) {
        const percent = status.usagePercent || 0;

        // Update title to show estimated
        this.rateLimitTitle.textContent = 'プラン使用制限（推定）';
        this.rateLimitContainer.classList.remove('synced');

        // Update progress bar
        this.rateLimitFill.style.width = `${percent}%`;

        // Color based on usage
        this.rateLimitFill.classList.remove('warning', 'danger');
        if (percent >= 80) {
            this.rateLimitFill.classList.add('danger');
        } else if (percent >= 50) {
            this.rateLimitFill.classList.add('warning');
        }

        // Update text
        this.rateLimitPercent.textContent = `${percent}% 使用済み`;
        this.rateLimitReset.textContent = status.resetTimeStr || '--';
        this.rateLimitTokens.textContent = `出力: ${this.formatNumber(status.outputTokens)} / ${this.formatNumber(status.limit)}`;

        // Update percent color
        this.rateLimitPercent.classList.remove('warning', 'danger');
        if (percent >= 80) {
            this.rateLimitPercent.classList.add('danger');
        } else if (percent >= 50) {
            this.rateLimitPercent.classList.add('warning');
        }
    }

    renderSyncedRateLimit(syncData, serverStatus = null) {
        // Base percentage from sync
        let percent = syncData.currentPercent;
        let messagesSinceSync = 0;
        let additionalPercent = 0;

        // Add message-based estimation (approximately 0.3% per message - conservative estimate)
        if (serverStatus && serverStatus.messagesSinceSync) {
            messagesSinceSync = serverStatus.messagesSinceSync;
            additionalPercent = Math.round(messagesSinceSync * 0.3);
            percent = Math.min(100, syncData.currentPercent + additionalPercent);
        }

        // Store current percent for modal pre-fill
        this.currentSyncedPercent = percent;

        // Update title to show synced
        this.rateLimitTitle.textContent = 'プラン使用制限（同期済み）';
        this.rateLimitContainer.classList.add('synced');

        // Update progress bar
        this.rateLimitFill.style.width = `${percent}%`;

        // Color based on usage
        this.rateLimitFill.classList.remove('warning', 'danger');
        if (percent >= 80) {
            this.rateLimitFill.classList.add('danger');
        } else if (percent >= 50) {
            this.rateLimitFill.classList.add('warning');
        }

        // Update text
        this.rateLimitPercent.textContent = `${percent}% 使用済み`;
        this.rateLimitReset.textContent = syncData.resetTimeStr;

        // Show message count and additional percentage
        if (messagesSinceSync > 0) {
            this.rateLimitTokens.textContent = `+${messagesSinceSync}件 (+${additionalPercent}%) ${this.formatSyncTime(syncData.syncedAt)}`;
        } else {
            this.rateLimitTokens.textContent = `同期: ${this.formatSyncTime(syncData.syncedAt)}`;
        }

        // Update percent color
        this.rateLimitPercent.classList.remove('warning', 'danger');
        if (percent >= 80) {
            this.rateLimitPercent.classList.add('danger');
        } else if (percent >= 50) {
            this.rateLimitPercent.classList.add('warning');
        }
    }

    // ==================== Rate Limit Sync ====================

    loadRateLimitSync() {
        const saved = localStorage.getItem('claudeRateLimitSync');
        return saved ? JSON.parse(saved) : null;
    }

    saveRateLimitSyncData(data) {
        localStorage.setItem('claudeRateLimitSync', JSON.stringify(data));
        this.rateLimitSync = data;
    }

    getSyncedRateLimit() {
        if (!this.rateLimitSync) return null;

        const now = Date.now();
        const syncedAt = this.rateLimitSync.syncedAt;
        const elapsedMs = now - syncedAt;
        const resetMs = this.rateLimitSync.resetMs;

        // Check if reset time has passed
        if (elapsedMs >= resetMs) {
            // Reset has occurred, clear sync data
            this.clearRateLimitSync();
            return null;
        }

        // Calculate remaining time
        const remainingMs = resetMs - elapsedMs;
        const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
        const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

        return {
            currentPercent: this.rateLimitSync.percent,
            resetTimeStr: `${remainingHours}時間${remainingMinutes}分後にリセット`,
            remainingMs: remainingMs,
            syncedAt: syncedAt
        };
    }

    clearRateLimitSync() {
        localStorage.removeItem('claudeRateLimitSync');
        this.rateLimitSync = null;
        this.currentSyncedPercent = null;
    }

    openRateLimitModal() {
        // Pre-fill with current estimated values if sync exists
        const syncData = this.getSyncedRateLimit();
        if (syncData) {
            // Use current displayed percent (includes message estimation)
            this.syncPercentInput.value = this.currentSyncedPercent ?? syncData.currentPercent;
            // Use remaining time (not original reset time)
            const hours = Math.floor(syncData.remainingMs / (1000 * 60 * 60));
            const minutes = Math.floor((syncData.remainingMs % (1000 * 60 * 60)) / (1000 * 60));
            this.syncHoursInput.value = hours;
            this.syncMinutesInput.value = minutes;
        } else {
            this.syncPercentInput.value = '';
            this.syncHoursInput.value = '';
            this.syncMinutesInput.value = '';
        }
        this.rateLimitModal.classList.add('active');
        this.syncPercentInput.focus();
    }

    closeRateLimitModal() {
        this.rateLimitModal.classList.remove('active');
    }

    saveRateLimitSync() {
        const percent = parseInt(this.syncPercentInput.value) || 0;
        const hours = parseInt(this.syncHoursInput.value) || 0;
        const minutes = parseInt(this.syncMinutesInput.value) || 0;

        if (percent < 0 || percent > 100) {
            alert('使用率は0〜100の間で入力してください');
            return;
        }

        const resetMs = (hours * 60 * 60 * 1000) + (minutes * 60 * 1000);

        const syncData = {
            percent: percent,
            resetMs: resetMs,
            syncedAt: Date.now()
        };

        this.saveRateLimitSyncData(syncData);
        this.closeRateLimitModal();
        this.fetchRateLimit();  // Fetch to get initial message count
    }

    resetRateLimitSync() {
        this.clearRateLimitSync();
        this.closeRateLimitModal();
        this.fetchRateLimit();
    }

    formatSyncTime(timestamp) {
        const date = new Date(timestamp);
        return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}に同期`;
    }

    startRateLimitTimer() {
        // Update every minute to refresh message count and reset time
        setInterval(() => {
            if (this.rateLimitSync) {
                const syncData = this.getSyncedRateLimit();
                if (!syncData) {
                    // Reset time passed, fetch new estimate
                    this.fetchRateLimit();
                } else {
                    // Fetch to get updated message count
                    this.fetchRateLimit();
                }
            }
            // Also refresh API usage if configured (admin key only)
            if (this.hasApiKey && this.keyType === 'admin') {
                this.fetchAnthropicRateLimit();
            }
        }, 60 * 1000);
    }

    // ==================== Config Modal ====================

    async fetchConfig() {
        try {
            const response = await fetch(`${API_BASE}/config`);
            if (!response.ok) return;

            const config = await response.json();
            this.hasApiKey = config.hasApiKey;
            this.keyType = config.keyType;

            if (config.hasApiKey && config.keyType === 'admin') {
                // Admin key: Show API usage section with full data
                this.apiUsageSection.style.display = 'block';
                this.rateLimitContainer.style.display = 'none';
                this.updateConfigStatus(config);
                this.fetchAnthropicRateLimit();
                this.fetchAnthropicUsage();
            } else if (config.hasApiKey) {
                // OAuth/Standard key: Show rate limit section with estimation only
                // OAuth tokens cannot fetch rate limits from API
                this.apiUsageSection.style.display = 'none';
                this.rateLimitContainer.style.display = 'block';
                this.updateConfigStatus(config);
                // Don't fetch rate limit for OAuth - use manual sync/estimation only
            } else {
                // No key: Show rate limit section with estimation
                this.apiUsageSection.style.display = 'none';
                this.rateLimitContainer.style.display = 'block';
            }
        } catch (err) {
            console.error('Failed to fetch config:', err);
        }
    }

    updateConfigStatus(config) {
        if (config.hasApiKey) {
            let typeLabel = 'Standard API';
            if (config.keyType === 'admin') {
                typeLabel = 'Admin API';
            } else if (config.keyType === 'oauth') {
                typeLabel = 'OAuth (Maxプラン)';
            }
            this.configKeyStatus.textContent = `${typeLabel} (${config.maskedKey})`;
            this.configKeyStatus.className = `config-value configured ${config.keyType}`;
        } else {
            this.configKeyStatus.textContent = '未設定';
            this.configKeyStatus.className = 'config-value';
        }
    }

    openConfigModal() {
        this.fetchConfig().then(() => {
            this.configModal.classList.add('active');
            this.apiKeyInput.value = '';
        });
    }

    closeConfigModal() {
        this.configModal.classList.remove('active');
        this.apiKeyInput.value = '';
    }

    async saveConfig() {
        const apiKey = this.apiKeyInput.value.trim();
        if (!apiKey) {
            alert('APIキーを入力してください');
            return;
        }

        if (!apiKey.startsWith('sk-ant-')) {
            alert('無効なAPIキー形式です。sk-ant-で始まる必要があります。');
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey })
            });

            const result = await response.json();
            if (result.success) {
                this.closeConfigModal();
                this.fetchConfig();
            } else {
                alert('設定の保存に失敗しました');
            }
        } catch (err) {
            console.error('Failed to save config:', err);
            alert('設定の保存に失敗しました');
        }
    }

    async deleteConfig() {
        if (!confirm('APIキーを削除しますか？')) return;

        try {
            const response = await fetch(`${API_BASE}/config`, {
                method: 'DELETE'
            });

            if (response.ok) {
                this.closeConfigModal();
                this.fetchConfig();
            }
        } catch (err) {
            console.error('Failed to delete config:', err);
        }
    }

    // ==================== Anthropic API ====================

    async fetchAnthropicRateLimit() {
        try {
            const response = await fetch(`${API_BASE}/anthropic/ratelimit`);
            if (!response.ok) return;

            const data = await response.json();
            if (data.error) {
                this.apiUsageStatus.textContent = data.error;
                return;
            }

            this.renderAnthropicRateLimit(data);
        } catch (err) {
            console.error('Failed to fetch Anthropic rate limit:', err);
        }
    }

    renderAnthropicRateLimit(data) {
        const percent = data.usagePercent || 0;

        // Check which container is visible
        if (this.apiUsageSection.style.display !== 'none') {
            // API usage section (Admin key)
            this.apiRateLimitValue.textContent = `${percent}%`;
            this.apiRateLimitReset.textContent = data.resetTimeStr || '--';
            this.apiRateFill.style.width = `${percent}%`;

            this.apiRateFill.classList.remove('warning', 'danger');
            if (percent >= 80) {
                this.apiRateFill.classList.add('danger');
            } else if (percent >= 50) {
                this.apiRateFill.classList.add('warning');
            }

            this.apiUsageStatus.textContent = `更新: ${new Date().toLocaleTimeString()}`;
        } else {
            // Rate limit container (OAuth/Standard key) - use API data
            this.rateLimitTitle.textContent = 'プラン使用制限（API）';
            this.rateLimitContainer.classList.add('synced');

            this.rateLimitFill.style.width = `${percent}%`;
            this.rateLimitPercent.textContent = `${percent}% 使用済み`;
            this.rateLimitReset.textContent = data.resetTimeStr || '--';

            // Show token info if available
            if (data.outputTokensRemaining !== null && data.outputTokensLimit) {
                this.rateLimitTokens.textContent = `残り: ${this.formatNumber(data.outputTokensRemaining)} / ${this.formatNumber(data.outputTokensLimit)}`;
            } else if (data.tokensRemaining !== null && data.tokensLimit) {
                this.rateLimitTokens.textContent = `残り: ${this.formatNumber(data.tokensRemaining)} / ${this.formatNumber(data.tokensLimit)}`;
            }

            this.rateLimitFill.classList.remove('warning', 'danger');
            this.rateLimitPercent.classList.remove('warning', 'danger');
            if (percent >= 80) {
                this.rateLimitFill.classList.add('danger');
                this.rateLimitPercent.classList.add('danger');
            } else if (percent >= 50) {
                this.rateLimitFill.classList.add('warning');
                this.rateLimitPercent.classList.add('warning');
            }
        }
    }

    async fetchAnthropicUsage() {
        try {
            const response = await fetch(`${API_BASE}/anthropic/usage`);
            if (!response.ok) return;

            const data = await response.json();
            if (data.error) {
                // Admin key required - show message
                this.apiTodayCost.textContent = '--';
                this.apiTodayTokens.textContent = data.error;
                this.apiMonthCost.textContent = '--';
                this.apiMonthTokens.textContent = '';
                return;
            }

            this.renderAnthropicUsage(data);
        } catch (err) {
            console.error('Failed to fetch Anthropic usage:', err);
        }
    }

    renderAnthropicUsage(data) {
        if (data.today) {
            this.apiTodayCost.textContent = this.formatCost(data.today.cost);
            const todayTotal = (data.today.tokens.input || 0) + (data.today.tokens.output || 0);
            this.apiTodayTokens.textContent = this.formatTokens(todayTotal);
        }

        if (data.month) {
            this.apiMonthCost.textContent = this.formatCost(data.month.cost);
            const monthTotal = (data.month.tokens.input || 0) + (data.month.tokens.output || 0);
            this.apiMonthTokens.textContent = this.formatTokens(monthTotal);
        }
    }

    formatTokens(tokens) {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(1)}M tokens`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K tokens`;
        }
        return `${tokens} tokens`;
    }

    renderStats(stats) {
        // Today's message count (from JSONL files, real-time)
        this.statMessages.textContent = stats.todayMessageCount || 0;

        // Costs from JSONL cache
        const tokens = stats.tokens || {};
        this.statTodayTokens.textContent = this.formatCost(tokens.todayCost || 0);
        this.statWeekTokens.textContent = this.formatCost(tokens.weekCost || 0);
        this.statMonthTokens.textContent = this.formatCost(tokens.monthCost || 0);
        this.statLastMonthTokens.textContent = this.formatCost(tokens.lastMonthCost || 0);

        // Render history charts if on history tab
        if (stats.dailyHistory && stats.monthlySummary) {
            this.renderHistoryCharts(stats.dailyHistory, stats.monthlySummary);
        }
    }

    formatCost(costUSD) {
        const costJPY = Math.round(costUSD * 150);
        if (costJPY >= 10000) {
            return '¥' + (costJPY / 10000).toFixed(1) + '万';
        }
        if (costJPY >= 1000) {
            return '¥' + (costJPY / 1000).toFixed(1) + 'K';
        }
        return '¥' + costJPY;
    }

    renderHistoryCharts(dailyHistory, monthlySummary) {
        // Monthly chart (bar chart) - using cost for height
        if (this.monthlyChart && monthlySummary.length > 0) {
            const maxCost = Math.max(...monthlySummary.map(m => m.costUSD));
            this.monthlyChart.innerHTML = monthlySummary.map(m => {
                const heightPercent = maxCost > 0 ? (m.costUSD / maxCost) * 100 : 0;
                const costJPY = Math.round(m.costUSD * 150);
                return `
                    <div class="chart-bar-container">
                        <div class="chart-bar" style="height: ${heightPercent}%">
                            <span class="chart-value">¥${this.formatCompactNumber(costJPY)}</span>
                        </div>
                        <span class="chart-label">${m.month.substring(5)}</span>
                        <span class="chart-cost">${m.days}日</span>
                    </div>
                `;
            }).join('');
        }

        // Daily chart (last 30 days) - using cost
        const last30Days = dailyHistory.slice(-30);
        if (this.dailyChart && last30Days.length > 0) {
            const maxCost = Math.max(...last30Days.map(d => d.cost || 0));
            this.dailyChart.innerHTML = last30Days.map(d => {
                const cost = d.cost || 0;
                const heightPercent = maxCost > 0 ? (cost / maxCost) * 100 : 0;
                const day = d.date.substring(8);
                const costJPY = Math.round(cost * 150);
                return `
                    <div class="daily-bar-container" title="${d.date}: ¥${costJPY.toLocaleString()}">
                        <div class="daily-bar" style="height: ${heightPercent}%"></div>
                        <span class="daily-label">${day}</span>
                    </div>
                `;
            }).join('');
        }

        // Monthly table with detailed breakdown
        if (this.monthlyTable && monthlySummary.length > 0) {
            this.monthlyTable.innerHTML = `
                <table class="summary-table">
                    <thead>
                        <tr>
                            <th>月</th>
                            <th>出力</th>
                            <th>入力</th>
                            <th>キャッシュ</th>
                            <th>日数</th>
                            <th>コスト</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${monthlySummary.slice().reverse().map(m => {
                            const costJPY = Math.round(m.costUSD * 150);
                            const cacheTotal = (m.cacheReadTokens || 0) + (m.cacheCreationTokens || 0);
                            return `
                                <tr>
                                    <td>${m.month}</td>
                                    <td>${this.formatNumber(m.outputTokens || 0)}</td>
                                    <td>${this.formatNumber(m.inputTokens || 0)}</td>
                                    <td>${this.formatNumber(cacheTotal)}</td>
                                    <td>${m.days}</td>
                                    <td class="cost-cell">¥${costJPY.toLocaleString()}<br><small>$${m.costUSD.toFixed(2)}</small></td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `;
        }
    }

    formatCompactNumber(num) {
        if (num >= 10000) return (num / 10000).toFixed(1) + '万';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    }

    formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    }

    checkForNewActivity() {
        if (!this.previousSessions.length) return;

        // Check for newly active sessions
        const prevActiveIds = this.previousSessions
            .filter(s => s.status === 'in_progress')
            .map(s => s.id);

        const newActive = this.sessions.filter(s =>
            s.status === 'in_progress' && !prevActiveIds.includes(s.id)
        );

        newActive.forEach(session => {
            this.showNotification(`新しいアクティビティ: ${session.name.substring(0, 50)}`);
        });
    }

    async renderSessions() {
        // Prevent concurrent renders
        if (this.isRenderingSessions) {
            return;
        }
        this.isRenderingSessions = true;

        try {
            const active = this.sessions.filter(s => s.status === 'in_progress');
            const recent = this.sessions.filter(s => s.status === 'pending');
            const old = this.sessions.filter(s => s.status === 'completed');

            this.activeContainer.innerHTML = '';
            this.recentContainer.innerHTML = '';
            this.oldContainer.innerHTML = '';

            active.forEach(s => this.activeContainer.appendChild(this.createSessionCard(s, 'active')));
            recent.forEach(s => this.recentContainer.appendChild(this.createSessionCard(s, 'recent')));
            old.slice(0, 10).forEach(s => this.oldContainer.appendChild(this.createSessionCard(s, 'old')));

            this.activeCount.textContent = `(${active.length})`;
            this.recentCount.textContent = `(${recent.length})`;
            this.oldCount.textContent = `(${old.length})`;

            // Fetch todos after all cards are in DOM
            await this.fetchAllCardTodos();
        } finally {
            this.isRenderingSessions = false;
        }
    }

    createSessionCard(session, type) {
        const card = document.createElement('div');
        card.className = `session-card ${type}`;

        const timeAgo = this.formatTimeAgo(session.minutesAgo);
        const displayTitle = this.getDisplayTitle(session);
        const hasCustomTitle = this.customTitles[session.id] ? true : false;

        // Token usage calculation
        const tokenUsage = session.tokenUsage || {};
        const totalTokens = tokenUsage.totalTokens || 0;
        const outputTokens = tokenUsage.outputTokens || 0;
        const inputTokens = tokenUsage.inputTokens || 0;
        const cacheReadTokens = tokenUsage.cacheReadTokens || 0;
        const cacheCreationTokens = tokenUsage.cacheCreationTokens || 0;
        const estimatedCost = session.estimatedCost || 0;

        // Use output tokens for percentage (more meaningful metric)
        // Claude Pro Max has high output limits, use 200K as reference
        const OUTPUT_TOKEN_LIMIT = 200000;
        const usagePercent = Math.min(100, Math.round((outputTokens / OUTPUT_TOKEN_LIMIT) * 100));

        // Gauge color class based on usage
        let gaugeColorClass = '';
        if (usagePercent >= 80) {
            gaugeColorClass = 'danger';
        } else if (usagePercent >= 50) {
            gaugeColorClass = 'warning';
        }

        // Cost in JPY (approximate rate: 1 USD = 150 JPY)
        const costJPY = Math.round(estimatedCost * 150);

        // Check if cache tokens are significant
        const hasCacheTokens = cacheReadTokens > 0 || cacheCreationTokens > 0;

        card.innerHTML = `
            <div class="card-header">
                <h3 class="${hasCustomTitle ? 'custom-title' : ''}">${this.escapeHtml(displayTitle)}</h3>
                <button class="btn-edit-title" title="タイトルを編集">✏️</button>
            </div>
            <div class="session-meta">
                <span>${timeAgo}</span>
                <span class="task-summary" data-session-id="${session.id}"></span>
                <span class="message-count">${session.messageCount} msgs</span>
            </div>
            ${outputTokens > 0 ? `
            <div class="session-usage">
                <div class="usage-header">
                    <span class="usage-label">使用量</span>
                    <span class="usage-cost">¥${costJPY.toLocaleString()} ($${estimatedCost.toFixed(2)})</span>
                </div>
                <div class="usage-gauge">
                    <div class="usage-gauge-fill ${gaugeColorClass}" style="width: ${usagePercent}%"></div>
                </div>
                <div class="usage-details">
                    <span>出力: ${this.formatNumber(outputTokens)} / 入力: ${this.formatNumber(inputTokens)}</span>
                    <span class="usage-percent ${gaugeColorClass}">${usagePercent}%</span>
                </div>
                ${hasCacheTokens ? `
                <div class="usage-cache">
                    <span class="cache-label">キャッシュ:</span>
                    <span>読込 ${this.formatNumber(cacheReadTokens)} / 作成 ${this.formatNumber(cacheCreationTokens)}</span>
                </div>
                ` : ''}
            </div>
            ` : ''}
            <div class="card-tasks" data-session-id="${session.id}">
                <div class="card-progress-bar"><div class="card-progress-fill"></div></div>
                <div class="card-task-list"><span class="no-tasks-small">タスクなし</span></div>
            </div>
        `;

        // Edit title button event
        const editBtn = card.querySelector('.btn-edit-title');
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openTitleModal(session);
        });

        // Immediately render cached todos if available
        if (this.todosCache[session.id]) {
            this.renderCardTodos(card, this.todosCache[session.id]);
        }

        return card;
    }

    async fetchCardTodos(sessionId, card) {
        try {
            console.log(`Fetching todos for session: ${sessionId}`);
            const response = await fetch(`${API_BASE}/todos/${sessionId}`);
            const todos = await response.json();
            console.log(`Todos received for ${sessionId}:`, todos);
            this.renderCardTodos(card, todos);
        } catch (err) {
            console.error(`Error fetching todos for ${sessionId}:`, err);
        }
    }

    async fetchAllCardTodos() {
        // Fetch todos for all cards currently in DOM
        const cardTasksElements = document.querySelectorAll('.card-tasks[data-session-id]');

        for (const cardTasks of cardTasksElements) {
            const sessionId = cardTasks.dataset.sessionId;
            const card = cardTasks.closest('.session-card');

            if (card && document.body.contains(card)) {
                try {
                    const response = await fetch(`${API_BASE}/todos/${sessionId}`);
                    const todos = await response.json();
                    // Save to cache for instant display on next render
                    this.todosCache[sessionId] = todos;
                    this.renderCardTodos(card, todos);
                } catch (err) {
                    console.error(`Error fetching todos for ${sessionId}:`, err);
                }
            }
        }
    }

    renderCardTodos(card, todos) {
        // Check if card is still in DOM (may have been removed by re-render)
        if (!document.body.contains(card)) {
            return;
        }

        const progressFill = card.querySelector('.card-progress-fill');
        const taskList = card.querySelector('.card-task-list');
        const taskSummary = card.querySelector('.task-summary');

        if (!taskList) {
            console.error('taskList element not found in card');
            return;
        }

        if (!todos || todos.length === 0) {
            taskList.innerHTML = '<span class="no-tasks-small">タスクなし</span>';
            if (taskSummary) taskSummary.textContent = '';
            return;
        }

        const completed = todos.filter(t => t.status === 'completed').length;
        const inProgress = todos.filter(t => t.status === 'in_progress').length;
        const percent = Math.round((completed / todos.length) * 100);

        progressFill.style.width = `${percent}%`;

        // Update task summary in session-meta
        if (taskSummary) {
            if (inProgress > 0) {
                taskSummary.textContent = `🔄 ${completed}/${todos.length}`;
                taskSummary.className = 'task-summary active';
            } else if (completed === todos.length) {
                taskSummary.textContent = `✅ ${completed}/${todos.length}`;
                taskSummary.className = 'task-summary completed';
            } else {
                taskSummary.textContent = `⏳ ${completed}/${todos.length}`;
                taskSummary.className = 'task-summary pending';
            }
        }

        const statusIcons = {
            'in_progress': '🔄',
            'completed': '✅',
            'pending': '⏳'
        };

        // Show up to 5 tasks
        taskList.innerHTML = todos.slice(0, 5).map(todo => `
            <div class="card-todo ${todo.status}">
                <span>${statusIcons[todo.status] || '⏳'}</span>
                <span>${this.escapeHtml((todo.content || todo.activeForm || '').substring(0, 30))}</span>
            </div>
        `).join('') + (todos.length > 5 ? `<span class="more-tasks">+${todos.length - 5} more</span>` : '');
    }

    // ==================== Session Detail Modal ====================

    async openSessionModal(session) {
        this.sessionModalTitle.textContent = session.name.substring(0, 50);
        this.sessionInfo.innerHTML = `
            <p><strong>セッションID:</strong> ${session.id.substring(0, 8)}...</p>
            <p><strong>メッセージ数:</strong> ${session.messageCount}</p>
            <p><strong>最終更新:</strong> ${this.formatTimeAgo(session.minutesAgo)}</p>
        `;

        // Fetch todos for this session
        try {
            const response = await fetch(`${API_BASE}/todos/${session.id}`);
            const todos = await response.json();
            this.renderSessionTodos(todos);
        } catch (err) {
            this.taskList.innerHTML = '<p class="no-tasks">タスク情報なし</p>';
            this.taskProgressFill.style.width = '0%';
            this.taskProgressText.textContent = '0%';
        }

        this.sessionModal.classList.add('active');
    }

    closeSessionModal() {
        this.sessionModal.classList.remove('active');
    }

    renderSessionTodos(todos) {
        if (!todos || todos.length === 0) {
            this.taskList.innerHTML = '<p class="no-tasks">タスクなし</p>';
            this.taskProgressFill.style.width = '0%';
            this.taskProgressText.textContent = '0%';
            return;
        }

        const completed = todos.filter(t => t.status === 'completed').length;
        const percent = Math.round((completed / todos.length) * 100);

        this.taskProgressFill.style.width = `${percent}%`;
        this.taskProgressText.textContent = `${percent}% (${completed}/${todos.length})`;

        const statusIcons = {
            'in_progress': '🔄',
            'completed': '✅',
            'pending': '⏳'
        };

        this.taskList.innerHTML = todos.map(todo => `
            <div class="todo-item ${todo.status}">
                <span class="todo-icon">${statusIcons[todo.status] || '⏳'}</span>
                <span class="todo-content">${this.escapeHtml(todo.content || todo.activeForm || 'タスク')}</span>
            </div>
        `).join('');
    }

    formatTimeAgo(minutes) {
        if (minutes < 1) return 'たった今';
        if (minutes < 60) return `${minutes}分前`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}時間前`;
        const days = Math.floor(hours / 24);
        return `${days}日前`;
    }

    // ==================== Manual Task Management ====================

    loadTasks() {
        const saved = localStorage.getItem('claudeTasks');
        return saved ? JSON.parse(saved) : [];
    }

    saveTasks() {
        localStorage.setItem('claudeTasks', JSON.stringify(this.tasks));
    }

    openModal(task = null) {
        this.editingTaskId = task ? task.id : null;
        this.modalTitle.textContent = task ? 'タスクを編集' : 'タスクを追加';
        this.taskNameInput.value = task ? task.name : '';
        this.taskDescInput.value = task ? task.description : '';
        this.taskStatusSelect.value = task ? task.status : 'pending';
        this.deleteBtn.style.display = task ? 'block' : 'none';
        this.modal.classList.add('active');
        this.taskNameInput.focus();
    }

    closeModal() {
        this.modal.classList.remove('active');
        this.editingTaskId = null;
    }

    saveTask() {
        const name = this.taskNameInput.value.trim();
        if (!name) {
            this.taskNameInput.focus();
            return;
        }

        const newStatus = this.taskStatusSelect.value;

        if (this.editingTaskId) {
            const task = this.tasks.find(t => t.id === this.editingTaskId);
            if (task) {
                const oldStatus = task.status;
                task.name = name;
                task.description = this.taskDescInput.value.trim();
                task.status = newStatus;
                task.updatedAt = Date.now();

                if (oldStatus !== 'completed' && newStatus === 'completed') {
                    this.showNotification(task.name);
                }
            }
        } else {
            const task = {
                id: Date.now().toString(),
                name: name,
                description: this.taskDescInput.value.trim(),
                status: newStatus,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            this.tasks.push(task);

            if (newStatus === 'completed') {
                this.showNotification(task.name);
            }
        }

        this.saveTasks();
        this.render();
        this.closeModal();
    }

    deleteTask() {
        if (!this.editingTaskId) return;
        if (!confirm('このタスクを削除しますか？')) return;

        this.tasks = this.tasks.filter(t => t.id !== this.editingTaskId);
        this.saveTasks();
        this.render();
        this.closeModal();
    }

    createTaskCard(task) {
        const card = document.createElement('div');
        card.className = `task-card ${task.status}`;
        card.onclick = () => this.openModal(task);

        const statusIcons = {
            'in_progress': '🔄',
            'completed': '✅',
            'pending': '⏳'
        };

        const statusTexts = {
            'in_progress': '進行中',
            'completed': '完了',
            'pending': '待機中'
        };

        card.innerHTML = `
            <h3>${this.escapeHtml(task.name)}</h3>
            ${task.description ? `<p>${this.escapeHtml(task.description)}</p>` : ''}
            <span class="task-status ${task.status}">
                ${statusIcons[task.status]} ${statusTexts[task.status]}
            </span>
        `;

        return card;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    render() {
        const inProgress = this.tasks.filter(t => t.status === 'in_progress');
        const pending = this.tasks.filter(t => t.status === 'pending');
        const completed = this.tasks.filter(t => t.status === 'completed');

        this.inProgressContainer.innerHTML = '';
        this.pendingContainer.innerHTML = '';
        this.completedContainer.innerHTML = '';

        inProgress.forEach(task => {
            this.inProgressContainer.appendChild(this.createTaskCard(task));
        });

        pending.forEach(task => {
            this.pendingContainer.appendChild(this.createTaskCard(task));
        });

        completed.forEach(task => {
            this.completedContainer.appendChild(this.createTaskCard(task));
        });

        this.inProgressCount.textContent = `(${inProgress.length})`;
        this.pendingCount.textContent = `(${pending.length})`;
        this.completedCount.textContent = `(${completed.length})`;

        this.updateProgress(completed.length, this.tasks.length);
    }

    updateProgress(completed, total) {
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        this.progressFill.style.width = `${percent}%`;
        this.progressText.textContent = `${percent}% (${completed}/${total})`;
    }

    // ==================== Notifications ====================

    requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    showNotification(message) {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Claude Task Dashboard', {
                body: message,
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📋</text></svg>'
            });
        }
    }

    // ==================== Custom Title Management ====================

    loadCustomTitles() {
        const saved = localStorage.getItem('claudeCustomTitles');
        return saved ? JSON.parse(saved) : {};
    }

    saveCustomTitles() {
        localStorage.setItem('claudeCustomTitles', JSON.stringify(this.customTitles));
    }

    getDisplayTitle(session) {
        return this.customTitles[session.id] || session.name;
    }

    openTitleModal(session) {
        this.editingSessionId = session.id;
        this.editTitleInput.value = this.customTitles[session.id] || '';
        this.originalTitle.textContent = `元のタイトル: ${session.name.substring(0, 80)}`;
        this.titleModal.classList.add('active');
        this.editTitleInput.focus();
    }

    closeTitleModal() {
        this.titleModal.classList.remove('active');
        this.editingSessionId = null;
    }

    async saveCustomTitle() {
        if (!this.editingSessionId) return;

        const newTitle = this.editTitleInput.value.trim();
        if (newTitle) {
            this.customTitles[this.editingSessionId] = newTitle;
        } else {
            delete this.customTitles[this.editingSessionId];
        }

        this.saveCustomTitles();
        await this.renderSessions();
        this.closeTitleModal();
    }

    async resetCustomTitle() {
        if (!this.editingSessionId) return;

        delete this.customTitles[this.editingSessionId];
        this.saveCustomTitles();
        await this.renderSessions();
        this.closeTitleModal();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new TaskDashboard();
});
