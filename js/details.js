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

            // Wait for Global Auth (app.js) to finish
            // This prevents "AbortError" caused by double-firing getSession()
            const authStore = Alpine.store('auth');
            if (authStore) {
                let safety = 0;
                while (authStore.loading && safety < 400) { // Max 20.0s wait (covers 10s lock timeout + overhead)
                    if (safety % 20 === 0) console.log("[Details] Waiting for auth...");
                    await new Promise(r => setTimeout(r, 50));
                    safety++;
                }
                if (authStore.loading) console.warn("[Details] Auth wait timed out (20s). Proceeding anyway...");
                this.user = authStore.user;
            } else {
                // Fallback if store missing (shouldn't happen)
                const { data } = await sbClient.auth.getSession();
                this.user = data?.session?.user || null;
            }

            // Check Admin Role
            if (this.user) {
                let roleData;
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    const res = await window.safeFetch(`/rest/v1/user_roles?select=role&id=eq.${this.user.id}&limit=1`);
                    roleData = (res.data && res.data.length > 0) ? res.data[0] : null;
                } else {
                    const { data } = await sbClient
                        .from('user_roles')
                        .select('role')
                        .eq('id', this.user.id)
                        .maybeSingle();
                    roleData = data;
                }

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
            // Fetch Model
            let data, error;
            if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                console.log("[Details] Using SafeFetch Fallback for Model Data");
                const res = await window.safeFetch(`/rest/v1/models?id=eq.${id}&select=*`, {
                    headers: { 'Prefer': 'return=representation' }
                });
                if (res.error) {
                    error = res.error;
                } else if (!res.data || res.data.length === 0) {
                    error = { message: "Model not found (empty result)" };
                } else {
                    data = res.data[0];
                }
            } else {
                const res = await sbClient.from('models').select('*').eq('id', id).single();
                data = res.data;
                error = res.error;
            }
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
                let flags;
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    const q = `?model_id=eq.${this.model.id}&user_id=eq.${this.user.id}&field_path=eq.__FLAG__&limit=1`;
                    const res = await window.safeFetch(`/rest/v1/model_edits${q}`);
                    flags = (res.data && res.data.length > 0) ? res.data[0] : null;
                } else {
                    const { data } = await sbClient.from('model_edits')
                        .select('id')
                        .eq('model_id', this.model.id)
                        .eq('user_id', this.user.id)
                        .eq('field_path', '__FLAG__')
                        .maybeSingle();
                    flags = data;
                }

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

        getAtlasLink() {
            if (!this.model) return null;
            // Check for atlas_link in multiple possible locations
            const atlasLink = this.model.card_data?.Model?.atlas_link || this.model.card_data?.atlas_link;

            if (atlasLink && typeof atlasLink === 'string' && atlasLink.startsWith('http')) {
                return atlasLink;
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
                        "Indexing": this.model.card_data.Model.Indexing,
                        "Descriptors": {
                            Authors: this.model.card_data.Model.Descriptors?.Authors || [],
                            Organizations: this.model.card_data.Model.Descriptors?.Organizations || [],
                            Funding: this.model.card_data.Model.Descriptors?.Funding || "",
                            References: this.model.card_data.Model.Descriptors?.References || []
                        },
                        "Model properties": {
                            Architecture: this.model.card_data.Model['Model properties'].Architecture,
                            Dataset: this.model.card_data.Model['Model properties'].Dataset,
                            "Indications for use": this.model.card_data.Model['Model properties']['Indications for use'],
                            Limitations: this.model.card_data.Model['Model properties'].Limitations,
                            Use: this.model.card_data.Model['Model properties'].Use,
                            Validation: this.model.card_data.Model['Model properties'].Validation,
                            Sustainability: this.model.card_data.Model['Model properties'].Sustainability || "",
                            "Regulatory information": {
                                "Comment": this.model.card_data.Model['Model properties']['Regulatory information']?.Comment || ""
                            },
                            repository_analysis: this.model.card_data.Model['Model properties'].repository_analysis
                        },
                        "Model performance": {
                            Comments: this.model.card_data.Model['Model performance']?.Comments || ""
                        },
                        atlas_link: this.model.card_data.Model.atlas_link
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
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    await window.safeFetch(`/rest/v1/model_edits?id=eq.${this.flagId}`, {
                        method: 'DELETE'
                    });
                } else {
                    const { error } = await sbClient.from('model_edits').delete().eq('id', this.flagId);
                    if (error) throw error;
                }

                // 2. NEW: Reset the public model status
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    await window.safeFetch(`/rest/v1/models?id=eq.${this.model.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ is_flagged: false, flag_reason: null })
                    });
                } else {
                    await sbClient.from('models')
                        .update({ is_flagged: false, flag_reason: null })
                        .eq('id', this.model.id);
                }

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

                let data, error;
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    const res = await window.safeFetch('/rest/v1/model_edits', {
                        method: 'POST',
                        headers: { 'Prefer': 'return=representation' },
                        body: JSON.stringify({
                            model_id: this.model.id,
                            user_id: this.user.id,
                            field_path: '__FLAG__',
                            old_value: '',
                            new_value: JSON.stringify(payload),
                            severity: 'major'
                        })
                    });
                    if (res.error) error = res.error;
                    else data = res.data[0];
                } else {
                    const res = await sbClient.from('model_edits').insert({
                        model_id: this.model.id,
                        user_id: this.user.id,
                        field_path: '__FLAG__',
                        old_value: '',
                        new_value: JSON.stringify(payload),
                        severity: 'major'
                    }).select().single();
                    data = res.data;
                    error = res.error;
                }

                if (error) throw error;

                // 2. NEW: Update the public model status so EVERYONE sees it
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    const res = await window.safeFetch(`/rest/v1/models?id=eq.${this.model.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ is_flagged: true, flag_reason: this.flagReason })
                    });
                    if (res.error) throw res.error;
                } else {
                    const { error: modelError } = await sbClient
                        .from('models')
                        .update({ is_flagged: true, flag_reason: this.flagReason })
                        .eq('id', this.model.id);

                    if (modelError) throw modelError;
                }

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
            /*
            if (this.isFlagged && !this.editMode && !this.isAdmin) {
                alert("Cannot edit a flagged model.");
                return;
            }
            */
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
                // [NEW] Ensure Sustainability field exists
                if (!this.draft.Model['Model properties'].Sustainability) {
                    this.draft.Model['Model properties'].Sustainability = '';
                } else if (this.draft.Model['Model properties'].Sustainability.trim() === 'Hardware: . Time:') {
                    // [FIX] Clear "template" data if it matches the common placeholder
                    this.draft.Model['Model properties'].Sustainability = '';
                }

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

                // [NEW] Ensure DOI, Title exist
                if (!this.draft.Model.Descriptors.References[0].DOI) this.draft.Model.Descriptors.References[0].DOI = '';
                if (!this.draft.Model.Descriptors.References[0].Title) this.draft.Model.Descriptors.References[0].Title = '';

                // [NEW] Handle Authors and Organizations (Array of Objects form) -> String form
                this.draft._authorsString = (this.draft.Model.Descriptors.Authors || [])
                    .map(a => a.Name)
                    .join('; ');

                this.draft._organizationsString = (this.draft.Model.Descriptors.Organizations || [])
                    .map(o => o.Name)
                    .join('; ');

                // Ensure Funding field exists
                if (!this.draft.Model.Descriptors.Funding) {
                    this.draft.Model.Descriptors.Funding = '';
                }

                // [NEW] Split Indexing.Content into Modalities and Specialties
                const content = this.draft.Model.Indexing?.Content || [];
                // Ensure array
                const contentArray = Array.isArray(content) ? content : [content];
                this.draft._selectedModalities = contentArray.filter(c => MODALITY_CODES.includes(c));
                this.draft._selectedSpecialties = contentArray.filter(c => SUBSPECIALTY_CODES.includes(c));

                // [NEW] Normalize Atlas Link to Model.atlas_link
                const existingAtlas = this.getAtlasLink();
                if (existingAtlas) {
                    this.draft.Model.atlas_link = existingAtlas;
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

            // Check Atlas Link
            const atlasLink = this.draft.Model.atlas_link;
            const hasAtlasLink = atlasLink && atlasLink.trim().length > 0;
            const validAtlasLink = !hasAtlasLink || this.isValidUrl(atlasLink);

            // Check Paper Link
            const refs = this.draft.Model.Descriptors?.References;
            const paperLink = refs && refs.length > 0 ? refs[0].PaperLink : null;
            const hasPaperLink = paperLink && paperLink.trim().length > 0;
            const validPaperLink = !hasPaperLink || this.isValidUrl(paperLink);

            // Logic: Paper Link IS REQUIRED + (Repo Link OR Demo Link)
            // AND all provided links must be valid URLs
            return hasPaperLink && validPaperLink &&
                (hasRepoLink || hasDemoLink) &&
                validRepoLink && validDemoLink && validAtlasLink;
        },

        async saveChanges(shouldVerify = true) {
            if (!this.user) return;

            try {

                // [NEW] Prevent verification if flagged
                if (this.isFlagged && shouldVerify) {
                    alert("Model is flagged. Changes will be saved, but verification is disabled until the flag is resolved.");
                    shouldVerify = false;
                }

                // [NEW] Merge Modalities and Specialties back into Content
                // Preserve any existing codes that are NOT in our managed lists (to be safe)
                const originalContent = this.draft.Model.Indexing?.Content || [];
                const otherCodes = Array.isArray(originalContent)
                    ? originalContent.filter(c => !MODALITY_CODES.includes(c) && !SUBSPECIALTY_CODES.includes(c))
                    : [];

                // Combine all
                const newContent = [
                    ...otherCodes,
                    ...(this.draft._selectedModalities || []),
                    ...(this.draft._selectedSpecialties || [])
                ];

                // Assign back to draft
                if (!this.draft.Model.Indexing) this.draft.Model.Indexing = {};
                this.draft.Model.Indexing.Content = newContent;

                // [NEW] Parse Authors and Organizations Strings back to Arrays
                const parseListToObjects = (str) => {
                    if (!str) return [];
                    return str.split(';')
                        .map(s => s.trim())
                        .filter(s => s.length > 0)
                        .map(name => ({ Name: name }));
                };

                this.draft.Model.Descriptors.Authors = parseListToObjects(this.draft._authorsString);
                this.draft.Model.Descriptors.Organizations = parseListToObjects(this.draft._organizationsString);

                const fields = [
                    { path: 'Model.Name', old: this.model.card_data.Model.Name, new: this.draft.Model.Name },
                    { path: 'Model.Link', old: this.model.card_data.Model.Link, new: this.draft.Model.Link },
                    { path: 'Model.atlas_link', old: this.getAtlasLink(), new: this.draft.Model.atlas_link },
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
                    {
                        path: 'Model.Descriptors.References.0.DOI',
                        old: this.model.card_data.Model.Descriptors?.References?.[0]?.DOI,
                        new: this.draft.Model.Descriptors.References[0].DOI
                    },
                    {
                        path: 'Model.Descriptors.References.0.Title',
                        old: this.model.card_data.Model.Descriptors?.References?.[0]?.Title,
                        new: this.draft.Model.Descriptors.References[0].Title
                    },
                    {
                        path: 'Model.Descriptors.Authors',
                        old: this.model.card_data.Model.Descriptors?.Authors,
                        new: this.draft.Model.Descriptors.Authors
                    },
                    {
                        path: 'Model.Descriptors.Organizations',
                        old: this.model.card_data.Model.Descriptors?.Organizations,
                        new: this.draft.Model.Descriptors.Organizations
                    },
                    {
                        path: 'Model.Descriptors.Funding',
                        old: this.model.card_data.Model.Descriptors?.Funding,
                        new: this.draft.Model.Descriptors.Funding
                    },
                    {
                        path: 'Model.Model properties.Sustainability',
                        old: this.model.card_data.Model['Model properties']?.Sustainability,
                        new: this.draft.Model['Model properties'].Sustainability
                    },
                    { path: 'Model.Model properties.Architecture', old: this.model.card_data.Model['Model properties']?.Architecture, new: this.draft.Model['Model properties'].Architecture },
                    { path: 'Model.Model properties.Dataset', old: this.model.card_data.Model['Model properties']?.Dataset, new: this.draft.Model['Model properties'].Dataset },
                    { path: 'Model.Model properties.Indications for use', old: this.model.card_data.Model['Model properties']?.['Indications for use'], new: this.draft.Model['Model properties']['Indications for use'] },
                    { path: 'Model.Model performance.Comments', old: this.model.card_data.Model['Model performance']?.Comments, new: this.draft.Model['Model performance']?.Comments },
                    { path: 'Model.Model properties.Limitations', old: this.model.card_data.Model['Model properties']?.Limitations, new: this.draft.Model['Model properties'].Limitations },
                    { path: 'Model.Model properties.Use', old: this.model.card_data.Model['Model properties']?.Use, new: this.draft.Model['Model properties'].Use },
                    { path: 'Model.Model properties.Validation', old: this.model.card_data.Model['Model properties']?.Validation, new: this.draft.Model['Model properties'].Validation },
                    { path: 'Model.Model properties.Regulatory information.Comment', old: this.model.card_data.Model['Model properties']?.['Regulatory information']?.Comment, new: this.draft.Model['Model properties']['Regulatory information']?.Comment },
                    // [NEW] Merged Content field
                    { path: 'Model.Indexing.Content', old: this.model.card_data.Model.Indexing?.Content, new: this.draft.Model.Indexing.Content }
                ];

                for (const f of fields) {
                    // Stringify for robust comparison (handles arrays/objects)
                    if (JSON.stringify(f.old) !== JSON.stringify(f.new)) {
                        if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                            await window.safeFetch('/rest/v1/model_edits', {
                                method: 'POST',
                                body: JSON.stringify({
                                    model_id: this.model.id,
                                    user_id: this.user.id,
                                    field_path: f.path,
                                    old_value: JSON.stringify(f.old) || '',
                                    new_value: JSON.stringify(f.new) || '',
                                    severity: this.severities[f.path] || 'minor'
                                })
                            });
                        } else {
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
                }

                // Prepare Update Payload
                const updatePayload = {
                    card_data: this.draft
                };

                // Only add verification data if requested
                if (shouldVerify) {
                    updatePayload.is_verified = true;
                    updatePayload.verified_by = this.user.id;
                    updatePayload.verification_date = new Date(); // SafeFetch handles date serialization? JSON.stringify works.
                }

                let error;
                if (window.safeFetch && Alpine.store('auth').useRawFetch) {
                    const res = await window.safeFetch(`/rest/v1/models?id=eq.${this.model.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify(updatePayload)
                    });
                    error = res.error;
                } else {
                    const res = await sbClient.from('models').update(updatePayload).eq('id', this.model.id);
                    error = res.error;
                }

                if (!error) {
                    this.model.card_data = this.draft;
                    if (shouldVerify) {
                        this.model.is_verified = true;
                        alert('Verified & Saved!');
                    } else {
                        alert('Changes Saved (Not Verified)!');
                    }
                } else {
                    console.error("[Details] Save error:", error);
                    alert('Save failed: ' + (error.message || JSON.stringify(error)));
                }

            } catch (e) {
                console.error("[Details] Critical error in saveChanges:", e);
                alert("Critical error saving changes: " + e.message);
            }
        }
    }));
});