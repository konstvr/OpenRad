// js/app.js

// --- CONFIGURATION ---
const SUPABASE_URL = 'https://lnhwazoamudessdhhvsj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_uzQs9fk-6ZTeu4RSJ3wHgw_1KMskJ9-';

// [NEW] Storage Isolation: Detect Handoff Mode
// If we receive a token via URL, use SessionStorage to avoid LocalStorage lock contention
const _urlParams = new URLSearchParams(window.location.search);
const _isHandoff = _urlParams.has('at');

const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, _isHandoff ? {
    auth: {
        storage: window.sessionStorage, // Isolate storage backend
        storageKey: 'sb-handoff-isolated', // Isolate lock names (Critical for concurrency)
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false
    }
} : {});

// Global Fallback Client (initially same as main)
window.sbRpcClient = sbClient;

const MODALITY_CODES = ["CT", "FL", "MR", "NM", "PET", "US", "XR", "DXA"];
const SUBSPECIALTY_CODES = [
    "AB", "BR", "CA", "CH", "ER", "GI", "GU", "HN", "IR", "MI",
    "MK", "NR", "OB", "OI", "OT", "PD", "QI", "RS", "VI"
];
const USE_CATEGORIES = ["Classification", "Detection", "Segmentation", "Foundation", "LLM", "Generative", "Other"];
const FULL_MAPPING = {
    "BR": "Breast", "BQ": "Biomarkers", "CA": "Cardiac Radiology", "CH": "Chest Radiology",
    "CT": "Computed Tomography", "DM": "Digital Mammography", "ED": "Education", "ER": "Emergency Radiology",
    "GI": "Gastrointestinal Radiology", "GU": "Genitourinary Radiology", "HN": "Head and Neck", "HP": "Health Policy",
    "IN": "Informatics", "IR": "Interventional", "LM": "Leadership & Management", "MI": "Molecular Imaging",
    "MK": "Musculoskeletal Radiology", "MR": "Magnetic Resonance Imaging", "NM": "Nuclear Medicine", "NR": "Neuroradiology",
    "OB": "Obstetric/Gynecologic Radiology", "OI": "Oncologic Imaging", "OT": "Other", "PD": "Pediatric Radiology",
    "PH": "Physics and Basic Science", "PR": "Professionalism", "SQ": "Quality Assurance", "RO": "Radiation Oncology",
    "RS": "Research and Statistical Methods", "US": "Ultrasound", "VA": "Vascular", "VI": "Vascular", "AB": "Abdomen", "FL": "Fluoroscopy",
    "XR": "X-ray", "DXA": "DEXA"
};

