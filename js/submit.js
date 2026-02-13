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
            performance_comments: ''
        },

        // Constants (matching app.js)
        MODALITY_CODES: [
            "CT", "MR", "XR", "US", "NM", "PET", "MG", "DX", "CR", "RF", "SC", "OT"
        ],
        SUBSPECIALTY_CODES: [
            "AB", "BR", "CA", "CH", "ER", "GI", "GU", "HN", "IR", "MI",
            "MK", "NR", "OB", "OI", "OT", "PD", "QI", "RS", "VI"
        ],
        FULL_MAPPING: {
            "BR": "Breast", "BQ": "Biomarkers", "CA": "Cardiac Radiology", "CH": "Chest Radiology",
            "CT": "Computed Tomography", "DM": "Digital Mammography", "ED": "Education", "ER": "Emergency Radiology",
            "GI": "Gastrointestinal", "GU": "Genitourinary", "HN": "Head and Neck", "IR": "Interventional Radiology",
            "MI": "Medical Informatics", "MK": "Musculoskeletal", "MR": "Magnetic Resonance Imaging", "NM": "Nuclear Medicine",
            "NR": "Neuroradiology", "OB": "Obstetric/Gynecologic", "OI": "Optical Imaging", "OT": "Other",
            "PD": "Pediatric Radiology", "QI": "Quantitative Imaging", "RF": "Fluoroscopy", "RS": "Radiation Oncology",
            "SC": "Secondary Capture", "US": "Ultrasound", "VI": "Vascular Intervention", "XR": "X-Ray",
            "DX": "Digital Radiography", "MG": "Mammography", "PET": "Positron Emission Tomography"
        },
        USE_CATEGORIES: ["Classification", "Detection", "Segmentation", "Foundation", "LLM", "Generative", "Other"],

        async init() {
            // Theme check
            if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

            // Auth check
            const { data: { session } } = await sbClient.auth.getSession();
            this.user = session?.user;

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

            // Helper to safe join
            const safeJoin = (arr, sep = ', ') => Array.isArray(arr) ? arr.join(sep) : (arr || '');

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

            this.formData.authors = safeJoin(desc.Authors);
            this.formData.organizations = safeJoin(desc.Organizations, '; '); // Semicolon for orgs
            this.formData.funding = desc.Funding || '';
            this.formData.ethical_review = desc["Ethical review"] || '';
            this.formData.imaging_procedures = safeJoin(img.Procedures);
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

            // [UPDATED] Map 'Comments' (or joined 'Metrics') to the single form field
            if (perf.Comments && perf.Comments.trim().length > 0) {
                this.formData.performance_metrics = perf.Comments;
            } else {
                this.formData.performance_metrics = Array.isArray(perf.Metrics) ? perf.Metrics.join('\n') : '';
            }
            // this.formData.performance_comments is removed
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

        isFormValid() {
            const f = this.formData;

            // Required Check (Fully Expanded)
            const requiredFields = [
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
            ];

            for (const field of requiredFields) {
                if (!f[field] || f[field].trim() === '') {
                    console.debug('Missing required field:', field);
                    return false;
                }
            }

            // Array Check
            if (f.use_cases.length === 0) { console.debug('Missing use_cases'); return false; }
            if (f.modalities.length === 0) { console.debug('Missing modalities'); return false; }
            if (f.specialties.length === 0) { console.debug('Missing specialties'); return false; }

            // URL Check
            if (!this.isValidUrl(f.link)) { console.debug('Invalid link'); return false; }
            if (f.demo_link && !this.isValidUrl(f.demo_link)) { console.debug('Invalid demo_link'); return false; }
            if (f.paper_link && !this.isValidUrl(f.paper_link)) { console.debug('Invalid paper_link'); return false; }

            return true;
        },

        processList(str, separator = /[\n,]+/) {
            if (!str) return [];
            return str.split(separator).map(s => s.trim()).filter(s => s.length > 0);
        },

        async submitModel() {
            if (!this.isFormValid()) return;

            this.submitting = true;
            this.error = null;

            try {
                // Construct JSON with extended structure
                const cardData = {
                    "$schema": "https://atlas.rsna.org/schemas/2025-11/model.json",
                    "Model": {
                        "Name": this.formData.name,
                        "Link": this.formData.link,
                        "Indexing": {
                            "Content": [...this.formData.modalities, ...this.formData.specialties]
                        },
                        "Descriptors": {
                            "Authors": this.processList(this.formData.authors),
                            "Organizations": this.processList(this.formData.organizations, /[\n;]+/), // Split by semicolon
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
                            "Modalities": [], // Legacy/Schema field, typically empty or dup of Indexing
                            "Procedures": this.processList(this.formData.imaging_procedures),
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
                            "Metrics": [], // [User Request] Empty this, use Comments instead
                            "Comments": this.formData.performance_metrics // Populate comments with the metrics text
                        }
                    }
                };

                let error;
                if (this.submissionId) {
                    // Update Mode
                    const { error: updateError } = await sbClient
                        .from('model_submissions')
                        .update({ card_data: cardData })
                        .eq('id', this.submissionId);
                    error = updateError;
                } else {
                    // Create Mode
                    const { error: insertError } = await sbClient
                        .from('model_submissions')
                        .insert({
                            user_id: this.user.id,
                            card_data: cardData,
                            status: 'pending' // Enforced by RLS anyway
                        });
                    error = insertError;
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
