// Task Dashboard Application

const API_URL = 'http://localhost:3456/api/sessions';
const REFRESH_INTERVAL = 10000; // 10 seconds

class TaskDashboard {
    constructor() {
        this.tasks = this.loadTasks();
        this.sessions = [];
        this.previousSessions = [];
        this.editingTaskId = null;
        this.serverConnected = false;

        this.initElements();
        this.bindEvents();
        this.requestNotificationPermission();
        this.render();
        this.fetchSessions();
        this.startAutoRefresh();
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

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeModal();
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
            const response = await fetch(API_URL);
            if (!response.ok) throw new Error('Server error');

            this.previousSessions = [...this.sessions];
            this.sessions = await response.json();

            this.setServerConnected(true);
            this.renderSessions();
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
            }
        }, REFRESH_INTERVAL);
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

    renderSessions() {
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
    }

    createSessionCard(session, type) {
        const card = document.createElement('div');
        card.className = `session-card ${type}`;

        const timeAgo = this.formatTimeAgo(session.minutesAgo);

        card.innerHTML = `
            <h3>${this.escapeHtml(session.name)}</h3>
            <div class="session-meta">
                <span>${timeAgo}</span>
                <span class="message-count">${session.messageCount} msgs</span>
            </div>
        `;

        return card;
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
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    new TaskDashboard();
});
