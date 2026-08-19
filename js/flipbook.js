/* ==========================================================================
   E-CATALOG FLIPBOOK — MAIN LOGIC
   --------------------------------------------------------------------------
   Alur kerja:
     1. Muat PDF via PDF.js (library eksternal via CDN)
     2. Deteksi jumlah halaman PDF secara dinamis (tidak hardcode)
     3. Render setiap halaman PDF ke <canvas>, ubah jadi gambar (lazy)
     4. Suapkan gambar halaman ke StPageFlip (engine animasi balik halaman 3D)
     5. StPageFlip menangani interaksi drag-sudut, kurva halaman, bayangan,
        dan physics balik-halaman secara realistis (mouse & touch)

   Mengapa StPageFlip?
     - Library ringan, murni JS, dibuat khusus untuk mensimulasikan
       fisika kertas nyata: drag dari sudut, kurva/lipat halaman,
       bayangan dinamis, deteksi threshold "cukup jauh vs kembali".
     - Tanpa StPageFlip, efek ini harus ditulis ulang manual dengan
       transform 3D CSS + kalkulasi vektor mouse, yang jauh lebih rapuh.

   Mengapa PDF.js?
     - Satu-satunya cara merender PDF asli menjadi gambar di browser
       tanpa backend/server, sesuai requirement "satu file PDF sumber".

   Mengganti library nanti:
     - Untuk mengganti engine flip: cukup ganti bagian "PAGE FLIP ENGINE"
       di bawah ini, method public (loadFromImages, flipNext, flipPrev,
       turnToPage) dibuat sebagai wrapper agar bagian lain kode tidak
       perlu tahu detail library yang dipakai.
     - Untuk mengganti sumber PDF: cukup ganti nilai PDF_URL.
   ========================================================================== */

