// --- Core Configuration ---
// Create an Axios instance with base configuration for API requests
const api = axios.create({
    baseURL: '/api',
});

// Interceptor to inject JWT authentication token into every request
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Global error handler for API responses
api.interceptors.response.use(
    (response) => response,
    (error) => {
        // Force logout on 401 Unauthorized status, except for the login attempt itself
        if (error.response?.status === 401 && !error.config.url.endsWith('/login')) {
            auth.logout(true);
        }
        return Promise.reject(error);
    }
);

// --- State Management ---
// Central application state (Single Source of Truth)
const state = {
    user: JSON.parse(localStorage.getItem('user')) || null, // Authenticated user profile
    activeScreen: 'dashboard',                             // Currently displayed UI screen
    products: [],                                          // Master inventory list
    categories: [],                                        // Product categories
    discounts: [],                                         // Active promotional campaigns
    personnel: [],                                         // personnel/store users list
    cart: [],                                              // Active checkout items
    cartDiscount: 0,                                       // Manual discount applied to total
    cartDiscountType: 'fixed',                            // 'fixed' or 'percent'
    cartDiscountValue: 0,                                  // Raw value of manual discount
    offlineQueue: JSON.parse(localStorage.getItem('offline_queue')) || [], // Sales waiting for sync
    isOffline: !navigator.onLine,                         // Current network status
    dashboardStats: null,                                 // Cached dashboard metrics
    activeCategory: null,                                 // Selected category filter in terminal
    reportsData: null,                                    // Data for reports screen
    inventorySearchQuery: ''                              // Search filter for inventory view
};

// --- Offline Management ---
// Handles local storage and synchronization of sales when network is unstable
const offlineManager = {
    init() {
        // Listen for browser connectivity changes
        window.addEventListener('online', () => this.handleOnlineStatus(true));
        window.addEventListener('offline', () => this.handleOnlineStatus(false));
        
        // Check initial status on boot
        this.handleOnlineStatus(navigator.onLine);
        
        // Background interval to periodically check for pending syncs
        setInterval(() => {
            if (!state.isOffline && state.offlineQueue.length > 0) {
                this.sync();
            }
        }, 30000);
    },
    // Updates internal state and UI indicators based on connectivity
    handleOnlineStatus(isOnline) {
        state.isOffline = !isOnline;
        document.body.dataset.online = isOnline;
        
        // Update the visual status pill in the POS terminal
        if (state.activeScreen === 'pos') {
            const statusEl = document.getElementById('offline-status');
            if (statusEl) {
                statusEl.innerHTML = isOnline 
                    ? '<span class="flex items-center gap-1.5 text-emerald-500 bg-emerald-50 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest"><span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Online</span>'
                    : `<span class="flex items-center gap-1.5 text-amber-500 bg-amber-50 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest"><i data-lucide="cloud-off" class="w-3 h-3"></i> Offline (${state.offlineQueue.length})</span>`;
                lucide.createIcons();
            }
        }

        // Trigger sync if we just came back online
        if (isOnline && state.offlineQueue.length > 0) {
            this.sync();
        }
    },
    // Stores a sale locally when offline
    queueSale(sale) {
        state.offlineQueue.push({
            ...sale,
            offline_id: Date.now() + Math.random().toString(36).substr(2, 9),
            queued_at: new Date().toISOString()
        });
        localStorage.setItem('offline_queue', JSON.stringify(state.offlineQueue));
        this.handleOnlineStatus(navigator.onLine); 
    },
    // Synchronizes all queued sales to the server
    async sync() {
        if (state.offlineQueue.length === 0 || this.isSyncing) return;
        
        this.isSyncing = true;
        console.log(`Starting sync of ${state.offlineQueue.length} sales...`);
        
        const queueToSync = [...state.offlineQueue];
        const successfulIds = [];

        for (const sale of queueToSync) {
            try {
                // Post each sale individually to maintain atomicity per transaction
                await api.post('/sales', sale);
                successfulIds.push(sale.offline_id);
            } catch (err) {
                console.error("Failed to sync sale:", err);
                if (!err.response) break; // Break loop if network is lost again
            }
        }

        // Filter out successfully synced items and update storage
        state.offlineQueue = state.offlineQueue.filter(s => !successfulIds.includes(s.offline_id));
        localStorage.setItem('offline_queue', JSON.stringify(state.offlineQueue));
        this.isSyncing = false;
        this.handleOnlineStatus(navigator.onLine);

        if (successfulIds.length > 0) {
            console.log(`Successfully synced ${successfulIds.length} sales.`);
        }
    }
};

// --- Barcode Scanner Management ---
// Handles keyboard-emulation scanners and mobile camera scanning
const barcodeScanner = {
    html5QrCode: null,
    isScanning: false,
    buffer: '',      // Temp buffer for keyboard events
    lastTime: 0,     // Timestamp to distinguish manual typing vs fast scannning
    
    init() {
        // Global listener for hardware scanners acting as HID keyboards
        window.addEventListener('keydown', (e) => {
            const target = e.target;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
            
            const currentTime = new Date().getTime();
            
            // If character gap > 50ms, it's likely a human typing, reset buffer
            if (currentTime - this.lastTime > 50) {
                this.buffer = '';
            }
            
            if (e.key === 'Enter') {
                // Process buffer as barcode if minimum length is met on Enter signal
                if (this.buffer.length >= 3) {
                    this.handleScan(this.buffer);
                    this.buffer = '';
                    if (isInput) e.preventDefault(); // Prevent accidental form submissions
                }
            } else if (e.key.length === 1) {
                this.buffer += e.key;
            }
            
            this.lastTime = currentTime;
        });
        
        // Custom event listener for when a code is identified (via HID or Camera)
        window.addEventListener('barcode-scanned', (e) => {
            const code = e.detail.code;
            ui.beep(); // Audio confirmation
            
            // If on terminal screen, automatically add the product to cart
            if (state.activeScreen === 'pos') {
                screens.addProductByBarcode(code);
                const search = document.getElementById('product-search');
                if (search && document.activeElement === search) {
                    search.value = '';
                    screens.renderProductsGrid();
                }
            }
            // Populate barcode fields in open forms if present
            const barcodeField = document.getElementById('p-barcode');
            if (barcodeField) {
                barcodeField.value = code;
                ui.notify("Captured: " + code);
            }
        });
    },
    
    lastScannedCode: null,
    lastScannedTime: 0,
    
    // Core handler with debounce logic
    handleScan(code) {
        const now = Date.now();
        // Prevent duplicate reads of same code within 1.5 seconds (cooldown)
        if (code === this.lastScannedCode && now - this.lastScannedTime < 1500) {
            return; 
        }
        this.lastScannedCode = code;
        this.lastScannedTime = now;
        window.dispatchEvent(new CustomEvent('barcode-scanned', { detail: { code } }));
    },
    
    // Mobile Camera Scanner Logic
    async startCamera(containerId, onResult, isContinuous = false) {
        if (this.isScanning) await this.stopCamera();
        
        this.html5QrCode = new Html5Qrcode(containerId);
        this.isScanning = true;
        
        try {
            const config = { 
                fps: 15, 
                qrbox: { width: 250, height: 160 },
                aspectRatio: 1.0,
                formatsToSupport: [ 
                    Html5QrcodeSupportedFormats.EAN_13, 
                    Html5QrcodeSupportedFormats.EAN_8, 
                    Html5QrcodeSupportedFormats.CODE_128, 
                    Html5QrcodeSupportedFormats.UPC_A, 
                    Html5QrcodeSupportedFormats.UPC_E,
                    Html5QrcodeSupportedFormats.QR_CODE 
                ]
            };
            
            await this.html5QrCode.start(
                { facingMode: "environment" },
                config,
                (decodedText) => {
                    if (!isContinuous) {
                        this.stopCamera().then(() => onResult(decodedText));
                    } else {
                        onResult(decodedText);
                    }
                },
                () => {}
            );
        } catch (err) {
            console.error("Camera scan failed:", err);
            ui.notify("Camera failed. Check permissions.", "error");
            this.isScanning = false;
        }
    },
    
    async stopCamera() {
        if (this.html5QrCode && this.isScanning) {
            try {
                await this.html5QrCode.stop();
            } catch (e) {}
            this.html5QrCode = null;
            this.isScanning = false;
        }
    }
};

// --- Auth Module ---
// Manages user authentication state and session lifecycle
const auth = {
    init() {
        offlineManager.init();
        barcodeScanner.init();
        // Auto-login if token exists in session
        if (state.user) {
            this.showMain();
        } else {
            this.showLogin();
        }
    },
    // Submits login credentials to server
    async login(event) {
        event.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        const errorEl = document.getElementById('login-error');
        const errorText = document.getElementById('login-error-text');
        const submitBtn = document.getElementById('login-submit-btn');
        
        errorEl.classList.add('hidden');
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<span class="animate-spin inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full"></span> <span>Authenticating...</span>`;
        
        try {
            const res = await api.post('/login', { username, password });
            const { token, user } = res.data;
            // Store credentials locally
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
            state.user = user;
            this.showMain();
        } catch (err) {
            errorText.innerText = err.response?.data?.error || 'Login failed';
            errorEl.classList.remove('hidden');
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<span>Sign In</span>`;
        }
    },
    // Ends session and clears local data
    logout(force = false) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        state.user = null;
        this.showLogin();
        if (!force) ui.notify("Logged out successfully");
    },
    // Switches display to authentications screen
    showLogin() {
        state.activeScreen = 'login';
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('main-layout').classList.add('hidden');
    },
    // Switches display to main application dashboard
    showMain() {
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('main-layout').classList.remove('hidden');
        document.getElementById('user-fullname').innerText = state.user.full_name;
        document.getElementById('user-role').innerText = state.user.role.replace('_', ' ');
        // Dynamic branding based on store name
        document.getElementById('store-name-display').innerText = (state.user.store_name?.split(' ')[0] || 'LORNA') + "'S";
        
        ui.renderSidebar();
        ui.initSidebar(); 
        router.navigate(state.activeScreen); // Start at previous or default screen
    }
};

// --- UI Components & Routing ---
// Manages screen navigation and role-based access control (RBAC)
const router = {
    screens: {
        dashboard: { label: 'Dashboard', icon: 'layout-dashboard', render: () => screens.renderDashboard(), roles: ['admin', 'user'] },
        pos: { label: 'Terminal', icon: 'shopping-cart', render: () => screens.renderTerminal(), roles: ['admin', 'user'] },
        inventory: { label: 'Inventory', icon: 'package', render: () => screens.renderInventory(), roles: ['admin', 'user'] },
        categories: { label: 'Categories', icon: 'layers', render: () => screens.renderCategories(), roles: ['admin', 'user'] },
        users: { label: 'Users', icon: 'users', render: () => screens.renderUsers(), roles: ['admin'] },
        discounts: { label: 'Discounts', icon: 'sparkles', render: () => screens.renderDiscounts(), roles: ['admin'] },
        reports: { label: 'Reports', icon: 'file-text', render: () => screens.renderReports(), roles: ['admin', 'user'] },
        settings: { label: 'Settings', icon: 'settings', render: () => screens.renderSettings(), roles: ['admin', 'user'] }
    },
    // Switches the main content area to the target screen
    navigate(screenId) {
        // Enforce RBAC
        if (!this.screens[screenId].roles.includes(state.user.role)) {
            ui.notify("Access Denied: Admin privileges required", 'error');
            return;
        }
        state.activeScreen = screenId;
        document.getElementById('screen-title').innerText = this.screens[screenId].label;
        
        // Auto-close mobile sidebar drawer on navigation
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        sidebar?.classList.add('-translate-x-full');
        overlay?.classList.add('hidden');

        // Toggle visual active state on sidebar links
        document.querySelectorAll('.nav-link').forEach(link => {
            if (link.dataset.screen === screenId) {
                link.classList.add('active-nav');
            } else {
                link.classList.remove('active-nav');
            }
        });
        
        // Invoke render function for selected screen
        this.screens[screenId].render();
    }
};

const ui = {
    initSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const openBtn = document.getElementById('open-sidebar');
        const closeBtn = document.getElementById('close-sidebar');

        const toggle = (show) => {
            if (show) {
                sidebar?.classList.remove('-translate-x-full');
                overlay?.classList.remove('hidden');
            } else {
                sidebar?.classList.add('-translate-x-full');
                overlay?.classList.add('hidden');
            }
        };

        openBtn?.addEventListener('click', () => toggle(true));
        closeBtn?.addEventListener('click', () => toggle(false));
        overlay?.addEventListener('click', () => toggle(false));
    },
    renderSidebar() {
        const nav = document.getElementById('nav-items');
        nav.innerHTML = '';
        
        Object.keys(router.screens).forEach(key => {
            const screen = router.screens[key];
            if (!screen.roles.includes(state.user.role)) return;
            if (key === 'stores') return; // Stores management removed with super_admin
            
            const btn = document.createElement('button');
            btn.className = `nav-link w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 ${state.activeScreen === key ? 'active-nav' : ''}`;
            btn.dataset.screen = key;
            btn.innerHTML = `<i data-lucide="${screen.icon}" class="w-4 h-4"></i> ${screen.label}`;
            btn.onclick = () => router.navigate(key);
            nav.appendChild(btn);
        });
        lucide.createIcons();
    },
    showModal(title, contentHTML, onSave, saveLabel = "Save Changes", sizeClass = "max-w-lg") {
        const container = document.getElementById('modal-container');
        const content = document.getElementById('modal-content');
        
        // Dynamic sizing
        content.className = `relative w-full ${sizeClass} bg-white rounded-3xl shadow-2xl p-6 lg:p-8 animate-in fade-in zoom-in duration-200`;
        
        content.innerHTML = `
            <div class="flex items-center justify-between mb-6">
                <h3 class="text-xl font-black text-zinc-900">${title}</h3>
                <button id="close-modal" class="p-2 hover:bg-zinc-100 rounded-full text-zinc-400 transition-colors"><i data-lucide="x" class="w-6 h-6"></i></button>
            </div>
            <div class="space-y-4 max-h-[65vh] overflow-y-auto pr-1 no-scrollbar">
                ${contentHTML}
            </div>
            <div class="mt-8 flex gap-3">
                <button id="modal-cancel" class="flex-1 h-12 bg-zinc-50 text-zinc-500 font-bold rounded-xl hover:bg-zinc-100 transition-all">Cancel</button>
                <button id="modal-save" class="flex-1 h-12 bg-zinc-900 text-white font-bold rounded-xl hover:bg-zinc-800 transition-all shadow-lg shadow-zinc-900/20">${saveLabel}</button>
            </div>
        `;
        
        container.classList.remove('hidden');
        lucide.createIcons();
        
        const close = () => container.classList.add('hidden');
        document.getElementById('close-modal').onclick = close;
        document.getElementById('modal-cancel').onclick = close;
        document.getElementById('modal-overlay').onclick = close;
        
        const saveBtn = document.getElementById('modal-save');
        saveBtn.onclick = async () => {
            if (saveBtn.disabled) return;
            saveBtn.disabled = true;
            const originalText = saveBtn.innerText;
            saveBtn.innerHTML = '<span class="animate-spin inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full"></span>';
            try {
                await onSave();
                close();
            } catch (err) {
                console.error("Modal Save Error:", err);
                let errorMsg = "An unexpected error occurred during save";
                
                if (err.response?.data) {
                    const data = err.response.data;
                    if (typeof data === 'string') {
                        errorMsg = data;
                    } else if (data.error) {
                        errorMsg = typeof data.error === 'object' ? (data.error.message || JSON.stringify(data.error)) : data.error;
                    }
                } else if (err.message) {
                    errorMsg = err.message;
                }
                
                this.notify(errorMsg, 'error');
            } finally {
                saveBtn.disabled = false;
                saveBtn.innerText = originalText;
            }
        };
    },
    hideModal() {
        const container = document.getElementById('modal-container');
        if (container) container.classList.add('hidden');
    },
    confirm(title, message, onConfirm, danger = true) {
        this.showModal(title, `
            <div class="flex flex-col items-center py-4 text-center">
                <div class="w-16 h-16 ${danger ? 'bg-red-50 text-red-500' : 'bg-amber-50 text-amber-500'} rounded-full flex items-center justify-center mb-4">
                    <i data-lucide="${danger ? 'trash-2' : 'alert-triangle'}" class="w-8 h-8"></i>
                </div>
                <p class="text-zinc-600 font-medium">${message}</p>
            </div>
        `, onConfirm, danger ? "Yes, Delete" : "Confirm");
        
        // Customize the confirm button style if danger
        if (danger) {
            const saveBtn = document.getElementById('modal-save');
            if (saveBtn) {
                saveBtn.className = "flex-1 h-12 bg-red-500 text-white font-bold rounded-xl hover:bg-red-600 transition-all shadow-lg shadow-red-500/20";
            }
        }
    },
    notify(message, type = 'success') {
        const container = document.getElementById('notification-container') || (() => {
            const el = document.createElement('div');
            el.id = 'notification-container';
            el.className = 'fixed top-6 right-6 z-[100] flex flex-col gap-3 pointer-events-none';
            document.body.appendChild(el);
            return el;
        })();

        const toast = document.createElement('div');
        const colors = {
            success: 'bg-emerald-500 text-white',
            error: 'bg-red-500 text-white',
            warning: 'bg-amber-500 text-white',
            info: 'bg-zinc-900 text-white'
        };
        const icons = {
            success: 'check-circle',
            error: 'alert-circle',
            warning: 'alert-triangle',
            info: 'info'
        };

        toast.className = `${colors[type]} p-4 rounded-2xl shadow-2xl flex items-center gap-3 min-w-[300px] transform translate-x-full transition-all duration-300 pointer-events-auto`;
        toast.innerHTML = `
            <i data-lucide="${icons[type]}" class="w-5 h-5"></i>
            <p class="text-sm font-bold">${typeof message === 'object' ? JSON.stringify(message) : message}</p>
        `;
        
        container.appendChild(toast);
        lucide.createIcons();
        
        // Animate in
        setTimeout(() => toast.classList.remove('translate-x-full'), 10);
        
        // Animate out and remove
        const remove = () => {
            toast.classList.add('translate-x-full', 'opacity-0');
            setTimeout(() => toast.remove(), 300);
        };
        
        setTimeout(remove, 4000);
        toast.onclick = remove;
    },
    handleError(err, context = "") {
        console.error(`Error in ${context}:`, err);
        let message = "An error occurred";
        
        if (err.response?.data?.error) {
            message = err.response.data.error;
        } else if (err.message) {
            message = err.message;
        }
        
        this.notify(`${context ? context + ': ' : ''}${message}`, 'error');
    },
    beep(frequency = 800) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = frequency;
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.12);
        } catch (e) {}
    }
};