// --- SHARED STORE ---
document.addEventListener('alpine:init', () => {
    Alpine.store('auth', {
        session: null, // [NEW] Store full session for token access
        user: null,
        isAdmin: false,
        loading: true,
        modalOpen: false,
        email: '',
        password: '',
        password: '',
        userLikes: new Set(), // [NEW] Track liked model IDs
        useRawFetch: false,   // [NEW] Toggle for raw fetch fallback
        recoveredToken: null,

        async init() {
            console.log("[Auth] Store initializing...");

            // [NEW] Token Handoff: Check for tokens passed via URL (from admin.html)
            const urlParams = new URLSearchParams(window.location.search);
            const at = urlParams.get('at');
            const rt = urlParams.get('rt');

            if (at) {
                console.log("[Auth] Detected token handoff. Setting session directly...");

                try {
                    const { data, error } = await sbClient.auth.setSession({
                        access_token: at,
                        refresh_token: rt || ''
                    });

                    if (!error && data?.session) {
                        console.log("[Auth] Session restored via handoff:", data.session.user.id);
                        this.session = data.session;
                        this.user = data.session.user;

                        // Cleanup URL (Security)
                        const newUrl = window.location.pathname + "?id=" + urlParams.get('id'); // Preserve ID
                        window.history.replaceState({}, document.title, newUrl);
                    } else {
                        console.warn("[Auth] Token handoff failed:", error);
                    }
                } catch (e) {
                    console.error("[Auth] setSession Exception:", e);
                }
            }

            // If we didn't recover session from URL, try standard checks
            if (!this.user) {
                // Robust Auth Check: Handle Lock Contention (AbortError)
                let attempts = 0;
                const maxAttempts = 2;

                while (attempts < maxAttempts) {
                    try {
                        console.log(`[Auth] Attempt ${attempts + 1}: calling getSession()`);
                        const start = Date.now();

                        // [OPTIMIZATION] Race getSession against a 2s timeout to avoid waiting 10s for lock
                        // We attach a no-op catch to sessionPromise to prevent "Uncaught (in promise)" logs when it eventually fails later
                        const sessionPromise = sbClient.auth.getSession().catch(err => ({ error: err }));
                        const timeoutPromise = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error("AuthLockTimeout")), 2000)
                        );

                        const { data, error } = await Promise.race([sessionPromise, timeoutPromise]);
                        console.log(`[Auth] getSession took ${Date.now() - start}ms`);

                        if (error) throw error;
                        this.session = data?.session || null;
                        this.user = data?.session?.user || null;
                        console.log("[Auth] Session found:", this.user ? this.user.id : "No Session");
                        if (this.session) {
                            // Sync RPC client
                            window.sbRpcClient = sbClient;
                        }
                        break;
                    } catch (error) {
                        console.warn(`[Auth] Attempt ${attempts + 1} failed:`, error);
                        console.log("DEBUG ERROR:", {
                            isError: error instanceof Error,
                            name: error?.name,
                            message: error?.message,
                            stringified: String(error)
                        });

                        const errString = String(error);
                        if (errString.includes('AbortError') || errString.includes('LockManager') || errString.includes('timeout') || errString.includes('lock') || errString.includes('AuthLockTimeout')) {
                            // [MODIFIED] Ultra-Robust Fallback: Manual LocalStorage Read
                            console.log(`[Auth] Lock contention detected. Attempting manual LocalStorage recovery...`);

                            try {
                                // 1. Try to read the token directly from LocalStorage
                                // The key is 'sb-<project_ref>-auth-token'
                                const projectRef = 'lnhwazoamudessdhhvsj';
                                const key = `sb-${projectRef}-auth-token`;
                                const raw = localStorage.getItem(key);

                                if (raw) {
                                    const session = JSON.parse(raw);
                                    if (session && session.access_token && session.user) {
                                        console.log("[Auth] Manually recovered session from LocalStorage!", session.user.id);
                                        this.session = session;
                                        this.user = session.user;

                                        // 2. Headless Safe Fetch (Bypasses Lock by using raw HTTP)
                                        console.log("[Auth] Switching to Raw Fetch mode with recovered token...");

                                        this.useRawFetch = true; // Flag to use raw fetch
                                        this.recoveredToken = session.access_token;

                                        // Helper for Raw Fetch
                                        window.safeFetch = async (endpoint, options = {}) => {
                                            const url = `${SUPABASE_URL}${endpoint}`;
                                            const headers = {
                                                'apikey': SUPABASE_KEY,
                                                'Authorization': `Bearer ${session.access_token}`,
                                                'Content-Type': 'application/json',
                                                ...options.headers
                                            };

                                            console.log(`[SafeFetch] ${options.method || 'GET'} ${url}`);
                                            const res = await fetch(url, { ...options, headers });

                                            // Handle Void responses
                                            if (res.status === 204) return { data: null, error: null };

                                            // Handle JSON
                                            const isJson = res.headers.get('content-type')?.includes('application/json');
                                            if (isJson) {
                                                const json = await res.json();
                                                if (!res.ok) return { data: null, error: json };
                                                return { data: json, error: null };
                                            }

                                            if (!res.ok) return { data: null, error: { message: res.statusText } };
                                            return { data: null, error: null };
                                        };

                                        // Set loading false explicitly here if we broke the loop early? 
                                        // No, init() finishes and sets loading = false.

                                        break; // Success!

                                        break; // Success!
                                    }
                                } else {
                                    console.log("[Auth] No session found in LocalStorage manually.");
                                }
                            } catch (manualErr) {
                                console.error("[Auth] Manual recovery failed:", manualErr);
                            }

                            attempts++;
                            if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 500));
                        } else {
                            console.error("[Auth] Fatal error (not lock related):", error);
                            this.user = null;
                            break;
                        }
                    }
                }
            }

            try {
                await this.updateAdminStatus();
                if (this.user) {
                    console.log("[Auth] Fetching user likes...");
                    await this.fetchUserLikes();
                }
            } catch (err) {
                console.error("[Auth] Post-login setup failed (Non-fatal):", err);
            }

            sbClient.auth.onAuthStateChange(async (event, session) => {
                console.log(`[Auth] onAuthStateChange event: ${event}`, session?.user?.id);

                if (session) {
                    this.session = session;
                    this.user = session.user;
                    window.sbRpcClient = sbClient; // Re-sync if official client recovers
                    this.useRawFetch = false;      // Turn off fallback
                } else {
                    // Spurious SIGNED_OUT check
                    const projectRef = 'lnhwazoamudessdhhvsj';
                    const key = `sb-${projectRef}-auth-token`;
                    const raw = localStorage.getItem(key);

                    if (raw && (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION')) {
                        console.warn("[Auth] False null session detected (storage still has token). Ignoring to prevent lock-out.");
                        return; // Keep existing session (likely the raw fetched one)
                    }

                    this.session = null;
                    this.user = null;
                }

                if (event === 'SIGNED_OUT' && !this.user) {
                    console.log("[Auth] User explicitly signed out or session expired.");
                }
                await this.updateAdminStatus();
                if (this.user) await this.fetchUserLikes();
            });
            this.loading = false;
            console.log("[Auth] Init complete. Loading = false. User state:", this.user ? "Logged In" : "Logged Out");
        },

        async updateAdminStatus() {
            if (!this.user) {
                this.isAdmin = false;
                return;
            }

            try {
                let data, error;
                if (window.safeFetch && this.useRawFetch) {
                    // Manual select: /rest/v1/user_roles?select=role&id=eq.USER_ID&limit=1
                    const q = `?select=role&id=eq.${this.user.id}&limit=1`;
                    // Header Prefer: return=representation used by default? Supabase rest returns array by default.
                    const res = await window.safeFetch(`/rest/v1/user_roles${q}`, {
                        method: 'GET',
                        headers: { 'Prefer': 'return=representation' }
                    });
                    // res.data is array
                    data = (res.data && res.data.length > 0) ? res.data[0] : null;
                    error = res.error;
                } else {
                    const res = await sbClient
                        .from('user_roles')
                        .select('role')
                        .eq('id', this.user.id)
                        .maybeSingle();
                    data = res.data;
                    error = res.error;
                }

                if (error) {
                    console.warn("[Auth] Failed to update admin status, preserving current state:", error);
                    return;
                }

                const roleData = data;

                if (roleData && roleData.role === 'admin') {
                    this.isAdmin = true;
                } else {
                    this.isAdmin = false;
                }
            } catch (err) {
                console.warn("[Auth] Exception in updateAdminStatus, preserving current state:", err);
            }
        },

        // [NEW] Fetch User Likes
        async fetchUserLikes() {
            if (!this.user) {
                this.userLikes = new Set();
                return;
            }

            try {
                const clientToUse = window.sbRpcClient || sbClient;
                const { data, error } = await clientToUse
                    .from('model_likes')
                    .select('model_id')
                    .eq('user_id', this.user.id);

                if (error) {
                    console.warn("[Auth] Failed to fetch user likes, preserving current state:", error);
                    return;
                }

                if (data) {
                    this.userLikes = new Set();
                    data.forEach(row => this.userLikes.add(row.model_id));
                }
            } catch (err) {
                console.warn("[Auth] Exception in fetchUserLikes, preserving current state:", err);
            }
        },

        // [NEW] Toggle Like Action
        async toggleLike(modelId) {
            if (!this.user) {
                this.modalOpen = true; // Use existing login modal
                return false;
            }

            const isLiked = this.userLikes.has(modelId);

            // Optimistic Update
            if (isLiked) this.userLikes.delete(modelId);
            else this.userLikes.add(modelId);

            try {
                if (window.safeFetch && this.useRawFetch) {
                    if (isLiked) {
                        // DELETE /rest/v1/model_likes?user_id=eq.ID&model_id=eq.ID
                        const q = `?user_id=eq.${this.user.id}&model_id=eq.${modelId}`;
                        await window.safeFetch(`/rest/v1/model_likes${q}`, { method: 'DELETE' });
                    } else {
                        // POST /rest/v1/model_likes
                        await window.safeFetch(`/rest/v1/model_likes`, {
                            method: 'POST',
                            body: JSON.stringify({ user_id: this.user.id, model_id: modelId }),
                            headers: { 'Prefer': 'return=minimal' }
                        });
                    }
                } else {
                    if (isLiked) {
                        // Unlike
                        await sbClient.from('model_likes').delete().eq('user_id', this.user.id).eq('model_id', modelId);
                    } else {
                        // Like
                        await sbClient.from('model_likes').insert({ user_id: this.user.id, model_id: modelId });
                    }
                }
                return true;
            } catch (err) {
                console.error("Like error:", err);
                // Revert
                if (isLiked) this.userLikes.add(modelId);
                else this.userLikes.delete(modelId);
                alert("Action failed. Please try again.");
                return false;
            }
        },

        async handleAuth() {
            const { data, error } = await sbClient.auth.signInWithPassword({
                email: this.email,
                password: this.password
            });

            if (error) {
                alert("Login Failed: " + error.message);
            } else {
                this.modalOpen = false;
                this.password = '';
            }
        },

        async logout() {
            try {
                // Race the official signout against a 2s timeout
                const signOutPromise = sbClient.auth.signOut().catch(err => { throw err; });
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("SignOutTimeout")), 2000));
                await Promise.race([signOutPromise, timeoutPromise]);
            } catch (err) {
                console.warn("[Auth] Official SignOut failed or timed out. Forcing local logout.", err);
            } finally {
                // Always aggressively clear tokens locally as a fallback
                const projectRef = 'lnhwazoamudessdhhvsj';
                localStorage.removeItem(`sb-${projectRef}-auth-token`);
                this.session = null;
                this.user = null;
                this.isAdmin = false;
                window.location.href = 'index.html';
            }
        }
    });
});

