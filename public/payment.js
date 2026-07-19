document.addEventListener('DOMContentLoaded', async () => {
  // Inject spin keyframes style
  const spinStyle = document.createElement('style');
  spinStyle.innerHTML = `
    @keyframes payment-spin {
      to { transform: rotate(360deg); }
    }
    .payment-spinner {
      width: 48px;
      height: 48px;
      border: 4px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: payment-spin 1s linear infinite;
    }
  `;
  document.head.appendChild(spinStyle);

  // View Containers
  const viewCheckout = document.getElementById('checkout-form-view');
  const viewInstructions = document.getElementById('instructions-view');
  const viewCamera = document.getElementById('camera-view');
  const viewInvoice = document.getElementById('invoice-view');

  // Plan Details Elements
  const planName = document.getElementById('selected-plan-name');
  const planPrice = document.getElementById('selected-plan-price');
  const planFeatures = document.getElementById('selected-plan-features');
  const instructionsDetail = document.getElementById('payment-instructions-detail');

  // Checkout View Elements
  const checkoutEmailDisplay = document.getElementById('checkout-email-display');
  const btnCheckoutPay = document.getElementById('btn-checkout-pay');
  const btnCheckoutPayText = document.getElementById('btn-checkout-pay-text');

  // Instructions View Elements
  const btnInstrBatal = document.getElementById('btn-instr-batal');
  const btnInstrLanjut = document.getElementById('btn-instr-lanjut');

  // Camera View Elements
  const cameraFrame = document.getElementById('checkout-camera-frame');
  const uploadBox = document.getElementById('checkout-upload-box');
  const video = document.getElementById('checkout-video');
  const fileInput = document.getElementById('checkout-file-input');
  const canvas = document.getElementById('checkout-canvas');
  const btnShutterCapture = document.getElementById('btn-shutter-capture');
  const btnCameraKembali = document.getElementById('btn-camera-kembali');
  const btnCameraUploadSubmit = document.getElementById('btn-camera-upload-submit');

  // Invoice View Elements
  const invoiceStatusBadge = document.getElementById('invoice-status-badge');
  const invoiceStatusText = document.getElementById('invoice-status-text');
  const invoiceVisuals = document.getElementById('invoice-visuals');
  const invDetailsId = document.getElementById('inv-details-id');
  const invDetailsPlan = document.getElementById('inv-details-plan');
  const invDetailsAmount = document.getElementById('inv-details-amount');
  const invDetailsEmail = document.getElementById('inv-details-email');
  const invDetailsDate = document.getElementById('inv-details-date');
  const invoiceActionContainer = document.getElementById('invoice-action-container');
  const invoiceEvaluationLog = document.getElementById('invoice-evaluation-log');

  const langSelect = document.getElementById('payment-lang-select');

  // State
  let selectedPlan = 'lite';
  let activeMethod = 'webcam'; // 'webcam' or 'upload'
  let cameraStream = null;
  let activeImageBase64 = null;
  let activeImageMime = 'image/jpeg';
  let countdownInterval = null;
  let userEmail = '-';

  // Language management
  if (langSelect) {
    langSelect.value = window.getLang();
    langSelect.addEventListener('change', (e) => {
      window.setLang(e.target.value);
    });
  }

  window.addEventListener('langchange', () => {
    updateLayout();
  });

  // Parse URL plan
  const urlParams = new URLSearchParams(window.location.search);
  const urlPlan = urlParams.get('plan');
  if (urlPlan === 'pro') {
    selectedPlan = 'pro';
  } else if (urlPlan === 'max') {
    selectedPlan = 'max';
  }

  // Load User Email + terapkan gating bahasa Indonesia (khusus plan Pro/Max —
  // sama seperti di dashboard, supaya tidak ada celah ganti ke 'id' lewat
  // halaman ini lalu kepakai lagi di tempat lain).
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const userData = await res.json();
      userEmail = userData.email || '-';
      if (checkoutEmailDisplay) checkoutEmailDisplay.textContent = userEmail;

      const tier = userData.subscription || 'free';
      const canUseBahasaIndonesia = tier === 'pro' || tier === 'max';
      if (langSelect && !canUseBahasaIndonesia) {
        const idOption = langSelect.querySelector('option[value="id"]');
        if (idOption) idOption.disabled = true;
        if (window.getLang() === 'id') {
          window.setLang('en');
          langSelect.value = 'en';
        }
      }
    }
  } catch (err) {
    console.error('Gagal memuat profil pengguna:', err);
  }

  function updateLayout() {
    const periodText = window.t('sub.perMinggu') || '/minggu';
    const litePeriodText = window.t('sub.litePeriod') || '/3 hari';
    
    // Populate Left plan info
    if (selectedPlan === 'lite') {
      planName.textContent = window.t('sub.lite') + ' Plan';
      planPrice.innerHTML = `
        <div style="display: flex; flex-direction: column; align-items: flex-start; line-height: 1.2;">
          <span style="text-decoration: line-through; color: var(--muted); font-size: 1.1rem; font-weight: 500; margin-bottom: 4px;">Rp 50.000</span>
          <span>Rp 100.000<span style="font-size: 1rem; font-weight: 600; color: var(--ink-2); margin-left: 6px;">${litePeriodText}</span></span>
        </div>
      `;
      instructionsDetail.innerHTML = window.t('sub.instrLite');
      btnCheckoutPayText.textContent = `${window.t('sub.btnUpgrade')} Lite (Rp 100.000)`;
      
      planFeatures.innerHTML = `
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.limitLite')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #ef4444;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span style="color: var(--muted);">${window.t('sub.noTg')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #ef4444;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          <span style="color: var(--muted);">${window.t('sub.noMcp')}</span>
        </li>
      `;
    } else if (selectedPlan === 'pro') {
      planName.textContent = window.t('sub.pro') + ' Plan';
      planPrice.innerHTML = `Rp 5.000.000<span style="font-size: 1rem; font-weight: 600; color: var(--ink-2); margin-left: 6px;">${periodText}</span>`;
      instructionsDetail.innerHTML = window.t('sub.instrPro');
      btnCheckoutPayText.textContent = `${window.t('sub.btnUpgrade')} Pro (Rp 5.000.000)`;
      
      planFeatures.innerHTML = `
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.limitPro')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.yesTg')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.yesMcp')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.prioritySupport')}</span>
        </li>
      `;
    } else {
      planName.textContent = window.t('sub.max') + ' Plan';
      planPrice.innerHTML = `Rp 1.000.000.000<span style="font-size: 1rem; font-weight: 600; color: var(--ink-2); margin-left: 6px;">${periodText}</span>`;
      instructionsDetail.innerHTML = window.t('sub.instrMax');
      btnCheckoutPayText.textContent = `${window.t('sub.btnUpgrade')} Max (Rp 1M)`;
      
      planFeatures.innerHTML = `
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.limitMax')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.yesTg')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.yesMcp')}</span>
        </li>
        <li>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;"><polyline points="20 6 9 17 4 12"></polyline></svg>
          <span>${window.t('sub.prioritySupport')}</span>
        </li>
      `;
    }
  }

  function showView(viewId) {
    viewCheckout.style.display = viewId === 1 ? 'block' : 'none';
    viewInstructions.style.display = viewId === 2 ? 'block' : 'none';
    viewCamera.style.display = viewId === 3 ? 'block' : 'none';
    viewInvoice.style.display = viewId === 4 ? 'block' : 'none';
    
    // Manage mobile view layout
    const stripeLeft = document.querySelector('.stripe-left');
    if (stripeLeft) {
      if (viewId === 2 || viewId === 3) {
        stripeLeft.classList.add('hidden-mobile-step');
      } else {
        stripeLeft.classList.remove('hidden-mobile-step');
      }
    }

    if (viewId !== 3) {
      stopCamera();
    }
  }

  // Camera Management
  async function startCamera() {
    if (activeMethod !== 'webcam') return;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
      video.srcObject = cameraStream;
      cameraFrame.style.display = 'block';
      uploadBox.style.display = 'none';
      btnShutterCapture.style.display = 'block';
      btnCameraUploadSubmit.style.display = 'none';
    } catch (err) {
      console.warn('Webcam error, fallback to file upload:', err);
      switchToUploadMode();
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(track => track.stop());
      cameraStream = null;
    }
    video.srcObject = null;
  }

  function switchToUploadMode() {
    activeMethod = 'upload';
    stopCamera();
    cameraFrame.style.display = 'none';
    uploadBox.style.display = 'flex';
    btnShutterCapture.style.display = 'none';
    btnCameraUploadSubmit.style.display = 'block';
    fileInput.value = '';
  }

  // File Upload Box Trigger
  uploadBox.addEventListener('click', () => {
    fileInput.click();
  });

  // File input change
  fileInput.addEventListener('change', (e) => {
    const file = e.target.value;
    if (file) {
      uploadBox.querySelector('p').textContent = file.split('\\').pop();
    }
  });

  // View 1 (Checkout) -> View 2 (Instructions)
  btnCheckoutPay.addEventListener('click', () => {
    showView(2);
  });

  // View 2 (Instructions) Actions
  btnInstrBatal.addEventListener('click', () => {
    showView(1);
  });

  btnInstrLanjut.addEventListener('click', () => {
    showView(3);
    activeMethod = 'webcam'; // default to camera
    startCamera();
  });

  // Sebagian device crash saat kamera diaktifkan (getUserMedia) — kasih jalan
  // pintas langsung ke mode upload file dari langkah instruksi, tanpa perlu
  // mencoba kamera dulu (beda dari switchToUploadMode() yang jadi fallback
  // otomatis kalau startCamera() gagal).
  const btnInstrUploadInstead = document.getElementById('btn-instr-upload-instead');
  if (btnInstrUploadInstead) {
    btnInstrUploadInstead.addEventListener('click', () => {
      showView(3);
      switchToUploadMode();
    });
  }

  // View 3 (Camera) Actions
  btnCameraKembali.addEventListener('click', () => {
    showView(2);
  });

  // Capture Shutter Button (Webcam Mode)
  btnShutterCapture.addEventListener('click', () => {
    if (!cameraStream) return;
    const width = video.videoWidth || 640;
    const height = video.videoHeight || 480;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, width, height);
    activeImageBase64 = canvas.toDataURL('image/jpeg').split(',')[1];
    activeImageMime = 'image/jpeg';
    
    stopCamera();
    processVerification();
  });

  // Submit Uploaded File Button (File Upload Mode)
  btnCameraUploadSubmit.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) {
      alert(window.t('sub.selectPhoto'));
      return;
    }
    activeImageMime = file.type;
    activeImageBase64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(file);
    });
    
    processVerification();
  });

  // VIEW 4: Verification & Realtime Invoice
  async function processVerification() {
    showView(4);
    
    // Generate Invoice Data
    const randomInvId = 'INV-' + Math.floor(1000000 + Math.random() * 9000000);
    const todayDate = new Date().toLocaleDateString(window.getLang() === 'id' ? 'id-ID' : 'en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    
    invDetailsId.textContent = randomInvId;
    invDetailsPlan.textContent = selectedPlan === 'lite' ? 'Lite' : (selectedPlan === 'pro' ? 'Pro' : 'Max');
    invDetailsAmount.textContent = selectedPlan === 'lite' ? 'Rp 100.000' : (selectedPlan === 'pro' ? 'Rp 5.000.000' : 'Rp 1.000.000.000');
    invDetailsEmail.textContent = userEmail;
    invDetailsDate.textContent = todayDate;

    // Reset view details to Verifying State
    invoiceStatusBadge.style.background = '#3b82f6';
    invoiceStatusBadge.style.color = '#ffffff';
    invoiceStatusText.textContent = window.t('sub.invoiceVerifying');
    
    invoiceVisuals.innerHTML = '<div class="payment-spinner"></div>';
    invoiceActionContainer.innerHTML = '';
    if (invoiceEvaluationLog) invoiceEvaluationLog.textContent = '';

    try {
      const response = await fetch('/api/subscription/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: selectedPlan,
          imageBase64: activeImageBase64,
          imageMime: activeImageMime
        })
      });

      const resData = await response.json();
      if (response.ok) {
        // Success PAID state
        invoiceStatusBadge.style.background = '#10b981';
        invoiceStatusBadge.style.color = '#ffffff';
        invoiceStatusText.textContent = window.t('sub.invoicePaid');
        
        // Success Checkmark SVG
        invoiceVisuals.innerHTML = `
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="animation: payment-spin-in 0.5s ease-out;">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        `;

        // Start Countdown 2s
        let countdown = 2;
        const renderCountdown = () => {
          invoiceActionContainer.innerHTML = `
            <p style="text-align: center; font-size: 0.9rem; color: var(--ink-2); font-weight: 600;">
              ${window.t('sub.redirectMsg', { s: countdown })}
            </p>
          `;
        };
        renderCountdown();
        
        clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
          countdown--;
          renderCountdown();
          if (countdown <= 0) {
            clearInterval(countdownInterval);
            window.location.href = '/dashboard';
          }
        }, 1000);
      } else {
        // Fail state
        invoiceStatusBadge.style.background = '#ef4444';
        invoiceStatusBadge.style.color = '#ffffff';
        invoiceStatusText.textContent = window.t('sub.invoiceFailed');
        
        // Cross SVG
        invoiceVisuals.innerHTML = `
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        `;
        invoiceEvaluationLog.textContent = (resData.error ? window.tServer(resData.error) : 'Bukti pembayaran tidak valid.');

        // Render Action Buttons
        invoiceActionContainer.innerHTML = `
          <div style="display: flex; gap: 12px; margin-top: 15px;">
            <button type="button" class="btn-secondary" id="btn-invoice-batal" style="flex: 1; padding: 12px; font-weight: 700; border-radius: 8px;">Batal</button>
            <button type="button" class="btn-primary" id="btn-invoice-retry" style="flex: 2; padding: 12px; font-weight: 700; border-radius: 8px; background: var(--accent); color: var(--accent-ink);">Coba Lagi</button>
          </div>
        `;
        
        document.getElementById('btn-invoice-batal').addEventListener('click', () => {
          window.location.href = '/dashboard';
        });
        document.getElementById('btn-invoice-retry').addEventListener('click', () => {
          showView(3);
          activeMethod = 'webcam';
          startCamera();
        });
      }
    } catch (err) {
      console.error(err);
      invoiceStatusBadge.style.background = '#ef4444';
      invoiceStatusBadge.style.color = '#ffffff';
      invoiceStatusText.textContent = 'ERROR';
      invoiceVisuals.innerHTML = '❌';
      invoiceEvaluationLog.textContent = 'Terjadi kesalahan sistem. Silakan coba kembali.';
      
      invoiceActionContainer.innerHTML = `
        <div style="display: flex; gap: 12px; margin-top: 15px;">
          <button type="button" class="btn-secondary" id="btn-invoice-batal" style="flex: 1; padding: 12px; font-weight: 700; border-radius: 8px;">Batal</button>
          <button type="button" class="btn-primary" id="btn-invoice-retry" style="flex: 2; padding: 12px; font-weight: 700; border-radius: 8px; background: var(--accent); color: var(--accent-ink);">Coba Lagi</button>
        </div>
      `;
      document.getElementById('btn-invoice-batal').addEventListener('click', () => {
        window.location.href = '/dashboard';
      });
      document.getElementById('btn-invoice-retry').addEventListener('click', () => {
        showView(3);
        activeMethod = 'webcam';
        startCamera();
      });
    }
  }

  // Initial Boot
  updateLayout();
});
