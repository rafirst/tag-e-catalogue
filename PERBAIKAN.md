# Catatan Perbaikan — Area Kosong Kiri/Kanan pada Flipbook

## Akar Masalah

Bug-nya ada di `js/flipbook.js`, bukan di CSS dan bukan karena ukuran PDF terlalu kecil.

Urutan eksekusi sebelumnya:

1. `FlipEngine.init()` dipanggil.
2. Di baris paling awal method itu, `computeDimensions()` langsung dijalankan untuk menghitung lebar/tinggi buku — **tapi rasio aspek halaman (`state.pageAspect`) saat itu masih memakai nilai default** (`760 / 560 = 1.357`, rasio potret/portrait).
3. StPageFlip diinisialisasi dan **dikunci** memakai ukuran hasil hitungan itu (buku sempit, karena dihitung seolah-olah halamannya potret).
4. **Baru setelah itu**, halaman 1 PDF benar-benar dirender, dan barulah `state.pageAspect` diperbarui ke rasio asli PDF Anda — yang ternyata **landscape/lanskap** (lebar, mis. ~1440×810, rasio ≈ 0,56). Tapi pembaruan ini sudah terlambat, ukuran buku sudah kadung dikunci di langkah 3.

Hasilnya: buku dibuat jauh lebih sempit dari lebar layar yang sebenarnya tersedia, sehingga muncul area kosong lebar di kiri dan kanan — persis seperti yang terlihat di kedua screenshot Anda (baik mode normal maupun fullscreen).

Jadi jawabannya: **bukan** karena ukuran konten PDF Anda kurang besar. Kontennya sudah cukup besar dan proporsional — masalahnya murni di urutan kode yang menghitung ukuran buku sebelum tahu bentuk asli halaman PDF.

## Perbaikan yang Dilakukan

1. **`js/flipbook.js` — `loadPdf()`**: begitu PDF berhasil dimuat, langsung ambil `viewport` halaman 1 (operasi ringan, tanpa render penuh) untuk mendapatkan rasio aspek **asli** PDF, sebelum `FlipEngine.init()` dipanggil sama sekali. Dengan begitu, perhitungan lebar/tinggi buku sejak awal sudah memakai bentuk halaman yang benar dan otomatis memaksimalkan lebar buku mengisi layar.

2. **Menghapus hack `FILL_SCALE`**: sebelumnya ada scale paksa 1.06x pada `book-shell` sebagai tambalan sementara untuk masalah yang sama. Setelah akar masalah diperbaiki, hack ini tidak diperlukan lagi dan berpotensi membuat buku overflow/terpotong tipis di tepi, jadi dihapus.

3. **`css/style.css`**: `object-fit` pada gambar halaman diubah dari `cover` ke `contain`. Karena sekarang ukuran kotak halaman sudah presisi mengikuti rasio asli PDF, `contain` menjamin seluruh isi halaman (foto produk, teks) selalu tampil utuh tanpa terpotong sedikit pun di tepi.

4. **Panel debug (kotak hitam JSON)**: sebelumnya tampil otomatis ke semua pengguna. Sekarang hanya muncul jika sengaja diaktifkan lewat `?debug=1` di URL, misalnya:
   ```
   http://127.0.0.1:5500/index.html?debug=1
   ```
   Untuk pemakaian normal, buka seperti biasa tanpa parameter tersebut dan panel tidak akan muncul.

## Update Terbaru — Isi Penuh Lebar & Tinggi (Tanpa Spasi Putih)

Setelah lebar kiri-kanan sudah penuh, permintaan berikutnya adalah tinggi (atas-bawah) juga harus penuh, tanpa ada spasi putih sama sekali.

**Perubahan pada iterasi ini:**

1. `computeDimensions()` di `js/flipbook.js` sekarang **tidak lagi mengikuti rasio aspek asli PDF sama sekali**. Kotak halaman dipaksa mengisi 100% lebar dan 100% tinggi panggung yang tersedia (setengah lebar per halaman untuk mode spread desktop, penuh untuk mode mobile).
2. `object-fit` gambar di `css/style.css` dikembalikan ke `cover` (bukan `contain`), supaya gambar tetap proporsional (tidak gepeng/distorsi) tapi otomatis di-crop halus mengikuti bentuk kotak — bukan menyisakan ruang kosong.
3. `renderPdfPageToDataUrl()` sekarang menghitung resolusi render berdasarkan sisi yang **paling membutuhkan resolusi lebih tinggi** (logika sama seperti `cover`), jadi hasil crop tetap tajam, tidak pecah, di kedua dimensi.

**Konsekuensi yang perlu dipahami (trade-off):**

Karena halaman PDF Anda landscape (lebar) sedangkan area panggung browser lebih tinggi secara proporsional, untuk mengisi penuh kiri-kanan **dan** atas-bawah tanpa distorsi, sebagian tepi gambar (biasanya atas & bawah, atau kiri & kanan tergantung ukuran jendela) **akan terpotong (crop) secara halus** — ini bukan bug, melainkan konsekuensi matematis wajar ketika bentuk gambar sumber berbeda dari bentuk wadah yang ingin diisi penuh. Semakin jendela browser berbeda proporsinya dari halaman PDF Anda, semakin besar bagian yang ter-crop.

Jika crop di beberapa halaman jadi memotong bagian penting (misalnya wajah produk/logo yang terlalu dekat ke tepi), dua opsi:
- Desain ulang bagian penting PDF agar berada lebih ke tengah dengan sedikit "bleed" margin aman di tepi, atau
- Beri tahu saya halaman mana yang bermasalah, saya bisa buatkan pengaturan crop-position per halaman (`object-position`) agar area penting tetap terlihat.


## File PDF Asli Anda

`js/flipbook.js` masih menunjuk ke `assets/catalog/solo.pdf` (sesuai pengaturan terakhir Anda). File PDF asli tersebut **tidak saya sertakan** di paket ini karena tidak diunggah ulang — silakan salin `solo.pdf` Anda ke folder `assets/catalog/` sebelum menjalankan. Sebagai contoh/fallback, `assets/catalog/dummy-catalog.pdf` (20 halaman potret) tetap disertakan tapi tidak dipakai kecuali Anda ubah `PDF_URL` di `js/flipbook.js`.
