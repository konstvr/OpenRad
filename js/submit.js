document.addEventListener('alpine:init', () => {
    Alpine.data('submitApp', () => ({
        user: null,
        loading: true,
        submissionId: null,
        submitting: false,
        success: false,
        error: null,

        // Form Data
        formData: {
            name: '',
            link: '',
            demo_link: '',
            paper_link: '',
            paper_title: '',
            doi: '',

            // Technical
            architecture: '',
            dataset: '',
            indications: '',
            limitations: '',
            sustainability: '',
            availability: '',

            // Lists / Textareas
            authors: '',
            organizations: '',
            funding: '',
            ethical_review: '',
            imaging_modalities: '',
            imaging_procedures: '',
            imaging_comments: '',

            // Categories
            use_cases: [],
            modalities: [],
            specialties: [],

            // Validation & Repo Analysis
            regulatory: '',
            validation: '',
            contains_weights: 'n/a',
            demo_available: 'no',

            // Performance
            performance_metrics: '',
            performance_metrics_list: '',
            performance_comments: ''
        },

        // JSON import state
        importSummary: null,
        importError: null,

        // Prompt copy state
        promptCopied: false,
        promptCopyError: null,

        // Drop-target state
        dragging: false,

        // Constants (matching app.js)
        MODALITY_CODES: ["CT", "FL", "MR", "NM", "PET", "US", "XR", "DXA"],
        SUBSPECIALTY_CODES: [
            "AB", "BR", "CA", "CH", "ER", "GI", "GU", "HN", "IR", "MI",
            "MK", "NR", "OB", "OI", "OT", "PD", "QI", "RS", "VI"
        ],
        FULL_MAPPING: {
            "BR": "Breast", "BQ": "Biomarkers", "CA": "Cardiac Radiology", "CH": "Chest Radiology",
            "CT": "Computed Tomography", "DM": "Digital Mammography", "ED": "Education", "ER": "Emergency Radiology",
            "GI": "Gastrointestinal Radiology", "GU": "Genitourinary Radiology", "HN": "Head and Neck", "HP": "Health Policy",
            "IN": "Informatics", "IR": "Interventional", "LM": "Leadership & Management", "MI": "Molecular Imaging",
            "MK": "Musculoskeletal Radiology", "MR": "Magnetic Resonance Imaging", "NM": "Nuclear Medicine", "NR": "Neuroradiology",
            "OB": "Obstetric/Gynecologic Radiology", "OI": "Oncologic Imaging", "OT": "Other", "PD": "Pediatric Radiology",
            "PH": "Physics and Basic Science", "PR": "Professionalism", "SQ": "Quality Assurance", "RO": "Radiation Oncology",
            "RS": "Research and Statistical Methods", "US": "Ultrasound", "VA": "Vascular", "VI": "Vascular", "AB": "Abdomen", "FL": "Fluoroscopy",
            "XR": "X-ray", "DXA": "DEXA", "QI": "Quality Improvement"
        },
        USE_CATEGORIES: ["Classification", "Detection", "Segmentation", "Foundation", "LLM", "Generative", "Other"],

        async init() {
            // Theme check
            if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

            // Auth check
            const authStore = Alpine.store('auth');
            if (authStore) {
                let safety = 0;
                while (authStore.loading && safety < 400) {
                    await new Promise(r => setTimeout(r, 50));
                    safety++;
                }
                this.user = authStore.user;
            } else {
                const { data } = await sbClient.auth.getSession();
                this.user = data?.session?.user;
            }

            if (!this.user) {
                // Redirect to home if not logged in
                window.location.href = 'index.html';
            }

            this.loading = false;

            // Check for edit mode
            const urlParams = new URLSearchParams(window.location.search);
            const editId = urlParams.get('edit');
            if (editId) {
                this.submissionId = editId;
                await this.loadSubmission(editId);
            }
        },

        async loadSubmission(id) {
            try {
                const { data, error } = await sbClient
                    .from('model_submissions')
                    .select('*')
                    .eq('id', id)
                    .single();

                if (error) throw error;
                if (!data) throw new Error("Submission not found");

                // Populate form
                this.mapSubmissionToForm(data.card_data);

            } catch (err) {
                console.error("Error loading submission:", err);
                this.error = "Failed to load submission: " + err.message;
            }
        },

        mapSubmissionToForm(json) {
            const m = json.Model || {};
            const idx = m.Indexing || {};
            const desc = m.Descriptors || {};
            const img = m.Imaging || {};
            const props = m["Model properties"] || {};
            const perf = m["Model performance"] || {};
            const refs = (desc.References && desc.References[0]) ? desc.References[0] : {};
            const repo = props.repository_analysis || {};

            // Helper to safe join (handles both older String arrays and newer {Name: String} arrays)
            const safeJoin = (arr, sep = '; ') => {
                if (!Array.isArray(arr)) return arr || '';
                return arr.map(item => typeof item === 'object' && item.Name ? item.Name : item).join(sep);
            };

            this.formData.name = m.Name || '';
            this.formData.link = m.Link || '';
            this.formData.demo_link = repo.demo_link || '';
            this.formData.paper_link = refs.PaperLink || '';
            this.formData.paper_title = refs.Title || '';
            this.formData.doi = refs.DOI || '';

            this.formData.architecture = props.Architecture || '';
            this.formData.dataset = props.Dataset || '';
            this.formData.indications = props["Indications for use"] || '';
            this.formData.limitations = props.Limitations || '';
            this.formData.sustainability = props.Sustainability || '';
            this.formData.availability = props.Availability || '';

            this.formData.authors = safeJoin(desc.Authors, '; '); // Enforce semicolon universally for viewing
            this.formData.organizations = safeJoin(desc.Organizations, '; ');
            this.formData.funding = desc.Funding || '';
            this.formData.ethical_review = desc["Ethical review"] || '';
            this.formData.imaging_modalities = safeJoin(img.Modalities, '; ');
            this.formData.imaging_procedures = safeJoin(img.Procedures, '; ');
            this.formData.imaging_comments = img.Comments || '';

            this.formData.use_cases = Array.isArray(props.Use) ? props.Use : [];
            this.formData.modalities = (idx.Content || []).filter(c => this.MODALITY_CODES.includes(c));
            this.formData.specialties = (idx.Content || []).filter(c => this.SUBSPECIALTY_CODES.includes(c));

            this.formData.regulatory = (props["Regulatory information"] || {}).Comment || '';
            this.formData.validation = props.Validation || '';
            this.formData.contains_weights = repo.contains_weights || 'n/a';
            this.formData.demo_available = repo.demo_available || 'no';

            this.formData.contains_weights = repo.contains_weights || 'n/a';
            this.formData.demo_available = repo.demo_available || 'no';

            // Structured metric list keeps its own field so imports round-trip losslessly.
            this.formData.performance_metrics_list = Array.isArray(perf.Metrics) ? perf.Metrics.join('\n') : '';

            // [UPDATED] Map 'Comments' (or joined 'Metrics') to the single form field
            if (perf.Comments && perf.Comments.trim().length > 0) {
                this.formData.performance_metrics = perf.Comments;
            } else {
                this.formData.performance_metrics = this.formData.performance_metrics_list;
            }
            // this.formData.performance_comments is removed
        },

        // --- JSON card import -------------------------------------------------
        // Normalises the shapes a card actually turns up in: a bare card, a
        // single-element array (the database exports are arrays), a full DB row
        // with a card_data column, or any of those double-JSON-encoded, which
        // some stored rows genuinely are.
        parseCardPayload(text) {
            const unwrap = (v) => {
                let guard = 0;
                while (typeof v === 'string' && guard++ < 3) v = JSON.parse(v);
                return v;
            };

            let data;
            try {
                data = unwrap(JSON.parse(text));
            } catch (e) {
                throw new Error('That file is not valid JSON.');
            }

            if (Array.isArray(data)) {
                if (data.length === 0) throw new Error('The file contains an empty array.');
                if (data.length > 1) throw new Error('The file contains ' + data.length + ' records. Import one at a time.');
                data = unwrap(data[0]);
            }

            if (!data || typeof data !== 'object') {
                throw new Error('The file does not contain a JSON object.');
            }

            // A row straight out of model_submissions / models
            if (data.card_data) data = unwrap(data.card_data);

            if (!data.Model || typeof data.Model !== 'object') {
                throw new Error('This is not a model record: no top-level "Model" object was found.');
            }
            return data;
        },

        countPopulatedFields() {
            return Object.values(this.formData).filter((v) => {
                if (Array.isArray(v)) return v.length > 0;
                if (v === null || v === undefined) return false;
                return String(v).trim() !== '';
            }).length;
        },

        async importCard(event) {
            const input = event.target;
            const file = input.files && input.files[0];
            input.value = ''; // allow re-importing the same filename
            await this.handleCardFile(file);
        },

        async handleDrop(event) {
            this.dragging = false;
            const file = event.dataTransfer && event.dataTransfer.files
                ? event.dataTransfer.files[0] : null;
            await this.handleCardFile(file);
        },

        async handleCardFile(file) {
            if (!file) return;

            this.importError = null;
            this.importSummary = null;

            try {
                const card = this.parseCardPayload(await file.text());

                // Reuse the exact mapper that powers ?edit= mode.
                this.mapSubmissionToForm(card);

                this.importSummary = {
                    filename: file.name,
                    modelName: (card.Model && card.Model.Name) || '(unnamed model)',
                    populated: this.countPopulatedFields(),
                    total: Object.keys(this.formData).length,
                    missing: this.missingRequiredFields()
                };
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } catch (err) {
                console.error('[Import] failed:', err);
                this.importError = err.message || 'Could not read that file.';
            }
        },

        // Puts the model-record prompt on the clipboard. The prompt is fetched from
        // GEM_PROMPT.md rather than duplicated here, so the file stays the single
        // source of truth and the button can never serve a stale copy.
        async copyPrompt() {
            this.promptCopyError = null;
            try {
                const res = await fetch('GEM_PROMPT.md', { cache: 'no-store' });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const text = await res.text();

                // Everything above the first horizontal rule is guidance for the
                // human; only what follows is meant for the LLM.
                const parts = text.split(/^---$/m);
                const prompt = (parts.length > 1 ? parts.slice(1).join('---') : text).trim();
                if (!prompt) throw new Error('Prompt file was empty');

                await navigator.clipboard.writeText(prompt);

                this.promptCopied = true;
                setTimeout(() => { this.promptCopied = false; }, 2500);
            } catch (err) {
                console.error('[Prompt] copy failed:', err);
                this.promptCopyError = 'Could not copy automatically. Use Download instead.';
            }
        },

        exportCard() {
            const slug = (this.formData.name || 'model-record')
                .replace(/[^a-z0-9]+/gi, '-')
                .replace(/^-+|-+$/g, '')
                .toLowerCase() || 'model-record';

            const blob = new Blob([JSON.stringify(this.buildCardData(), null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = slug + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        },

        isValidUrl(str) {
            if (!str || str.trim().length === 0) return true;
            try {
                const url = new URL(str);
                return url.protocol === 'http:' || url.protocol === 'https:';
            } catch (_) {
                return false;
            }
        },

        // Single source of truth for what the form requires. Shared by isFormValid()
        // and the import banner so the two can never disagree.
        REQUIRED_FIELDS: [
            // 1. Identification
            'name', 'link',
            'paper_title', 'doi',

            // 2. Descriptors
            'authors', 'organizations', 'funding', 'ethical_review',

            // 3. Properties
            'architecture', 'dataset', 'indications', 'limitations',
            'regulatory', 'validation', // Removed sustainability, availability

            // 5. Performance
            'performance_metrics'
        ],
        REQUIRED_LISTS: [
            { key: 'use_cases', label: 'Use Case' },
            { key: 'modalities', label: 'Modality' },
            { key: 'specialties', label: 'Subspecialty' }
        ],

        // Returns human-readable labels of everything still missing. Empty array == ready.
        missingRequiredFields() {
            const f = this.formData;
            const missing = [];

            for (const field of this.REQUIRED_FIELDS) {
                const v = f[field];
                if (!v || String(v).trim() === '') missing.push(field);
            }
            for (const { key, label } of this.REQUIRED_LISTS) {
                if (!Array.isArray(f[key]) || f[key].length === 0) missing.push(label);
            }
            return missing;
        },

        isFormValid() {
            const f = this.formData;

            const missing = this.missingRequiredFields();
            if (missing.length > 0) {
                console.debug('Missing required:', missing.join(', '));
                return false;
            }

            // URL Check
            if (!this.isValidUrl(f.link)) { console.debug('Invalid link'); return false; }
            if (f.demo_link && !this.isValidUrl(f.demo_link)) { console.debug('Invalid demo_link'); return false; }
            if (f.paper_link && !this.isValidUrl(f.paper_link)) { console.debug('Invalid paper_link'); return false; }

            return true;
        },

        processList(str, separator = /[\n;]+/, toObject = false) {
            if (!str) return [];
            const arr = str.split(separator).map(s => s.trim()).filter(s => s.length > 0);
            return toObject ? arr.map(name => ({ Name: name })) : arr;
        },

        // Assembles the nested RSNA ATLAS card from the flat form state.
        // Used by both submitModel() and exportCard(); the form is always the
        // source of truth, so an imported file can never inject stray keys.
        buildCardData() {
            return {
                "$schema": "https://atlas.rsna.org/schemas/2025-11/model.json",
                "Model": {
                    "Name": this.formData.name,
                    "Link": this.formData.link,
                    "Indexing": {
                        "Content": [...this.formData.modalities, ...this.formData.specialties]
                    },
                    "Descriptors": {
                        "Authors": this.processList(this.formData.authors, /[\n;]+/, true),
                        "Organizations": this.processList(this.formData.organizations, /[\n;]+/, true),
                        "Funding": this.formData.funding,
                        "Ethical review": this.formData.ethical_review,
                        "References": [
                            {
                                "Title": this.formData.paper_title || "Paper",
                                "DOI": this.formData.doi,
                                "PaperLink": this.formData.paper_link // Keep custom field for compatibility
                            }
                        ]
                    },
                    "Imaging": {
                        // Free-text modality description; the published dataset populates this
                        // on the majority of records, so keep it rather than writing [].
                        "Modalities": this.processList(this.formData.imaging_modalities, /[\n;]+/, false),
                        // Objects, matching the shape used by every published card.
                        "Procedures": this.processList(this.formData.imaging_procedures, /[\n;]+/, true),
                        "Comments": this.formData.imaging_comments
                    },
                    "Model properties": {
                        "Architecture": this.formData.architecture,
                        "Sustainability": this.formData.sustainability,
                        "Limitations": this.formData.limitations,
                        "Indications for use": this.formData.indications,
                        "Regulatory information": {
                            "Comment": this.formData.regulatory
                        },
                        "Use": this.formData.use_cases,
                        "Availability": this.formData.availability,
                        "Dataset": this.formData.dataset,
                        "Validation": this.formData.validation,
                        "repository_analysis": {
                            "contains_weights": this.formData.contains_weights,
                            "demo_available": this.formData.demo_available,
                            "demo_link": this.formData.demo_link || null
                        }
                    },
                    "Model performance": {
                        "Metrics": this.processList(this.formData.performance_metrics_list, /[\n]+/, false),
                        "Comments": this.formData.performance_metrics // free-text narrative of the numbers
                    }
                }
            };
        },

        async submitModel() {
            if (!this.isFormValid()) return;

            this.submitting = true;
            this.error = null;

            try {
                const cardData = this.buildCardData();

                let error;
                const authStore = Alpine.store('auth');

                // Helper: Safe raw fetch with timeout (always try this first as it's more reliable)
                const safeRawFetch = async (endpoint, options = {}) => {
                    const SUPABASE_URL = 'https://lnhwazoamudessdhhvsj.supabase.co';
                    const SUPABASE_KEY = 'sb_publishable_uzQs9fk-6ZTeu4RSJ3wHgw_1KMskJ9-';

                    // Get token from session or recovered token
                    const token = (authStore?.session?.access_token) || authStore?.recoveredToken;
                    if (!token) {
                        throw new Error("No authentication token available. Please log in again.");
                    }

                    const url = `${SUPABASE_URL}${endpoint}`;
                    const headers = {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        ...options.headers
                    };


                    // Race the fetch against a timeout to prevent hanging
                    const fetchPromise = fetch(url, { ...options, headers });
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("FetchTimeout")), 5000)
                    );

                    const res = await Promise.race([fetchPromise, timeoutPromise]);

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

                // Try raw fetch first (more reliable), fall back to sbClient with timeout
                try {
                    if (this.submissionId) {
                        // Update Mode - try raw fetch first
                        const res = await safeRawFetch(`/rest/v1/model_submissions?id=eq.${this.submissionId}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ card_data: cardData }),
                            headers: { 'Prefer': 'return=minimal' }
                        });
                        error = res.error;
                    } else {
                        // Create Mode - try raw fetch first
                        const res = await safeRawFetch('/rest/v1/model_submissions', {
                            method: 'POST',
                            body: JSON.stringify({
                                user_id: this.user.id,
                                card_data: cardData,
                                status: 'pending'
                            }),
                            headers: { 'Prefer': 'return=minimal' }
                        });
                        error = res.error;
                    }
                } catch (fetchErr) {
                    // Raw fetch failed, try sbClient with timeout as fallback
                    console.warn("[Submit] Raw fetch failed, falling back to sbClient:", fetchErr);

                    const withTimeout = (promise, timeoutMs) => Promise.race([
                        promise,
                        new Promise((_, reject) => setTimeout(() => reject(new Error("Supabase operation timed out")), timeoutMs))
                    ]);

                    try {
                        if (this.submissionId) {
                            const result = await withTimeout(
                                sbClient.from('model_submissions').update({ card_data: cardData }).eq('id', this.submissionId),
                                5000
                            );
                            error = result.error;
                        } else {
                            const result = await withTimeout(
                                sbClient.from('model_submissions').insert({
                                    user_id: this.user.id,
                                    card_data: cardData,
                                    status: 'pending'
                                }),
                                5000
                            );
                            error = result.error;
                        }
                    } catch (timeoutErr) {
                        // If both failed, throw the original fetch error
                        console.error("[Submit] Both methods failed");
                        throw fetchErr;
                    }
                }

                if (error) throw error;

                this.success = true;
                // Scroll to top
                window.scrollTo({ top: 0, behavior: 'smooth' });

            } catch (err) {
                console.error(err);
                this.error = err.message;
            } finally {
                this.submitting = false;
            }
        }
    }));
});
