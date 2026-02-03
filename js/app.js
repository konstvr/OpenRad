// js/app.js

// --- CONFIGURATION ---
const SUPABASE_URL = 'https://lnhwazoamudessdhhvsj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_uzQs9fk-6ZTeu4RSJ3wHgw_1KMskJ9-';

const sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const MODALITY_CODES = ["CT", "FL", "MR", "NM", "PET", "US", "XR", "DXA"];
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
        user: null,
        loading: true,
        modalOpen: false,
        email: '',
        password: '',

        async init() {
            const { data: { session } } = await sbClient.auth.getSession();
            this.user = session?.user || null;
            sbClient.auth.onAuthStateChange((_event, session) => {
                this.user = session?.user || null;
            });
            this.loading = false;
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

// --- UTILS ---
function checkWeights(modelData) {
    const props = modelData.Model?.['Model properties'] || modelData['Model properties'];
    const repo = props?.repository_analysis;
    return repo && (repo.contains_weights === 'yes' || repo.contains_weights === true);
}

function checkDemo(modelData) {
    const props = modelData.Model?.['Model properties'] || modelData['Model properties'];
    const repo = props?.repository_analysis;

    // 1. Get the link from Deep Path (Priority) or Legacy/Root Paths
    let link = repo?.demo_link || modelData.demo_link || modelData.Model?.demo_link;

    // 2. Strict Validation: Must be a string AND start with http/https
    return typeof link === 'string' && /^https?:\/\//i.test(link.trim());
}

// --- MAIN APP LOGIC ---
function dashboardApp() {
    return {
        darkMode: localStorage.getItem('theme') === 'dark',
        currentTab: 'browse',
        loading: true,
        allModels: [],
        searchQuery: '',

        // PAGINATION / SCROLL STATE
        displayLimit: 100,

        // FILTERS
        filterVerified: false,
        filterDemo: false,
        filterWeights: false,
        selectedSpecialties: [],
        selectedModalities: [],
        selectedUses: [],
        codeMap: FULL_MAPPING,

        async initApp() {
            if (this.darkMode) document.documentElement.classList.add('dark');

            // 1. WAIT for the session to load from LocalStorage
            // This ensures Supabase has the user's token before we ask for data.
            await sbClient.auth.getSession();

            // 2. Fetch data immediately
            await this.fetchData();

            // 3. Optional: Listen for login events to re-fetch automatically
            // This fixes the issue where logging in didn't update the list immediately
            sbClient.auth.onAuthStateChange((event) => {
                if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
                    this.fetchData();
                }
            });
        },

        // New helper function to handle fetching
        async fetchData() {
            this.loading = true;
            let allData = [];
            let from = 0;
            const batchSize = 1000; // Supabase default safe size
            let done = false;

            try {
                while (!done) {
                    // Fetch range: 0-999, then 1000-1999, etc.
                    let { data, error } = await sbClient
                        .from('models')
                        .select('*')
                        .order('created_at', { ascending: false })
                        .range(from, from + batchSize - 1);

                    if (error) throw error;

                    if (data && data.length > 0) {
                        allData = allData.concat(data);
                        from += batchSize;

                        // If we received fewer rows than we asked for, we reached the end.
                        if (data.length < batchSize) {
                            done = true;
                        }
                    } else {
                        // No data returned, we are done.
                        done = true;
                    }
                }

                // Success: We now have the full dataset
                // [FIX] Deduplicate AND Filter invalid IDs (Strict)
                const uniqueData = new Map();
                let invalidCount = 0;
                let duplicateCount = 0;

                console.log(`[Fetch] Raw items fetched: ${allData.length}`);

                allData.forEach(item => {
                    // [FIX] Ensure card_data is an object (handle stringified JSON from Admin actions)
                    if (item.card_data && typeof item.card_data === 'string') {
                        try {
                            item.card_data = JSON.parse(item.card_data);
                        } catch (e) {
                            console.warn("Failed to parse card_data for ID:", item.id);
                            item.card_data = null;
                        }
                    }

                    // [SOFT DELETE FILTER] Skip items marked as deleted or invalid
                    if (!item.card_data || item.card_data._deleted === true || item.card_data._deleted === "true" || item.card_data._deleted_at) return;

                    if (item.id) {
                        // Normalize ID to ensure uniqueness
                        const safeId = String(item.id).trim();
                        if (!uniqueData.has(safeId)) {
                            uniqueData.set(safeId, item);
                        } else {
                            duplicateCount++;
                            // console.warn('Duplicate found:', safeId, item.card_data.Model.Name);
                        }
                    } else {
                        invalidCount++;
                    }
                });

                if (invalidCount > 0) console.warn(`[Fetch] Filtered ${invalidCount} items with missing IDs`);
                if (duplicateCount > 0) console.warn(`[Fetch] Removed ${duplicateCount} duplicate items`);

                this.allModels = Array.from(uniqueData.values());
                console.log(`[Fetch] Final unique models: ${this.allModels.length}`);

            } catch (err) {
                console.error("Error fetching models:", err);
            } finally {
                this.loading = false;
            }
        },

        toggleTheme() {
            this.darkMode = !this.darkMode;
            document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', this.darkMode ? 'dark' : 'light');
        },

        toggleFilter(arrayName, item) {
            const idx = this[arrayName].indexOf(item);
            if (idx === -1) this[arrayName].push(item);
            else this[arrayName].splice(idx, 1);

            // Reset scroll when filtering changes so user starts at top
            this.displayLimit = 100;
        },

        getFilterArray(name) { return this[name]; },

        resetFilters() {
            this.searchQuery = '';
            this.filterVerified = false;
            this.filterDemo = false;
            this.filterWeights = false;
            this.selectedSpecialties = [];
            this.selectedModalities = [];
            this.selectedUses = [];
            this.displayLimit = 100; // Reset pagination
        },

        // Scroll Handler (Infinite Scroll)
        handleScroll() {
            const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 500;
            if (bottom && this.displayLimit < this.filteredModels.length) {
                this.displayLimit += 50; // Load 50 more
            }
        },

        get isFiltered() {
            return this.searchQuery || this.filterVerified || this.filterDemo || this.filterWeights ||
                this.selectedSpecialties.length || this.selectedModalities.length || this.selectedUses.length;
        },

        // --- HELPER FOR ARRAYS ---
        asArray(val) {
            if (!val) return [];
            return Array.isArray(val) ? val : [val];
        },

        // --- DYNAMIC LISTS ---
        extractCodes(condition) {
            const s = new Set();
            this.allModels.forEach(row => {
                const val = row.card_data.Model.Indexing?.Content;
                if (val) val.forEach(c => condition(c) && s.add(c));
            });
            return Array.from(s).sort();
        },
        get availableSpecialties() { return this.extractCodes(c => !MODALITY_CODES.includes(c)); },
        get availableModalities() { return this.extractCodes(c => MODALITY_CODES.includes(c)); },

        get availableUses() {
            const s = new Set();
            this.allModels.forEach(r => {
                const uses = this.asArray(r.card_data.Model['Model properties'].Use);
                let hasValidCategory = false;
                uses.forEach(u => {
                    const cleanU = u.trim();
                    if (USE_CATEGORIES.includes(cleanU)) {
                        s.add(cleanU);
                        hasValidCategory = true;
                    }
                });
                if (!hasValidCategory) s.add("Other");
            });
            return Array.from(s).sort();
        },

        getCount(val, type) {
            if (type === 'Use Case') {
                return this.allModels.filter(r => {
                    const uses = this.asArray(r.card_data.Model['Model properties'].Use).map(u => u.trim());
                    if (val === "Other") return uses.length === 0 || !uses.some(u => USE_CATEGORIES.includes(u));
                    return uses.includes(val);
                }).length;
            }
            return this.allModels.filter(r => r.card_data.Model.Indexing?.Content?.includes(val)).length;
        },

        // --- DISPLAY HELPERS (NEW) ---
        getModalities(item) {
            const content = item.card_data.Model.Indexing?.Content || [];
            return content.filter(c => MODALITY_CODES.includes(c));
        },

        getSpecialties(item) {
            const content = item.card_data.Model.Indexing?.Content || [];
            return content.filter(c => !MODALITY_CODES.includes(c)).map(c => FULL_MAPPING[c] || c);
        },

        // --- MAIN FILTER ---
        get filteredModels() {
            return this.allModels.filter(row => {
                const m = row.card_data.Model;

                // 1. Search
                if (this.searchQuery && !JSON.stringify(m).toLowerCase().includes(this.searchQuery.toLowerCase())) return false;

                // 2. Toggles
                if (this.filterVerified && !row.is_verified) return false;
                if (this.filterWeights && !checkWeights(row.card_data)) return false;
                if (this.filterDemo && !checkDemo(row.card_data)) return false;

                // 3. Lists
                const content = m.Indexing?.Content || [];
                if (this.selectedModalities.length > 0 && !this.selectedModalities.some(x => content.includes(x))) return false;
                if (this.selectedSpecialties.length > 0 && !this.selectedSpecialties.some(x => content.includes(x))) return false;

                // 4. Use Case Filter (AND Logic)
                if (this.selectedUses.length > 0) {
                    const modelUses = this.asArray(m['Model properties'].Use).map(u => u.trim());
                    const matchesAll = this.selectedUses.every(filter => {
                        if (filter === "Other") return modelUses.length === 0 || !modelUses.some(u => USE_CATEGORIES.includes(u));
                        return modelUses.includes(filter);
                    });
                    if (!matchesAll) return false;
                }

                return true;
            });
        },

        // --- VISIBLE SUBSET (PAGINATION) ---
        get visibleModels() {
            return this.filteredModels.slice(0, this.displayLimit);
        },

        goToDetails(id) { window.location.href = `details.html?id=${id}`; },
        updateCharts() { renderDashboardCharts(this.allModels); }
    }
}