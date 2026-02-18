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
        userLikes: new Set(), // [NEW] Track liked model IDs

        async init() {
            console.log("[Auth] Store initializing...");

            // [NEW] Token Handoff: Check for tokens passed via URL (from admin.html)
            const urlParams = new URLSearchParams(window.location.search);
            const at = urlParams.get('at');
            const rt = urlParams.get('rt');

            if (at) {
                console.log(`[Auth] Detected token handoff. Token length: ${at.length}`);
                console.log("[Auth] Storage mode:", typeof window.sessionStorage);
                console.log("[Auth] Starting setSession...");

                try {
                    const { data, error } = await sbClient.auth.setSession({
                        access_token: at,
                        refresh_token: rt || ''
                    });

                    console.log("[Auth] setSession returned.");
                    if (error) {
                        console.error("[Auth] setSession Error:", error);
                    } else if (data && data.session) {
                        console.log("[Auth] setSession Success. User ID:", data.session.user.id);
                        this.session = data.session;
                        this.user = data.session.user;

                        // Cleanup URL (Security)
                        const newUrl = window.location.pathname + "?id=" + urlParams.get('id'); // Preserve ID
                        window.history.replaceState({}, document.title, newUrl);
                    } else {
                        console.warn("[Auth] setSession succeeded but no session data returned.", data);
                    }
                } catch (e) {
                    console.error("[Auth] setSession Exception:", e);
                }
            }

            // If we didn't recover session from URL, try standard checks
            if (!this.user) {
                // Robust Auth Check: Handle Lock Contention (AbortError)
                let attempts = 0;
                const maxAttempts = 5;

                while (attempts < maxAttempts) {
                    try {
                        console.log(`[Auth] Attempt ${attempts + 1}: calling getSession()`);
                        const { data, error } = await sbClient.auth.getSession();
                        if (error) throw error;
                        this.session = data?.session || null;
                        this.user = data?.session?.user || null;
                        console.log("[Auth] Session found:", this.user ? this.user.id : "No Session");
                        break;
                    } catch (error) {
                        console.warn(`[Auth] Attempt ${attempts + 1} failed:`, error);

                        if (error.name === 'AbortError' || error.message?.includes('AbortError')) {
                            // Jittered Backoff: 300ms, 600ms, 1200ms... + random jitter
                            const delay = (300 * Math.pow(2, attempts)) + (Math.random() * 200);
                            console.log(`[Auth] Waiting ${Math.round(delay)}ms before retry...`);

                            try {
                                const { data: userData, error: userError } = await sbClient.auth.getUser();
                                if (!userError && userData?.user) {
                                    this.user = userData.user;
                                    console.log("[Auth] Fallback recovered user:", this.user.id);
                                    break;
                                }
                            } catch (innerErr) { /* ignore */ }

                            attempts++;
                            await new Promise(r => setTimeout(r, delay));
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

            sbClient.auth.onAuthStateChange(async (_event, session) => {
                this.session = session;
                this.user = session?.user || null;
                await this.updateAdminStatus();
                await this.fetchUserLikes(); // [NEW]
            });
            this.loading = false;
            console.log("[Auth] Init complete. Loading = false");
        },

        async updateAdminStatus() {
            this.isAdmin = false;
            if (this.user) {
                const { data: roleData } = await sbClient
                    .from('user_roles')
                    .select('role')
                    .eq('id', this.user.id)
                    .maybeSingle();

                if (roleData && roleData.role === 'admin') {
                    this.isAdmin = true;
                }
            }
        },

        // [NEW] Fetch User Likes
        async fetchUserLikes() {
            this.userLikes = new Set();
            if (this.user) {
                const { data } = await sbClient
                    .from('model_likes')
                    .select('model_id')
                    .eq('user_id', this.user.id);

                if (data) {
                    data.forEach(row => this.userLikes.add(row.model_id));
                }
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
                if (isLiked) {
                    // Unlike
                    await sbClient.from('model_likes').delete().eq('user_id', this.user.id).eq('model_id', modelId);
                } else {
                    // Like
                    await sbClient.from('model_likes').insert({ user_id: this.user.id, model_id: modelId });
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
            await sbClient.auth.signOut();
            window.location.href = 'index.html';
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

            // Wait for Auth Store to complete initialization
            // This ensures we have the user ID for likes and correct admin status before fetching
            const authStore = Alpine.store('auth');
            if (authStore) {
                // Wait up to 2 seconds for auth
                let safety = 0;
                while (authStore.loading && safety < 40) {
                    await new Promise(r => setTimeout(r, 50));
                    safety++;
                }
            }


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
            Alpine.effect(() => {
                const u = Alpine.store('auth').user; // Dependency
                // debounce or simple check to avoid double-fetch on init
                // We rely on the initial fetch above for the first load. 
                // This effect will run on changes. 
            });
        },

        debouncedFetch: Alpine.debounce(function () {
            this.fetchModels(true);
        }, 500),

        async fetchModels(reset = false) {
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
                const { data, error } = await sbClient.rpc('get_model_previews', {
                    p_page: this.currentPage,
                    p_page_size: this.pageSize,
                    p_search: this.searchQuery,
                    p_filters: filters,
                    p_sort: this.sortBy, // [NEW]
                    p_liked_by_user: null // Not needed for main dashboard
                });

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
            } finally {
                this.loading = false;
            }
        },

        async fetchStats() {
            try {
                const { data, error } = await sbClient.rpc('get_dashboard_stats');
                if (error) throw error;
                this.stats = data;

                // Update Helper Counts for UI (Optional, if we want badges on filters)
                // This is a trade-off: Server stats are global, not filtered. 
                // We'll map them to the UI logic.
                // For now, we update charts.
                if (window.renderDashboardCharts) {
                    window.renderDashboardCharts(null, this.stats); // Pass stats directly
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
            window.location.href = `details.html?id=${id}`;
        },

        updateCharts() {
            // If stats already loaded, render. Else it waits for fetchStats.
            if (this.stats) renderDashboardCharts(null, this.stats);
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