(() => {
  "use strict";

  /* ------------------------------------------------------------------
     KONFIGURASI
  ------------------------------------------------------------------ */
  const CONFIG = {
    // Ganti path ini dengan PDF katalog asli Anda kapan saja.
    // Updated to use the newly uploaded PDF (replace filename if different).
    PDF_URL: window.location.hostname.endsWith("github.io")
      ? "https://media.githubusercontent.com/media/rafirst/tag-e-catalogue/main/assets/catalog/TAG-E-CATALOGUE.pdf"
      : "assets/catalog/TAG-E-CATALOGUE.pdf",

    // Kualitas render halaman (device pixel ratio dibatasi demi performa)
    // Increase render scale and max DPR for HD output in the flipbook
    RENDER_SCALE: 2.2,
    MAX_DPR: 3,

    // Ukuran dasar satu halaman buku (rasio disesuaikan otomatis dari PDF)
    BASE_PAGE_WIDTH: 560,
    BASE_PAGE_HEIGHT: 760,

    ZOOM_MIN: 1,
    ZOOM_MAX: 2.4,
    ZOOM_STEP: 0.25,

    LOADING_TIMEOUT_MS: 120000,
  };

  /* ------------------------------------------------------------------
     STATE
  ------------------------------------------------------------------ */
  const state = {
    pdfDoc: null,
    pageCount: 0,
    pageFlip: null,
    renderedPages: new Map(), // pageNumber -> dataURL
    pageMeta: {}, // diagnostics per page (width/height/edge-white%)
    pageAspect: CONFIG.BASE_PAGE_HEIGHT / CONFIG.BASE_PAGE_WIDTH,
    zoom: 1,
    isDemoMode: false,
    hintDismissed: false,
    isPanning: false,
    panStart: { x: 0, y: 0, scrollLeft: 0, scrollTop: 0 },
  };

  /* ------------------------------------------------------------------
     DOM REFS
  ------------------------------------------------------------------ */
  const el = {
    errorScreen: document.getElementById("error-screen"),
    errorMessage: document.getElementById("error-message"),
    errorRetryBtn: document.getElementById("error-retry-btn"),

    app: document.getElementById("app"),
    stage: document.getElementById("stage"),
    bookShell: document.getElementById("book-shell"),
    flipbookEl: document.getElementById("flipbook"),

    dragHint: document.getElementById("drag-hint"),
    navPrev: document.getElementById("nav-prev"),
    navNext: document.getElementById("nav-next"),

    pageCurrent: document.getElementById("page-current"),
    pageTotal: document.getElementById("page-total"),
    progressFill: document.getElementById("progress-fill"),

    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
  };

  /* ==========================================================================
     PHASE 1–3: LOAD PDF & RENDER PAGES
     ========================================================================== */

  function showError(message) {
    // If message is an Error, extract message
    const msg = message && message.message ? message.message : message;
    el.errorMessage.textContent = msg;
    // show optional details area if present
    const detailsEl = document.getElementById("error-details");
    if (detailsEl && typeof message === "object" && message._details) {
      detailsEl.textContent = String(message._details);
      detailsEl.classList.remove("hidden");
    } else if (detailsEl) {
      detailsEl.classList.add("hidden");
      detailsEl.textContent = "";
    }
    el.errorScreen.classList.remove("hidden");
  }

  async function initPdfJs() {
    if (!window.pdfjsLib) {
      throw new Error("PDF.js gagal dimuat dari CDN.");
    }
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  /**
   * Memuat dokumen PDF dan mendeteksi jumlah halaman secara dinamis.
   * Jika gagal (mis. dummy PDF belum tersedia), otomatis masuk DEMO MODE
   * agar UI tetap bisa diuji tanpa PDF nyata.
   */
  async function loadPdf() {
    await initPdfJs();

    const loadingTask = window.pdfjsLib.getDocument(CONFIG.PDF_URL);

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), CONFIG.LOADING_TIMEOUT_MS)
    );

    try {
      state.pdfDoc = await Promise.race([loadingTask.promise, timeout]);
      state.pageCount = state.pdfDoc.numPages; // deteksi dinamis, tidak hardcode
      if (state.pageCount < 1) throw new Error("EMPTY_PDF");

      // PENTING: deteksi rasio aspek halaman ASLI dari PDF di sini, SEBELUM
      // FlipEngine dibuat. Sebelumnya rasio aspek baru diketahui setelah
      // halaman pertama dirender di dalam FlipEngine.init(), padahal ukuran
      // buku (lebar/tinggi) sudah dihitung & dikunci lebih dulu memakai
      // rasio default (portrait). Akibatnya, jika PDF ternyata berbentuk
      // landscape/lanskap (seperti katalog ini), buku dibuat terlalu sempit
      // dan menyisakan area kosong besar di kiri-kanan panggung.
      try {
        const firstPage = await state.pdfDoc.getPage(1);
        const rawViewport = firstPage.getViewport({ scale: 1 });
        state.pageAspect = rawViewport.height / rawViewport.width;
      } catch (aspectErr) {
        console.warn("Gagal membaca rasio halaman pertama, pakai rasio default.", aspectErr);
      }
    } catch (err) {
      console.error("Gagal memuat PDF:", err);
      throw err;
    }
  }

  /**
   * Mode demo: dipakai bila dummy-catalog.pdf belum ditaruh di /assets/catalog/.
   * Menghasilkan halaman placeholder bergaya katalog otomotif agar interaksi
   * flip tetap bisa diuji end-to-end.
   */
  function enterDemoMode() {
    state.isDemoMode = true;
    state.pageCount = 20;
  }

  /**
   * Merender satu halaman PDF menjadi data URL gambar (lazy, dipanggil
   * per-halaman saat dibutuhkan StPageFlip, bukan sekaligus di awal —
   * ini penting untuk performa pada katalog 20–100+ halaman).
   */
  async function renderPdfPageToDataUrl(pageNumber) {
    if (state.renderedPages.has(pageNumber)) {
      return state.renderedPages.get(pageNumber);
    }

    if (state.isDemoMode) {
      const dataUrl = renderDemoPage(pageNumber);
      state.renderedPages.set(pageNumber, dataUrl);
      return dataUrl;
    }

    const page = await state.pdfDoc.getPage(pageNumber);
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR);
    // Determine target page CSS size (width & height) from FlipEngine so the
    // rendered image resolution is high enough to fully COVER the display
    // box in both dimensions (container kini sengaja diisi penuh kiri-kanan
    // DAN atas-bawah, tidak lagi mengikuti rasio asli PDF — kelebihan pada
    // salah satu sisi akan di-crop halus lewat object-fit: cover di CSS).
    let targetPageCssW = CONFIG.BASE_PAGE_WIDTH;
    let targetPageCssH = CONFIG.BASE_PAGE_HEIGHT;
    try {
      const dims = FlipEngine.computeDimensions();
      if (dims && dims.width) targetPageCssW = dims.width;
      if (dims && dims.height) targetPageCssH = dims.height;
    } catch (e) {
      // fallback ke ukuran default
    }

    // Hitung scale berdasarkan sisi yang PALING MEMBUTUHKAN resolusi lebih
    // tinggi (logika yang sama seperti object-fit: cover), supaya hasil
    // render tetap tajam di kedua dimensi, bukan hanya mengikuti lebar.
    const unscaled = page.getViewport({ scale: 1 });
    const scaleForWidth = (targetPageCssW * dpr) / unscaled.width;
    const scaleForHeight = (targetPageCssH * dpr) / unscaled.height;
    const scale = Math.max(1, scaleForWidth, scaleForHeight);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Analyze edges for large white gutters (diagnostic)
    try {
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const sampleCols = Math.max(8, Math.floor(canvas.width * 0.05));
      let leftWhite = 0, rightWhite = 0, totalLeft = 0, totalRight = 0;
      const stepY = Math.max(2, Math.floor(canvas.height / 200));
      for (let x = 0; x < sampleCols; x++) {
        for (let y = 0; y < canvas.height; y += stepY) {
          const idx = (y * canvas.width + x) * 4;
          const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
          const lum = (0.299 * r + 0.587 * g + 0.114 * b);
          totalLeft++;
          if (lum > 240) leftWhite++;
        }
      }
      for (let x = canvas.width - sampleCols; x < canvas.width; x++) {
        for (let y = 0; y < canvas.height; y += stepY) {
          const idx = (y * canvas.width + x) * 4;
          const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
          const lum = (0.299 * r + 0.587 * g + 0.114 * b);
          totalRight++;
          if (lum > 240) rightWhite++;
        }
      }
      state.pageMeta[pageNumber] = {
        width: canvas.width,
        height: canvas.height,
        leftWhitePct: Math.round((leftWhite / Math.max(1, totalLeft)) * 100),
        rightWhitePct: Math.round((rightWhite / Math.max(1, totalRight)) * 100),
      };
      // If significant white gutters detected, perform precise crop and upscale to fill width
      const leftPct = state.pageMeta[pageNumber].leftWhitePct;
      const rightPct = state.pageMeta[pageNumber].rightWhitePct;
      const GUTTER_THRESHOLD = 8; // percent
      if (leftPct >= GUTTER_THRESHOLD || rightPct >= GUTTER_THRESHOLD) {
        // precise column scan for non-white content
        let leftBound = 0;
        let rightBound = canvas.width - 1;
        const lumThresh = 250;
        // find leftBound
        outerLeft: for (let x = 0; x < canvas.width; x++) {
          for (let y = 0; y < canvas.height; y += stepY) {
            const idx = (y * canvas.width + x) * 4;
            const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
            const lum = (0.299 * r + 0.587 * g + 0.114 * b);
            if (lum <= lumThresh) { leftBound = Math.max(0, x - 1); break outerLeft; }
          }
        }
        // find rightBound
        outerRight: for (let x = canvas.width - 1; x >= 0; x--) {
          for (let y = 0; y < canvas.height; y += stepY) {
            const idx = (y * canvas.width + x) * 4;
            const r = imgData.data[idx], g = imgData.data[idx + 1], b = imgData.data[idx + 2];
            const lum = (0.299 * r + 0.587 * g + 0.114 * b);
            if (lum <= lumThresh) { rightBound = Math.min(canvas.width - 1, x + 1); break outerRight; }
          }
        }
        // ensure bounds sane
        if (rightBound - leftBound < Math.floor(canvas.width * 0.5)) {
          // too aggressive: abort crop
        } else if (leftBound > 0 || rightBound < canvas.width - 1) {
          const cropW = rightBound - leftBound + 1;
          const cropH = canvas.height;
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = cropW;
          cropCanvas.height = cropH;
          const cropCtx = cropCanvas.getContext('2d');
          cropCtx.putImageData(imgData, -leftBound, 0);
          // redraw scaled to original canvas to fill width
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(cropCanvas, 0, 0, cropW, cropH, 0, 0, canvas.width, canvas.height);
          // update meta
          state.pageMeta[pageNumber].cropped = true;
          state.pageMeta[pageNumber].cropLeft = leftBound;
          state.pageMeta[pageNumber].cropRight = canvas.width - 1 - rightBound;
        }
      }
    } catch (e) {
      // ignore analysis failures
      state.pageMeta[pageNumber] = { width: canvas.width, height: canvas.height };
    }

    // Use higher JPEG quality for crisper results in the flipbook
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);
    state.renderedPages.set(pageNumber, dataUrl);

    // Simpan rasio aspek dari halaman pertama untuk menyesuaikan bentuk buku
    if (pageNumber === 1) {
      state.pageAspect = viewport.height / viewport.width;
    }

    canvas.width = 0; // bantu GC, hindari kebocoran memori kanvas besar
    canvas.height = 0;

    return dataUrl;
  }

  // ------- Diagnostics helpers -------
  function _base64SizeBytes(dataUrl) {
    try {
      const idx = dataUrl.indexOf(',');
      if (idx < 0) return 0;
      const b64 = dataUrl.slice(idx + 1);
      const padding = (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
      return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
    } catch (e) {
      return 0;
    }
  }

  // Debug panel hanya tampil jika diaktifkan secara eksplisit lewat
  // ?debug=1 di URL — supaya pengguna akhir tidak pernah melihat panel
  // JSON mentah ini di produksi.
  const DEBUG_MODE = new URLSearchParams(window.location.search).has("debug");

  function showDiagnostics(summary) {
    console.info('Flipbook diagnostics:', summary);
    if (!DEBUG_MODE) return;
    const detailsEl = document.getElementById('error-details');
    if (detailsEl) {
      detailsEl.textContent = JSON.stringify(summary, null, 2);
      detailsEl.classList.remove('hidden');
    }
    // also show a visible debug panel on the page
    let panel = document.getElementById('debug-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'debug-panel';
      panel.style.position = 'fixed';
      panel.style.right = '12px';
      panel.style.top = '72px';
      panel.style.zIndex = '9999';
      panel.style.background = 'rgba(0,0,0,0.75)';
      panel.style.color = '#fff';
      panel.style.fontSize = '12px';
      panel.style.padding = '10px 12px';
      panel.style.borderRadius = '6px';
      panel.style.maxWidth = '380px';
      panel.style.maxHeight = '60vh';
      panel.style.overflow = 'auto';
      document.body.appendChild(panel);
    }
    panel.innerHTML = '';
    const h = document.createElement('div');
    h.style.fontWeight = '600';
    h.style.marginBottom = '6px';
    h.textContent = 'Debug: Flipbook layout diagnostics';
    panel.appendChild(h);
    const p = document.createElement('pre');
    p.style.whiteSpace = 'pre-wrap';
    p.style.margin = 0;
    p.textContent = JSON.stringify(summary, null, 2);
    panel.appendChild(p);
  }

  /**
   * Membuat halaman placeholder bergaya "katalog otomotif" untuk demo mode,
   * digambar langsung ke canvas (tanpa aset eksternal).
   */
  function renderDemoPage(pageNumber) {
    const w = 900, h = Math.round(900 * (CONFIG.BASE_PAGE_HEIGHT / CONFIG.BASE_PAGE_WIDTH));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    // Latar kertas
    ctx.fillStyle = "#f4f2ee";
    ctx.fillRect(0, 0, w, h);

    // Cover khusus halaman 1
    if (pageNumber === 1) {
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#111111");
      grad.addColorStop(1, "#0b0b0b");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "#c1121f";
      ctx.lineWidth = 3;
      ctx.strokeRect(40, 40, w - 80, h - 80);

      ctx.fillStyle = "#e01e2f";
      ctx.font = "bold 64px Arial";
      ctx.textAlign = "center";
      ctx.fillText("E-CATALOG", w / 2, h / 2 - 20);

      ctx.fillStyle = "#eaeaea";
      ctx.font = "22px Arial";
      ctx.fillText("KATALOG DIGITAL — MODE DEMO", w / 2, h / 2 + 30);

      ctx.fillStyle = "#6b6b6b";
      ctx.font = "16px Arial";
      ctx.fillText("Ganti assets/catalog/dummy-catalog.pdf dengan PDF asli Anda", w / 2, h - 60);
    } else {
      // Header aksen merah
      ctx.fillStyle = "#c1121f";
      ctx.fillRect(0, 0, w, 10);

      ctx.fillStyle = "#111111";
      ctx.font = "bold 40px Arial";
      ctx.textAlign = "left";
      ctx.fillText("Halaman " + pageNumber, 60, 100);

      ctx.strokeStyle = "#c1121f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(60, 120);
      ctx.lineTo(220, 120);
      ctx.stroke();

      // Blok gambar placeholder
      ctx.fillStyle = "#e2ded4";
      ctx.fillRect(60, 160, w - 120, h * 0.45);
      ctx.fillStyle = "#a89f8e";
      ctx.font = "16px Arial";
      ctx.textAlign = "center";
      ctx.fillText("[ Gambar Produk / Ilustrasi Katalog ]", w / 2, 160 + h * 0.225);

      // Garis teks dummy
      ctx.fillStyle = "#3a3a3a";
      ctx.textAlign = "left";
      ctx.font = "15px Arial";
      const linesY = 160 + h * 0.45 + 50;
      for (let i = 0; i < 6; i++) {
        ctx.fillRect(60, linesY + i * 26, w - 120 - (i % 3) * 80, 8);
      }

      ctx.fillStyle = "#a89f8e";
      ctx.font = "13px Arial";
      ctx.textAlign = "right";
      ctx.fillText(String(pageNumber), w - 50, h - 40);
    }

    return canvas.toDataURL("image/jpeg", 0.85);
  }

  /* ==========================================================================
     PAGE FLIP ENGINE (StPageFlip wrapper)
     ========================================================================== */

  const FlipEngine = {
    instance: null,

    /**
     * Menghitung dimensi halaman dengan mempertahankan rasio asli PDF.
     */
    computeDimensions() {
      const rootStyle = getComputedStyle(document.documentElement);
      const topbarH = parseInt(rootStyle.getPropertyValue('--topbar-h')) || 64;
      const bottombarH = parseInt(rootStyle.getPropertyValue('--bottombar-h')) || 56;
      const gutter = 24;

      const viewportW = Math.max(480, window.innerWidth - gutter * 2);
      const viewportH = Math.max(360, window.innerHeight - topbarH - bottombarH - gutter * 2);
      const pageAspect = state.pageAspect > 0 ? state.pageAspect : CONFIG.BASE_PAGE_HEIGHT / CONFIG.BASE_PAGE_WIDTH;

      let pageH = viewportH;
      let pageW = pageH / pageAspect;
      if (pageW > viewportW) {
        pageW = viewportW;
        pageH = pageW * pageAspect;
      }

      return {
        width: Math.max(220, Math.round(pageW)),
        height: Math.max(300, Math.round(pageH)),
        usePortrait: true,
      };
    },

    async init() {
      // Support multiple possible globals exported by different builds
      const PageFlipClass = (window.St && window.St.PageFlip) ||
        window.PageFlip ||
        (window.pageFlip && window.pageFlip.PageFlip) ||
        (window.PageFlip && window.PageFlip.default) ||
        null;

      if (!PageFlipClass) {
        throw new Error("Engine page-flip (PageFlip) gagal dimuat dari CDN.");
      }

      // Compute dimensions from stage/viewport to maximize fill area
      const dims = this.computeDimensions();

      // Instantiate with a safety retry: jika PageFlip menolak karena
      // width/height invalid, coba lagi dengan ukuran fallback yang aman.
      try {
        this.instance = new PageFlipClass(el.flipbookEl, {
          width: dims.width,
          height: dims.height,
          size: "stretch",
          minWidth: Math.floor(dims.width / 2) + 1,
          // allow very large maxWidth so PageFlip can stretch to full viewport
          maxWidth: 9999,
          minHeight: 300,
          maxHeight: 9999,
          maxShadowOpacity: 0.55, // bayangan dinamis realistis saat membalik
          showCover: true,
          usePortrait: dims.usePortrait,
          mobileScrollSupport: false, // kita kelola swipe sendiri lewat engine
          swipeDistance: 28,
          clickEventForward: true,
          useMouseEvents: true,
          drawShadow: true,
          flippingTime: 700,
          autoSize: true,
        });
      } catch (err) {
        console.warn("PageFlip init failed with dims, retrying with safe fallback:", err);
        // fallback sizes (70% of viewport, clamped)
        const fbWidth = Math.min(900, Math.max(560, Math.floor(window.innerWidth * 0.7)));
        const fbHeight = Math.min(1200, Math.max(400, Math.floor(window.innerHeight * 0.7)));
        try {
          this.instance = new PageFlipClass(el.flipbookEl, {
            width: fbWidth,
            height: fbHeight,
            size: "stretch",
            minWidth: Math.floor(fbWidth / 2) + 1,
            maxWidth: 9999,
            minHeight: 300,
            maxHeight: 9999,
            maxShadowOpacity: 0.55,
            showCover: true,
            usePortrait: dims.usePortrait,
            mobileScrollSupport: false,
            swipeDistance: 28,
            clickEventForward: true,
            useMouseEvents: true,
            drawShadow: true,
            flippingTime: 700,
            autoSize: true,
          });
        } catch (err2) {
          // Jika masih gagal, tampilkan error agar user tahu
          console.error("PageFlip initialization failed after fallback", err2);
          showError({ message: "Gagal menginisialisasi engine flipbook.", _details: (err2 && err2.stack) ? err2.stack.split('\n').slice(0,6).join('\n') : String(err2) });
          return;
        }
      }

      state.pageFlip = this.instance;

      // Load the first page first so the book is visible while other pages render.
      try {
        const firstPage = await renderPdfPageToDataUrl(1);
        const images = [firstPage];
        state.renderedPages.set("__injected_1", true);
        this.instance.loadFromImages(images);

        // Render the remaining pages in the background and refresh the book.
        for (let p = 2; p <= state.pageCount; p++) {
          images.push(await renderPdfPageToDataUrl(p));
          state.renderedPages.set("__injected_" + p, true);
          if (typeof this.instance.updateFromImages === "function") {
            this.instance.updateFromImages(images);
          }
        }

        // Post-load verification
        setTimeout(() => {
          const imgs = el.flipbookEl.querySelectorAll('img');
          const imgCount = imgs ? imgs.length : 0;
          const diag = {
            pageCount: state.pageCount,
            imgCount,
            computedDims: dims,
            pageMeta: state.pageMeta,
          };
          if (imgCount === 0) {
            showDiagnostics(diag);
          } else {
            console.info('Flipbook loaded successfully', diag);
          }
        }, 120);
      } catch (err) {
        console.error('Prerender all pages failed', err);
        showError({ message: 'Gagal merender halaman katalog.', _details: (err && err.stack) ? err.stack.split('\n').slice(0,6).join('\n') : String(err) });
        return;
      }

      this.instance.on("flip", (e) => {
        onPageChanged(e.data + 1);
        dismissDragHint();
      });

      this.instance.on("changeOrientation", () => {
        this.handleResize();
      });

      onPageChanged(1);
    },

    handleResize() {
      if (!this.instance) return;
      const dims = this.computeDimensions();
      try {
        this.instance.updateState({
          width: dims.width,
          height: dims.height,
          usePortrait: dims.usePortrait,
        });
      } catch (err) {
        // StPageFlip versi tertentu memerlukan reinit penuh saat orientasi berubah drastis
        console.warn("Resize halus gagal, elemen tetap responsif via CSS.", err);
      }
    },

    next() {
      this.instance && this.instance.flipNext();
    },

    prev() {
      this.instance && this.instance.flipPrev();
    },

    goTo(pageIndexZeroBased) {
      this.instance && this.instance.flip(pageIndexZeroBased);
    },

    currentPageIndex() {
      return this.instance ? this.instance.getCurrentPageIndex() : 0;
    },
  };

  function buildPagePlaceholder(pageNumber) {
    const wrapper = document.createElement("div");
    wrapper.className = "page";
    wrapper.setAttribute("data-page-number", String(pageNumber));

    const content = document.createElement("div");
    content.className = "page-content";

    const placeholder = document.createElement("div");
    placeholder.className = "page-loading-placeholder";
    placeholder.textContent = "Memuat...";
    content.appendChild(placeholder);

    wrapper.appendChild(content);
    return wrapper;
  }

  /**
   * Merender gambar untuk halaman aktif ± 2 halaman di sekitarnya
   * (lazy rendering demi performa pada katalog besar — Phase 11 / #23).
   */
  async function lazyRenderAroundPage(centerPage) {
    const range = [];
    for (let p = centerPage - 2; p <= centerPage + 3; p++) {
      if (p >= 1 && p <= state.pageCount) range.push(p);
    }

    await Promise.all(
      range.map(async (pageNum) => {
        if (state.renderedPages.has("__injected_" + pageNum)) return;
        try {
          const dataUrl = await renderPdfPageToDataUrl(pageNum);
          injectImageIntoPage(pageNum, dataUrl);
          state.renderedPages.set("__injected_" + pageNum, true);
        } catch (err) {
          console.error("Gagal merender halaman", pageNum, err);
        }
      })
    );
  }

  function injectImageIntoPage(pageNumber, dataUrl) {
    const pageEl = el.flipbookEl.querySelector(
      `.page[data-page-number="${pageNumber}"] .page-content`
    );
    if (!pageEl) return;

    pageEl.innerHTML = "";
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = `Halaman ${pageNumber}`;
    img.draggable = false;
    pageEl.appendChild(img);
  }

  /* ==========================================================================
     UI: PAGE INDICATOR, PROGRESS
     ========================================================================== */

  function onPageChanged(pageNumber) {
    el.pageCurrent.textContent = pageNumber;
    el.pageTotal.textContent = state.pageCount;
    const pct = (pageNumber / state.pageCount) * 100;
    el.progressFill.style.width = pct + "%";
  }

  /* ==========================================================================
     INTERAKSI: HINT, NAV ZONE, KEYBOARD
     ========================================================================== */

  function dismissDragHint() {
    if (state.hintDismissed) return;
    state.hintDismissed = true;
    el.dragHint.classList.add("fade-out");
  }

  function setupNavZones() {
    el.stage.addEventListener("click", (event) => {
      if (event.target.closest("#flipbook")) return;

      const rect = el.stage.getBoundingClientRect();
      const edgeWidth = Math.max(90, rect.width * 0.08);
      const x = event.clientX - rect.left;

      if (x <= edgeWidth) {
        FlipEngine.prev();
        dismissDragHint();
      } else if (x >= rect.width - edgeWidth) {
        FlipEngine.next();
        dismissDragHint();
      }
    });
  }

  function setupKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") {
        FlipEngine.next();
        dismissDragHint();
      } else if (e.key === "ArrowLeft") {
        FlipEngine.prev();
        dismissDragHint();
      }
    });
  }

  /* ==========================================================================
     ZOOM
     ========================================================================== */

  function applyZoom() {
    el.bookShell.style.transform = `scale(${state.zoom})`;
    el.bookShell.style.transformOrigin = "center center";
    el.bookShell.classList.toggle("is-zoomed", state.zoom > 1);
  }

  function zoomIn() {
    state.zoom = Math.min(CONFIG.ZOOM_MAX, +(state.zoom + CONFIG.ZOOM_STEP).toFixed(2));
    applyZoom();
  }

  function zoomOut() {
    state.zoom = Math.max(CONFIG.ZOOM_MIN, +(state.zoom - CONFIG.ZOOM_STEP).toFixed(2));
    applyZoom();
  }

  function setupZoomPan() {
    el.btnZoomIn.addEventListener("click", zoomIn);
    el.btnZoomOut.addEventListener("click", zoomOut);

    // Saat di-zoom, drag di tengah buku untuk pan; tetap prioritaskan
    // page-turn jika drag dimulai dekat tepi/sudut halaman.
    el.bookShell.addEventListener("mousedown", (e) => {
      if (state.zoom <= 1) return;
      const rect = el.bookShell.getBoundingClientRect();
      const nearEdge =
        e.clientX - rect.left < 60 || rect.right - e.clientX < 60;
      if (nearEdge) return; // biarkan StPageFlip menangani drag sudut

      state.isPanning = true;
      el.bookShell.classList.add("is-panning");
      state.panStart = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: el.stage.scrollLeft,
        scrollTop: el.stage.scrollTop,
      };
    });

    window.addEventListener("mousemove", (e) => {
      if (!state.isPanning) return;
      el.stage.scrollLeft = state.panStart.scrollLeft - (e.clientX - state.panStart.x);
      el.stage.scrollTop = state.panStart.scrollTop - (e.clientY - state.panStart.y);
    });

    window.addEventListener("mouseup", () => {
      state.isPanning = false;
      el.bookShell.classList.remove("is-panning");
    });
  }

  /* ==========================================================================
     RESIZE
     ========================================================================== */

  function setupResizeListener() {
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => FlipEngine.handleResize(), 180);
    });
  }

  /* ==========================================================================
     BOOT SEQUENCE
     ========================================================================== */

  async function boot() {
    try {
      el.app.classList.remove("hidden");
      await loadPdf();

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await FlipEngine.init();

      setupNavZones();
      setupKeyboard();
      setupZoomPan();
      setupResizeListener();

      // Sembunyikan hint drag otomatis setelah beberapa saat jika tak disentuh
      setTimeout(dismissDragHint, 6000);
    } catch (err) {
      console.error(err);
      // Surface a helpful message + short stack snippet in the UI to aid diagnosis
      const userMessage = err && err.message === "TIMEOUT"
        ? "Waktu memuat katalog habis. Periksa koneksi Anda dan coba lagi."
        : "Terjadi kesalahan saat memuat katalog. Silakan coba lagi.";
      const details = (err && err.stack) ? err.stack.split("\n").slice(0,4).join("\n") : null;
      const payload = { message: userMessage };
      if (details) payload._details = details;
      showError(payload);
    }
  }

  el.errorRetryBtn.addEventListener("click", () => {
    el.errorScreen.classList.add("hidden");
    el.app.classList.remove("hidden");
    state.renderedPages.clear();
    boot();
  });

  document.addEventListener("DOMContentLoaded", boot);
})();