// --- HELPER FUNCTIONS ---
function checkWeights(card_data) {
    if (!card_data || !card_data.Model) return false;
    const props = card_data.Model['Model properties'] || {};
    const repo = props.repository_analysis || {};
    return repo.contains_weights === 'yes' || repo.contains_weights === true;
}

function checkDemo(card_data) {
    if (!card_data || !card_data.Model) return false;
    // Check root, model root, or repository analysis
    const link = card_data.demo_link ||
        card_data.Model.demo_link ||
        (card_data.Model['Model properties']?.repository_analysis?.demo_link);

    return typeof link === 'string' && /^https?:\/\//i.test(link.trim());
}


// --- MAIN APP LOGIC ---
function dashboardApp() {
    return {
        darkMode: localStorage.getItem('theme') === 'dark',
        currentTab: 'browse',
        loading: true,
        models: [], // Current page of models
        totalModels: 0,

        // PAGINATION
        currentPage: 1,
        pageSize: 18, // Multiple of 1, 2, 3 for grid
        hasMore: true,

        // FILTERS
        searchQuery: '',
        filterVerified: false,
        filterDemo: false,
        filterWeights: false,
        filterAtlas: false,
        selectedSpecialties: [],
        selectedModalities: [],
        selectedModalities: [],
        selectedUses: [],
        sortBy: 'likes', // [NEW] Default Sort

        // Constants for UI
        codeMap: FULL_MAPPING,
        // Pre-defined lists for filter UI (Client-side static lists are better for UX than dynamic scan)
        availableModalities: MODALITY_CODES,
        availableSpecialties: SUBSPECIALTY_CODES, // Or we could use Object.keys(FULL_MAPPING) filtering out modalities
        availableUses: USE_CATEGORIES,

        // Stats Cache
        stats: null,
        statsCounts: {}, // To store filter counts if needed, or simplified

        async initApp() {
            if (this.darkMode) document.documentElement.classList.add('dark');

            // Initial Fetch
            await this.fetchModels(true);
            this.fetchStats(); // Fire and forget

            // Setup Search Debounce
            this.$watch('searchQuery', () => this.debouncedFetch());

            // Watch filters to trigger refetch
            ['filterVerified', 'filterDemo', 'filterWeights', 'filterAtlas',
                'selectedSpecialties', 'selectedModalities', 'selectedUses', 'sortBy'].forEach(prop => {
                    this.$watch(prop, () => this.fetchModels(true));
                });

            // Watch auth user change to refetch (e.g. after login/logout)
            // This fixes the issue where the list doesn't update if auth happens LATE (after timeout)
            // or if the user logs in via modal.
            let lastUserId = undefined;
            Alpine.effect(() => {
                const u = Alpine.store('auth').user; // Dependency
                const currentId = u ? u.id : null;

                if (lastUserId !== undefined && lastUserId !== currentId) {
                    // Only trigger fetch if the actual user ID changed (e.g. logged in or logged out)
                    // and wait for auth store to finish loading first to avoid race conditions
                    if (!Alpine.store('auth').loading) {
                        this.debouncedFetch();
                        this.fetchStats(); // RE-FETCH STATS AFTER AUTH CHANGES
                    }
                }
                lastUserId = currentId;
            });
        },

        debouncedFetch: Alpine.debounce(function () {
            this.fetchModels(true);
        }, 500),

        async fetchModels(reset = false) {
            // [MODIFIED] Wait for Auth to Stabilize
            // This is critical because init() might be recovering from lock timeout
            while (Alpine.store('auth').loading) {
                console.log("[FetchModels] Waiting for auth to stabilize...");
                await new Promise(r => setTimeout(r, 200));
            }

            if (this.loading && !reset) return; // Prevent parallel fetches

            this.loading = true;

            if (reset) {
                this.currentPage = 1;
                this.models = [];
                this.hasMore = true;
            }

            if (!this.hasMore && !reset) {
                this.loading = false;
                return;
            }

            try {
                // Construct Filters
                const filters = {
                    verified: this.filterVerified,
                    weights: this.filterWeights,
                    demo: this.filterDemo,
                    atlas: this.filterAtlas,
                    modalities: this.selectedModalities,
                    specialties: this.selectedSpecialties,
                    uses: this.selectedUses
                };

                // [MODIFIED] Use new RPC signature
                // Use safeFetch if main client is locked out
                let data, error;

                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    console.log("[FetchModels] Using RAW FETCH (Fallback)");
                    const res = await window.safeFetch('/rest/v1/rpc/get_model_previews', {
                        method: 'POST',
                        body: JSON.stringify({
                            p_page: this.currentPage,
                            p_page_size: this.pageSize,
                            p_search: this.searchQuery,
                            p_filters: filters,
                            p_sort: this.sortBy,
                            p_liked_by_user: null
                        })
                    });
                    data = res.data;
                    error = res.error;
                } else {
                    console.log("[FetchModels] Using MAIN client");
                    const res = await sbClient.rpc('get_model_previews', {
                        p_page: this.currentPage,
                        p_page_size: this.pageSize,
                        p_search: this.searchQuery,
                        p_filters: filters,
                        p_sort: this.sortBy,
                        p_liked_by_user: null
                    });
                    data = res.data;
                    error = res.error;
                }

                if (error) throw error;

                // Transform Data
                const newModels = data.map(row => ({
                    id: row.id,
                    created_at: row.created_at,
                    is_verified: row.is_verified,
                    likes_count: row.likes_count, // [NEW]
                    card_data: row.preview_data // Use the pre-processed JSON from RPC
                }));

                if (reset) {
                    this.models = newModels;
                    this.totalModels = data.length > 0 ? data[0].total_count : 0;
                } else {
                    // Check for duplicates before appending (Safety net)
                    const existingIds = new Set(this.models.map(m => m.id));
                    const uniqueNew = newModels.filter(m => !existingIds.has(m.id));
                    this.models = [...this.models, ...uniqueNew];
                }

                // Check if we reached the end
                if (newModels.length < this.pageSize) {
                    this.hasMore = false;
                } else {
                    this.currentPage++;
                }

            } catch (err) {
                console.error("Error fetching models:", err);
                console.error("Fetch Error Details:", {
                    name: err.name,
                    message: err.message,
                    details: err.details,
                    hint: err.hint
                });
            } finally {
                this.loading = false;
            }
        },

        async fetchStats() {
            // Wait for auth to ensure we use correct client (main or fallback)
            while (Alpine.store('auth').loading) {
                await new Promise(r => setTimeout(r, 200));
            }

            try {
                let data, error;
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    const res = await window.safeFetch('/rest/v1/rpc/get_dashboard_stats', { method: 'POST' });
                    data = res.data;
                    error = res.error;
                } else {
                    const res = await sbClient.rpc('get_dashboard_stats');
                    data = res.data;
                    error = res.error;
                }

                if (error) throw error;
                this.stats = data;

                // Only render if currently viewing the stats tab. 
                // If on browse tab, updateCharts() handles rendering when they switch.
                if (window.renderDashboardCharts && this.currentTab === 'stats') {
                    setTimeout(() => window.renderDashboardCharts(null, this.stats), 50);
                }

            } catch (err) {
                console.error("Error fetching stats:", err);
            }
        },

        // --- UI HELPERS ---
        toggleTheme() {
            this.darkMode = !this.darkMode;
            document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', this.darkMode ? 'dark' : 'light');
        },

        toggleFilter(arrayName, item) {
            const arr = this[arrayName];
            const idx = arr.indexOf(item);
            if (idx === -1) arr.push(item);
            else arr.splice(idx, 1);
            // Watcher triggers fetch
        },

        getFilterArray(name) { return this[name]; },

        resetFilters() {
            this.searchQuery = '';
            this.filterVerified = false;
            this.filterDemo = false;
            this.filterWeights = false;
            this.filterAtlas = false;
            this.selectedSpecialties = [];
            this.selectedModalities = [];
            this.selectedUses = [];
        },

        // Scroll Handler (Infinite Scroll)
        handleScroll() {
            const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 500;
            if (bottom && this.hasMore && !this.loading) {
                this.fetchModels(false);
            }
        },

        get isFiltered() {
            return this.searchQuery || this.filterVerified || this.filterDemo || this.filterWeights || this.filterAtlas ||
                this.selectedSpecialties.length || this.selectedModalities.length || this.selectedUses.length;
        },

        // --- DISPLAY HELPERS ---
        // Compatible with existing HTML which calls these
        getModalities(item) {
            return item.card_data.Model.Indexing?.Content || [];
        },

        getSpecialties(item) {
            return (item.card_data.Model.Indexing?.Content || [])
                .filter(c => !MODALITY_CODES.includes(c))
                .map(c => FULL_MAPPING[c] || c);
        },

        // Get count for filter badges (using global stats to avoid heavy query)
        getCount(val, type) {
            if (!this.stats) return 0;
            if (type === 'Modality') return this.stats.modalities?.[val] || 0;
            if (type === 'Subspecialty') return this.stats.specialties?.[val] || 0;
            if (type === 'Use Case') return this.stats.uses?.[val] || 0; // Uses might need mapping if keys differ
            return 0;
        },

        // --- NAVIGATION ---
        goToDetails(id) {
            window.open(`details.html?id=${id}`, '_blank');
        },

        updateCharts() {
            // Wait for Alpine to finish making the x-show element visible
            if (this.stats) {
                setTimeout(() => {
                    renderDashboardCharts(null, this.stats);
                }, 50);
            } else {
                this.fetchStats();
            }
        },

        // Proxy for filteredModels used in HTML (mapped to current page models)
        get filteredModels() {
            return this.models;
        },

        // Proxy for visibleModels (same)
        get visibleModels() {
            return this.models;
        }
    }
}