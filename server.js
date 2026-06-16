'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');

// Carrega variáveis do .env no ambiente local (na Vercel, use o painel de Env Vars).
(function loadEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const linha of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = linha.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const chave = m[1];
      let valor = m[2].trim().replace(/^["']|["']$/g, '');
      if (!(chave in process.env)) process.env[chave] = valor;
    }
  } catch { /* ignora */ }
})();

const app = express();

// ── Gateway Enki Bank (PIX) — https://app.enki-bank.com/docs ──────────────────
// Backend: api.qivotech.com.br. Autenticação Basic base64(public_key:secret_key).
const ENKI_URL = 'https://api.qivotech.com.br';
const ENKI_PUBLIC_KEY = process.env.ENKI_PUBLIC_KEY;
const ENKI_SECRET_KEY = process.env.ENKI_SECRET_KEY;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';

function enkiConfigurado() { return !!(ENKI_PUBLIC_KEY && ENKI_SECRET_KEY); }
function enkiAuth() {
  return 'Basic ' + Buffer.from(`${ENKI_PUBLIC_KEY}:${ENKI_SECRET_KEY}`).toString('base64');
}

// ── Plano deste checkout ──────────────────────────────────────────────────────
// Este repositório (flopgames2) = plano de 3 Meses por R$ 39,97.
// (O repo flopgames usa os valores do plano de 1 Mês por R$ 19,97.)
const PLAN = {
  amount_cents: 3997,
  price_now: '39,97',              // exibido após o "R$"
  price_per: '/ 3 meses',
  old_price: 'de R$ 230,70',       // âncora riscada
  plan_badge: '3 MESES',           // selo do card + linha do título
  duration_label: '3 Meses',
  plan_name: 'Game Pass Ultimate — 3 Meses'
};
const AMOUNT_CENTS = PLAN.amount_cents;

// ─── Middlewares ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gerarCPF() {
  function calcDigito(nums, start) {
    const sum = nums.reduce((acc, n, i) => acc + n * (start - i), 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  }
  let base;
  do {
    base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  } while (base.every(d => d === base[0]));
  const d1 = calcDigito(base, 10);
  const d2 = calcDigito([...base, d1], 11);
  return [...base, d1, d2].join('');
}

// UTMs (objeto vindo do front) → string única que a Enki espera no campo "utm".
function montarUtmString(utms) {
  if (!utms || typeof utms !== 'object') return null;
  const map = {
    source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign',
    content: 'utm_content', term: 'utm_term',
    fbclid: 'fbclid', ttclid: 'ttclid', gclid: 'gclid'
  };
  const parts = [];
  for (const [k, v] of Object.entries(utms)) {
    if (!v) continue;
    const key = map[k] || k;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? '?' + parts.join('&') : null;
}

// Status da Enki → vocabulário usado pelo front (PENDING / PAID / EXPIRED / CANCELED / FAILED).
function normalizarStatus(s) {
  switch (String(s || '').toUpperCase()) {
    case 'PAID': return 'PAID';
    case 'EXPIRED': return 'EXPIRED';
    case 'CANCELLED':
    case 'CANCELED':
    case 'REFUNDED':
    case 'CHARGEBACK': return 'CANCELED';
    case 'REFUSED': return 'FAILED';
    default: return 'PENDING'; // PENDING, WAITING_PAYMENT
  }
}

// ─── API: Criar PIX ──────────────────────────────────────────────────────────
app.post('/api/criar-pix', async (req, res) => {
  const { nome, email, telefone, utms } = req.body;

  if (!nome?.trim() || !email?.trim() || !telefone?.trim()) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }

  if (!enkiConfigurado()) {
    return res.status(500).json({ error: 'Gateway não configurado. Defina ENKI_PUBLIC_KEY e ENKI_SECRET_KEY.' });
  }

  const phoneDigits = telefone.replace(/\D/g, '');
  if (phoneDigits.length < 10) {
    return res.status(400).json({ error: 'Número de WhatsApp inválido.' });
  }

  const body = {
    amount: AMOUNT_CENTS,
    payment_method: 'PIX',
    items: [{
      title: PLAN.plan_name,
      unit_price: AMOUNT_CENTS,
      quantity: 1,
      tangible: false,
      external_ref: PLAN.plan_badge
    }],
    customer: {
      name: nome.trim(),
      email: email.trim(),
      phone: phoneDigits,
      document: { number: gerarCPF(), type: 'CPF' }
    }
  };

  const utm = montarUtmString(utms);
  if (utm) body.utm = utm;
  if (process.env.WEBHOOK_URL) body.postback_url = process.env.WEBHOOK_URL;

  try {
    const resp = await fetch(`${ENKI_URL}/v1/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': enkiAuth()
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[Enki] Erro ao criar:', resp.status, JSON.stringify(data));
      return res.status(resp.status).json({ error: data.message || data.error || 'Erro ao gerar PIX.' });
    }

    const tx = data.data || data;            // resposta vem direta (sem wrapper) na criação
    const pix = tx.pix || {};
    res.json({
      id: tx.id,
      status: normalizarStatus(tx.status),
      pix: { copy_paste: pix.copy_paste, expires_at: pix.expires_at }
    });
  } catch (err) {
    console.error('[Enki] Falha de comunicação:', err.message);
    res.status(500).json({ error: 'Falha ao conectar ao gateway de pagamento.' });
  }
});

// ─── API: Consultar status ────────────────────────────────────────────────────
app.get('/api/status/:id', async (req, res) => {
  if (!enkiConfigurado()) {
    return res.status(500).json({ error: 'Gateway não configurado.' });
  }

  try {
    const resp = await fetch(`${ENKI_URL}/v1/transactions/${req.params.id}`, {
      headers: { 'Authorization': enkiAuth() }
    });

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Transação não encontrada.' });
    }

    const tx = data.data || data;            // consulta vem embrulhada em { data: {...} }
    res.json({ status: normalizarStatus(tx.status), paid_at: tx.paid_at || null });
  } catch (err) {
    console.error('[Enki] Status error:', err.message);
    res.status(500).json({ error: 'Falha ao consultar status.' });
  }
});

// ─── Webhook Enki ─────────────────────────────────────────────────────────────
// Cadastre a URL em app.enki-bank.com → Integrações → Webhooks (ou via postback_url).
// URL: https://SEU-DOMINIO.vercel.app/api/webhook · Evento: transaction.paid
app.post('/api/webhook', (req, res) => {
  const payload = req.body || {};
  const event = payload.event || payload.type || '';
  const tx = payload.data || payload.transaction || payload;

  console.log(`[Webhook Enki] ${event}`, tx?.id);

  const pago = event === 'transaction.paid' || normalizarStatus(tx?.status) === 'PAID';
  if (pago) {
    console.log(`[Webhook] PAGO tx=${tx?.id}`);
    // TODO: Aqui você envia a chave do Game Pass para o cliente
    // Dados disponíveis: tx.customer.email, .phone, .name
    // Exemplo: enviar via WhatsApp API ou email
  }

  res.sendStatus(200);
});

// ─── Config frontend ──────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    whatsapp: WHATSAPP_NUMBER,
    price_now: PLAN.price_now,
    price_per: PLAN.price_per,
    old_price: PLAN.old_price,
    plan_badge: PLAN.plan_badge,
    duration_label: PLAN.duration_label,
    plan_name: PLAN.plan_name
  });
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3002;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`FlopGames Checkout: http://localhost:${PORT}`);
  });
}

module.exports = app;
