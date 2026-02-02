// js/charts.js
let chartInstances = {};

function renderDashboardCharts(models) {
    // Wait for DOM
    setTimeout(() => {
        const modalities = ["CT", "FL", "MR", "NM", "PET", "US", "XR"];
        
        // 1. Modality Chart
        drawChart('modalityChart', 'doughnut', modalities, (label) => {
            return models.filter(r => r.card_data.Model.Indexing?.Content?.includes(label)).length;
        }, modalities.map(m => FULL_MAPPING[m] || m));

        // 2. Specialty Chart
        const specialties = [...new Set(models.flatMap(r => r.card_data.Model.Indexing?.Content || []).filter(c => !modalities.includes(c)))].sort();
        drawChart('specialtyChart', 'bar', specialties, (label) => {
            return models.filter(r => r.card_data.Model.Indexing?.Content?.includes(label)).length;
        }, specialties.map(s => FULL_MAPPING[s] || s));

        // 3. Validation
        drawChart('validationChart', 'pie', ['internal', 'external', 'none'], (label) => {
            return models.filter(r => (r.card_data.Model['Model properties'].Validation || 'none').toLowerCase().includes(label)).length;
        }, ['Internal', 'External', 'None']);

        // 4. Weights
        const hasWeights = models.filter(r => checkWeights(r.card_data)).length;
        drawChart('weightsChart', 'doughnut', ['Available', 'Not Available'], () => null, ['Available', 'Not Available'], [hasWeights, models.length - hasWeights]);

    }, 100);
}

function drawChart(id, type, labels, countFn, displayLabels, directData = null) {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    if (chartInstances[id]) chartInstances[id].destroy();

    const data = directData || labels.map(l => countFn(l));

    chartInstances[id] = new Chart(ctx, {
        type: type,
        data: {
            labels: displayLabels,
            datasets: [{
                data: data,
                backgroundColor: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#6366f1']
            }]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            plugins: { legend: { position: type === 'bar' ? 'none' : 'right' } } 
        }
    });
}