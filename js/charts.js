// js/charts.js
Chart.defaults.font.size = 14;
let chartInstances = {};

// Modified to accept direct stats object
function renderDashboardCharts(models, stats) {
    if (!stats && !models) return;

    // Wait for DOM
    setTimeout(() => {
        // 1. Modality Chart
        // Use stats.modalities if available, else derive (fallback removed for brevity/performance)
        if (stats && stats.modalities) {
            const labels = Object.keys(stats.modalities);
            const data = Object.values(stats.modalities);
            // Sort by count desc
            const sorted = labels.map((l, i) => ({ l, d: data[i] })).sort((a, b) => b.d - a.d);

            drawChart('modalityChart', 'doughnut',
                sorted.map(x => x.l),
                null,
                sorted.map(x => FULL_MAPPING[x.l] || x.l),
                sorted.map(x => x.d)
            );
        }

        // 2. Specialty Chart
        if (stats && stats.specialties) {
            const labels = Object.keys(stats.specialties).filter(l => l !== 'QI');
            const data = labels.map(l => stats.specialties[l]);
            const sorted = labels.map((l, i) => ({ l, d: data[i] })).sort((a, b) => b.d - a.d);

            drawChart('specialtyChart', 'bar',
                sorted.map(x => x.l),
                null,
                sorted.map(x => FULL_MAPPING[x.l] || x.l),
                sorted.map(x => x.d)
            );
        }

        // 3. Validation
        if (stats && stats.validation) {
            const allowed = ['n/a', 'internal', 'external'];
            const labels = Object.keys(stats.validation).filter(l => allowed.includes(l));
            const data = labels.map(l => stats.validation[l]);
            drawChart('validationChart', 'pie', labels, null, labels.map(l => l.charAt(0).toUpperCase() + l.slice(1)), data);
        }

        // 4. Weights
        if (stats && stats.weights) {
            const labels = ['Available', 'Not Available'];
            const data = [stats.weights['Available'] || 0, stats.weights['Not Available'] || 0];
            drawChart('weightsChart', 'doughnut', labels, null, labels, data);
        }

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
            plugins: { legend: { position: type === 'bar' ? 'none' : 'right' } },
            ...(type === 'bar' ? {
                scales: {
                    x: {
                        display: true,
                        ticks: {
                            autoSkip: false,
                            maxRotation: 45,
                            minRotation: 45
                        }
                    }
                }
            } : {})
        }
    });
}