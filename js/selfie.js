/* =========================================================
   selfie.js - Webcam selfie capture for attendance verification
   Returns a Promise resolving to a JPEG dataURL, or rejecting on cancel.
   ========================================================= */

const Selfie = (() => {
  async function capture({ width = 320, quality = 0.55 } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera not supported on this device/browser.');
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      throw new Error('Camera access denied or unavailable. Please allow camera permission and retry.');
    }

    return new Promise((resolve, reject) => {
      const video = Utils.el('video', {
        autoplay: true, playsinline: true, muted: true, class: 'selfie-video',
      });
      video.srcObject = stream;

      const canvas = Utils.el('canvas', { class: 'selfie-canvas hidden' });
      const previewImg = Utils.el('img', { class: 'selfie-preview hidden', alt: 'Selfie preview' });

      let captured = null;

      const captureBtn = Utils.el('button', { type: 'button', class: 'btn btn-primary' }, 'Capture');
      const retakeBtn = Utils.el('button', { type: 'button', class: 'btn btn-ghost hidden' }, 'Retake');
      const confirmBtn = Utils.el('button', { type: 'button', class: 'btn btn-primary hidden' }, 'Use this selfie');
      const cancelBtn = Utils.el('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel');

      captureBtn.addEventListener('click', () => {
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 480;
        const targetW = Math.min(width, vw);
        const targetH = Math.round((targetW / vw) * vh);
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.translate(targetW, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0, targetW, targetH);
        ctx.restore();
        captured = canvas.toDataURL('image/jpeg', quality);
        previewImg.src = captured;
        video.classList.add('hidden');
        previewImg.classList.remove('hidden');
        captureBtn.classList.add('hidden');
        retakeBtn.classList.remove('hidden');
        confirmBtn.classList.remove('hidden');
      });

      retakeBtn.addEventListener('click', () => {
        captured = null;
        previewImg.classList.add('hidden');
        video.classList.remove('hidden');
        captureBtn.classList.remove('hidden');
        retakeBtn.classList.add('hidden');
        confirmBtn.classList.add('hidden');
      });

      function cleanup() {
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        document.querySelector('.modal-backdrop')?.remove();
      }

      confirmBtn.addEventListener('click', () => {
        if (!captured) return;
        cleanup();
        resolve(captured);
      });

      cancelBtn.addEventListener('click', () => {
        cleanup();
        reject(new Error('Selfie cancelled.'));
      });

      const body = Utils.el('div', { class: 'selfie-wrap' },
        Utils.el('p', { class: 'muted small' }, 'Take a selfie to verify your attendance. The photo is stored locally and shown to your instructor.'),
        Utils.el('div', { class: 'selfie-stage' }, video, previewImg, canvas),
        Utils.el('div', { class: 'selfie-actions' }, cancelBtn, retakeBtn, captureBtn, confirmBtn)
      );

      const { body: modalBody } = Utils.openModal();
      modalBody.previousElementSibling.textContent = 'Selfie verification';
      modalBody.appendChild(body);

      const backdrop = document.querySelector('.modal-backdrop');
      if (backdrop) {
        const closeBtn = backdrop.querySelector('.modal-close');
        if (closeBtn) closeBtn.addEventListener('click', () => { try { stream.getTracks().forEach(t => t.stop()); } catch (e) {} reject(new Error('Selfie cancelled.')); });
      }
    });
  }

  return { capture };
})();