// --- Screen Renders ---
const screens = {
    async renderDashboard() {
        const root = document.getElementById('screen-content');
        root.innerHTML = '<div class="animate-pulse flex items-center justify-center p-20 text-zinc-400">Loading summary...</div>';
        
        try {
            const res = await api.get('/reports/dashboard');
            const data = res.data;
            state.dashboardStats = data;
            
            root.innerHTML = `
                <div class="space-y-6">
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        ${this.card("Today's Sales", `₱${Number(data.stats?.todaySales?.total || 0).toFixed(2)}`, 'text-zinc-900')}
                        ${this.card("Total Orders", data.stats?.totalOrders?.count || 0, 'text-zinc-900')}
                        ${this.card("Low Stock", data.stats?.lowStock?.count || 0, (data.stats?.lowStock?.count || 0) > 0 ? 'text-amber-500' : 'text-zinc-900')}
                        ${this.card("Expiring Soon", data.stats?.expiringSoon?.count || 0, (data.stats?.expiringSoon?.count || 0) > 0 ? 'text-red-500' : 'text-zinc-900')}
                    </div>
                    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div class="lg:col-span-2 bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm h-[400px] flex flex-col">
                            <h3 class="font-bold text-zinc-900 mb-4">Sales Performance</h3>
                            <canvas id="salesChart"></canvas>
                        </div>
                        <div class="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm flex flex-col">
                            <h3 class="font-bold text-zinc-900 mb-4">Quick Actions</h3>
                            <div class="space-y-3">
                                ${state.user.role !== 'user' ? `
                                    <button onclick="screens.openProductModal()" class="w-full flex items-center gap-3 h-14 px-4 bg-white border border-zinc-200 rounded-xl font-bold hover:bg-zinc-50 transition-all active:scale-95 text-sm">
                                        <i data-lucide="plus" class="w-5 h-5"></i> Add New Product
                                    </button>
                                    <button onclick="router.navigate('users')" class="w-full flex items-center gap-3 h-14 px-4 bg-white border border-zinc-200 rounded-xl font-bold hover:bg-zinc-50 transition-all active:scale-95 text-sm">
                                        <i data-lucide="users" class="w-5 h-5"></i> Manage Personnel
                                    </button>
                                    <button onclick="screens.openCategoryModal()" class="w-full flex items-center gap-3 h-14 px-4 bg-white border border-zinc-200 rounded-xl font-bold hover:bg-zinc-50 transition-all active:scale-95 text-sm">
                                        <i data-lucide="tag" class="w-5 h-5"></i> New Category
                                    </button>
                                    <button onclick="screens.openDiscountModal()" class="w-full flex items-center gap-3 h-14 px-4 bg-white border border-zinc-200 rounded-xl font-bold hover:bg-zinc-50 transition-all active:scale-95 text-sm">
                                        <i data-lucide="sparkles" class="w-5 h-5"></i> New Campaign
                                    </button>
                                ` : `
                                    <button onclick="router.navigate('pos')" class="w-full flex items-center gap-3 h-14 px-4 bg-zinc-900 text-white rounded-xl font-bold hover:bg-zinc-800 transition-all active:scale-95 text-sm">
                                        <i data-lucide="shopping-cart" class="w-5 h-5"></i> Open Terminal
                                    </button>
                                    <button onclick="router.navigate('inventory')" class="w-full flex items-center gap-3 h-14 px-4 bg-white border border-zinc-200 rounded-xl font-bold hover:bg-zinc-50 transition-all active:scale-95 text-sm">
                                        <i data-lucide="package" class="w-5 h-5"></i> Check Inventory
                                    </button>
                                `}
                            </div>
                        </div>
                    </div>
                </div>
            `;
            lucide.createIcons();
            this.initCharts(data);
        } catch (err) {
            console.error(err);
            root.innerHTML = `<div class="p-10 text-center text-red-500 font-bold uppercase tracking-widest bg-red-50 m-6 rounded-2xl border border-red-100 flex flex-col items-center gap-4">
                <i data-lucide="alert-circle" class="w-10 h-10"></i>
                <span>Failed to load dashboard summary</span>
                <p class="text-[10px] font-medium text-red-400">${err.message}</p>
                <button onclick="screens.renderDashboard()" class="mt-2 px-4 py-2 bg-red-500 text-white rounded-lg text-xs font-black">RETRY CONNECTION</button>
            </div>`;
            lucide.createIcons();
        }
    },
    card(label, value, colorClass) {
        return `
            <div class="bg-white p-5 rounded-2xl border border-zinc-200 shadow-sm">
                <p class="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-1">${label}</p>
                <p class="text-2xl font-black ${colorClass}">${value}</p>
            </div>
        `;
    },
    initCharts(data) {
        const ctx = document.getElementById('salesChart');
        if (!ctx) return;
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: (data.salesChart || []).map(d => d.date),
                datasets: [{
                    label: 'Daily Sales',
                    data: (data.salesChart || []).map(d => d.amount),
                    borderColor: '#10B981',
                    tension: 0.4,
                    fill: true,
                    backgroundColor: 'rgba(16, 185, 129, 0.1)'
                }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });
    },
    async renderTerminal() {
        const root = document.getElementById('screen-content');
        root.innerHTML = `
            <div class="flex flex-col lg:flex-row gap-4 lg:gap-6 h-full overflow-hidden relative">
                <!-- Main Products Area -->
                <div class="flex-1 flex flex-col gap-4 lg:gap-6 min-w-0 h-full overflow-hidden">
                    <div class="flex gap-3 items-center">
                        <div class="relative flex-1">
                            <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 w-5 h-5"></i>
                            <input type="text" id="product-search" placeholder="Search products or scan..." class="pl-10 h-11 md:h-12 w-full px-4 py-2 bg-white border border-zinc-200 rounded-xl md:rounded-2xl outline-none focus:ring-2 focus:ring-zinc-900/5 focus:border-zinc-900 transition-all text-sm">
                        </div>
                        <button onclick="screens.openCameraScanner('pos')" class="h-11 w-11 md:h-12 md:w-12 flex items-center justify-center bg-white border border-zinc-200 rounded-xl md:rounded-2xl text-zinc-500 hover:text-zinc-900 transition-all active:scale-95" title="Scan Barcode">
                            <i data-lucide="scan" class="w-5 h-5"></i>
                        </button>
                        <div id="offline-status" class="hidden md:block"></div>
                        <button class="lg:hidden h-11 w-11 md:h-12 md:w-12 flex items-center justify-center bg-white border border-zinc-200 rounded-xl md:rounded-2xl text-zinc-500 relative transition-transform active:scale-95" onclick="screens.toggleMobileCart(true)">
                            <i data-lucide="shopping-basket" class="w-5 h-5"></i>
                            <span id="mobile-cart-badge" class="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] w-4 h-4 rounded-full hidden flex items-center justify-center font-bold border-2 border-white">0</span>
                        </button>
                    </div>
                    <div id="category-chips" class="flex gap-2 overflow-x-auto pb-2 no-scrollbar min-h-[40px] md:min-h-[48px]"></div>
                    <div id="terminal-products" class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3 md:gap-4 overflow-y-auto pr-2 flex-1 no-scrollbar pb-24 lg:pb-0"></div>
                </div>
                
                <!-- Cart Sidebar / Drawer -->
                <div id="cart-drawer-overlay" class="lg:hidden fixed inset-0 bg-black/60 z-[60] hidden opacity-0 transition-opacity duration-300" onclick="screens.toggleMobileCart(false)"></div>
                
                <div id="cart-sidebar" class="fixed lg:relative inset-y-0 right-0 z-[70] lg:z-10 w-[85%] max-w-[400px] lg:w-[380px] flex flex-col bg-white border-l lg:border border-zinc-200 lg:rounded-2xl shadow-2xl lg:shadow-sm transform translate-x-full lg:translate-x-0 transition-transform duration-300 h-full shrink-0 overflow-hidden">
                    <div class="p-4 lg:p-5 border-b border-zinc-100 flex items-center justify-between bg-zinc-50/50">
                        <h3 class="font-bold flex items-center gap-2"><i data-lucide="shopping-cart" class="w-5 h-5"></i> Current Order</h3>
                        <div class="flex items-center gap-2">
                             <button onclick="screens.clearCart()" class="p-2 text-zinc-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors" title="Clear Order">
                                <i data-lucide="trash-2" class="w-5 h-5"></i>
                             </button>
                             <span id="cart-count" class="bg-zinc-900 text-white px-2.5 py-1 rounded-lg text-xs font-black">0 Items</span>
                             <button class="lg:hidden p-2 text-zinc-400 hover:text-zinc-900 rounded-lg hover:bg-zinc-100" onclick="screens.toggleMobileCart(false)"><i data-lucide="x" class="w-5 h-5"></i></button>
                        </div>
                    </div>
                    <div id="cart-items" class="flex-1 overflow-y-auto p-4 space-y-4 no-scrollbar"></div>
                    <div class="p-4 lg:p-6 bg-zinc-50 border-t border-zinc-100 space-y-4">
                        <div class="space-y-2">
                            <div class="flex justify-between text-sm text-zinc-500 font-medium"><span>Subtotal</span> <span id="cart-subtotal" class="text-zinc-900">₱0.00</span></div>
                            <div id="cart-discount-row" class="hidden flex justify-between text-sm text-amber-600 font-bold">
                                <span class="flex items-center gap-1">Discount <button onclick="screens.openCartDiscountModal()" class="text-[10px] bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">Edit</button></span> 
                                <span id="cart-discount">-₱0.00</span>
                            </div>
                            <div id="apply-discount-placeholder" class="flex justify-center py-1">
                                <button onclick="screens.openCartDiscountModal()" class="text-[10px] font-black text-zinc-400 uppercase tracking-widest hover:text-zinc-900 transition-colors flex items-center gap-1">
                                    <i data-lucide="minus-square" class="w-4 h-4"></i> Apply Discount
                                </button>
                            </div>
                            <div id="cart-promo-discount-row" class="hidden flex justify-between text-sm text-emerald-600 font-bold italic">
                                <span>Promotional Savings</span>
                                <span id="cart-promo-discount">-₱0.00</span>
                            </div>
                            <div class="pt-3 border-t border-zinc-200 flex justify-between font-black text-xl lg:text-2xl text-zinc-900"><span>Total</span> <span id="cart-total">₱0.00</span></div>
                        </div>
                        <button id="checkout-btn" disabled class="w-full h-12 md:h-14 bg-zinc-900 text-white font-bold rounded-xl text-lg hover:bg-zinc-800 shadow-lg shadow-zinc-900/20 transition-all active:scale-95 disabled:opacity-50 disabled:grayscale">Process Payment</button>
                    </div>
                </div>

                <!-- Floating Mobile Checkout FAB -->
                <div id="mobile-checkout-bar" class="lg:hidden fixed bottom-6 left-6 right-6 z-50 transform translate-y-32 opacity-0 transition-all duration-500 flex items-center justify-between bg-zinc-900 text-white p-4 rounded-2xl shadow-2xl shadow-black/40 ring-4 ring-zinc-900/10 cursor-pointer active:scale-95" onclick="screens.toggleMobileCart(true)">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 bg-white/10 rounded-xl flex items-center justify-center"><i data-lucide="shopping-cart" class="w-5 h-5"></i></div>
                        <div>
                            <p class="text-[10px] text-white/50 font-bold uppercase tracking-widest leading-none">Amount Due</p>
                            <p id="floating-cart-total" class="text-lg font-black leading-none mt-1">₱0.00</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-3 font-bold text-sm h-10 px-4 bg-white/10 rounded-xl">
                        <span id="floating-cart-count">0 items</span>
                        <i data-lucide="chevron-up" class="w-4 h-4"></i>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('checkout-btn').onclick = () => this.handleCheckout();
        lucide.createIcons();
        this.loadTerminalData();
    },
    toggleMobileCart(show) {
        const drawer = document.getElementById('cart-sidebar');
        const overlay = document.getElementById('cart-drawer-overlay');
        const bar = document.getElementById('mobile-checkout-bar');
        
        if (show) {
            drawer?.classList.remove('translate-x-full');
            overlay?.classList.remove('hidden');
            setTimeout(() => overlay?.classList.remove('opacity-0'), 10);
            bar?.classList.add('translate-y-32', 'opacity-0');
        } else {
            drawer?.classList.add('translate-x-full');
            overlay?.classList.add('opacity-0');
            setTimeout(() => overlay?.classList.add('hidden'), 300);
            // Only show FAB if cart has items
            if (state.cart.length > 0) {
                bar?.classList.remove('translate-y-32', 'opacity-0');
            }
        }
    },
    async handleCheckout() {
        if (state.cart.length === 0) return;
        
        let subtotal = 0;
        let promoDiscountTotal = 0;
        const now = new Date();
        const activePromos = (state.discounts || []).filter(d => {
            if (d.is_active === 0) return false;
            if (d.start_date && new Date(d.start_date + 'T00:00:00') > now) return false;
            if (d.end_date && new Date(d.end_date + 'T23:59:59') < now) return false;
            return true;
        });

        const saleItems = state.cart.map(item => {
            let itemPromoDiscount = 0;
            activePromos.forEach(p => {
                let applies = false;
                if (p.target_type === 'all') applies = true;
                else if (p.target_type === 'category' && item.category_id === parseInt(p.target_id)) applies = true;
                else if (p.target_type === 'product' && item.id === parseInt(p.target_id)) applies = true;
                
                if (applies) {
                    if (p.type === 'percentage') {
                        itemPromoDiscount += (item.selling_price * item.quantity) * (p.value / 100);
                    } else {
                        itemPromoDiscount += p.value * item.quantity;
                    }
                }
            });

            const lineTotal = item.selling_price * item.quantity;
            subtotal += lineTotal;
            promoDiscountTotal += itemPromoDiscount;

            return {
                product_id: item.id,
                quantity: item.quantity,
                unit_price: item.selling_price,
                subtotal: lineTotal - itemPromoDiscount,
                discount_amount: itemPromoDiscount
            };
        });

        // Manual discount calculation
        let manualDiscountValue = 0;
        if (state.cartDiscountType === 'percent') {
            manualDiscountValue = subtotal * ((state.cartDiscountValue || 0) / 100);
        } else {
            manualDiscountValue = state.cartDiscountValue || 0;
        }

        const totalDeduction = manualDiscountValue + promoDiscountTotal;
        const total = Math.max(0, subtotal - totalDeduction);

        let selectedMethod = 'cash'; // Tracks selected platform for the transaction

        // Renders the payment dialog with amounts and input fields
        ui.showModal("Process Payment", `
            <div class="space-y-6">
                <!-- High-visibility Total Due banner -->
                <div class="p-6 bg-zinc-900 text-white rounded-3xl text-center shadow-xl shadow-zinc-900/10">
                    <p class="text-[10px] font-black text-white/40 uppercase tracking-[0.2em] mb-1">Total Amount Due</p>
                    <p class="text-4xl font-black">₱${total.toFixed(2)}</p>
                </div>

                <!-- Toggle buttons for payment source -->
                <div class="space-y-3">
                    <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest px-1">Choose Payment Method</label>
                    <div class="grid grid-cols-2 gap-2" id="payment-methods">
                        <button data-method="cash" class="payment-btn active h-14 rounded-2xl border-2 border-zinc-900 bg-zinc-900 text-white font-black flex items-center justify-center gap-2 transition-all">
                            <i data-lucide="banknote" class="w-5 h-5"></i> Cash
                        </button>
                        <button data-method="gcash" class="payment-btn h-14 rounded-2xl border-2 border-zinc-100 bg-zinc-50 text-zinc-500 font-bold flex items-center justify-center gap-2 hover:bg-white hover:border-zinc-200 transition-all">
                            <i data-lucide="smartphone" class="w-5 h-5"></i> GCash
                        </button>
                    </div>
                </div>

                <!-- Dynamic Input Area -->
                <div id="payment-input-area" class="space-y-4">
                    <!-- Specific Error Alert (Hidden by default) -->
                    <div id="payment-error-alert" class="hidden p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2 duration-300">
                        <i data-lucide="alert-circle" class="w-5 h-5 flex-shrink-0"></i>
                        <p id="payment-error-text" class="text-xs font-bold"></p>
                    </div>

                    <!-- Section for Physical Cash -->
                    <div id="cash-inputs" class="space-y-4">
                        <div class="space-y-1.5 focus-within:ring-2 focus-within:ring-zinc-900/5 transition-all">
                            <label class="text-[10px] font-black text-zinc-500 uppercase tracking-widest px-1">Cash Tendered</label>
                            <input type="number" id="cash-received" step="0.01" class="w-full h-16 text-3xl font-black px-5 bg-zinc-50 border border-zinc-100 rounded-2xl outline-none placeholder:text-zinc-200" placeholder="0.00" autofocus>
                        </div>
                        <div class="flex justify-between items-center px-2 py-1">
                            <span class="text-xs font-black text-zinc-400 uppercase tracking-widest">Change Due</span>
                            <span id="change-display" class="text-2xl font-black text-emerald-500">₱0.00</span>
                        </div>
                    </div>

                    <!-- Section for GCash (QR + Ref) -->
                    <div id="reference-inputs" class="hidden space-y-4">
                         <div id="gcash-qr-area" class="hidden flex flex-col items-center gap-2 p-4 bg-zinc-50 rounded-2xl border border-dashed border-zinc-200">
                            <img src="${state.user.gcash_qr ? state.user.gcash_qr : `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=GCash: ${state.user.gcash_number || '09XX-XXX-XXXX'}`}" class="w-32 h-32 rounded-xl shadow-sm border border-white object-contain bg-white">
                            <p class="text-[10px] font-bold text-zinc-400 uppercase">Scan to Pay using GCash</p>
                            <p class="text-xs font-black text-zinc-900">${state.user.gcash_name || state.user.store_name || 'LORNA\'S STORE'}</p>
                            <p class="text-xs text-zinc-500 font-medium">${state.user.gcash_number || '09XX-XXX-XXXX'}</p>
                         </div>
                         <div class="space-y-1.5">
                            <label class="text-[10px] font-black text-zinc-500 uppercase tracking-widest px-1">Reference Number (Optional)</label>
                            <input type="text" id="payment-ref" class="w-full h-14 px-5 bg-zinc-50 border border-zinc-100 rounded-2xl outline-none font-bold" placeholder="Ref #1234...">
                        </div>
                    </div>
                </div>
            </div>
        `, async () => {
            // Save Handler: Validates and pushes the transaction to DB/Queue
            const errorAlert = document.getElementById('payment-error-alert');
            const errorText = document.getElementById('payment-error-text');
            
            errorAlert.classList.add('hidden'); // Reset error state on new attempt

            try {
                const cashReceivedField = document.getElementById('cash-received');
                const refField = document.getElementById('payment-ref');

                let cash_received = 0;
                let change_given = 0;
                let payment_details = '';

                // 1. Validation Phase
                if (selectedMethod === 'cash') {
                    cash_received = parseFloat(cashReceivedField.value) || 0;
                    if (cash_received < total) {
                        throw new Error(`Insufficient cash. Minimum required: ₱${total.toFixed(2)}`);
                    }
                    change_given = cash_received - total;
                } else {
                    payment_details = refField.value ? JSON.stringify({ reference: refField.value.trim() }) : '';
                }
                
                const saleData = {
                    items: saleItems,
                    total_amount: total,
                    discount_amount: totalDeduction,
                    payment_method: selectedMethod,
                    cash_received: cash_received,
                    change_given: change_given,
                    payment_details: payment_details
                };
                
                // 2. Persistence Phase
                if (state.isOffline) {
                    offlineManager.queueSale(saleData);
                    this.completeCheckoutProcess(saleData, saleItems);
                    ui.notify("Offline: Transaction queued", 'warning');
                    return;
                }

                // 3. Server Sync Phase
                const res = await api.post('/sales', saleData);
                const saleId = res.data.id;
                
                // 4. Finalization Phase
                this.showReceipt(saleId, { ...saleData, saleItems });
                this.completeCheckoutProcess();
                ui.notify("Payment processed successfully!");

            } catch (err) {
                console.error("Payment Processing Error:", err);
                
                // Extract clean error message
                let msg = err.message || "Payment failed";
                if (err.response?.data?.error) msg = err.response.data.error;
                
                // Display error INSIDE the modal for better visibility
                errorText.innerText = msg;
                errorAlert.classList.remove('hidden');
                
                // Shake effect for feedback
                const modal = document.getElementById('modal-content');
                modal.classList.add('animate-shake');
                setTimeout(() => modal.classList.remove('animate-shake'), 400);

                // IMPORTANT: Re-throw to inform ui.showModal handler that save failed
                // and should stop the loading state but KEEP the modal open.
                throw err;
            }
        }, "Confirm & Finalize Payment");

        // Set much better button label
        // Interactive UI Logic for Payment Modal
        const methodBtns = document.querySelectorAll('.payment-btn');
        const sections = {
            cash: document.getElementById('cash-inputs'),
            ref: document.getElementById('reference-inputs'),
            qr: document.getElementById('gcash-qr-area')
        };

        methodBtns.forEach(btn => {
            btn.onclick = () => {
                methodBtns.forEach(b => {
                    b.classList.remove('active', 'border-zinc-900', 'bg-zinc-900', 'text-white');
                    b.classList.add('border-zinc-100', 'bg-zinc-50', 'text-zinc-500');
                });
                btn.classList.add('active', 'border-zinc-900', 'bg-zinc-900', 'text-white');
                btn.classList.remove('border-zinc-100', 'bg-zinc-50', 'text-zinc-500');
                
                selectedMethod = btn.dataset.method;
                
                // Toggle sections
                Object.values(sections).forEach(s => s.classList.add('hidden'));
                if (selectedMethod === 'cash') {
                    sections.cash.classList.remove('hidden');
                } else {
                    sections.ref.classList.remove('hidden');
                    if (selectedMethod === 'gcash') {
                        sections.qr.classList.remove('hidden');
                    }
                }

                lucide.createIcons();
            };
        });

        const cashInput = document.getElementById('cash-received');
        const changeDisplay = document.getElementById('change-display');
        cashInput.oninput = () => {
            const val = parseFloat(cashInput.value) || 0;
            const change = Math.max(0, val - total);
            changeDisplay.innerText = `₱${change.toFixed(2)}`;
        };
    },
    // Resets the POS state after a successful (or offline queued) transaction
    completeCheckoutProcess() {
        state.cart = [];
        state.cartDiscount = 0;
        state.cartDiscountValue = 0;
        state.cartDiscountType = 'percent';
        this.renderCart();
        this.renderProductsGrid(document.getElementById('product-search')?.value || '');
    },
    // Generates a formal receipt modal with print capabilities
    showReceipt(saleId, data) {
        const now = new Date();
        const formattedDate = now.toLocaleDateString();
        const formattedTime = now.toLocaleTimeString();
        
        const receiptHtml = `
            <div id="receipt-print-area" class="bg-white p-6 md:p-8 font-mono text-sm text-zinc-800 space-y-4">
                <!-- Branding Header -->
                <div class="text-center space-y-1">
                    <h2 class="text-xl font-black uppercase">${state.user.store_name || "LORNA'S STORE"}</h2>
                    <p class="text-[10px] text-zinc-500">${state.user.store_address || "Proprietary POS System"}</p>
                    <p class="text-[10px] text-zinc-500">Contact: ${state.user.store_phone || "N/A"}</p>
                </div>
                
                <!-- Sale Transaction Metadata -->
                <div class="border-y border-dashed border-zinc-200 py-3 space-y-1">
                    <div class="flex justify-between text-[10px]"><span>Receipt #:</span> <span class="font-bold">${saleId}</span></div>
                    <div class="flex justify-between text-[10px]"><span>Date:</span> <span>${formattedDate} ${formattedTime}</span></div>
                    <div class="flex justify-between text-[10px]"><span>Cashier:</span> <span>${state.user.full_name}</span></div>
                </div>

                <!-- Individual Itemization -->
                <div class="space-y-2">
                    <div class="flex justify-between font-bold text-[10px] uppercase border-b border-zinc-100 pb-1">
                        <span class="w-1/2">Item</span>
                        <span class="w-1/4 text-center">Qty</span>
                        <span class="w-1/4 text-right">Price</span>
                    </div>
                    ${data.saleItems.map(item => {
                        const product = state.products.find(p => p.id === item.product_id);
                        return `
                            <div class="flex justify-between text-[11px] leading-tight">
                                <span class="w-1/2 truncate font-medium">${product ? product.name : 'Unknown Product'}</span>
                                <span class="w-1/4 text-center">${item.quantity}</span>
                                <span class="w-1/4 text-right">₱${(item.unit_price * item.quantity).toFixed(2)}</span>
                            </div>
                        `;
                    }).join('')}
                </div>

                <!-- Financial Summary -->
                <div class="border-t border-dashed border-zinc-200 pt-3 space-y-1">
                    <div class="flex justify-between text-[11px]"><span>Subtotal:</span> <span>₱${(Number(data.total_amount) + Number(data.discount_amount)).toFixed(2)}</span></div>
                    ${data.discount_amount > 0 ? `<div class="flex justify-between text-[11px] text-emerald-600 font-bold"><span>Total Discount:</span> <span>-₱${Number(data.discount_amount).toFixed(2)}</span></div>` : ''}
                    <div class="flex justify-between text-lg font-black pt-2 uppercase"><span>Grand Total:</span> <span>₱${Number(data.total_amount).toFixed(2)}</span></div>
                </div>

                <!-- Payment Recap -->
                <div class="pt-2 text-[10px] space-y-1">
                    <div class="flex justify-between uppercase"><span>Payment Method:</span> <span class="font-bold">${data.payment_method}</span></div>
                    ${data.payment_method === 'cash' ? `
                        <div class="flex justify-between"><span>Cash Tendered:</span> <span>₱${Number(data.cash_received || 0).toFixed(2)}</span></div>
                        <div class="flex justify-between"><span>Change:</span> <span class="font-bold text-emerald-600">₱${Number(data.change_given || 0).toFixed(2)}</span></div>
                    ` : ''}
                </div>

                <!-- QR Validation and Footer -->
                <div class="text-center pt-6 space-y-2">
                    <div class="flex justify-center">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=pos-receipt-${saleId}" class="w-24 h-24 border border-zinc-100 p-1 rounded-lg">
                    </div>
                    <p class="text-[10px] font-black uppercase">Thank you for your purchase!</p>
                    <p class="text-[10px] text-zinc-400 italic">Please come again.</p>
                    <p class="text-[8px] text-zinc-300 pt-2 border-t border-zinc-100">Printed at: ${formattedDate} ${formattedTime}</p>
                </div>
            </div>
        `;

        ui.showModal("Transaction Receipt", receiptHtml, async () => {
            this.printReceipt();
        }, "Print Receipt", "max-w-md");
        
        // Relabel generic save button to Print action
        const saveBtn = document.getElementById('modal-save');
        if (saveBtn) {
            saveBtn.innerHTML = '<i data-lucide="printer" class="w-4 h-4"></i> Print Receipt';
            lucide.createIcons();
        }
    },
    // Standard browser print trigger
    printReceipt() {
        const originalTitle = document.title;
        document.title = `Receipt_${new Date().getTime()}`;
        window.print();
        document.title = originalTitle;
    },
    // Loads foundational POS data: Products, Categories, Settings, Discounts
    async loadTerminalData() {
        try {
            // Concurrent fetching for performance
            const [prodRes, catRes, setRes, discRes] = await Promise.all([
                api.get('/products'), 
                api.get('/categories'),
                api.get('/settings'),
                api.get('/discounts')
            ]);
            state.products = prodRes.data;
            state.categories = catRes.data;
            state.discounts = discRes.data;
            
            // Sync environment settings to user session for receipt branding
            if (setRes.data) {
                state.user.gcash_name = setRes.data.gcash_name;
                state.user.gcash_number = setRes.data.gcash_number;
                state.user.gcash_qr = setRes.data.gcash_qr;
                state.user.store_name = setRes.data.store_name;
                state.user.store_address = setRes.data.store_address;
                state.user.store_phone = setRes.data.store_phone;
            }
            
            // Cache master data for offline resilience
            localStorage.setItem('cached_products', JSON.stringify(state.products));
            localStorage.setItem('cached_categories', JSON.stringify(state.categories));
            localStorage.setItem('cached_discounts', JSON.stringify(state.discounts));
        } catch (err) { 
            console.warn("Offline or API Error, loading from cache:", err);
            // Fallback to local cache if network fails
            state.products = JSON.parse(localStorage.getItem('cached_products')) || [];
            state.categories = JSON.parse(localStorage.getItem('cached_categories')) || [];
            state.discounts = JSON.parse(localStorage.getItem('cached_discounts')) || [];
        } finally {
            this.renderCategoriesChips();
            this.renderProductsGrid();
            this.renderCart();
            // Connect search input to filtering logic
            document.getElementById('product-search').oninput = (e) => this.renderProductsGrid(e.target.value);
            offlineManager.handleOnlineStatus(navigator.onLine); // Update UI status
        }
    },
    // Renders the horizontal scrolling category filter list
    renderCategoriesChips() {
        const container = document.getElementById('category-chips');
        container.innerHTML = '<button onclick="screens.filterCategory(null)" class="px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-colors bg-zinc-900 text-white">All Items</button>';
        (state.categories || []).forEach(cat => {
            const btn = document.createElement('button');
            btn.className = "px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-colors bg-white border border-zinc-200 text-zinc-500 hover:bg-zinc-50";
            btn.innerText = cat.name;
            btn.onclick = () => this.filterCategory(cat.id, btn);
            container.appendChild(btn);
        });
    },
    // Switches the active category filter for the product grid
    filterCategory(id, btn) {
        // Toggle visual active state classes
        document.querySelectorAll('#category-chips button').forEach(b => b.className = "px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-colors bg-white border border-zinc-200 text-zinc-500 hover:bg-zinc-50");
        if (btn) btn.className = "px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-colors bg-zinc-900 text-white";
        else document.querySelector('#category-chips button').className = "px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-colors bg-zinc-900 text-white";
        
        state.activeCategory = id;
        this.renderProductsGrid(document.getElementById('product-search').value);
    },
    renderProductsGrid(search = '') {
        const container = document.getElementById('terminal-products');
        container.innerHTML = '';
        
        const filtered = (state.products || []).filter(p => 
            (search === '' || p.name.toLowerCase().includes(search.toLowerCase()) || p.barcode.includes(search)) &&
            (state.activeCategory == null || p.category_id === state.activeCategory)
        );
        
        filtered.forEach(p => {
            const div = document.createElement('div');
            div.className = "bg-white p-3 rounded-2xl border border-zinc-200 hover:border-zinc-900 cursor-pointer group transition-all";
            div.innerHTML = `
                <div class="aspect-square bg-zinc-50 rounded-xl mb-3 overflow-hidden flex items-center justify-center">
                    ${p.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500">` : `<i data-lucide="package" class="w-10 h-10 text-zinc-200"></i>`}
                </div>
                <p class="font-bold text-zinc-900 truncate">${p.name}</p>
                <p class="text-zinc-400 text-xs mb-2">${p.barcode}</p>
                <div class="flex items-center justify-between">
                    <span class="font-black text-zinc-900">₱${Number(p.selling_price).toFixed(2)}</span>
                    <span class="text-[10px] font-black px-2 py-0.5 rounded-full uppercase ${p.stock_quantity > 10 ? 'bg-green-50 text-green-600' : 'bg-orange-50 text-orange-600'}">${p.stock_quantity} pts</span>
                </div>
            `;
            div.onclick = () => this.addToCart(p);
            container.appendChild(div);
        });
        lucide.createIcons();
    },
    addToCart(product) {
        const existing = state.cart.find(i => i.id === product.id);
        if (existing) {
            existing.quantity++;
        } else {
            state.cart.push({ ...product, quantity: 1 });
        }
        this.renderCart();
    },
    updateCartQty(id, delta) {
        const item = state.cart.find(i => i.id === id);
        if (!item) return;
        item.quantity += delta;
        if (item.quantity <= 0) {
            state.cart = state.cart.filter(i => i.id !== id);
        }
        this.renderCart();
    },
    removeFromCart(id) {
        ui.confirm("Remove Item", "Are you sure you want to remove this item from the order?", () => {
            state.cart = state.cart.filter(i => i.id !== id);
            this.renderCart();
        }, false);
    },
    clearCart() {
        if (state.cart.length === 0) return;
        ui.confirm("Clear Order", "Are you sure you want to discard all items in the current order?", () => {
            state.cart = [];
            state.cartDiscount = 0;
            this.renderCart();
            ui.notify("Order cleared");
        });
    },
    renderCart() {
        const container = document.getElementById('cart-items');
        if (!container) return; // Prevent errors if not in terminal screen
        container.innerHTML = '';
        
        let subtotal = 0;
        let promoDiscountTotal = 0;
        const now = new Date();
        const activePromos = (state.discounts || []).filter(d => {
            if (d.is_active === 0) return false;
            if (d.start_date && new Date(d.start_date + 'T00:00:00') > now) return false;
            if (d.end_date && new Date(d.end_date + 'T23:59:59') < now) return false;
            return true;
        });

        state.cart.forEach(item => {
            // Calculate discount for this specific item
            let itemPromoDiscount = 0;
            activePromos.forEach(p => {
                let applies = false;
                if (p.target_type === 'all') applies = true;
                else if (p.target_type === 'category' && item.category_id === parseInt(p.target_id)) applies = true;
                else if (p.target_type === 'product' && item.id === parseInt(p.target_id)) applies = true;

                if (applies) {
                    if (p.type === 'percentage') {
                        itemPromoDiscount += (item.selling_price * item.quantity) * (p.value / 100);
                    } else {
                        // Targeted fixed discount is per item quantity
                        // Global fixed discount ('all') should ideally be treated differently, 
                        // but sticking to user's "target item" focus:
                        itemPromoDiscount += p.value * item.quantity;
                    }
                }
            });

            const itemLineTotal = item.selling_price * item.quantity;
            subtotal += itemLineTotal;
            promoDiscountTotal += itemPromoDiscount;

            const div = document.createElement('div');
            div.className = "flex items-center gap-3";
            div.innerHTML = `
                <div class="w-12 h-12 rounded-lg bg-zinc-50 border border-zinc-100 flex-shrink-0 flex items-center justify-center overflow-hidden">
                    ${item.image_url ? `<img src="${item.image_url}" class="w-full h-full object-cover text-[8px] italic">` : `<i data-lucide="package" class="w-6 h-6 text-zinc-200"></i>`}
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-bold truncate">${item.name}</p>
                    <div class="flex items-center gap-2">
                        <p class="text-xs ${itemPromoDiscount > 0 ? 'text-zinc-400 line-through' : 'text-zinc-400 font-medium'}">₱${Number(item.selling_price).toFixed(2)}</p>
                        ${itemPromoDiscount > 0 ? `<p class="text-xs text-emerald-600 font-black">₱${((itemLineTotal - itemPromoDiscount) / item.quantity).toFixed(2)}</p>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <div class="flex items-center bg-zinc-50 rounded-lg p-1 border border-zinc-100">
                        <button onclick="screens.updateCartQty(${item.id}, -1)" class="w-7 h-7 flex items-center justify-center hover:bg-white rounded-md transition-colors font-bold text-zinc-400 hover:text-zinc-900">-</button>
                        <span class="w-8 text-center text-xs font-black text-zinc-900">${item.quantity}</span>
                        <button onclick="screens.updateCartQty(${item.id}, 1)" class="w-7 h-7 flex items-center justify-center hover:bg-white rounded-md transition-colors font-bold text-zinc-400 hover:text-zinc-900">+</button>
                    </div>
                    <button onclick="screens.removeFromCart(${item.id})" class="p-1.5 text-zinc-300 hover:text-red-500 hover:bg-red-50 rounded-md transition-all">
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                    </button>
                </div>
            `;
            container.appendChild(div);
        });
        
        if (state.cart.length === 0) {
            container.innerHTML = '<div class="h-full flex flex-col items-center justify-center text-zinc-300 space-y-3 opacity-50 p-10"><i data-lucide="shopping-cart" class="w-12 h-12 stroke-1 text-zinc-200"></i><p class="font-semibold text-sm">No items in order</p></div>';
            this.toggleMobileCart(false); // Close drawer if empty
        }
        
        // Manual discount calculation
        if (state.cartDiscountType === 'percent') {
            state.cartDiscount = subtotal * ((state.cartDiscountValue || 0) / 100);
        } else {
            state.cartDiscount = state.cartDiscountValue || 0;
        }

        const manualDiscount = state.cartDiscount || 0;
        const totalDiscount = manualDiscount + promoDiscountTotal;
        const total = Math.max(0, subtotal - totalDiscount);
        const totalQty = state.cart.reduce((s, i) => s + i.quantity, 0);
        
        document.getElementById('cart-count').innerText = `${totalQty} Items`;
        document.getElementById('cart-subtotal').innerText = `₱${subtotal.toFixed(2)}`;
        
        const discountRow = document.getElementById('cart-discount-row');
        const promoRow = document.getElementById('cart-promo-discount-row');
        const discountPlaceholder = document.getElementById('apply-discount-placeholder');
        
        if (discountRow && discountPlaceholder) {
            if (manualDiscount > 0) {
                discountRow.classList.remove('hidden');
                discountPlaceholder.classList.add('hidden');
                document.getElementById('cart-discount').innerText = `-₱${manualDiscount.toFixed(2)}`;
            } else {
                discountRow.classList.add('hidden');
                discountPlaceholder.classList.remove('hidden');
            }
        }

        if (promoRow) {
            if (promoDiscountTotal > 0) {
                promoRow.classList.remove('hidden');
                document.getElementById('cart-promo-discount').innerText = `-₱${promoDiscountTotal.toFixed(2)}`;
            } else {
                promoRow.classList.add('hidden');
            }
        }

        document.getElementById('cart-total').innerText = `₱${total.toFixed(2)}`;
        
        // Mobile UI Updates
        const badge = document.getElementById('mobile-cart-badge');
        if (badge) {
            badge.innerText = totalQty;
            badge.classList.toggle('hidden', totalQty === 0);
        }

        const floatingBar = document.getElementById('mobile-checkout-bar');
        const floatingTotal = document.getElementById('floating-cart-total');
        const floatingCount = document.getElementById('floating-cart-count');
        if (floatingBar && floatingTotal && floatingCount) {
            floatingTotal.innerText = `₱${total.toFixed(2)}`;
            floatingCount.innerText = `${totalQty} items`;
            
            // Only show floating bar on mobile if drawer is NOT open
            const isDrawerOpen = !document.getElementById('cart-sidebar').classList.contains('translate-x-full');
            if (totalQty > 0 && !isDrawerOpen) {
                floatingBar.classList.remove('translate-y-32', 'opacity-0');
            } else {
                floatingBar.classList.add('translate-y-32', 'opacity-0');
            }
        }
        
        document.getElementById('checkout-btn').disabled = state.cart.length === 0;
        lucide.createIcons();
    },
    updateCartDiscountByInput() {
        const val = parseFloat(document.getElementById('discount-value-input')?.value) || 0;
        const typeButtons = document.getElementById('discount-type-fixed')?.parentElement;
        const type = typeButtons?.dataset.type || 'fixed';
        
        state.cartDiscountType = type;
        state.cartDiscountValue = val;
        this.renderCart();
    },
    openCartDiscountModal() {
        const now = new Date();
        const activePromos = (state.discounts || []).filter(d => {
            if (d.is_active === 0) return false;
            if (d.start_date && new Date(d.start_date + 'T00:00:00') > now) return false;
            if (d.end_date && new Date(d.end_date + 'T23:59:59') < now) return false;
            return state.cart.some(item => {
                if (d.target_type === 'all') return true;
                if (d.target_type === 'category' && item.category_id === parseInt(d.target_id || 0)) return true;
                if (d.target_type === 'product' && item.id === parseInt(d.target_id || 0)) return true;
                return false;
            });
        });

        ui.showModal("Apply Discount", `
            <div class="space-y-4">
                ${(activePromos || []).length > 0 ? `
                    <div class="p-4 bg-emerald-50 rounded-2xl border border-emerald-100 space-y-3">
                        <div class="flex items-center gap-2 text-emerald-700">
                             <i data-lucide="sparkles" class="w-4 h-4"></i>
                             <span class="text-[10px] font-black uppercase tracking-widest">Active Promotions Applied</span>
                        </div>
                        <div class="space-y-2">
                            ${activePromos.map(p => `
                                <div class="flex justify-between items-center bg-white/50 p-2 rounded-xl text-xs">
                                    <span class="font-bold text-zinc-700">${p.name}</span>
                                    <span class="font-black text-emerald-600">${p.type === 'percentage' ? `${p.value}% OFF` : `₱${Number(p.value).toFixed(2)} OFF`}</span>
                                </div>
                            `).join('')}
                        </div>
                        <p class="text-[9px] font-bold text-emerald-600/60 uppercase">These are applied automatically to valid items.</p>
                    </div>
                ` : ''}

                <div class="p-4 bg-amber-50 rounded-2xl border border-amber-100 flex items-center gap-3">
                    <i data-lucide="info" class="w-5 h-5 text-amber-500"></i>
                    <p class="text-xs font-bold text-amber-700">Add a manual discount below to stack with current offers.</p>
                </div>
                <div class="space-y-1.5">
                    <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest px-1">Discount Method</label>
                    <div id="discount-type-container" data-type="${state.cartDiscountType || 'fixed'}" class="grid grid-cols-2 gap-2">
                        <button id="discount-type-fixed" onclick="this.parentElement.dataset.type='fixed'; this.className='h-11 rounded-xl bg-zinc-900 text-white font-bold text-xs'; document.getElementById('discount-type-percent').className='h-11 rounded-xl bg-zinc-100 text-zinc-500 font-bold text-xs'; screens.updateCartDiscountByInput()" class="h-11 rounded-xl ${state.cartDiscountType === 'fixed' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500'} font-bold text-xs">Fixed Amount (₱)</button>
                        <button id="discount-type-percent" onclick="this.parentElement.dataset.type='percent'; this.className='h-11 rounded-xl bg-zinc-900 text-white font-bold text-xs'; document.getElementById('discount-type-fixed').className='h-11 rounded-xl bg-zinc-100 text-zinc-500 font-bold text-xs'; screens.updateCartDiscountByInput()" class="h-11 rounded-xl ${state.cartDiscountType === 'percent' ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500'} font-bold text-xs">Percentage (%)</button>
                    </div>
                </div>
                <div class="space-y-1.5">
                    <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest px-1">Value</label>
                    <input type="number" id="discount-value-input" oninput="screens.updateCartDiscountByInput()" value="${state.cartDiscountValue || ''}" placeholder="0.00" class="w-full h-14 px-4 bg-zinc-50 border border-zinc-200 rounded-xl outline-none text-2xl font-black">
                </div>
                ${state.cartDiscountValue > 0 ? `
                    <button onclick="state.cartDiscount = 0; state.cartDiscountValue = 0; ui.hideModal(); screens.renderCart();" class="w-full py-2 text-red-500 text-xs font-bold hover:bg-red-50 rounded-lg transition-colors">Remove Current Discount</button>
                ` : ''}
            </div>
        `, async () => {
            // Logic is handled in real-time now, just ensure values are saved (they already are in state)
            this.renderCart();
        }, "Confirm Discount");
    },
    openCameraScanner(mode) {
        const isContinuous = mode === 'pos';
        ui.showModal(isContinuous ? "Scan Products (Continuous)" : "Single Barcode Scan", `
            <div class="flex flex-col items-center gap-4">
                <div id="scanner-view" class="w-full aspect-video bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl relative">
                    <div class="absolute inset-0 border-2 border-dashed border-white/20 pointer-events-none m-8 rounded-xl flex items-center justify-center">
                        <div class="w-full h-0.5 bg-red-500/50 animate-pulse"></div>
                    </div>
                </div>
                <p id="scan-feedback" class="text-xs text-zinc-500 font-bold uppercase tracking-widest bg-zinc-50 px-4 py-2 rounded-full">
                    ${isContinuous ? "Scan items one after another" : "Position barcode within frame"}
                </p>
            </div>
        `, null, "Close Scanner", "max-w-2xl");
        
        // Modal logic for camera
        const close = () => {
            barcodeScanner.stopCamera();
            ui.hideModal();
        };
        
        const saveBtn = document.getElementById('modal-save');
        if (saveBtn) {
            saveBtn.onclick = close;
        }
        document.getElementById('modal-cancel').onclick = close;
        document.getElementById('close-modal').onclick = close;

        // Small delay to ensure DOM is ready
        setTimeout(() => {
            barcodeScanner.startCamera('scanner-view', (code) => {
                barcodeScanner.handleScan(code);
                const feedback = document.getElementById('scan-feedback');
                if (feedback) {
                    feedback.innerText = "Captured: " + code;
                    feedback.className = "text-xs text-emerald-600 font-black uppercase tracking-widest bg-emerald-50 px-4 py-2 rounded-full";
                    setTimeout(() => {
                        if (feedback && isContinuous) {
                            feedback.innerText = "Scanning next...";
                            feedback.className = "text-xs text-zinc-500 font-bold uppercase tracking-widest bg-zinc-50 px-4 py-2 rounded-full";
                        }
                    }, 1000);
                }
                if (!isContinuous) close();
            }, isContinuous);
        }, 100);
    },
    addProductByBarcode(barcode) {
        const product = state.products.find(p => p.barcode === barcode);
        if (product) {
            this.addToCart(product);
            ui.notify(`Added: ${product.name}`);
        } else {
            ui.notify(`Product not found: ${barcode}`, 'error');
        }
    },
    startInlineScanner() {
        const scannerContainer = document.getElementById('p-inline-scanner');
        if (scannerContainer) {
            scannerContainer.classList.remove('hidden');
            scannerContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            barcodeScanner.startCamera('p-inline-view', (code) => {
                const field = document.getElementById('p-barcode');
                if (field) {
                    field.value = code;
                    ui.notify("Captured: " + code);
                    ui.beep();
                }
                this.stopInlineScanner();
            });
        }
    },
    stopInlineScanner() {
        const scannerContainer = document.getElementById('p-inline-scanner');
        if (scannerContainer) scannerContainer.classList.add('hidden');
        barcodeScanner.stopCamera();
    },
    async renderInventory() {
        const root = document.getElementById('screen-content');
        root.innerHTML = '<div class="p-10 text-center text-zinc-400 animate-pulse">Fetching inventory tracker...</div>';
        try {
            // Initial data fetch if state is empty, or refresh on screen load
            const res = await api.get('/products');
            state.products = res.data;
            
            this.renderInventoryUI();
        } catch (err) { 
            console.error(err); 
            root.innerHTML = `<div class="p-10 text-center text-red-500 font-bold uppercase tracking-widest bg-red-50 m-6 rounded-2xl border border-red-100 flex flex-col items-center gap-4">
                <i data-lucide="alert-circle" class="w-10 h-10"></i>
                <span>Failed to load inventory tracker</span>
                <p class="text-[10px] font-medium text-red-400">${err.message}</p>
                <button onclick="screens.renderInventory()" class="mt-2 px-4 py-2 bg-red-500 text-white rounded-lg text-xs font-black">RETRY CONNECTION</button>
            </div>`;
            lucide.createIcons();
        }
    },
    renderInventoryUI() {
        const root = document.getElementById('screen-content');
        root.innerHTML = `
            <div class="space-y-6">
                <div class="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                    <div>
                        <h2 class="text-2xl font-bold tracking-tight">Stock Management</h2>
                        <p class="text-xs text-zinc-400 font-medium">Monitor levels, update pricing, and manage assets</p>
                    </div>
                    <div class="flex flex-wrap gap-2 w-full lg:w-auto">
                        <button onclick="screens.exportInventoryPDF()" class="flex-1 lg:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-white border border-zinc-200 text-zinc-900 rounded-xl font-bold hover:bg-zinc-50 transition-all text-sm shadow-sm">
                            <i data-lucide="download" class="w-4 h-4"></i> Export PDF
                        </button>
                        ${state.user.role !== 'user' ? `
                            <button onclick="screens.openProductModal()" class="flex-1 lg:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-zinc-900 text-white rounded-xl font-bold hover:bg-zinc-800 transition-all text-sm shadow-lg shadow-zinc-900/20">
                                <i data-lucide="plus" class="w-4 h-4"></i> Add Product
                            </button>
                        ` : ''}
                    </div>
                </div>

                <!-- Low Stock Alerts Section -->
                <div id="inventory-alerts" class="space-y-3 empty:hidden"></div>

                <!-- Shared Search & Filter Area -->
                <div class="flex flex-col sm:flex-row gap-3 bg-white p-3 rounded-2xl border border-zinc-200 shadow-sm">
                    <div class="flex-1 relative group">
                        <i data-lucide="search" class="absolute left-4 top-3.5 w-5 h-5 text-zinc-400 group-focus-within:text-zinc-900 transition-colors"></i>
                        <input 
                            type="text" 
                            id="inventory-search" 
                            placeholder="Search by name, barcode, or category..." 
                            value="${state.inventorySearchQuery}"
                            class="w-full h-12 pl-12 pr-4 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5 focus:bg-white transition-all text-sm"
                        >
                    </div>
                </div>

                <div class="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
                    <div class="overflow-x-auto no-scrollbar">
                        <table class="w-full text-left min-w-[700px]">
                            <thead class="bg-zinc-50 border-b border-zinc-200">
                                <tr>
                                    <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Product Details</th>
                                    <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Category</th>
                                    <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Price</th>
                                    <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Stock Level</th>
                                    <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Expiry</th>
                                    <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="inventory-list" class="divide-y divide-zinc-100 italic text-zinc-400">
                                <!-- Dynamic rows via updateInventoryTable() -->
                            </tbody>
                        </table>
                    </div>
                    <div id="inventory-empty-state" class="hidden py-20 text-center">
                        <div class="w-16 h-16 bg-zinc-50 rounded-full flex items-center justify-center mx-auto mb-4">
                            <i data-lucide="search-x" class="w-8 h-8 text-zinc-300"></i>
                        </div>
                        <h3 class="text-zinc-900 font-bold">No products found</h3>
                        <p class="text-sm text-zinc-400">Try adjusting your search keywords</p>
                    </div>
                </div>
            </div>
        `;

        // Initialize table content
        this.updateInventoryTable();
        this.updateInventoryAlerts();

        // Bind Search Input
        const searchInput = document.getElementById('inventory-search');
        searchInput.oninput = (e) => {
            state.inventorySearchQuery = e.target.value;
            this.updateInventoryTable();
        };

        lucide.createIcons();
    },

    updateInventoryAlerts() {
        const alertRoot = document.getElementById('inventory-alerts');
        if (!alertRoot) return;

        const lowStockProducts = (state.products || []).filter(p => p.stock_quantity <= p.min_stock_level);
        
        // Expiration Logic
        const now = new Date();
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(now.getDate() + 30);

        const expiringSoonProducts = (state.products || []).filter(p => {
            if (!p.expiration_date) return false;
            const expiry = new Date(p.expiration_date);
            return expiry <= thirtyDaysFromNow && expiry > now;
        });

        const expiredProducts = (state.products || []).filter(p => {
            if (!p.expiration_date) return false;
            const expiry = new Date(p.expiration_date);
            return expiry <= now;
        });

        if (lowStockProducts.length === 0 && expiringSoonProducts.length === 0 && expiredProducts.length === 0) {
            alertRoot.innerHTML = '';
            return;
        }

        alertRoot.innerHTML = `
            <div class="space-y-4 animate-in fade-in slide-in-from-top-4 duration-500">
                ${lowStockProducts.length > 0 ? `
                    <div class="p-4 bg-red-50 border border-red-100 rounded-2xl flex flex-col gap-4">
                        <div class="flex items-center gap-3 text-red-600">
                            <div class="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                                <i data-lucide="alert-octagon" class="w-5 h-5"></i>
                            </div>
                            <div>
                                <h3 class="font-black text-sm uppercase tracking-tighter">Critical Stock Alerts</h3>
                                <p class="text-[10px] opacity-80 font-bold uppercase">${lowStockProducts.length} items require immediate replenishment</p>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            ${lowStockProducts.map(p => `
                                <div class="bg-white p-3 rounded-xl border border-red-100 flex items-center gap-3 shadow-sm hover:shadow-md transition-all group cursor-pointer" onclick="screens.openProductModal(${JSON.stringify(p).replace(/"/g, '&quot;')})">
                                    <div class="w-10 h-10 rounded-lg bg-zinc-50 border border-zinc-100 flex-shrink-0 overflow-hidden">
                                        ${p.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover">` : `<div class="w-full h-full flex items-center justify-center text-zinc-300"><i data-lucide="package" class="w-4 h-4"></i></div>`}
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <p class="text-xs font-bold text-zinc-900 truncate">${p.name}</p>
                                        <div class="flex items-center gap-2 mt-0.5">
                                            <span class="text-[10px] font-black text-red-600">${p.stock_quantity} left</span>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}

                ${expiredProducts.length > 0 ? `
                    <div class="p-4 bg-zinc-900 border border-zinc-800 rounded-2xl flex flex-col gap-4">
                        <div class="flex items-center gap-3 text-white">
                            <div class="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
                                <i data-lucide="skull" class="w-5 h-5 text-red-500"></i>
                            </div>
                            <div>
                                <h3 class="font-black text-sm uppercase tracking-tighter">Expired Inventory</h3>
                                <p class="text-[10px] opacity-60 font-bold uppercase">${expiredProducts.length} items must be removed from shelves</p>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            ${expiredProducts.map(p => `
                                <div class="bg-white/5 p-3 rounded-xl border border-white/10 flex items-center gap-3 shadow-sm hover:bg-white/10 transition-all group cursor-pointer" onclick="screens.openProductModal(${JSON.stringify(p).replace(/"/g, '&quot;')})">
                                    <div class="w-10 h-10 rounded-lg bg-white/5 flex-shrink-0 overflow-hidden">
                                        ${p.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover opacity-50">` : `<div class="w-full h-full flex items-center justify-center text-zinc-600"><i data-lucide="package" class="w-4 h-4"></i></div>`}
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <p class="text-xs font-bold text-white truncate">${p.name}</p>
                                        <p class="text-[9px] font-black text-red-400 uppercase">Expired: ${p.expiration_date}</p>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}

                ${expiringSoonProducts.length > 0 ? `
                    <div class="p-4 bg-amber-50 border border-amber-100 rounded-2xl flex flex-col gap-4">
                        <div class="flex items-center gap-3 text-amber-700">
                            <div class="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                                <i data-lucide="timer" class="w-5 h-5"></i>
                            </div>
                            <div>
                                <h3 class="font-black text-sm uppercase tracking-tighter">Expiring Soon</h3>
                                <p class="text-[10px] opacity-80 font-bold uppercase">${expiringSoonProducts.length} items nearing expiration (30 Days)</p>
                            </div>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            ${expiringSoonProducts.map(p => `
                                <div class="bg-white p-3 rounded-xl border border-amber-100 flex items-center gap-3 shadow-sm hover:shadow-md transition-all group cursor-pointer" onclick="screens.openProductModal(${JSON.stringify(p).replace(/"/g, '&quot;')})">
                                    <div class="w-10 h-10 rounded-lg bg-zinc-50 flex-shrink-0 overflow-hidden">
                                        ${p.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover">` : `<div class="w-full h-full flex items-center justify-center text-zinc-300"><i data-lucide="package" class="w-4 h-4"></i></div>`}
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <p class="text-xs font-bold text-zinc-900 truncate">${p.name}</p>
                                        <p class="text-[9px] font-black text-amber-600 uppercase">Expires: ${p.expiration_date}</p>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
        lucide.createIcons();
    },

    updateInventoryTable() {
        const tbody = document.getElementById('inventory-list');
        const emptyState = document.getElementById('inventory-empty-state');
        const q = state.inventorySearchQuery.toLowerCase().trim();

        // Filter Logic
        const filtered = (state.products || []).filter(p => {
            const name = (p.name || '').toLowerCase();
            const barcode = (p.barcode || '').toLowerCase();
            const category = (p.category_name || '').toLowerCase();
            return name.includes(q) || barcode.includes(q) || category.includes(q);
        });

        if (filtered.length === 0) {
            tbody.innerHTML = '';
            emptyState.classList.remove('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        tbody.innerHTML = filtered.map(p => {
            const now = new Date();
            const expiryDate = p.expiration_date ? new Date(p.expiration_date) : null;
            const isExpired = expiryDate && expiryDate <= now;
            const isExpiringSoon = expiryDate && expiryDate <= new Date(now.setDate(now.getDate() + 30)) && !isExpired;

            return `
            <tr class="hover:bg-zinc-50/50 transition-colors group">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-4">
                        <div class="w-10 h-10 rounded-xl bg-zinc-100 flex-shrink-0 flex items-center justify-center text-zinc-400 overflow-hidden border border-zinc-200">
                            ${p.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover ${isExpired ? 'grayscale' : ''}">` : `<i data-lucide="package" class="w-5 h-5"></i>`}
                        </div>
                        <div class="min-w-0">
                            <p class="font-bold text-zinc-900 truncate">${p.name}</p>
                            <p class="text-[10px] text-zinc-400 font-mono tracking-tighter uppercase truncate">${p.barcode}</p>
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4">
                    <span class="px-2.5 py-1 rounded-lg bg-zinc-100 text-zinc-600 text-[10px] font-black uppercase tracking-tight">${p.category_name || 'General'}</span>
                </td>
                <td class="px-6 py-4">
                    <div class="flex flex-col">
                        <span class="font-bold text-zinc-900">₱${Number(p.selling_price).toFixed(2)}</span>
                        ${p.cost_price ? `<span class="text-[10px] text-zinc-400">Cost: ₱${Number(p.cost_price).toFixed(2)}</span>` : ''}
                    </div>
                </td>
                <td class="px-6 py-4">
                    <div class="flex flex-col gap-1.5">
                        <div class="w-24 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                            <div class="h-full rounded-full transition-all duration-700 ${p.stock_quantity > p.min_stock_level ? 'bg-emerald-500' : 'bg-red-500'}" 
                                 style="width: ${Math.min(100, (p.stock_quantity / (p.min_stock_level * 10)) * 100)}%"></div>
                        </div>
                        <div class="flex items-center gap-2">
                             <span class="text-[10px] font-bold ${p.stock_quantity > p.min_stock_level ? 'text-zinc-600' : 'text-red-600'}">${p.stock_quantity} units</span>
                             ${p.stock_quantity <= p.min_stock_level ? `
                                <span class="flex items-center gap-1 text-[8px] font-black text-red-500 uppercase px-1.5 py-0.5 bg-red-50 rounded">
                                    <i data-lucide="alert-triangle" class="w-2 h-2"></i> Low
                                </span>
                             ` : ''}
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4">
                    ${p.expiration_date ? `
                        <div class="flex flex-col gap-0.5">
                            <span class="text-xs font-bold ${isExpired ? 'text-red-600' : (isExpiringSoon ? 'text-amber-500' : 'text-zinc-900')}">${p.expiration_date}</span>
                            ${isExpired ? `
                                <span class="text-[8px] font-black text-red-500 uppercase bg-red-50 px-1.5 py-0.5 rounded w-fit">Expired</span>
                            ` : (isExpiringSoon ? `
                                <span class="text-[8px] font-black text-amber-500 uppercase bg-amber-50 px-1.5 py-0.5 rounded w-fit">Near Expiry</span>
                            ` : '')}
                        </div>
                    ` : '<span class="text-[10px] text-zinc-300 font-bold uppercase tracking-widest italic">No Expiry</span>'}
                </td>
                <td class="px-6 py-4 text-right whitespace-nowrap">
                    <div class="flex items-center justify-end gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
                        ${state.user.role !== 'user' ? `
                            <button onclick="screens.openProductModal(${JSON.stringify(p).replace(/"/g, '&quot;')})" class="w-9 h-9 flex items-center justify-center hover:bg-zinc-100 rounded-xl text-zinc-600 transition-all" title="Edit Item">
                                <i data-lucide="edit-3" class="w-4 h-4"></i>
                            </button>
                            <button onclick="screens.handleDelete('product', ${p.id})" class="w-9 h-9 flex items-center justify-center hover:bg-red-50 rounded-xl text-red-400 transition-all" title="Delete Item">
                                <i data-lucide="trash-2" class="w-4 h-4"></i>
                            </button>
                        ` : '<span class="text-[10px] text-zinc-300 font-bold uppercase tracking-widest px-4">Locked</span>'}
                    </div>
                </td>
            </tr>
        `;
        }).join('');
        lucide.createIcons();
    },
    async openProductModal(p = null) {
        if (state.categories.length === 0) {
            const res = await api.get('/categories');
            state.categories = res.data;
        }

        ui.showModal(p ? "Edit Product" : "Add New Product", `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div id="p-inline-scanner" class="hidden md:col-span-2 bg-zinc-900 rounded-3xl overflow-hidden p-4 space-y-4 shadow-inner relative">
                    <div id="p-inline-view" class="w-full aspect-video md:aspect-[21/9] bg-black rounded-2xl overflow-hidden"></div>
                    <div class="flex justify-between items-center">
                         <span class="text-[10px] font-black text-white/50 uppercase tracking-widest">Scanning Active</span>
                         <button type="button" onclick="screens.stopInlineScanner()" class="px-3 py-1 bg-red-500 text-white text-[10px] font-bold rounded-lg uppercase">Cancel</button>
                    </div>
                </div>

                <div class="md:col-span-2 flex flex-col items-center mb-2">
                    <div id="p-image-preview" class="w-28 h-28 rounded-2xl bg-zinc-100 border-2 border-dashed border-zinc-200 flex items-center justify-center overflow-hidden cursor-pointer hover:border-zinc-900 transition-all">
                        ${p?.image_url ? `<img src="${p.image_url}" class="w-full h-full object-cover">` : `<i data-lucide="image-plus" class="w-8 h-8 text-zinc-400"></i>`}
                    </div>
                    <input type="file" id="p-image-input" class="hidden" accept="image/*">
                    <p class="text-[10px] font-bold text-zinc-400 mt-2 uppercase">Click to upload photo</p>
                </div>
                <div class="md:col-span-2 space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Product Name</label>
                    <input type="text" id="p-name" value="${p?.name || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5 md:col-span-2">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Barcode/SKU</label>
                    <div class="flex gap-2">
                        <input type="text" id="p-barcode" value="${p?.barcode || ''}" class="flex-1 h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                        <button type="button" onclick="screens.startInlineScanner()" class="h-11 px-6 bg-zinc-900 text-white rounded-xl hover:bg-zinc-800 transition-all flex items-center justify-center gap-2 font-bold text-xs" title="Scan Barcode">
                            <i data-lucide="scan" class="w-4 h-4"></i> Scan
                        </button>
                    </div>
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Category</label>
                    <select id="p-category" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                        <option value="">No Category</option>
                        ${state.categories.map(c => `<option value="${c.id}" ${p?.category_id === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
                    </select>
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Cost Price</label>
                    <input type="number" id="p-cost" value="${p?.cost_price || 0}" step="0.01" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Selling Price</label>
                    <input type="number" id="p-price" value="${p?.selling_price || 0}" step="0.01" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Initial Stock</label>
                    <input type="number" id="p-stock" value="${p?.stock_quantity || 0}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Min Stock Level</label>
                    <input type="number" id="p-min" value="${p?.min_stock_level || 10}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Expiration Date</label>
                    <input type="date" id="p-expiry" value="${p?.expiration_date ? p.expiration_date.split('T')[0] : ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
            </div>
        `, async () => {
            const imageInput = document.getElementById('p-image-input');
            let imageUrl = p?.image_url || '';
            
            if (imageInput.files[0]) {
                const formData = new FormData();
                formData.append('image', imageInput.files[0]);
                const uploadRes = await api.post('/upload', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
                imageUrl = uploadRes.data.imageUrl;
            }

            const data = {
                name: document.getElementById('p-name').value.trim(),
                barcode: document.getElementById('p-barcode').value.trim(),
                category_id: document.getElementById('p-category').value || null,
                cost_price: parseFloat(document.getElementById('p-cost').value) || 0,
                selling_price: parseFloat(document.getElementById('p-price').value) || 0,
                stock_quantity: parseInt(document.getElementById('p-stock').value) || 0,
                min_stock_level: parseInt(document.getElementById('p-min').value) || 0,
                expiration_date: document.getElementById('p-expiry').value || null,
                image_url: imageUrl
            };

            // Basic integrity validation before sending to API
            if (!data.name) throw new Error("Product name is required");
            if (!data.barcode) throw new Error("Barcode is required");
            if (data.selling_price < 0) throw new Error("Selling price cannot be negative");

            // Direct API call based on whether it's an update (id exists) or create
            if (p) {
                await api.put(`/products/${p.id}`, data);
            } else {
                await api.post('/products', data);
            }
            this.renderInventory(); // Reload the list
        }, "Save Product", "max-w-2xl");

        // Setup image upload triggers
        const preview = document.getElementById('p-image-preview');
        const input = document.getElementById('p-image-input');
        if (preview && input) {
            preview.onclick = () => input.click();
            input.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (re) => {
                        preview.innerHTML = `<img src="${re.target.result}" class="w-full h-full object-cover">`;
                    };
                    reader.readAsDataURL(file);
                }
            };
        }
        lucide.createIcons();
    },
    // Renders the standalone Category management screen
    async renderCategories() {
        const root = document.getElementById('screen-content');
        root.innerHTML = '<div class="p-10 text-center text-zinc-400 animate-pulse">Loading categories catalog...</div>';
        try {
            const res = await api.get('/categories');
            state.categories = res.data;
            root.innerHTML = `
                <div class="max-w-4xl space-y-6">
                    <!-- Screen Header -->
                    <div class="flex justify-between items-center">
                        <h2 class="text-2xl font-bold tracking-tight text-zinc-900">Category Catalog</h2>
                        ${state.user.role !== 'user' ? `
                            <button onclick="screens.openCategoryModal()" class="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg font-bold hover:bg-zinc-800 transition-all"><i data-lucide="plus" class="w-4 h-4"></i> New Category</button>
                        ` : ''}
                    </div>
                    <!-- Card Grid Layout -->
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        ${(state.categories || []).map(cat => `
                            <div class="bg-white p-5 rounded-2xl border border-zinc-200 shadow-sm flex items-center justify-between group">
                                <div class="flex items-center gap-3">
                                    <div class="w-10 h-10 rounded-xl bg-zinc-50 flex items-center justify-center text-zinc-400"><i data-lucide="layers" class="w-5 h-5"></i></div>
                                    <span class="font-bold text-zinc-900">${cat.name}</span>
                                </div>
                                <div class="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                                    ${state.user.role !== 'user' ? `
                                        <button onclick="screens.openCategoryModal(${JSON.stringify(cat).replace(/"/g, '&quot;')})" class="p-2 hover:bg-zinc-100 rounded-lg text-zinc-400"><i data-lucide="edit-3" class="w-4 h-4"></i></button>
                                        <button onclick="screens.handleDelete('category', ${cat.id})" class="p-2 hover:bg-zinc-100 rounded-lg text-red-400"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                                    ` : ''}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            lucide.createIcons();
        } catch (err) { 
            console.error(err); 
            root.innerHTML = `<div class="p-10 text-center text-red-500 font-bold uppercase tracking-widest bg-red-50 m-6 rounded-2xl border border-red-100 flex flex-col items-center gap-4">
                <i data-lucide="alert-circle" class="w-10 h-10"></i>
                <span>Failed to load category catalog</span>
                <p class="text-[10px] font-medium text-red-400">${err.message}</p>
                <button onclick="screens.renderCategories()" class="mt-2 px-4 py-2 bg-red-500 text-white rounded-lg text-xs font-black">RETRY CONNECTION</button>
            </div>`;
            lucide.createIcons();
        }
    },
    // Form for Category addition/modification
    openCategoryModal(cat = null) {
        ui.showModal(cat ? "Edit Category" : "New Category", `
            <div class="space-y-1.5">
                <label class="text-xs font-bold text-zinc-500 uppercase">Category Name</label>
                <input type="text" id="cat-name" value="${cat?.name || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
            </div>
        `, async () => {
            const name = document.getElementById('cat-name').value.trim();
            if (!name) throw new Error("Category name is required");
            
            if (cat) {
                await api.put(`/categories/${cat.id}`, { name });
            } else {
                await api.post('/categories', { name });
            }
            this.renderCategories();
        });
    },
    // Renders User/Personnel registry for store owners
    async renderUsers() {
        const root = document.getElementById('screen-content');
        root.innerHTML = '<div class="p-10 text-center text-zinc-400 animate-pulse">Loading personnel registry...</div>';
        try {
            const res = await api.get('/users');
            state.personnel = res.data;
            root.innerHTML = `
                <div class="space-y-6">
                    <div class="flex justify-between items-center">
                        <h2 class="text-2xl font-bold tracking-tight text-zinc-900">Personnel Registry</h2>
                        <button onclick="screens.openUserModal()" class="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg font-bold hover:bg-zinc-800 transition-all"><i data-lucide="plus" class="w-4 h-4"></i> Add Personnel</button> structure
                    </div>
                    <!-- Registry Grid -->
                    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                        ${(state.personnel || []).map(u => `
                            <div class="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm relative overflow-hidden">
                                <div class="flex items-start justify-between mb-4">
                                    <div class="w-12 h-12 rounded-2xl bg-zinc-100 flex items-center justify-center text-zinc-400 border border-zinc-200"><i data-lucide="user" class="w-6 h-6"></i></div>
                                    <span class="text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-tighter bg-blue-50 text-blue-600">${u.role.replace('_', ' ')}</span>
                                </div>
                                <h4 class="font-black text-lg text-zinc-900">${u.full_name}</h4>
                                <p class="text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">@${u.username}</p>
                                
                                ${u.phone ? `
                                    <div class="flex items-center gap-2 text-zinc-500 mb-6">
                                        <i data-lucide="phone" class="w-3.5 h-3.5"></i>
                                        <span class="text-xs font-mono font-bold tracking-tight">${u.phone}</span>
                                    </div>
                                ` : '<div class="h-10"></div>'}

                                <div class="flex gap-2">
                                    <button onclick="screens.openUserModal(${JSON.stringify(u).replace(/"/g, '&quot;')})" class="flex-1 px-4 py-2 bg-zinc-50 border border-zinc-200 rounded-lg text-xs font-bold hover:bg-zinc-100">Edit Profile</button>
                                    <button onclick="screens.handleDelete('user', ${u.id})" class="px-3 py-2 bg-red-50 text-red-500 rounded-lg hover:bg-red-100"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            lucide.createIcons();
        } catch (err) { console.error(err); }
    },
    // Modal for personnel account configuration
    openUserModal(u = null) {
        ui.showModal(u ? "Edit Personnel" : "Add Personnel", `
            <div class="space-y-4">
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Full Name</label>
                    <input type="text" id="u-fullname" value="${u?.full_name || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Username</label>
                    <input type="text" id="u-username" value="${u?.username || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Password ${u ? '(Leave blank to keep current)' : ''}</label>
                    <input type="password" id="u-password" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Role</label>
                    <select id="u-role" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                        <option value="user" ${u?.role === 'user' ? 'selected' : ''}>User (Cashier)</option>
                        <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Admin (Owner)</option>
                    </select>
                </div>
                <div class="space-y-1.5">
                    <label class="text-xs font-bold text-zinc-500 uppercase">Phone Number</label>
                    <input type="text" id="u-phone" value="${u?.phone || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5" placeholder="09XX XXX XXXX" maxlength="11">
                </div>
            </div>
        `, async () => {
            const data = {
                full_name: document.getElementById('u-fullname').value.trim(),
                username: document.getElementById('u-username').value.trim(),
                password: document.getElementById('u-password').value || undefined,
                role: document.getElementById('u-role').value,
                phone: document.getElementById('u-phone').value.trim()
            };

            if (!data.full_name) throw new Error("Full name is required");
            if (!data.username) throw new Error("Username is required");
            if (!u && !data.password) throw new Error("Password is required for new personnel");
            
            if (data.phone && !/^09\d{9}$/.test(data.phone)) {
                throw new Error("Phone number must be 11 digits starting with 09");
            }

            if (u) {
                await api.put(`/users/${u.id}`, data);
            } else {
                await api.post('/users', data);
            }
            this.renderUsers();
        });
    },
    // Renders the Discounts and Campaigns list
    async renderDiscounts() {
        const root = document.getElementById('screen-content');
        root.innerHTML = '<div class="p-10 text-center text-zinc-400 animate-pulse">Loading active promotions...</div>';
        try {
            const res = await api.get('/discounts');
            state.discounts = res.data;
            root.innerHTML = `
                <div class="space-y-6">
                    <div class="flex justify-between items-center">
                        <div class="space-y-1">
                            <h2 class="text-2xl font-bold tracking-tight text-zinc-900">Promotions & Discounts</h2>
                            <p class="text-sm text-zinc-500">Manage your active campaigns and targeted price reductions.</p>
                        </div>
                        <button onclick="screens.openDiscountModal()" class="flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white rounded-lg font-bold hover:bg-zinc-800 transition-all"><i data-lucide="plus" class="w-4 h-4"></i> Add Campaign</button>
                    </div>
                    
                    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                        ${(state.discounts || []).map(d => `
                            <div class="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden flex flex-col group transition-all hover:border-zinc-300">
                                <div class="p-6 flex-1 space-y-4">
                                    <div class="flex justify-between items-start">
                                        <div class="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600"><i data-lucide="sparkles" class="w-5 h-5"></i></div>
                                        <span class="text-[10px] font-black px-2 py-1 rounded-full uppercase tracking-tighter ${d.is_active ? 'bg-emerald-50 text-emerald-600' : 'bg-zinc-100 text-zinc-400'}">${d.is_active ? 'Active' : 'Inactive'}</span>
                                    </div>
                                    <div>
                                        <h4 class="font-black text-xl text-zinc-900">${d.name}</h4>
                                        <p class="text-xs font-bold text-zinc-400 uppercase tracking-widest">Type: ${d.target_type}</p>
                                    </div>
                                    <div class="p-4 bg-zinc-50 rounded-2xl border border-zinc-100">
                                        <p class="text-xs font-bold text-zinc-400 uppercase tracking-widest mb-1 text-zinc-400">Benefit</p>
                                        <p class="text-2xl font-black text-zinc-900">${d.type === 'percentage' ? `${d.value}% OFF` : `₱${Number(d.value).toFixed(2)} OFF`}</p>
                                    </div>
                                    <div class="space-y-2">
                                        <div class="flex justify-between items-center text-xs">
                                            <span class="font-bold text-zinc-400 uppercase">Starts</span>
                                            <span class="font-black text-zinc-900">${d.start_date ? new Date(d.start_date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A'}</span>
                                        </div>
                                        <div class="flex justify-between items-center text-xs">
                                            <span class="font-bold text-zinc-400 uppercase">Ends</span>
                                            <span class="font-black text-zinc-900">${d.end_date ? new Date(d.end_date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'N/A'}</span>
                                        </div>
                                    </div>
                                </div>
                                <div class="p-4 bg-zinc-100/50 border-t border-zinc-200 flex gap-2">
                                    <button onclick="screens.openDiscountModal(${JSON.stringify(d).replace(/"/g, '&quot;')})" class="flex-1 h-10 bg-white border border-zinc-200 rounded-xl text-xs font-bold text-zinc-900 hover:bg-zinc-50 transition-all">Edit Campaign</button>
                                    <button onclick="screens.handleDelete('discount', ${d.id})" class="w-10 h-10 flex items-center justify-center bg-red-50 text-red-500 rounded-xl hover:bg-red-100 transition-all"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
            lucide.createIcons();
        } catch (err) { console.error(err); }
    },
    // Combined form for Discounts (Category or Product specific)
    async openDiscountModal(d = null) {
        // Pre-fetch related targets for dropdown selection
        const [prodRes, catRes] = await Promise.all([api.get('/products'), api.get('/categories')]);
        const products = prodRes.data;
        const categories = catRes.data;

        ui.showModal(d ? "Edit Campaign" : "New Campaign", `
            <div class="space-y-4">
                <div class="space-y-1.5">
                    <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Campaign Name</label>
                    <input type="text" id="d-name" value="${d?.name || ''}" class="w-full h-11 px-4 bg-zinc-50 border border-zinc-100 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5 font-bold" placeholder="e.g., Summer Sale">
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Type</label>
                        <select id="d-type" class="w-full h-11 px-4 bg-zinc-50 border border-zinc-100 rounded-xl outline-none font-bold">
                            <option value="percentage" ${d?.type === 'percentage' ? 'selected' : ''}>Percentage (%)</option>
                            <option value="fixed" ${d?.type === 'fixed' ? 'selected' : ''}>Fixed Amount (₱)</option>
                        </select>
                    </div>
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Value</label>
                        <input type="number" id="d-value" value="${d?.value || ''}" class="w-full h-11 px-4 bg-zinc-50 border border-zinc-100 rounded-xl outline-none font-bold">
                    </div>
                </div>
                <!-- Logic for targeting specific segments -->
                <div class="grid grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Target Scope</label>
                        <select id="d-target-type" class="w-full h-11 px-4 bg-zinc-50 border border-zinc-100 rounded-xl outline-none font-bold" onchange="document.getElementById('target-selector-container').style.display = this.value === 'all' ? 'none' : 'block';">
                            <option value="all" ${d?.target_type === 'all' ? 'selected' : ''}>Store-wide</option>
                            <option value="category" ${d?.target_type === 'category' ? 'selected' : ''}>Specific Category</option>
                            <option value="product" ${d?.target_type === 'product' ? 'selected' : ''}>Specific Product</option>
                        </select>
                    </div>
                    <div class="space-y-1.5" id="target-selector-container" style="display: ${d?.target_type === 'all' ? 'none' : 'block'}">
                        <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Target Item</label>
                        <select id="d-target-id" class="w-full h-11 px-4 bg-zinc-50 border border-zinc-100 rounded-xl outline-none font-bold">
                            <optgroup label="Categories">
                                ${categories.map(c => `<option value="${c.id}" ${d?.target_type === 'category' && d.target_id === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
                            </optgroup>
                            <optgroup label="Products">
                                ${products.map(p => `<option value="${p.id}" ${d?.target_type === 'product' && d.target_id === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
                            </optgroup>
                        </select>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Start Date</label>
                        <input type="date" id="d-start-date" value="${d?.start_date ? d.start_date.split('T')[0] : ''}" class="w-full h-11 px-4 bg-zinc-50 border border-zinc-100 rounded-xl font-bold">
                    </div>
                    <div class="space-y-1.5">
                        <label class="text-[10px] font-black text-zinc-400 uppercase tracking-widest">End Date</label>
                        <input type="date" id="d-end-date" value="${d?.end_date ? d.end_date.split('T')[0] : ''}" class="w-full h-11 px-4 bg-zinc-50 border border-zinc-100 rounded-xl font-bold">
                    </div>
                </div>
                <div class="flex items-center gap-3 p-4 bg-zinc-50 rounded-2xl border border-zinc-100">
                    <input type="checkbox" id="d-is-active" ${d?.is_active !== 0 ? 'checked' : ''} class="w-5 h-5 rounded-lg border-zinc-300 text-zinc-900 focus:ring-zinc-900">
                    <label for="d-is-active" class="text-sm font-bold text-zinc-700">Campaign is currently active</label>
                </div>
            </div>
        `, async () => {
            const data = {
                name: document.getElementById('d-name').value.trim(),
                type: document.getElementById('d-type').value,
                value: parseFloat(document.getElementById('d-value').value) || 0,
                target_type: document.getElementById('d-target-type').value,
                target_id: document.getElementById('d-target-type').value === 'all' ? null : parseInt(document.getElementById('d-target-id').value),
                start_date: document.getElementById('d-start-date').value,
                end_date: document.getElementById('d-end-date').value,
                is_active: document.getElementById('d-is-active').checked ? 1 : 0
            };

            if (!data.name) throw new Error("Campaign name is required");
            if (data.value <= 0) throw new Error("Discount value must be greater than 0");
            if (data.target_type !== 'all' && isNaN(data.target_id)) throw new Error("Please select a target for this discount");

            if (d) {
                await api.put(`/discounts/${d.id}`, data);
            } else {
                await api.post('/discounts', data);
            }
            this.renderDiscounts();
        });
    },
    // Universal deletion handler with confirmation and endpoint routing
    async handleDelete(type, id) {
        ui.confirm(`Delete ${(type || 'Item').replace('-', ' ').charAt(0).toUpperCase() + (type || '').replace('-', '').slice(1)}`, `Are you sure you want to permanently remove this ${type.replace('-', ' ')}? This action cannot be undone.`, async () => {
            try {
                let endpoint = '';
                switch (type) {
                    case 'product': endpoint = '/products'; break;
                    case 'category': endpoint = '/categories'; break;
                    case 'user': endpoint = '/users'; break;
                    case 'discount': endpoint = '/discounts'; break;
                }
                
                await api.delete(`${endpoint}/${id}`);
                
                // Refresh only the affected screen context
                if (type === 'product') this.renderInventory();
                if (type === 'category') this.renderCategories();
                if (type === 'user') this.renderUsers();
                if (type === 'discount') this.renderDiscounts();
                
                ui.notify(`${(type || 'Item').replace('-', ' ').charAt(0).toUpperCase() + (type || '').replace('-', ' ').slice(1)} deleted successfully`);
            } catch (err) {
                ui.notify(err.response?.data?.error || "Delete failed", 'error');
            }
        });
    },
    // Renders the Analytics dashboard with charts and sales history
    async renderReports() {
        const root = document.getElementById('screen-content');
        root.innerHTML = '<div class="p-10 text-center text-zinc-400 animate-pulse">Generating analytical data...</div>';
        try {
            // Simultaneous fetch for sales logs and processed analytics
            const [salesRes, analyticsRes] = await Promise.all([
                api.get('/sales'),
                api.get('/reports/analytics')
            ]);
            
            const sales = salesRes.data;
            const analytics = analyticsRes.data;
            state.reportsData = { sales, analytics };
            
            // Empty state handler - check if we have any meaningful data
            if (!analytics || !analytics.topProducts || !analytics.monthlyTrends || (analytics.monthlyTrends.length === 0 && analytics.topProducts.length === 0)) {
                root.innerHTML = `
                    <div class="flex flex-col items-center justify-center p-20 text-center space-y-4">
                        <div class="w-20 h-20 bg-zinc-100 rounded-full flex items-center justify-center text-zinc-300">
                             <i data-lucide="bar-chart-2" class="w-10 h-10"></i>
                        </div>
                        <h2 class="text-xl font-bold text-zinc-900">No Analytics Data Yet</h2>
                        <p class="text-zinc-500 max-w-sm">Start making sales to see your store's performance metrics and monthly trends.</p>
                        <button onclick="router.navigate('pos')" class="px-6 py-2 bg-zinc-900 text-white rounded-xl font-bold hover:bg-zinc-800 transition-all">Go to Terminal</button>
                    </div>
                `;
                lucide.createIcons();
                return;
            }

            root.innerHTML = `
                <div class="space-y-8 pb-12">
                    <!-- Dashboard Header -->
                    <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                        <div>
                            <h2 class="text-2xl font-black tracking-tight text-zinc-900">Performance Analytics</h2>
                            <p class="text-zinc-500 text-sm">Real-time breakdown of your store's sales and trends.</p>
                        </div>
                        <div class="flex gap-2 w-full md:w-auto">
                            <button onclick="screens.exportReportsPDF()" class="flex-1 md:flex-none px-4 py-2.5 bg-white border border-zinc-200 rounded-xl text-sm font-bold hover:bg-zinc-50 transition-colors flex items-center justify-center gap-2">
                                <i data-lucide="download" class="w-4 h-4"></i> Export PDF
                            </button>
                            <button onclick="screens.exportReportsCSV()" class="flex-1 md:flex-none px-4 py-2.5 bg-zinc-900 text-white rounded-xl text-sm font-bold hover:bg-zinc-800 transition-all flex items-center justify-center gap-2">
                                <i data-lucide="file-spreadsheet" class="w-4 h-4"></i> Export CSV
                            </button>
                        </div>
                    </div>

                    <!-- Visual Charts Section -->
                    <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
                        <!-- Revenue Trend Card -->
                        <div class="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm">
                            <div class="flex items-center justify-between mb-6">
                                <h3 class="font-bold text-zinc-900 flex items-center gap-2">
                                    <span class="w-2 h-6 bg-zinc-900 rounded-full"></span> Monthly Sales Trend
                                </h3>
                                <span class="text-[10px] font-black px-2 py-1 bg-zinc-100 rounded-lg text-zinc-500 uppercase tracking-widest">Last 6 Months</span>
                            </div>
                            <div class="h-[300px]">
                                <canvas id="chart-monthly-trends"></canvas>
                            </div>
                        </div>

                        <!-- Categorization Card -->
                        <div class="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm">
                            <div class="flex items-center justify-between mb-6">
                                <h3 class="font-bold text-zinc-900 flex items-center gap-2">
                                    <span class="w-2 h-6 bg-indigo-500 rounded-full"></span> Sales by Category
                                </h3>
                                <i data-lucide="pie-chart" class="w-4 h-4 text-zinc-400"></i>
                            </div>
                            <div class="h-[300px] flex items-center justify-center">
                                <canvas id="chart-category-sales"></canvas>
                            </div>
                        </div>

                        <!-- Top Items Card -->
                        <div class="bg-white p-6 rounded-3xl border border-zinc-200 shadow-sm xl:col-span-2">
                            <div class="flex items-center justify-between mb-6">
                                <h3 class="font-bold text-zinc-900 flex items-center gap-2">
                                    <span class="w-2 h-6 bg-emerald-500 rounded-full"></span> Top 10 Selling Products
                                </h3>
                            </div>
                            <div class="h-[400px]">
                                <canvas id="chart-top-products"></canvas>
                            </div>
                        </div>
                    </div>

                    <!-- Tabular Sales History -->
                    <div class="space-y-4">
                        <h3 class="font-bold text-zinc-900 px-2 text-lg">Detailed Sales History</h3>
                        <div class="bg-white rounded-3xl border border-zinc-200 shadow-sm overflow-hidden">
                            <div class="overflow-x-auto no-scrollbar">
                                <table class="w-full text-left">
                                    <thead class="bg-zinc-50 border-b border-zinc-100">
                                        <tr>
                                            <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Order ID</th>
                                            <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Date/Time</th>
                                            <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest">Transaction By</th>
                                            <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest text-right">Net Amount</th>
                                            <th class="px-6 py-4 text-[10px] font-black text-zinc-400 uppercase tracking-widest text-center">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody class="divide-y divide-zinc-50">
                                        ${(sales || []).map(s => `
                                            <tr class="hover:bg-zinc-50/50 transition-colors group">
                                                <td class="px-6 py-4 font-bold text-zinc-900">#${s.id}</td>
                                                <td class="px-6 py-4 text-zinc-500 text-sm font-medium">${new Date(s.created_at).toLocaleString()}</td>
                                                <td class="px-6 py-4">
                                                    <div class="flex items-center gap-2">
                                                        <div class="w-6 h-6 rounded-full bg-zinc-100 flex items-center justify-center text-[10px] font-black text-zinc-500 border border-zinc-200">${(s.user_name || 'System').charAt(0)}</div>
                                                        <span class="font-bold text-zinc-700 text-sm">${s.user_name || 'System'}</span>
                                                    </div>
                                                </td>
                                                <td class="px-6 py-4 font-black text-zinc-900 text-right">₱${Number(s.total_amount).toFixed(2)}</td>
                                                <td class="px-6 py-4 text-center">
                                                    <button onclick="screens.viewReceipt(${s.id})" class="h-9 px-4 bg-zinc-100 group-hover:bg-zinc-900 group-hover:text-white rounded-xl text-xs font-bold transition-all flex items-center gap-2 mx-auto">
                                                        <i data-lucide="eye" class="w-3.5 h-3.5"></i> View Detail
                                                    </button>
                                                </td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            this.initAnalyticsCharts(analytics);
            lucide.createIcons();
        } catch (err) { 
            ui.handleError(err, "Analytics failed");
            root.innerHTML = `<div class="p-10 text-center text-red-500 font-bold bg-red-50 rounded-2xl border border-red-100 mx-6">ERROR: Failed to load analytics. ${err.message}</div>`;
        }
    },

    initAnalyticsCharts(data) {
        if (!data) return;
        // Shared configuration
        const fontConfig = { family: "'Inter', sans-serif", weight: '700' };

        // Monthly Trends
        const trendEl = document.getElementById('chart-monthly-trends');
        if (trendEl && data.monthlyTrends) {
            new Chart(trendEl, {
                type: 'line',
                data: {
                    labels: data.monthlyTrends.map(m => m.month),
                    datasets: [{
                        label: 'Revenue',
                        data: data.monthlyTrends.map(m => m.total),
                        borderColor: '#18181b',
                        backgroundColor: 'rgba(24, 24, 27, 0.05)',
                        fill: true,
                        tension: 0.4,
                        borderWidth: 3,
                        pointBackgroundColor: '#fff',
                        pointBorderColor: '#18181b',
                        pointBorderWidth: 2,
                        pointRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, grid: { color: '#f4f4f5' }, ticks: { font: fontConfig } },
                        x: { grid: { display: false }, ticks: { font: fontConfig } }
                    }
                }
            });
        }

        // Sales By Category
        const catEl = document.getElementById('chart-category-sales');
        if (catEl && data.salesByCategory) {
            new Chart(catEl, {
                type: 'doughnut',
                data: {
                    labels: data.salesByCategory.map(c => c.name),
                    datasets: [{
                        data: data.salesByCategory.map(c => c.total),
                        backgroundColor: ['#18181b', '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#ec4899'],
                        borderWidth: 4,
                        borderColor: '#ffffff',
                        hoverOffset: 15
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom', labels: { font: fontConfig, padding: 20, usePointStyle: true } }
                    },
                    cutout: '70%'
                }
            });
        }

        // Top Products
        const prodEl = document.getElementById('chart-top-products');
        if (prodEl && data.topProducts) {
            new Chart(prodEl, {
                type: 'bar',
                data: {
                    labels: data.topProducts.map(p => p.name),
                    datasets: [{
                        label: 'Quantity Sold',
                        data: data.topProducts.map(p => p.total_qty),
                        backgroundColor: '#10b981',
                        borderRadius: 12,
                        barThickness: 32
                    }, {
                        label: 'Revenue (₱)',
                        data: data.topProducts.map(p => p.total_revenue / 10), // Scaled for combined view
                        backgroundColor: '#18181b',
                        borderRadius: 12,
                        barThickness: 32
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'top', labels: { font: fontConfig } }
                    },
                    scales: {
                        y: { beginAtZero: true, grid: { color: '#f4f4f5' }, ticks: { font: fontConfig } },
                        x: { grid: { display: false }, ticks: { font: fontConfig } }
                    }
                }
            });
        }
    },
    // Generates a CSV file from the sales data stored in state
    // Generates a formal inventory asset report in PDF format
    exportInventoryPDF() {
        try {
            if (!state.products || state.products.length === 0) {
                ui.notify("No inventory products to export", "error");
                return;
            }

            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();
            const storeName = state.user?.store_name || "LORNA'S STORE";

            // Header styling
            doc.setFillColor(31, 41, 55);
            doc.rect(0, 0, 210, 35, 'F');
            doc.setTextColor(255);
            doc.setFontSize(22);
            doc.text(storeName, 14, 18);
            doc.setFontSize(10);
            doc.text("INVENTORY STATUS & ASSET REPORT", 14, 28);
            doc.text(`As of: ${new Date().toLocaleString()}`, 140, 28);

            // Summary Table
            const totalStock = state.products.reduce((sum, p) => sum + Number(p.stock_quantity || 0), 0);
            const totalAssetCostValue = state.products.reduce((sum, p) => sum + (Number(p.cost_price || 0) * Number(p.stock_quantity || 0)), 0);
            const lowStockCount = state.products.filter(p => Number(p.stock_quantity || 0) <= Number(p.min_stock_level || 10)).length;

            const formatMoney = (val) => `PHP ${Number(val).toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,')}`;

            doc.autoTable({
                startY: 45,
                head: [["Total SKU", "Total Stock Qty", "Low Stock Alert", "Total Inventory Val"]],
                body: [[
                    state.products.length.toString(),
                    totalStock.toString(),
                    lowStockCount.toString(),
                    formatMoney(totalAssetCostValue)
                ]],
                theme: 'plain',
                styles: { fontSize: 10, halign: 'center', fontStyle: 'bold' }
            });

            // Detailed Product List
            const productBody = state.products.map(p => [
                p.barcode,
                p.name,
                formatMoney(p.cost_price || 0),
                p.stock_quantity.toString(),
                p.expiration_date ? new Date(p.expiration_date).toLocaleDateString() : 'N/A',
                formatMoney(Number(p.cost_price || 0) * Number(p.stock_quantity || 0))
            ]);

            doc.autoTable({
                startY: doc.lastAutoTable.finalY + 15,
                head: [["Barcode", "Item Name", "Cost", "Stock", "Expiry", "Total Val"]],
                body: productBody,
                theme: 'striped',
                headStyles: { fillColor: [31, 41, 55], textColor: 255 },
                styles: { fontSize: 8 },
                columnStyles: {
                    0: { cellWidth: 30 },
                    1: { cellWidth: 'auto' },
                    2: { halign: 'right' },
                    3: { halign: 'center' },
                    4: { halign: 'center' },
                    5: { halign: 'right' }
                },
                didDrawCell: (data) => {
                    // Highlight low stock or expired in red
                    const now = new Date();
                    
                    // Stock check
                    if (data.column.index === 3 && parseInt(data.cell.text) <= 10) {
                        doc.setTextColor(220, 38, 38);
                        doc.setFont('helvetica', 'bold');
                    } 
                    // Expiry check
                    else if (data.column.index === 4 && data.cell.text !== 'N/A') {
                        const expiry = new Date(data.cell.text);
                        if (expiry <= now) {
                            doc.setTextColor(220, 38, 38);
                            doc.setFont('helvetica', 'bold');
                        }
                    } else {
                        doc.setTextColor(0);
                        doc.setFont('helvetica', 'normal');
                    }
                }
            });

            doc.save(`Inventory_Report_${new Date().toISOString().split('T')[0]}.pdf`);
            ui.notify("Inventory PDF generated successfully");

        } catch (error) {
            console.error("Inventory PDF Error:", error);
            ui.notify("Inventory export failed", "error");
        }
    },
    async exportReportsCSV() {
        if (!state.reportsData || !state.reportsData.sales) {
            ui.notify("No data available to export", "error");
            return;
        }
        
        const sales = state.reportsData.sales;
        // Define CSV headers with localized currency column
        let csvContent = "Order ID,Date,Cashier,Net Amount,Payment Method\n";
        
        sales.forEach(s => {
            const row = [
                s.id,
                new Date(s.created_at).toLocaleString().replace(/,/g, ''),
                s.user_name,
                Number(s.total_amount).toFixed(2),
                s.payment_method
            ].join(",");
            csvContent += row + "\n";
        });
        
        // Creating a blob and triggering an automatic browser download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `Sales_Report_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },
    // Triggers a professional PDF export using jsPDF and autoTable
    exportReportsPDF() {
        try {
            if (!state.reportsData || !state.reportsData.analytics) {
                ui.notify("No analytics data available to export", "error");
                return;
            }

            const { sales, analytics } = state.reportsData;
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF();
            
            const storeName = state.user?.store_name || "LORNA'S STORE";
            const dateStr = new Date().toLocaleDateString('en-PH', { 
                year: 'numeric', month: 'long', day: 'numeric', 
                hour: '2-digit', minute: '2-digit' 
            });

            // --- PDF HEADER ---
            doc.setFillColor(31, 41, 55); // Dark zinc-900 equivalent
            doc.rect(0, 0, 210, 40, 'F');
            
            doc.setTextColor(255, 255, 255);
            doc.setFontSize(24);
            doc.setFont("helvetica", "bold");
            doc.text(storeName, 14, 20);
            
            doc.setFontSize(10);
            doc.setFont("helvetica", "normal");
            doc.text("BUSINESS PERFORMANCE REPORT", 14, 30);
            doc.text(`Generated: ${dateStr}`, 140, 30);

            // --- SUMMARY CARDS SECTION ---
            doc.setTextColor(31, 41, 55);
            doc.setFontSize(14);
            doc.setFont("helvetica", "bold");
            doc.text("Executive Summary", 14, 55);

            const summaryData = [
                ["Metric", "Value"],
                ["Total Sales Record", sales.length.toString()],
                ["Total Revenue", `PHP ${sales.reduce((sum, s) => sum + Number(s.total_amount || 0), 0).toLocaleString(undefined, {minimumFractionDigits: 2})}`],
                ["Top Product", analytics.topProducts && analytics.topProducts.length > 0 ? analytics.topProducts[0].name : "N/A"],
                ["Active Campaigns", state.discounts.filter(d => d.is_active).length.toString()]
            ];

            doc.autoTable({
                startY: 60,
                head: [summaryData[0]],
                body: summaryData.slice(1),
                theme: 'striped',
                headStyles: { fillColor: [52, 58, 64], fontStyle: 'bold' },
                styles: { fontSize: 10, cellPadding: 4 }
            });

            // --- TOP SELLING PRODUCTS TABLE ---
            doc.setFontSize(14);
            doc.text("Top 10 Selling Products", 14, doc.lastAutoTable.finalY + 15);

            const topProductsBody = (analytics.topProducts || []).map((p, index) => [
                `#${index + 1}`,
                p.name,
                p.category_name || "Uncategorized",
                p.total_qty.toString(),
                `PHP ${(p.total_revenue || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}`
            ]);

            doc.autoTable({
                startY: doc.lastAutoTable.finalY + 20,
                head: [["Rank", "Product Name", "Category", "Qty Sold", "Revenue Generated"]],
                body: topProductsBody,
                theme: 'grid',
                headStyles: { fillColor: [16, 185, 129], textColor: 255 }, // emerald-500
                styles: { fontSize: 9 }
            });

            // --- RECENT SALES HISTORY ---
            doc.addPage();
            doc.setFontSize(16);
            doc.text("Full Transaction History", 14, 20);

            const salesBody = (sales || []).map(s => [
                `#${s.id}`,
                new Date(s.created_at).toLocaleString(),
                s.user_name || "System",
                s.payment_method.toUpperCase(),
                `PHP ${Number(s.total_amount).toFixed(2)}`
            ]);

            doc.autoTable({
                startY: 25,
                head: [["Order ID", "Date/Time", "Cashier", "Method", "Amount"]],
                body: salesBody,
                theme: 'striped',
                headStyles: { fillColor: [31, 41, 55], textColor: 255 },
                styles: { fontSize: 8 }
            });

            // --- FOOTER ---
            const pageCount = doc.internal.getNumberOfPages();
            for (let i = 1; i <= pageCount; i++) {
                doc.setPage(i);
                doc.setFontSize(8);
                doc.setTextColor(150);
                doc.text(`Page ${i} of ${pageCount} - Confidential Financial Report - ${storeName}`, 14, 285);
            }

            doc.save(`Performance_Report_${new Date().toISOString().split('T')[0]}.pdf`);
            ui.notify("PDF Report generated successfully!");

        } catch (error) {
            console.error("PDF Export Error:", error);
            ui.notify("Failed to generate PDF: " + error.message, "error");
        }
    },
    // Generates a professional thermal-style PDF for a single receipt
    exportReceiptPDF(sale) {
        try {
            const { jsPDF } = window.jspdf;
            // POS-style narrow paper (80mm width)
            const doc = new jsPDF({
                unit: 'mm',
                format: [80, 200]
            });

            const margin = 5;
            let currentY = 10;
            const pageWidth = 80;
            const contentWidth = pageWidth - (margin * 2);

            // Center align helper
            const centerText = (text, y, size = 10, style = 'normal') => {
                doc.setFontSize(size);
                doc.setFont('helvetica', style);
                const textWidth = doc.getTextWidth(text);
                const x = (pageWidth - textWidth) / 2;
                doc.text(text, x, y);
            };

            // Header
            centerText(sale.store_name || "LORNA'S STORE", currentY, 14, 'bold');
            currentY += 6;
            centerText(sale.store_address || "Default Address", currentY, 7);
            currentY += 4;
            centerText(`Contact: ${sale.store_phone || "N/A"}`, currentY, 7);
            currentY += 8;

            // Separator
            doc.setLineDash([1, 1]);
            doc.line(margin, currentY, pageWidth - margin, currentY);
            doc.setLineDash([]);
            currentY += 6;

            // Details
            doc.setFontSize(8);
            doc.setFont('helvetica', 'normal');
            doc.text(`Receipt #: ${sale.id}`, margin, currentY);
            currentY += 4;
            doc.text(`Date: ${new Date(sale.created_at).toLocaleString()}`, margin, currentY);
            currentY += 4;
            doc.text(`Cashier: ${sale.user_name || 'System'}`, margin, currentY);
            currentY += 8;

            // Items Header
            doc.setFont('helvetica', 'bold');
            doc.text("ITEM", margin, currentY);
            doc.text("QTY", margin + 45, currentY);
            doc.text("PRICE", pageWidth - margin, currentY, { align: 'right' });
            currentY += 4;
            doc.line(margin, currentY, pageWidth - margin, currentY);
            currentY += 6;

            // Items
            doc.setFont('helvetica', 'normal');
            (sale.items || []).forEach(item => {
                const name = item.name || 'Unknown';
                const qty = item.quantity.toString();
                const price = `PHP ${(Number(item.unit_price || 0) * Number(item.quantity || 0)).toFixed(2)}`;
                
                // Truncate name if too long
                const truncatedName = name.length > 20 ? name.substring(0, 17) + "..." : name;
                
                doc.text(truncatedName, margin, currentY);
                doc.text(qty, margin + 45, currentY);
                doc.text(price, pageWidth - margin, currentY, { align: 'right' });
                currentY += 5;
            });

            currentY += 3;
            doc.line(margin, currentY, pageWidth - margin, currentY);
            currentY += 6;

            // Totals
            doc.setFontSize(9);
            const subtotal = Number(sale.total_amount || 0) + Number(sale.discount_amount || 0);
            doc.text("Subtotal:", margin, currentY);
            doc.text(`PHP ${subtotal.toFixed(2)}`, pageWidth - margin, currentY, { align: 'right' });
            currentY += 5;

            if (sale.discount_amount > 0) {
                doc.setFont('helvetica', 'bold');
                doc.setTextColor(16, 185, 129);
                doc.text("Discount:", margin, currentY);
                doc.text(`-PHP ${Number(sale.discount_amount).toFixed(2)}`, pageWidth - margin, currentY, { align: 'right' });
                doc.setTextColor(0);
                currentY += 5;
            }

            doc.setFontSize(12);
            doc.setFont('helvetica', 'bold');
            doc.text("TOTAL:", margin, currentY);
            doc.text(`PHP ${Number(sale.total_amount).toFixed(2)}`, pageWidth - margin, currentY, { align: 'right' });
            currentY += 8;

            // Payment Detail
            doc.setFontSize(8);
            doc.setFont('helvetica', 'normal');
            doc.text(`Payment: ${sale.payment_method?.toUpperCase() || 'N/A'}`, margin, currentY);
            currentY += 4;
            if (sale.payment_method === 'cash') {
                doc.text(`Tendered: PHP ${Number(sale.cash_received || 0).toFixed(2)}`, margin, currentY);
                currentY += 4;
                doc.text(`Change: PHP ${Number(sale.change_given || 0).toFixed(2)}`, margin, currentY);
                currentY += 8;
            }

            // Footer
            centerText("Thank you for your purchase!", currentY, 9, 'bold');
            currentY += 5;
            centerText("Please come again!", currentY, 8);

            doc.save(`Receipt_${sale.id}.pdf`);
            ui.notify("Receipt downloaded as PDF");

        } catch (error) {
            console.error("Receipt PDF Error:", error);
            ui.notify("PDF Generation failed", "error");
        }
    },
    // Fetches and displays the itemized receipt for a historical sale
    async viewReceipt(id) {
        try {
            const res = await api.get(`/sales/${id}`);
            const sale = res.data;
            
            // Standardizing date and data arrays for the view
            const dateStr = new Date(sale.created_at).toLocaleString();
            const items = sale.items || [];
            
            ui.showModal("Invoice Details", `
                <!-- Receipt Mirror Structure -->
                <div id="receipt-print-area" class="bg-white p-6 md:p-8 font-mono text-xs text-zinc-800 space-y-4">
                    <div class="text-center space-y-1">
                        <h2 class="text-xl font-black uppercase text-zinc-900">${sale.store_name || "LORNA'S STORE"}</h2>
                        <p class="text-[10px] text-zinc-500">${sale.store_address || "Default Address"}</p>
                        <p class="text-[10px] text-zinc-500">Contact: ${sale.store_phone || "N/A"}</p>
                    </div>
                    
                    <!-- Metadata block -->
                    <div class="border-y border-dashed border-zinc-200 py-3 space-y-1">
                        <div class="flex justify-between text-[10px]"><span>Receipt #:</span> <span class="font-bold">${sale.id}</span></div>
                        <div class="flex justify-between text-[10px]"><span>Date/Time:</span> <span>${dateStr}</span></div>
                        <div class="flex justify-between text-[10px]"><span>Cashier:</span> <span>${sale.user_name || 'System'}</span></div>
                    </div>

                    <!-- Line Items Table -->
                    <div class="space-y-2">
                        <div class="flex justify-between font-bold text-[10px] uppercase border-b border-zinc-100 pb-1 text-zinc-400">
                            <span class="w-1/2">Item</span>
                            <span class="w-1/4 text-center">Qty</span>
                            <span class="w-1/4 text-right">Price</span>
                        </div>
                        ${items.map(item => `
                            <div class="flex justify-between text-[11px] leading-tight">
                                <span class="w-1/2 truncate font-medium text-zinc-900">${item.name || 'Unknown Item'}</span>
                                <span class="w-1/4 text-center">${item.quantity}</span>
                                <span class="w-1/4 text-right">₱${(item.unit_price * item.quantity).toFixed(2)}</span>
                            </div>
                        `).join('')}
                    </div>

                    <!-- Financial Breakdown -->
                    <div class="border-t border-dashed border-zinc-200 pt-3 space-y-1 text-zinc-600">
                        <div class="flex justify-between text-[11px]"><span>Subtotal:</span> <span>₱${(Number(sale.total_amount) + Number(sale.discount_amount)).toFixed(2)}</span></div>
                        ${sale.discount_amount > 0 ? `<div class="flex justify-between text-[11px] text-emerald-600 font-bold"><span>Total Discount:</span> <span>-₱${Number(sale.discount_amount).toFixed(2)}</span></div>` : ''}
                        <div class="flex justify-between text-lg font-black pt-2 uppercase text-zinc-900"><span>Grand Total:</span> <span class="text-zinc-900">₱${Number(sale.total_amount).toFixed(2)}</span></div>
                    </div>

                    <!-- Tender specifics -->
                    <div class="pt-2 text-[10px] space-y-1">
                        <div class="flex justify-between uppercase"><span>Payment Method:</span> <span class="font-bold text-zinc-900">${(sale.payment_method || 'N/A').toUpperCase()}</span></div>
                        ${sale.payment_method === 'cash' ? `
                            <div class="flex justify-between"><span>Cash Tendered:</span> <span>₱${Number(sale.cash_received || 0).toFixed(2)}</span></div>
                            <div class="flex justify-between"><span>Change:</span> <span class="font-bold text-emerald-600">₱${Number(sale.change_given || 0).toFixed(2)}</span></div>
                        ` : ''}
                    </div>

                    <div class="text-center pt-6 space-y-2 border-t border-zinc-100 mt-4">
                        <div class="flex justify-center mb-2">
                            <img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=pos-receipt-${sale.id}" class="w-20 h-20 border border-zinc-100 p-1 rounded-lg">
                        </div>
                        <p class="text-[10px] font-black uppercase text-zinc-900">Thank you for your purchase!</p>
                        <p class="text-[10px] text-zinc-400 italic font-medium">This is an automated system generated receipt.</p>
                        <p class="text-[8px] text-zinc-300 pt-2 border-t border-zinc-100">Printed: ${new Date().toLocaleString()}</p>
                    </div>
                </div>
                <div class="flex gap-2 mt-4">
                    <button onclick='screens.exportReceiptPDF(${JSON.stringify(sale).replace(/'/g, "&apos;")})' class="flex-1 h-11 bg-white border border-zinc-200 rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-zinc-50 transition-all">
                        <i data-lucide="download" class="w-4 h-4"></i> Download PDF
                    </button>
                </div>
            `, () => {
                this.printReceipt();
            }, "Print Receipt", "max-w-md");
            
            // Customize the primary modal button to show a print icon
            const saveBtn = document.getElementById('modal-save');
            if (saveBtn) {
                saveBtn.innerHTML = '<i data-lucide="printer" class="w-4 h-4"></i> Print Receipt';
                lucide.createIcons();
            }
        } catch (err) { 
            ui.notify(err.message, 'error'); 
        }
    },
    // Renders the administrative settings panel
    async renderSettings() {
        const root = document.getElementById('screen-content');
        root.innerHTML = '<div class="p-10 text-center text-zinc-400 animate-pulse">Loading system settings...</div>';
        try {
            const setRes = await api.get('/settings');
            const settings = setRes.data;
            
            root.innerHTML = `
                <div class="max-w-2xl space-y-8 pb-20">
                    <div class="space-y-1">
                        <h2 class="text-2xl font-bold tracking-tight text-zinc-900">System Settings</h2>
                        <p class="text-sm text-zinc-500">Manage your store preferences and localized configurations.</p>
                    </div>
                    
                    <div class="space-y-6">
                        <!-- Store Layout Settings -->
                        <div class="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-4">
                            <h3 class="font-bold text-zinc-900 flex items-center gap-2"><i data-lucide="store" class="w-5 h-5"></i> Store Identity</h3>
                            <div class="space-y-4">
                                <div class="space-y-1.5">
                                    <label class="text-xs font-bold text-zinc-500 uppercase">Display Name</label>
                                    <input type="text" id="set-store-name" value="${settings.store_name || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5">
                                </div>
                                <div class="space-y-1.5">
                                    <label class="text-xs font-bold text-zinc-500 uppercase">Store Address</label>
                                    <textarea id="set-store-address" class="w-full min-h-[80px] p-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5 text-sm" placeholder="123 Store St, City, Country">${settings.store_address || ''}</textarea>
                                </div>
                                <div class="space-y-1.5">
                                    <label class="text-xs font-bold text-zinc-500 uppercase">Contact Number</label>
                                    <input type="text" id="set-store-phone" value="${settings.store_phone || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5" placeholder="09XX XXX XXXX" maxlength="11">
                                </div>
                            </div>
                        </div>

                        <!-- Payment configuration (GCash specifics) -->
                        <div class="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-4">
                            <h3 class="font-bold text-zinc-900 flex items-center gap-2"><i data-lucide="smartphone" class="w-5 h-5"></i> Digital Payments (GCash)</h3>
                            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div class="space-y-1.5">
                                    <label class="text-xs font-bold text-zinc-500 uppercase">Account Name</label>
                                    <input type="text" id="set-gcash-name" value="${settings.gcash_name || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5" placeholder="LORNA'S STORE">
                                </div>
                                <div class="space-y-1.5">
                                    <label class="text-xs font-bold text-zinc-500 uppercase">Phone Number</label>
                                    <input type="text" id="set-gcash-number" value="${settings.gcash_number || ''}" class="w-full h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5" placeholder="09XX XXX XXXX" maxlength="11">
                                </div>
                            </div>
                            <div class="space-y-3 pt-2">
                                <label class="text-xs font-bold text-zinc-500 uppercase">Custom QR Code Image URL</label>
                                <div class="flex gap-2">
                                    <input type="text" id="set-gcash-qr" value="${settings.gcash_qr || ''}" class="flex-1 h-11 px-3 bg-zinc-50 border border-zinc-200 rounded-xl outline-none focus:ring-2 focus:ring-zinc-900/5" placeholder="https://... or leave empty for auto-generated">
                                    <button onclick="document.getElementById('qr-upload-input').click()" class="px-4 bg-zinc-100 rounded-xl border border-zinc-200 hover:bg-zinc-200 transition-colors">
                                        <i data-lucide="upload" class="w-4 h-4"></i>
                                    </button>
                                    <input type="file" id="qr-upload-input" class="hidden" accept="image/*" onchange="screens.handleQRCodeUpload(this)">
                                </div>
                                <p class="text-[10px] text-zinc-400 italic">If empty, the system will auto-generate a generic GCash QR code using the phone number above.</p>
                            </div>
                        </div>

                        <!-- Security policy summary -->
                        <div class="bg-white p-6 rounded-2xl border border-zinc-200 shadow-sm space-y-4">
                            <h3 class="font-bold text-zinc-900 flex items-center gap-2"><i data-lucide="shield-check" class="w-5 h-5"></i> Security</h3>
                            <p class="text-xs text-zinc-400 font-medium">Session tokens are encrypted using enterprise-grade JWT standards. Multi-factor authentication is currently managed via organizational identity providers.</p>
                        </div>

                        <!-- Control buttons based on authorization -->
                        ${state.user.role !== 'user' ? `
                            <button onclick="screens.saveSettings()" id="save-settings-btn" class="w-full h-14 bg-zinc-900 text-white font-bold rounded-xl text-lg hover:bg-zinc-800 transition-all shadow-lg shadow-zinc-900/10">Update Configurations</button>
                        ` : `
                            <div class="p-4 bg-amber-50 border border-amber-100 rounded-xl text-amber-700 text-xs font-bold text-center uppercase tracking-widest">Read-Only Mode</div>
                        `}
                    </div>
                </div>
            `;
            lucide.createIcons();
        } catch (err) { 
            ui.handleError(err, "Settings load failed");
            root.innerHTML = `<div class="p-10 text-center text-red-500 font-bold bg-red-50 rounded-2xl border border-red-100">Failed to load settings. Please check your connection.</div>`;
        }
    },
    // Persists store and GCash configurations to the backend
    async saveSettings() {
        const btn = document.getElementById('save-settings-btn');
        const storeName = document.getElementById('set-store-name').value.trim();
        const storeAddress = document.getElementById('set-store-address').value.trim();
        const storePhone = document.getElementById('set-store-phone').value.trim();
        const gcashName = document.getElementById('set-gcash-name').value.trim();
        const gcashNumber = document.getElementById('set-gcash-number').value.trim();
        const gcashQr = document.getElementById('set-gcash-qr').value.trim();
        
        if (!storeName) {
            ui.notify("Store name is required", "error");
            return;
        }

        const phoneRegex = /^09\d{9}$/;
        if (storePhone && !phoneRegex.test(storePhone)) {
            ui.notify("Store contact number must be 11 digits starting with 09", "error");
            return;
        }
        if (gcashNumber && !phoneRegex.test(gcashNumber)) {
            ui.notify("GCash number must be 11 digits starting with 09", "error");
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<span class="animate-spin inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full"></span> Saving...';
        
        try {
            await api.put('/settings/store', { 
                name: storeName, 
                address: storeAddress,
                phone: storePhone,
                gcash_name: gcashName,
                gcash_number: gcashNumber,
                gcash_qr: gcashQr
            });
            
            // Synchronize local session status so header and receipts update immediately
            state.user.store_name = storeName;
            state.user.store_address = storeAddress;
            state.user.store_phone = storePhone;
            state.user.gcash_name = gcashName;
            state.user.gcash_number = gcashNumber;
            state.user.gcash_qr = gcashQr;
            
            localStorage.setItem('user', JSON.stringify(state.user));
            auth.showMain(); // Forced UI refresh
            ui.notify("Settings updated successfully!");
        } catch (err) {
            ui.handleError(err, "Save failed");
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerText = "Update Configurations";
            }
        }
    },
    async handleQRCodeUpload(input) {
        if (!input.files || !input.files[0]) return;
        const file = input.files[0];
        
        // Simple file size check (max 5MB)
        if (file.size > 5 * 1024 * 1024) {
            ui.notify("File too large. Max 5MB", "error");
            return;
        }

        const formData = new FormData();
        formData.append('image', file);
        
        const uploadBtn = input.previousElementSibling;
        const originalHtml = uploadBtn.innerHTML;
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = '<span class="animate-spin inline-block w-4 h-4 border-2 border-zinc-300 border-t-zinc-900 rounded-full"></span>';
        
        try {
            const res = await api.post('/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' }
            });
            document.getElementById('set-gcash-qr').value = res.data.imageUrl;
            ui.notify("QR Code image uploaded");
        } catch (err) {
            ui.handleError(err, "Upload failed");
        } finally {
            uploadBtn.disabled = false;
            uploadBtn.innerHTML = originalHtml;
        }
    }
};

// --- Initialization ---
window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    ui.notify(event.reason?.message || "An unexpected error occurred", 'error');
});

document.getElementById('login-form').onsubmit = (e) => auth.login(e);
document.getElementById('logout-btn').onclick = () => auth.logout();

auth.init();
