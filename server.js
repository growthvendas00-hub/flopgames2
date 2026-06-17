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

// ── Gateway BravoPay (PIX) ────────────────────────────────────────────────────
const BRAVOPAY_API_KEY = process.env.BRAVOPAY_API_KEY;
const BRAVOPAY_URL = 'https://bravopay.club/api/v1';
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';

// ── Plano deste checkout ──────────────────────────────────────────────────────
// Este repositório (flopgames2) = plano de 3 Meses por R$ 39,97.
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

function formatarTelefone(tel) {
  let phone = tel.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = phone.slice(1);
  if (!phone.startsWith('55')) phone = `55${phone}`;
  return phone;
}

// ─── API: Criar PIX ──────────────────────────────────────────────────────────
app.post('/api/criar-pix', async (req, res) => {
  const { nome, email, telefone, utms } = req.body;

  if (!nome?.trim() || !email?.trim() || !telefone?.trim()) {
    return res.status(400).json({ error: 'Preencha todos os campos.' });
  }

  if (!BRAVOPAY_API_KEY) {
    return res.status(500).json({ error: 'Gateway não configurado. Defina BRAVOPAY_API_KEY.' });
  }

  const phoneDigits = telefone.replace(/\D/g, '');
  if (phoneDigits.length < 10) {
    return res.status(400).json({ error: 'Número de WhatsApp inválido.' });
  }

  const body = {
    amount_cents: AMOUNT_CENTS,
    method: 'pix',
    customer: {
      name: nome.trim(),
      email: email.trim(),
      phone: formatarTelefone(telefone),
      cpf: gerarCPF()
    },
    external_reference: `flop_${Date.now()}`
  };

  if (utms && typeof utms === 'object' && Object.keys(utms).length) {
    body.utm = utms;
  }

  try {
    const resp = await fetch(`${BRAVOPAY_URL}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRAVOPAY_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('[BravoPay] Erro:', data);
      return res.status(resp.status).json({ error: data.message || 'Erro ao gerar PIX.' });
    }

    res.json({
      id: data.id,
      status: data.status,
      pix: data.pix,
      amount_cents: data.amount_cents
    });
  } catch (err) {
    console.error('[BravoPay] Falha de comunicação:', err.message);
    res.status(500).json({ error: 'Falha ao conectar ao gateway de pagamento.' });
  }
});

// ─── API: Consultar status ────────────────────────────────────────────────────
app.get('/api/status/:id', async (req, res) => {
  if (!BRAVOPAY_API_KEY) {
    return res.status(500).json({ error: 'Gateway não configurado.' });
  }

  try {
    const resp = await fetch(`${BRAVOPAY_URL}/transactions/${req.params.id}`, {
      headers: { 'Authorization': `Bearer ${BRAVOPAY_API_KEY}` }
    });

    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Transação não encontrada.' });
    }

    res.json({ status: data.status, paid_at: data.paid_at });
  } catch (err) {
    console.error('[BravoPay] Status error:', err.message);
    res.status(500).json({ error: 'Falha ao consultar status.' });
  }
});

// ─── Webhook BravoPay ─────────────────────────────────────────────────────────
// Configure em: bravopay.club/dashboard/integracoes/webhooks
// URL: https://SEU-DOMINIO.vercel.app/api/webhook
app.post('/api/webhook', (req, res) => {
  const { event, transaction } = req.body || {};

  console.log(`[Webhook BravoPay] ${event}`, transaction?.id);

  if (event === 'transaction.paid' && transaction) {
    const valor = (transaction.amount_cents / 100).toFixed(2);
    console.log(`[Webhook] PAGO tx=${transaction.id} R$${valor}`);
    // TODO: Aqui você envia a chave do Game Pass para o cliente
    // Dados disponíveis: transaction.customer.email, .phone, .name
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
