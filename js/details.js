document.addEventListener('alpine:init', () => {
    Alpine.data('detailsApp', () => ({
        loading: true,
        model: null,
        user: null,
        editMode: false,
        draft: null,
        severities: {},
        copySuccess: false,
        isAdmin: false,

        // Flagging State
        flagModalOpen: false,
        flagReason: 'Irrelevant/ Spam',
        flagComment: '',
        isFlagged: false, // Visual cue state
        flagId: null, // Track the specific edit ID for this flag

        async init() {
            // Theme check
            if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

            // Auth check
            const { data: { session } } = await sbClient.auth.getSession();
            this.user = session?.user;

            // Check Admin Role
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

            // Get ID from URL
            const id = new URLSearchParams(window.location.search).get('id');
            if (!id) {
                window.location.href = 'index.html';
                return;
            }

            // Fetch Model
            const { data, error } = await sbClient.from('models').select('*').eq('id', id).single();
            if (error || !data) {
                alert("Model not found");
                window.location.href = 'index.html';
                return;
            }

            this.model = data;

            // [DEBUG] Log initial data
            console.log("Fetched model data:", this.model);
            console.log("Type of card_data:", typeof this.model.card_data);

            // [FIX] Recursive parsing to handle potential double-stringification
            let parseAttempts = 0;
            while (this.model.card_data && typeof this.model.card_data === 'string' && parseAttempts < 3) {
                try {
                    console.log("Parsing card_data (attempt " + (parseAttempts + 1) + ")...");
                    this.model.card_data = JSON.parse(this.model.card_data);
                } catch (e) {
                    console.error("Failed to parse card_data:", e);
                    break;
                }
                parseAttempts++;
            }

            console.log("Final card_data:", this.model.card_data);

            // Check for existing flag
            // 1. Check if the model itself is flagged (Visible to everyone)
            if (this.model.is_flagged) {
                this.isFlagged = true;
            }

            // 2. (Optional) If you want to allow the user to Unflag their OWN report, 
            // you still need to find their specific edit ID.
            if (this.user && this.isFlagged) {
                const { data: flags } = await sbClient.from('model_edits')
                    .select('id')
                    .eq('model_id', this.model.id)
                    .eq('user_id', this.user.id)
                    .eq('field_path', '__FLAG__')
                    .maybeSingle();

                if (flags) {
                    this.flagId = flags.id; // Store ID so they can unflag it later
                }
            }

            this.loading = false;
        },

        // --- UI HELPERS ---
        hasData(str) {
            return str && str.trim().length > 0;
        },

        checkWeights() {
            const r = this.model.card_data.Model['Model properties'].repository_analysis;
            return r && (r.contains_weights === 'yes' || r.contains_weights === true);
        },

        getPrimaryModalities() {
            if (!this.model) return [];
            const content = this.model.card_data.Model.Indexing?.Content || [];
            // Assumes MODALITY_CODES is defined in app.js
            return content.filter(c => typeof MODALITY_CODES !== 'undefined' && MODALITY_CODES.includes(c));
        },

        getSubspecialties() {
            if (!this.model) return [];
            const content = this.model.card_data.Model.Indexing?.Content || [];
            if (typeof MODALITY_CODES === 'undefined' || typeof FULL_MAPPING === 'undefined') return content;

            const specialties = content.filter(c => !MODALITY_CODES.includes(c));
            return specialties.map(s => FULL_MAPPING[s] || s);
        },

        getUseAsArray(val) {
            if (!val) return [];
            if (Array.isArray(val)) return val;
            return [val];
        },

        getRawDOI() {
            const refs = this.model.card_data.Model.Descriptors?.References;
            if (!refs || refs.length === 0) return null;
            return refs[0].DOI || null;
        },

        getPaperLink() {
            const refs = this.model.card_data.Model.Descriptors?.References;
            if (!refs || refs.length === 0) return null;

            const ref = refs[0];

            // 1. Priority: Manual Override
            if (ref.PaperLink && ref.PaperLink.trim().length > 0) {
                const link = ref.PaperLink.trim();
                // Ensure it starts with http/https
                if (link.startsWith('http')) return link;
            }

            // 2. Priority: DOI Field
            if (ref.DOI) {
                const doi = ref.DOI.trim();

                // PubMed Central (PMC) ID
                if (doi.toUpperCase().startsWith('PMC')) {
                    return 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + doi + '/';
                }

                // PubMed ID (PMID)
                if (doi.toUpperCase().startsWith('PMID:')) {
                    const pmid = doi.split(':')[1].trim();
                    return 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/';
                }

                // Standard DOI
                if (doi.startsWith('10.')) return 'https://doi.org/' + doi;
                // Direct URL (e.g. arXiv)
                if (doi.startsWith('http')) return doi;
            }

            return null;
        },

        getDemoLink() {
            if (!this.model) return null;
            const m = this.model.card_data;

            // 1. Try Deep Path
            let link = m.Model?.['Model properties']?.repository_analysis?.demo_link;

            // 2. Fallback to Legacy/Root Paths
            if (!link) link = m.demo_link || m.Model?.demo_link;

            // 3. Strict Validation (must be http/https)
            if (typeof link === 'string' && /^https?:\/\//i.test(link.trim())) {
                return link.trim();
            }
            return null;
        },

        // --- ACTIONS ---
        downloadJson() {
            const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(this.model.card_data, null, 4));
            const a = document.createElement('a');
            a.href = dataStr;
            a.download = (this.model.card_data.Model.Name.replace(/[^a-z0-9]/gi, '_').toLowerCase()) + "_card.json";
            document.body.appendChild(a);
            a.click();
            a.remove();
        },

        async copyToClipboard() {
            try {
                // Construct Clean Schema
                const cleanData = {
                    Model: {
                        Name: this.model.card_data.Model.Name,
                        Link: this.model.card_data.Model.Link,
                        "Model properties": {
                            Architecture: this.model.card_data.Model['Model properties'].Architecture,
                            Dataset: this.model.card_data.Model['Model properties'].Dataset,
                            "Indications for use": this.model.card_data.Model['Model properties']['Indications for use'],
                            Limitations: this.model.card_data.Model['Model properties'].Limitations,
                            Use: this.model.card_data.Model['Model properties'].Use,
                            Validation: this.model.card_data.Model['Model properties'].Validation,
                            "Regulatory information": {
                                "Comment": this.model.card_data.Model['Model properties']['Regulatory information']?.Comment || ""
                            }
                        },
                        "Model performance": {
                            Comments: this.model.card_data.Model['Model performance']?.Comments || ""
                        }
                    }
                };

                const jsonStr = JSON.stringify(cleanData, null, 4);
                await navigator.clipboard.writeText(jsonStr);

                this.copySuccess = true;
                setTimeout(() => { this.copySuccess = false; }, 2000);
            } catch (err) {
                console.error(err);
                alert("Failed to copy: " + err.message);
            }
        },

        handleFlagClick() {
            if (!this.user) {
                alert("Please log in to flag models.");
                return;
            }

            if (this.isFlagged) {
                // UNFLAG
                this.unflagModel();
            } else {
                // FLAG
                this.flagModalOpen = true;
            }
        },

        async unflagModel() {
            if (!this.flagId) return;
            // No confirm needed for unflagging, per user friction preference (implied)
            // or maybe a small one:
            if (!confirm("Remove your flag?")) return;

            try {
                // 1. Delete the log entry
                const { error } = await sbClient.from('model_edits').delete().eq('id', this.flagId);
                if (error) throw error;

                // 2. NEW: Reset the public model status
                await sbClient.from('models')
                    .update({ is_flagged: false, flag_reason: null })
                    .eq('id', this.model.id);

                this.isFlagged = false;
                this.flagId = null;
            } catch (e) {
                console.error(e);
                alert("Error unflagging: " + e.message);
            }
        },

        async submitFlag() {
            try {
                const payload = {
                    reason: this.flagReason,
                    comment: this.flagComment
                };

                const { data, error } = await sbClient.from('model_edits').insert({
                    model_id: this.model.id,
                    user_id: this.user.id,
                    field_path: '__FLAG__',
                    old_value: '',
                    new_value: JSON.stringify(payload),
                    severity: 'major'
                }).select().single();

                if (error) throw error;

                // 2. NEW: Update the public model status so EVERYONE sees it
                const { error: modelError } = await sbClient
                    .from('models')
                    .update({ is_flagged: true, flag_reason: this.flagReason })
                    .eq('id', this.model.id);

                if (modelError) throw modelError;

                // Success State
                this.isFlagged = true;
                this.flagId = data.id;
                this.flagModalOpen = false;
                this.flagComment = '';

            } catch (e) {
                console.error(e);
                console.error("Error flagging model: " + e.message);
            }
        },

        // --- EDIT LOGIC ---
        toggleEdit() {
            if (this.isFlagged && !this.editMode) {
                alert("Cannot edit a flagged model.");
                return;
            }
            this.editMode = !this.editMode;
            if (this.editMode) {
                this.draft = JSON.parse(JSON.stringify(this.model.card_data));
                this.severities = {};

                // [FIX] Ensure nested structure exists for Demo Link
                if (!this.draft.Model['Model properties']) this.draft.Model['Model properties'] = {};
                if (!this.draft.Model['Model properties'].repository_analysis) {
                    this.draft.Model['Model properties'].repository_analysis = {};
                }
                if (!this.draft.Model['Model properties'].repository_analysis.contains_weights) {
                    this.draft.Model['Model properties'].repository_analysis.contains_weights = 'n/a';
                }

                // Initialize nested objects if missing
                if (!this.draft.Model['Model performance']) this.draft.Model['Model performance'] = { Comments: '' };
                if (!this.draft.Model['Model properties']) this.draft.Model['Model properties'] = {};
                if (!this.draft.Model['Model properties']['Regulatory information']) this.draft.Model['Model properties']['Regulatory information'] = { Comment: '' };

                // Sanitize Use Case (Filter invalid options)
                const validOptions = ['Classification', 'Detection', 'Segmentation', 'Foundation', 'LLM', 'Generative', 'Other'];
                let currentUse = this.draft.Model['Model properties'].Use;
                let asArray = Array.isArray(currentUse) ? currentUse : (currentUse ? [currentUse] : []);
                this.draft.Model['Model properties'].Use = asArray.filter(item => validOptions.includes(item));

                // [FIX] Ensure References array and first element exist
                if (!this.draft.Model.Descriptors) this.draft.Model.Descriptors = {};
                if (!this.draft.Model.Descriptors.References) this.draft.Model.Descriptors.References = [{}];
                if (this.draft.Model.Descriptors.References.length === 0) this.draft.Model.Descriptors.References.push({});

                // Ensure PaperLink exists
                if (!this.draft.Model.Descriptors.References[0].PaperLink) {
                    this.draft.Model.Descriptors.References[0].PaperLink = '';

                    // [FIX] Auto-populate with existing derived link if available
                    const existingLink = this.getPaperLink();
                    if (existingLink) {
                        this.draft.Model.Descriptors.References[0].PaperLink = existingLink;
                    }
                }
            }
        },

        isValidUrl(str) {
            if (!str || str.trim().length === 0) return true; // Empty is handled by isFormValid requirements
            try {
                const url = new URL(str);
                return url.protocol === 'http:' || url.protocol === 'https:';
            } catch (_) {
                return false;
            }
        },

        isFormValid() {
            if (!this.draft) return false;

            // Check Repository Link
            const repoLink = this.draft.Model.Link;
            const hasRepoLink = repoLink && repoLink.trim().length > 0;
            const validRepoLink = !hasRepoLink || this.isValidUrl(repoLink);

            // Check Demo Link
            const demoLink = this.draft.Model['Model properties']?.repository_analysis?.demo_link;
            const hasDemoLink = demoLink && demoLink.trim().length > 0;
            const validDemoLink = !hasDemoLink || this.isValidUrl(demoLink);

            // Check Paper Link
            const refs = this.draft.Model.Descriptors?.References;
            const paperLink = refs && refs.length > 0 ? refs[0].PaperLink : null;
            const hasPaperLink = paperLink && paperLink.trim().length > 0;
            const validPaperLink = !hasPaperLink || this.isValidUrl(paperLink);

            // Logic: Paper Link IS REQUIRED + (Repo Link OR Demo Link)
            // AND all provided links must be valid URLs
            return hasPaperLink && validPaperLink &&
                (hasRepoLink || hasDemoLink) &&
                validRepoLink && validDemoLink;
        },

        async saveChanges(shouldVerify = true) {
            if (!this.user) return;

            const fields = [
                { path: 'Model.Name', old: this.model.card_data.Model.Name, new: this.draft.Model.Name },
                { path: 'Model.Link', old: this.model.card_data.Model.Link, new: this.draft.Model.Link },
                {
                    path: 'Model.Model properties.repository_analysis.demo_link',
                    old: this.model.card_data.Model['Model properties']?.repository_analysis?.demo_link,
                    new: this.draft.Model['Model properties'].repository_analysis.demo_link
                },
                {
                    path: 'Model.Model properties.repository_analysis.contains_weights',
                    old: this.model.card_data.Model['Model properties']?.repository_analysis?.contains_weights,
                    new: this.draft.Model['Model properties'].repository_analysis.contains_weights
                },
                {
                    path: 'Model.Descriptors.References.0.PaperLink',
                    old: this.model.card_data.Model.Descriptors?.References?.[0]?.PaperLink,
                    new: this.draft.Model.Descriptors.References[0].PaperLink
                },
                { path: 'Model.Model properties.Architecture', old: this.model.card_data.Model['Model properties'].Architecture, new: this.draft.Model['Model properties'].Architecture },
                { path: 'Model.Model properties.Dataset', old: this.model.card_data.Model['Model properties'].Dataset, new: this.draft.Model['Model properties'].Dataset },
                { path: 'Model.Model properties.Indications for use', old: this.model.card_data.Model['Model properties']['Indications for use'], new: this.draft.Model['Model properties']['Indications for use'] },
                { path: 'Model.Model performance.Comments', old: this.model.card_data.Model['Model performance']?.Comments, new: this.draft.Model['Model performance']?.Comments },
                { path: 'Model.Model properties.Limitations', old: this.model.card_data.Model['Model properties'].Limitations, new: this.draft.Model['Model properties'].Limitations },
                { path: 'Model.Model properties.Use', old: this.model.card_data.Model['Model properties'].Use, new: this.draft.Model['Model properties'].Use },
                { path: 'Model.Model properties.Validation', old: this.model.card_data.Model['Model properties'].Validation, new: this.draft.Model['Model properties'].Validation },
                { path: 'Model.Model properties.Regulatory information.Comment', old: this.model.card_data.Model['Model properties']['Regulatory information']?.Comment, new: this.draft.Model['Model properties']['Regulatory information']?.Comment }
            ];

            for (const f of fields) {
                // Stringify for robust comparison (handles arrays/objects)
                if (JSON.stringify(f.old) !== JSON.stringify(f.new)) {
                    await sbClient.from('model_edits').insert({
                        model_id: this.model.id,
                        user_id: this.user.id,
                        field_path: f.path,
                        old_value: JSON.stringify(f.old) || '',
                        new_value: JSON.stringify(f.new) || '',
                        severity: this.severities[f.path] || 'minor'
                    });
                }
            }

            // Prepare Update Payload
            const updatePayload = {
                card_data: this.draft
            };

            // Only add verification data if requested
            if (shouldVerify) {
                updatePayload.is_verified = true;
                updatePayload.verified_by = this.user.id;
                updatePayload.verification_date = new Date();
            }

            const { error } = await sbClient.from('models').update(updatePayload).eq('id', this.model.id);

            if (!error) {
                this.model.card_data = this.draft;
                if (shouldVerify) {
                    this.model.is_verified = true;
                    alert('Verified & Saved!');
                } else {
                    alert('Changes Saved (Not Verified)!');
                }
            } else {
                alert('Save failed: ' + error.message);
            }
        }
    }));
});