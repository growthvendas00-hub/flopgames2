'use strict';

const App = {
  txId: null,
  pollingInterval: null,
  countdownTimer: null,

  // ── Captura UTMs da URL ─────────────────────────────────────────────────────
  getUTMs() {
    const params = new URLSearchParams(window.location.search);
    const map = {
      utm_source: 'source', utm_medium: 'medium',
      utm_campaign: 'campaign', utm_content: 'content', utm_term: 'term',
      fbclid: 'fbclid', ttclid: 'ttclid', gclid: 'gclid'
    };
    const result = {};
    for (const [urlKey, apiKey] of Object.entries(map)) {
      const val = params.get(urlKey);
      if (val) result[apiKey] = val;
    }
    return result;
  },

  // ── Máscara de telefone ─────────────────────────────────────────────────────
  phoneMask(input) {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 11);
      let v = '';
      if (digits.length === 0) { v = ''; }
      else if (digits.length <= 2) { v = `(${digits}`; }
      else if (digits.length <= 6) { v = `(${digits.slice(0, 2)}) ${digits.slice(2)}`; }
      else if (digits.length <= 10) { v = `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`; }
      else { v = `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`; }
      input.value = v;
    });
  },

  // ── Validação e erro inline ─────────────────────────────────────────────────
  setError(id, msg) {
    const el = document.getElementById('erro-' + id);
    if (el) el.textContent = msg;
  },

  clearErrors() {
    ['nome', 'email', 'telefone'].forEach(id => this.setError(id, ''));
  },

  validate(nome, email, telefone) {
    let ok = true;
    if (!nome) { this.setError('nome', 'Informe seu nome.'); ok = false; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.setError('email', 'Informe um e-mail válido.'); ok = false;
    }
    const digits = telefone.replace(/\D/g, '');
    if (digits.length < 10) { this.setError('telefone', 'Informe um número de WhatsApp válido.'); ok = false; }
    return ok;
  },

  // ── Submit do formulário ────────────────────────────────────────────────────
  async submitForm(e) {
    e.preventDefault();
    this.clearErrors();

    const nome = document.getElementById('nome').value.trim();
    const email = document.getElementById('email').value.trim();
    const telefone = document.getElementById('telefone').value.trim();

    if (!this.validate(nome, email, telefone)) return;

    const btn = document.getElementById('btn-pagar');
    this._btnHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-label">GERANDO PIX…</span>';

    try {
      const resp = await fetch('/api/criar-pix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nome, email, telefone, utms: this.getUTMs() })
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Erro ao gerar o PIX. Tente novamente.');

      this.mostrarPix(data);
    } catch (err) {
      this.setError('telefone', err.message);
      btn.disabled = false;
      btn.innerHTML = this._btnHTML;
    }
  },

  // ── Exibe seção de pagamento ────────────────────────────────────────────────
  mostrarPix(data) {
    this.txId = data.id;

    document.getElementById('form-section').style.display = 'none';
    const sec = document.getElementById('pix-section');
    sec.style.display = 'block';
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const code = data.pix.copy_paste;
    document.getElementById('pix-code').value = code;
    this.renderQR(code);

    if (data.pix.expires_at) {
      this.startCountdown(new Date(data.pix.expires_at));
    }

    this.startPolling(data.id);
  },

  // ── Renderiza o QR Code (lib qrcode-generator) ──────────────────────────────
  renderQR(text) {
    const box = document.getElementById('qr-canvas');
    try {
      const qr = qrcode(0, 'M');           // type auto, correção média
      qr.addData(text);
      qr.make();
      box.innerHTML = qr.createImgTag(5, 0); // 5px por módulo, sem margem extra
      const img = box.querySelector('img');
      if (img) { img.style.width = '230px'; img.style.height = '230px'; img.alt = 'QR Code PIX'; }
    } catch (e) {
      console.error('Falha ao gerar QR:', e);
      box.innerHTML = '<p style="font-size:12px;color:#8295a4">Use o código copia e cola abaixo 👇</p>';
    }
  },

  // ── Copiar código PIX ───────────────────────────────────────────────────────
  async copiar() {
    const code = document.getElementById('pix-code').value;
    const btn = document.getElementById('btn-copiar');

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const el = document.getElementById('pix-code');
        el.select();
        document.execCommand('copy');
      }
      btn.textContent = '✓ Copiado!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copiar código';
        btn.classList.remove('copied');
      }, 2500);
    } catch {
      alert('Não foi possível copiar automaticamente.\nSelecione o código e copie manualmente (Ctrl+C).');
    }
  },

  // ── Contador regressivo ─────────────────────────────────────────────────────
  startCountdown(expiresAt) {
    const el = document.getElementById('countdown');

    const tick = () => {
      const diff = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      const m = String(Math.floor(diff / 60)).padStart(2, '0');
      const s = String(diff % 60).padStart(2, '0');
      el.textContent = `${m}:${s}`;

      if (diff <= 120) el.style.color = '#ff6644';
      if (diff <= 0) {
        el.textContent = 'Expirado';
        clearInterval(this.countdownTimer);
      }
    };

    tick();
    this.countdownTimer = setInterval(tick, 1000);
  },

  // ── Polling de status ───────────────────────────────────────────────────────
  startPolling(id) {
    this.pollingInterval = setInterval(async () => {
      try {
        const resp = await fetch(`/api/status/${id}`);
        if (!resp.ok) return;
        const data = await resp.json();

        if (data.status === 'PAID') {
          clearInterval(this.pollingInterval);
          clearInterval(this.countdownTimer);
          this.onPaid(id);
        } else if (['EXPIRED', 'CANCELED', 'FAILED'].includes(data.status)) {
          clearInterval(this.pollingInterval);
          clearInterval(this.countdownTimer);
          this.onError(data.status);
        }
      } catch { /* rede instável, tenta na próxima rodada */ }
    }, 3000);
  },

  // ── Pagamento confirmado ────────────────────────────────────────────────────
  onPaid(id) {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');

    dot.style.animation = 'none';
    dot.style.background = '#00ff41';
    txt.textContent = '✅ Pagamento confirmado! Redirecionando...';
    txt.style.color = '#00ff41';

    setTimeout(() => {
      window.location.href = `/obrigado?ref=${id}`;
    }, 1400);
  },

  // ── Pagamento falhou/expirou ────────────────────────────────────────────────
  onError(status) {
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    const msgs = {
      EXPIRED: 'PIX expirado. Recarregue a página para tentar novamente.',
      CANCELED: 'Pagamento cancelado.',
      FAILED: 'Falha no pagamento. Entre em contato com o suporte.'
    };

    dot.style.animation = 'none';
    dot.style.background = '#ff4444';
    txt.textContent = msgs[status] || 'Erro no pagamento.';
    txt.style.color = '#ff5555';
  },

  // ── Carrega preço/plano do servidor ─────────────────────────────────────────
  async loadConfig() {
    try {
      const cfg = await (await fetch('/api/config')).json();
      if (cfg.price_now) document.getElementById('price-now').textContent = cfg.price_now;
      if (cfg.price_per) document.getElementById('price-per').textContent = cfg.price_per;
      if (cfg.duration_label) document.getElementById('plan-duration').textContent = cfg.duration_label;
    } catch { /* mantém os valores padrão do HTML */ }
  },

  // ── Init ────────────────────────────────────────────────────────────────────
  init() {
    this.loadConfig();
    document.getElementById('form-checkout').addEventListener('submit', e => this.submitForm(e));
    document.getElementById('btn-copiar').addEventListener('click', () => this.copiar());
    this.phoneMask(document.getElementById('telefone'));

    window.addEventListener('beforeunload', () => {
      clearInterval(this.pollingInterval);
      clearInterval(this.countdownTimer);
    });
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
