let screenshotBlob = null;
let currentFilename = 'screenshot.png';
let currentMode = 'single';
let multiImages = [];

function toggleAdvanced() {
    document.getElementById('advanced-options').classList.toggle('visible');
}

function setMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const multiSection = document.getElementById('multi-section');
    const submitBtn = document.getElementById('submit-btn');
    const heightGroup = document.getElementById('height').closest('.form-group');
    const outputWidthGroup = document.getElementById('output_width').closest('.form-group');

    if (mode === 'multi') {
        multiSection.classList.remove('hidden');
        heightGroup.classList.add('hidden');
        outputWidthGroup.classList.add('hidden');
        document.getElementById('advanced-options').classList.add('visible');
        if (document.querySelectorAll('.output-row').length === 0) {
            addOutput();
            addOutput();
        }
        submitBtn.textContent = '📸 Capture Multiple Screenshots';
    } else {
        multiSection.classList.add('hidden');
        heightGroup.classList.remove('hidden');
        outputWidthGroup.classList.remove('hidden');
        submitBtn.textContent = '📸 Capture Screenshot';
    }
    resetForm();
}

function addOutput() {
    const list = document.getElementById('outputs-list');
    const index = list.children.length + 1;
    const row = document.createElement('div');
    row.className = 'output-row';
    row.innerHTML = `
        <span class="output-label">Output ${index}</span>
        <input type="number" placeholder="Height (px)" class="output-input" data-field="height">
        <input type="number" placeholder="Output Width (px)" class="output-input" data-field="output_width">
        <button type="button" class="btn-remove" onclick="removeOutput(this)">×</button>
    `;
    list.appendChild(row);
}

function removeOutput(btn) {
    btn.closest('.output-row').remove();
    // Renumber remaining outputs
    document.querySelectorAll('.output-row').forEach((row, i) => {
        row.querySelector('.output-label').textContent = `Output ${i + 1}`;
    });
}

function showError(message) {
    document.querySelector('.error')?.remove();
    const err = document.createElement('div');
    err.className = 'error';
    err.innerHTML = `<div class="error-title">Error</div><div>${message}</div>`;
    document.querySelector('.form-container').prepend(err);
}

async function captureScreenshot(e) {
    e.preventDefault();
    const btn = document.getElementById('submit-btn');
    const data = new FormData(e.target);

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Capturing...';
    document.querySelector('.error')?.remove();

    try {
        if (currentMode === 'multi') {
            await captureMultiScreenshot(data);
        } else {
            await captureSingleScreenshot(data);
        }
    } catch (error) {
        showError(error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = currentMode === 'multi' ? '📸 Capture Multiple Screenshots' : '📸 Capture Screenshot';
    }
}

async function captureSingleScreenshot(data) {
    const body = { url: data.get('url') };

    ['width', 'height', 'waitTime', 'output_width', 'output_quality'].forEach(f => {
        const v = data.get(f);
        if (v) body[f] = parseInt(v);
    });

    if (data.get('output_format')) body.output_format = data.get('output_format');

    const res = await fetch('/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Screenshot failed');
    }

    const contentType = res.headers.get('Content-Type');
    const ext = contentType === 'image/webp' ? 'webp' : contentType === 'image/jpeg' ? 'jpg' : 'png';

    currentFilename = `screenshot-${Date.now()}.${ext}`;
    screenshotBlob = await res.blob();
    document.getElementById('screenshot-img').src = URL.createObjectURL(screenshotBlob);
    document.getElementById('result-container').classList.add('visible');
    document.getElementById('result-container-multi').classList.remove('visible');
    scrollToResult();
}

async function captureMultiScreenshot(data) {
    const body = { url: data.get('url') };

    ['width', 'waitTime'].forEach(f => {
        const v = data.get(f);
        if (v) body[f] = parseInt(v);
    });

    if (data.get('output_format')) body.output_format = data.get('output_format');
    if (data.get('output_quality')) body.output_quality = parseInt(data.get('output_quality'));

    // Read outputs directly from DOM
    const outputs = [];
    document.querySelectorAll('.output-row').forEach(row => {
        const height = row.querySelector('[data-field="height"]').value;
        const output_width = row.querySelector('[data-field="output_width"]').value;
        if (height || output_width) {
            outputs.push({
                height: height ? parseInt(height) : null,
                output_width: output_width ? parseInt(output_width) : null
            });
        }
    });

    if (outputs.length === 0) {
        throw new Error('Please specify height or output_width for at least one output');
    }

    body.outputs = outputs;

    const res = await fetch('/shot-multi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Multi screenshot failed');
    }

    const result = await res.json();
    displayMultiResults(result.images);
}

function displayMultiResults(images) {
    multiImages = images;
    const container = document.getElementById('multi-results');
    container.innerHTML = images.map((img, i) => {
        const ext = img.content_type === 'image/webp' ? 'webp'
                    : img.content_type === 'image/jpeg' ? 'jpg' : 'png';
        return `
            <div class="multi-result">
                <div class="multi-result-header">
                    <span>${img.width} × ${img.height}</span>
                    <button class="btn btn-sm btn-secondary" onclick="downloadMultiImage(${i})">
                        ⬇️ Download
                    </button>
                </div>
                <img src="data:${img.content_type};base64,${img.data}" alt="Screenshot ${i + 1}">
            </div>
        `;
    }).join('');

    document.getElementById('result-container-multi').classList.add('visible');
    document.getElementById('result-container').classList.remove('visible');
    scrollToResult();
}

function downloadMultiImage(index) {
    const img = multiImages[index];
    if (!img) return;

    const ext = img.content_type === 'image/webp' ? 'webp'
                : img.content_type === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `screenshot-${index + 1}_${img.width}x${img.height}.${ext}`;
    const byteChars = atob(img.data);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
        bytes[i] = byteChars.charCodeAt(i);
    }

    const blob = new Blob([bytes], { type: img.content_type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

function downloadScreenshot() {
    if (!screenshotBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(screenshotBlob);
    a.download = currentFilename;
    a.click();
    URL.revokeObjectURL(a.href);
}

function resetForm() {
    document.getElementById('screenshot-form').reset();
    document.getElementById('result-container').classList.remove('visible');
    document.getElementById('result-container-multi').classList.remove('visible');
    document.getElementById('url').focus();
    screenshotBlob = null;
    multiImages = [];
}

function scrollToResult() {
    const container = currentMode === 'multi'
        ? document.getElementById('result-container-multi')
        : document.getElementById('result-container');
    container.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('screenshot-form').addEventListener('submit', captureScreenshot);
