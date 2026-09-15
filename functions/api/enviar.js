/**
 * BésameBRA · Primeira Fila
 * Recebe o formulario e grava no Brevo.
 *
 * Variaveis de ambiente (Cloudflare Pages > Settings > Environment variables):
 *   BREVO_API_KEY      obrigatoria, marcar como Secret
 *   BREVO_LIST_ID      obrigatoria, o ID numerico da lista besamebra-primeira-fila
 *   BREVO_DOI_TEMPLATE opcional, ID do template de double opt-in
 *   DOI_REDIRECT       opcional, URL para onde a pessoa volta apos confirmar
 *
 * Binding opcional (Settings > Functions > KV namespace bindings):
 *   LEADS              guarda o registro bruto antes de falar com o Brevo
 */

const BREVO = 'https://api.brevo.com/v3';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function code() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const r = crypto.getRandomValues(new Uint8Array(6));
  for (let i = 0; i < 6; i++) s += a[r[i] % a.length];
  return 'BB-' + s;
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max || 180);
}

function splitLocal(txt) {
  const t = clean(txt, 120);
  const i = t.lastIndexOf(',');
  if (i > 0) return { cidade: t.slice(0, i).trim(), pais: t.slice(i + 1).trim() };
  return { cidade: t, pais: '' };
}

export async function onRequestPost({ request, env }) {
  let d;
  try {
    d = await request.json();
  } catch (e) {
    return reply(400, { ok: false, error: 'json' });
  }

  // 1. armadilhas anti-bot, repetidas no servidor porque o cliente e' burlavel
  if (d.website) return reply(200, { ok: true, code: code() });          // honeypot
  const dur = Date.parse(d.sentAt) - Date.parse(d.startedAt);
  if (!(dur > 2000)) return reply(200, { ok: true, code: code() });      // rapido demais

  // 2. validacao
  const email = clean(d.email, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return reply(400, { ok: false, error: 'email' });
  if (d.consent !== true) return reply(400, { ok: false, error: 'consent' });

  const wa = clean(d.whatsapp, 24).replace(/[^\d+]/g, '');
  const local = splitLocal(d.cidade);
  const ref = code();

  const attributes = {
    CIDADE: local.cidade,
    PAIS: local.pais,
    ARTISTAS: clean(d.artistas, 180),
    CANAL: clean(d.canal, 60),
    IDIOMA: clean(d.lang, 5),
    ORIGEM: clean(d.formType, 40) + '@' + clean(d.formVersion, 20),
    CONSENT_EM: new Date().toISOString().slice(0, 10),
    OPT_IN: true,
    EXT_ID: ref
  };
  if (wa) attributes.WHATSAPP = wa;

  // 3. copia crua antes de falar com terceiro, para nao perder lead se o Brevo cair
  if (env.LEADS) {
    try {
      await env.LEADS.put('lead:' + Date.now() + ':' + ref, JSON.stringify({
        email, wa, attributes,
        consentText: clean(d.consentText, 300),
        noticeVersion: clean(d.noticeVersion, 40),
        device: clean(d.device, 20),
        ua: request.headers.get('user-agent') || '',
        pais_cf: request.headers.get('cf-ipcountry') || '',
        em: new Date().toISOString()
      }));
    } catch (e) { /* segue mesmo assim */ }
  }

  // 4. Brevo
  const listId = Number(env.BREVO_LIST_ID);
  const headers = {
    'api-key': env.BREVO_API_KEY,
    'content-type': 'application/json',
    accept: 'application/json'
  };

  let url, body;
  if (env.BREVO_DOI_TEMPLATE) {
    // caminho preferido: confirmacao por e-mail, prova de consentimento e entregabilidade
    url = BREVO + '/contacts/doubleOptinConfirmation';
    body = {
      email,
      attributes,
      includeListIds: [listId],
      templateId: Number(env.BREVO_DOI_TEMPLATE),
      redirectionUrl: env.DOI_REDIRECT || 'https://besamebra.com/pre-save-lista/?ok=1'
    };
  } else {
    url = BREVO + '/contacts';
    body = { email, attributes, listIds: [listId], updateEnabled: true };
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    return reply(502, { ok: false, error: 'brevo_offline' });
  }

  if (res.status === 201 || res.status === 204) return reply(200, { ok: true, code: ref });

  let err = {};
  try { err = await res.json(); } catch (e) { /* ignora */ }

  // contato ja existente nao e' falha para o usuario
  if (err.code === 'duplicate_parameter') return reply(200, { ok: true, code: ref, dup: true });

  console.log('brevo_fail', res.status, JSON.stringify(err));
  return reply(502, { ok: false, error: err.code || 'brevo_' + res.status });
}

export async function onRequest() {
  return new Response('Method Not Allowed', { status: 405 });
}
