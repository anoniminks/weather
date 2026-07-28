// ============================================================
// Плагин Lampa: HDRezka + AmneziaWG 1.5
// Версия 4.0
// ============================================================

(function() {
    const PLUGIN_ID = 'hdrezka_amnezia';

    const Store = {
        get(key, def = null) {
            try {
                const val = localStorage.getItem(`plugin_${PLUGIN_ID}_${key}`);
                return val ? JSON.parse(val) : def;
            } catch { return def; }
        },
        set(key, val) {
            localStorage.setItem(`plugin_${PLUGIN_ID}_${key}`, JSON.stringify(val));
        }
    };

    // ============================================================
    // Парсер AmneziaWG 1.5
    // ============================================================
    class AmneziaParser {
        constructor() {
            this.servers = [];
            this.rawConfig = Store.get('config_text', '');
            this.ready = false;
        }

        parse(text) {
            const servers = [];
            const lines = text.split('\n');
            let currentPeer = null;

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;

                if (trimmed === '[Peer]') {
                    currentPeer = {};
                    continue;
                }

                const match = trimmed.match(/^([^=]+)\s*=\s*(.+)$/);
                if (!match) continue;

                const key = match[1].trim();
                const value = match[2].trim();

                if (currentPeer && key === 'Endpoint') {
                    const server = this.extractServer(value);
                    if (server) {
                        servers.push(server);
                        currentPeer._server = server;
                    }
                }
            }

            // Если не нашли Peer — пытаемся найти Endpoint в Interface
            if (servers.length === 0) {
                for (const line of lines) {
                    if (line.includes('Endpoint')) {
                        const match = line.match(/Endpoint\s*=\s*(.+)/);
                        if (match) {
                            const server = this.extractServer(match[1].trim());
                            if (server) servers.push(server);
                        }
                    }
                }
            }

            return servers;
        }

        extractServer(endpoint) {
            const match = endpoint.match(/^([^:]+):(\d+)$/);
            if (match) {
                return {
                    ip: match[1],
                    port: parseInt(match[2]),
                    full: endpoint
                };
            }
            return null;
        }

        load(text) {
            this.rawConfig = text;
            Store.set('config_text', text);
            this.servers = this.parse(text);
            this.ready = this.servers.length > 0;
            return this.servers;
        }

        getStats() {
            return {
                count: this.servers.length,
                ready: this.ready
            };
        }
    }

    // ============================================================
    // Менеджер прокси
    // ============================================================
    class AmneziaProxyManager {
        constructor(parser) {
            this.parser = parser;
            this.currentIndex = 0;
        }

        getNextProxy() {
            const servers = this.parser.servers;
            if (servers.length === 0) return null;

            const server = servers[this.currentIndex % servers.length];
            this.currentIndex = (this.currentIndex + 1) % servers.length;
            return server;
        }

        async fetch(url, options = {}) {
            const maxRetries = 5;
            let lastError = null;

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                const proxy = this.getNextProxy();
                if (!proxy) break;

                try {
                    const proxyUrl = `http://${proxy.ip}:${proxy.port}`;

                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 15000);

                    const response = await fetch(url, {
                        ...options,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
                            ...options.headers
                        },
                        signal: controller.signal
                    });

                    clearTimeout(timeout);

                    if (response.ok) {
                        console.log(`[Amnezia] Успешно через ${proxy.full}`);
                        return response;
                    }
                } catch (error) {
                    lastError = error;
                    console.warn(`[Amnezia] Попытка ${attempt + 1} не удалась:`, error.message);
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }

            throw lastError || new Error('Все попытки через Amnezia не удались');
        }
    }

    // ============================================================
    // Парсер HDRezka через Amnezia
    // ============================================================
    class HDRezkaAmneziaParser {
        constructor() {
            this.name = 'HDRezka (Amnezia)';
            this.type = 'movie';
            this.baseUrl = 'https://hdrezka.ag';
            this.parser = new AmneziaParser();
            this.proxy = new AmneziaProxyManager(this.parser);
            this.initialized = false;
        }

        async init() {
            if (this.initialized) return;
            const saved = Store.get('config_text', '');
            if (saved) this.parser.load(saved);
            this.initialized = true;
        }

        loadConfig(text) {
            return this.parser.load(text);
        }

        async search(query, page = 1) {
            await this.init();
            if (!this.parser.ready) return [];

            try {
                const url = `${this.baseUrl}/search/?do=search&subaction=search&q=${encodeURIComponent(query)}`;
                const response = await this.proxy.fetch(url);
                const html = await response.text();
                return this.parseSearchResults(html);
            } catch (error) {
                console.error('[HDRezka] Search error:', error);
                return [];
            }
        }

        parseSearchResults(html) {
            const results = [];
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const items = doc.querySelectorAll('.b-content__inline_item');
            items.forEach(item => {
                const link = item.querySelector('.b-content__inline_item-link a');
                const title = link?.textContent?.trim() || '';
                const href = link?.getAttribute('href') || '';
                const poster = item.querySelector('.b-content__inline_item-cover img')?.getAttribute('src') || '';

                const isSeries = href.includes('/series/');
                const type = isSeries ? 'tv' : 'movie';
                const id = href.match(/\/(\d+)-/)?.[1] || '';

                if (id) {
                    results.push({
                        id: id,
                        title: title,
                        poster: poster,
                        type: type,
                        url: href,
                        source: 'hdrezka_amnezia'
                    });
                }
            });

            return results;
        }

        async getDetails(id, type = 'movie') {
            await this.init();
            if (!this.parser.ready) return null;

            try {
                const url = `${this.baseUrl}/${type === 'tv' ? 'series' : 'movie'}/${id}-...`;
                const response = await this.proxy.fetch(url);
                const html = await response.text();
                return this.parseDetails(html, type);
            } catch (error) {
                console.error('[HDRezka] Details error:', error);
                return null;
            }
        }

        parseDetails(html, type) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            return {
                title: doc.querySelector('.b-post__title h1')?.textContent?.trim() || '',
                description: doc.querySelector('.b-post__description_text')?.textContent?.trim() || '',
                year: doc.querySelector('.b-post__info .year')?.textContent?.trim() || '',
                rating: doc.querySelector('.b-post__rating .rating_imdb')?.textContent?.trim() || '',
                poster: doc.querySelector('.b-post__cover img')?.getAttribute('src') || '',
                playerUrl: doc.querySelector('iframe[src*="hdrezka"]')?.getAttribute('src') ||
                           doc.querySelector('video source')?.getAttribute('src') || null,
                type: type
            };
        }
    }

    // ============================================================
    // Плагин Lampa
    // ============================================================
    class LampaAmneziaPlugin {
        constructor() {
            this.parser = new HDRezkaAmneziaParser();
            this.initialized = false;
        }

        async init() {
            if (this.initialized) return;
            await this.parser.init();
            this.registerSource();
            this.addSettingsTab();
            this.initialized = true;
        }

        registerSource() {
            const MovieDB = window.Lampa.MovieDB;
            if (!MovieDB) {
                setTimeout(() => this.registerSource(), 1000);
                return;
            }

            const originalSearch = MovieDB.search;
            MovieDB.search = async (query, page, callback) => {
                const config = Store.get('config', {});
                if (config.enabled !== false && this.parser.parser.ready) {
                    try {
                        const results = await this.parser.search(query, page);
                        if (results.length > 0) {
                            callback(results);
                            return;
                        }
                    } catch (error) {
                        console.error('[Lampa] Search error:', error);
                    }
                }
                originalSearch.call(MovieDB, query, page, callback);
            };

            const Player = window.Lampa.Player;
            if (Player) {
                Player.addSource('hdrezka_amnezia', {
                    name: 'HDRezka (Amnezia)',
                    getUrl: async (item) => {
                        if (item.source === 'hdrezka_amnezia') {
                            const details = await this.parser.getDetails(item.id, item.type);
                            return details?.playerUrl || null;
                        }
                        return null;
                    }
                });
            }
        }

        // ============================================================
        // МЕНЮ
        // ============================================================
        addSettingsTab() {
            const Settings = window.Lampa.Settings;
            if (!Settings) {
                setTimeout(() => this.addSettingsTab(), 1000);
                return;
            }

            Settings.addTab(PLUGIN_ID, {
                name: 'HDRezka + Amnezia',
                icon: 'shield',
                template: this.buildHTML(),
                onOpen: () => this.updateStatus()
            });

            this.setupEvents();
        }

        buildHTML() {
            const saved = Store.get('config_text', '');
            const stats = this.parser.parser.getStats();

            return `
                <style>
                    .am-settings .section {
                        background: rgba(255,255,255,0.05);
                        border-radius: 8px;
                        padding: 12px 16px;
                        margin-bottom: 12px;
                    }
                    .am-settings .section-title {
                        font-size: 14px;
                        font-weight: 600;
                        color: #fff;
                        margin-bottom: 8px;
                    }
                    .am-settings .input-field {
                        width: 100%;
                        padding: 8px 12px;
                        background: rgba(255,255,255,0.1);
                        border: 1px solid rgba(255,255,255,0.2);
                        border-radius: 6px;
                        color: #fff;
                        font-size: 14px;
                        font-family: monospace;
                        min-height: 120px;
                        resize: vertical;
                    }
                    .am-settings .btn {
                        padding: 8px 16px;
                        border: none;
                        border-radius: 6px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: all 0.2s;
                    }
                    .am-settings .btn-success {
                        background: #51cf66;
                        color: #fff;
                    }
                    .am-settings .btn-danger {
                        background: #e74c3c;
                        color: #fff;
                    }
                    .am-settings .btn-secondary {
                        background: rgba(255,255,255,0.1);
                        color: #fff;
                    }
                    .am-settings .btn-secondary:hover {
                        background: rgba(255,255,255,0.2);
                    }
                    .am-settings .status-badge {
                        display: inline-block;
                        padding: 2px 10px;
                        border-radius: 12px;
                        font-size: 12px;
                        font-weight: 600;
                    }
                    .am-settings .status-badge.success {
                        background: #51cf66;
                        color: #fff;
                    }
                    .am-settings .status-badge.danger {
                        background: #e74c3c;
                        color: #fff;
                    }
                    .am-settings .flex-row {
                        display: flex;
                        gap: 8px;
                        align-items: center;
                        flex-wrap: wrap;
                    }
                    .am-settings .mt-8 {
                        margin-top: 8px;
                    }
                    .am-settings .text-muted {
                        color: rgba(255,255,255,0.4);
                        font-size: 12px;
                    }
                    .am-settings .toggle-label {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        cursor: pointer;
                    }
                    .am-settings .toggle-label input {
                        width: 18px;
                        height: 18px;
                        accent-color: #ff6b6b;
                    }
                    .am-settings .log-output {
                        background: rgba(0,0,0,0.3);
                        border-radius: 6px;
                        padding: 8px 12px;
                        font-family: monospace;
                        font-size: 12px;
                        max-height: 100px;
                        overflow-y: auto;
                        color: rgba(255,255,255,0.7);
                        white-space: pre-wrap;
                    }
                </style>

                <div class="am-settings">
                    <div class="section">
                        <div class="flex-row">
                            <label class="toggle-label">
                                <input type="checkbox" id="am_enabled" ${Store.get('config', {}).enabled !== false ? 'checked' : ''}>
                                <span>Включить HDRezka через Amnezia</span>
                            </label>
                            <span class="status-badge ${this.parser.parser.ready ? 'success' : 'danger'}" id="am_status">
                                ${this.parser.parser.ready ? '✅ Активен' : '❌ Нет серверов'}
                            </span>
                        </div>
                        <div class="text-muted mt-8">
                            Серверов: <span id="am_count">${stats.count}</span>
                        </div>
                    </div>

                    <div class="section">
                        <div class="section-title">🔑 AmneziaWG 1.5 — конфиг</div>
                        <textarea class="input-field" id="am_config_input" placeholder="Вставьте сюда ваш полный конфиг...">${saved}</textarea>
                        <div class="flex-row mt-8">
                            <button class="btn btn-success" id="am_apply">📥 Применить</button>
                            <button class="btn btn-danger" id="am_clear">🗑️ Очистить</button>
                        </div>
                    </div>

                    <div class="section">
                        <div class="section-title">📋 Лог</div>
                        <div class="log-output" id="am_log">Готов к работе...</div>
                    </div>
                </div>
            `;
        }

        setupEvents() {
            document.addEventListener('change', (e) => {
                if (e.target.id === 'am_enabled') {
                    const config = Store.get('config', {});
                    config.enabled = e.target.checked;
                    Store.set('config', config);
                    this.log('Плагин ' + (config.enabled ? 'включён' : 'выключен'));
                }
            });

            document.addEventListener('click', async (e) => {
                if (e.target.id === 'am_apply') {
                    const text = document.getElementById('am_config_input')?.value || '';
                    if (!text.trim()) {
                        this.log('❌ Конфиг пуст');
                        return;
                    }

                    const servers = this.parser.loadConfig(text);
                    this.updateStatus();
                    this.log(`✅ Конфиг загружен. Найдено серверов: ${servers.length}`);
                }

                if (e.target.id === 'am_clear') {
                    Store.set('config_text', '');
                    this.parser.parser.rawConfig = '';
                    this.parser.parser.servers = [];
                    this.parser.parser.ready = false;
                    document.getElementById('am_config_input').value = '';
                    this.updateStatus();
                    this.log('🗑️ Конфиг очищен');
                }
            });
        }

        updateStatus() {
            const status = document.getElementById('am_status');
            const count = document.getElementById('am_count');
            const ready = this.parser.parser.ready;

            if (status) {
                status.textContent = ready ? '✅ Активен' : '❌ Нет серверов';
                status.className = `status-badge ${ready ? 'success' : 'danger'}`;
           
