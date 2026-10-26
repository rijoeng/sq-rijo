/*
 * SQ-Rijo · App de campo da Verificação de Serviço (FVS) · v0.1.0 · 25/10/2026
 * Offline-first: tudo é gravado no celular (IndexedDB) e enviado quando houver sinal.
 * Mesmo padrão do APP Diário de Obras (API Vobi 06): POST { acao, token, dados } ao Apps Script.
 */
'use strict';

const CFG = Object.assign({ API_URL: 'demo', DIAS_ALERTA_SINC: 2 }, window.SQ_CONFIG || {});
const VERSAO = '0.1.0';
const MODO_DEMO = CFG.API_URL === 'demo';
const STATUS_LIBERA = ['Aprovada', 'Aprovada com ressalva'];

/* ============================================================
 *  Utilidades
 * ============================================================ */
const $ = (s, r) => (r || document).querySelector(s);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
}));
const agoraISO = () => new Date().toISOString();
const dataBR = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleDateString('pt-BR'); };
const horaBR = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); };
const quandoBR = (iso) => {
  if (!iso) return 'nunca';
  const d = new Date(iso), hoje = new Date();
  const ontem = new Date(); ontem.setDate(hoje.getDate() - 1);
  if (d.toDateString() === hoje.toDateString()) return 'hoje, ' + horaBR(iso);
  if (d.toDateString() === ontem.toDateString()) return 'ontem, ' + horaBR(iso);
  return dataBR(iso) + ' ' + horaBR(iso);
};
const dia = (v) => String(v || '').slice(0, 10);
const diasDesde = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity;

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('mostra');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('mostra'), 3200);
}

const ICON = {
  cadeado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  semSinal: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.8"/><path d="M19 12.9a10 10 0 0 0-2.4-1.8"/><path d="M12 20h.01"/></svg>',
  camera: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'
};

/* ============================================================
 *  Banco local (IndexedDB) — kv · fvs · fila · fotos
 * ============================================================ */
const DB = (() => {
  let db = null; const mem = { kv: {}, fvs: {}, fila: {}, fotos: {} };
  const abrir = () => new Promise((ok) => {
    if (!('indexedDB' in window)) return ok(null);
    const req = indexedDB.open('sq-rijo', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('kv');
      d.createObjectStore('fvs', { keyPath: 'id' });
      d.createObjectStore('fila', { keyPath: 'id' });
      d.createObjectStore('fotos', { keyPath: 'id' });
    };
    req.onsuccess = () => { db = req.result; ok(db); };
    req.onerror = () => ok(null);
  });
  const tx = (loja, modo, fn) => new Promise((ok, falha) => {
    const t = db.transaction(loja, modo); const s = t.objectStore(loja); const r = fn(s);
    t.oncomplete = () => ok(r && 'result' in r ? r.result : undefined); t.onerror = () => falha(t.error);
  });
  return {
    abrir,
    async get(loja, chave) { if (!db) return mem[loja][chave]; return tx(loja, 'readonly', (s) => s.get(chave)); },
    async put(loja, valor, chave) {
      if (!db) { mem[loja][chave || valor.id] = valor; return; }
      return tx(loja, 'readwrite', (s) => (chave !== undefined ? s.put(valor, chave) : s.put(valor)));
    },
    async del(loja, chave) { if (!db) { delete mem[loja][chave]; return; } return tx(loja, 'readwrite', (s) => s.delete(chave)); },
    async all(loja) { if (!db) return Object.values(mem[loja]); return tx(loja, 'readonly', (s) => s.getAll()); }
  };
})();

/* ============================================================
 *  Estado
 * ============================================================ */
const S = {
  token: null,
  boot: null,          // cadastros + situação vinda do servidor
  fvs: {},             // FVS guardadas neste celular (id -> objeto completo)
  fila: [],            // envios pendentes
  ultimaSinc: null,    // última sincronização bem-sucedida
  sincronizando: false,
  erroSinc: null,
  obra: null,          // código da obra em uso
  etapa: {},           // etapa aberta por FVS
  filtroMapa: 'comFVS'
};

async function salvarFVS(f) {
  f.atualizadaEm = agoraISO();
  S.fvs[f.id] = f;
  await DB.put('fvs', f);
}

async function enfileirar(tipo, ref) {
  const id = tipo + ':' + ref;
  const existente = S.fila.find((x) => x.id === id);
  const item = existente || { id, tipo, ref, criadoEm: agoraISO(), tentativas: 0 };
  item.estado = 'pendente'; item.erro = null;
  if (!existente) S.fila.push(item);
  await DB.put('fila', item);
  atualizarCabecalho();
}

/* ============================================================
 *  Servidor (ou demonstração)
 * ============================================================ */
const API = {
  async chamar(acao, dados) {
    if (MODO_DEMO) return Demo.chamar(acao, dados);
    if (!navigator.onLine) throw Object.assign(new Error('Sem conexão com a internet'), { temporario: true });
    const ctl = new AbortController();
    const limite = setTimeout(() => ctl.abort(), acao === 'enviarFoto' ? 120000 : 45000);
    try {
      const r = await fetch(CFG.API_URL, {
        method: 'POST', signal: ctl.signal, redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ acao, token: S.token, dados })
      });
      const j = await r.json();
      if (!j.ok) {
        const temporario = j.erro === 'temporario' || j.erro === 'servidor';
        throw Object.assign(new Error(j.msg || 'Erro do servidor'), { temporario, codigo: j.erro });
      }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('Sem resposta do servidor (sinal fraco)'), { temporario: true });
      if (e.temporario !== undefined) throw e;
      throw Object.assign(new Error('Falha de conexão'), { temporario: true });
    } finally { clearTimeout(limite); }
  }
};

/* Servidor simulado para o modo demonstração (guarda no próprio celular). */
const Demo = {
  async estado() {
    let s = await DB.get('kv', 'demoServidor');
    if (!s) { s = JSON.parse(JSON.stringify(window.SQ_DEMO)); s.contFVS = {}; s.contNC = 4; s.fvsCompletas = {}; await DB.put('kv', s, 'demoServidor'); }
    return s;
  },
  async chamar(acao, d) {
    await new Promise((r) => setTimeout(r, 350));
    const s = await this.estado();
    const usuario = { id: 'demo', nome: 'Sérgio Guimarães (demonstração)', papel: 'engenheiro' };
    if (acao === 'bootstrap') {
      return { ok: true, versao: VERSAO, servidorEm: agoraISO(), usuario, obras: s.obras, locais: s.locais, pes: s.pes,
               itens: s.itens, pesObra: s.pesObra, encadeamento: s.encadeamento, situacao: s.situacao };
    }
    if (acao === 'situacao') return { ok: true, servidorEm: agoraISO(), situacao: s.situacao };
    if (acao === 'enviarFVS') {
      let f = s.situacao.fvs.find((x) => x.id === d.id);
      if (!f) {
        const num = d.pes.replace(/\D/g, '');
        s.contFVS[num] = (s.contFVS[num] || 1) + 1;
        f = { id: d.id, numero: 'FVS-' + d.obra + '-' + num + '-' + String(s.contFVS[num]).padStart(4, '0') };
        s.situacao.fvs.push(f);
      }
      Object.assign(f, { obra: d.obra, localId: d.localId, local: d.local, pes: d.pes, status: d.status, inspecao: d.inspecao, inspetor: d.inspetor, atualizadaEm: agoraISO() });
      const ncNumeros = {};
      (d.ncs || []).forEach((n) => {
        let reg = s.situacao.nc.find((x) => x.id === n.id);
        if (!reg) { s.contNC += 1; reg = { id: n.id, numero: 'NC-' + d.obra + '-' + String(s.contNC).padStart(4, '0') }; s.situacao.nc.push(reg); }
        Object.assign(reg, { obra: d.obra, fvsId: d.id, pes: d.pes, local: d.local, descricao: n.descricao, disposicao: n.disposicao,
                              acao: n.acao, responsavel: n.responsavel, prazo: n.prazo, status: n.status });
        ncNumeros[n.id] = reg.numero;
      });
      s.situacao.nc = s.situacao.nc.filter((n) => n.status !== 'Encerrada');
      s.fvsCompletas[d.id] = JSON.parse(JSON.stringify(Object.assign({}, d, { numero: f.numero })));
      await DB.put('kv', s, 'demoServidor');
      return { ok: true, id: d.id, numero: f.numero, ncNumeros };
    }
    if (acao === 'enviarFoto') return { ok: true, id: d.id, url: '#' };
    if (acao === 'obterFVS') {
      if (s.fvsCompletas[d.id]) return { ok: true, fvs: s.fvsCompletas[d.id] };
      const f = s.situacao.fvs.find((x) => x.id === d.id);
      if (!f) return { ok: false, msg: 'FVS não encontrada.' };
      const p = s.pes.find((x) => x.codigo === f.pes);
      let marcouNC = false;
      const itens = s.itens.filter((i) => i.pes === f.pes).map((i) => {
        let res = 'C';
        if (f.status === 'Reprovada' && i.critico && !marcouNC && !/^Sistema/.test(i.instrumento)) { res = 'NC'; marcouNC = true; }
        return Object.assign({}, i, { respostas: [{ inspecao: 1, resultado: res, valor: '', obs: res === 'NC' ? 'Ver NC.' : '', em: f.atualizadaEm, fotos: [] }] });
      });
      const ncs = s.situacao.nc.filter((n) => n.fvsId === f.id).map((n) => Object.assign({}, n, { itemOrdem: (itens.find((i) => i.respostas[0].resultado === 'NC') || {}).ordem }));
      return { ok: true, fvs: { id: f.id, numero: f.numero, obra: f.obra, localId: f.localId, local: f.local, pes: f.pes, revisao: p.revisao,
        classificacao: p.classificacao, equipe: '', inspetor: f.inspetor, status: f.status, inspecao: f.inspecao, itens, ncs } };
    }
    return { ok: false, msg: 'Ação desconhecida' };
  }
};

/* ============================================================
 *  Sincronização
 * ============================================================ */
async function sincronizar(manual) {
  if (S.sincronizando || !S.token) return;
  S.sincronizando = true; S.erroSinc = null; atualizarCabecalho();
  try {
    if (!S.boot) await baixarCadastros();
    // 1) FVS primeiro (dados leves), depois as fotos.
    const ordenada = S.fila.filter((x) => x.estado === 'pendente').sort((a, b) => (a.tipo === 'fvs' ? 0 : 1) - (b.tipo === 'fvs' ? 0 : 1));
    for (const item of ordenada) {
      try {
        if (item.tipo === 'fvs') await enviarFVS(item.ref);
        else await enviarFoto(item.ref);
        S.fila = S.fila.filter((x) => x.id !== item.id); await DB.del('fila', item.id);
      } catch (e) {
        item.tentativas += 1; item.erro = e.message;
        if (e.temporario === false) item.estado = 'rejeitado';
        await DB.put('fila', item);
        if (e.temporario !== false) throw e; // sem sinal: para e tenta depois
      }
    }
    // 2) Atualiza a situação geral (FVS de outros celulares).
    await baixarCadastros();
    S.ultimaSinc = agoraISO(); await DB.put('kv', S.ultimaSinc, 'ultimaSinc');
    if (manual) toast('Sincronizado.');
  } catch (e) {
    S.erroSinc = e.message;
    if (manual) toast(e.message + '. Tudo continua salvo no celular.');
  } finally {
    S.sincronizando = false; atualizarCabecalho();
    // Só redesenha telas sem formulário, para não apagar o que a pessoa está digitando.
    if (['pend', 'mapa', 'sync'].includes(rota().tela) || !document.querySelector('#view .cartao')) render();
  }
}

async function baixarCadastros() {
  const r = await API.chamar('bootstrap', {});
  S.boot = r; await DB.put('kv', r, 'boot');
  if (!S.obra || !r.obras.some((o) => o.codigo === S.obra)) S.obra = r.obras[0] && r.obras[0].codigo;
}

async function enviarFVS(id) {
  const f = S.fvs[id]; if (!f) return;
  const dados = JSON.parse(JSON.stringify(f));
  dados.itens.forEach((it) => it.respostas.forEach((r) => { r.qtdFotos = (r.fotos || []).length; delete r.fotos; }));
  const r = await API.chamar('enviarFVS', dados);
  f.numero = r.numero; f.sincronizadaEm = agoraISO();
  (f.ncs || []).forEach((n) => { if (r.ncNumeros && r.ncNumeros[n.id]) n.numero = r.ncNumeros[n.id]; });
  S.fvs[id] = f; await DB.put('fvs', f);
}

async function enviarFoto(fotoId) {
  const foto = await DB.get('fotos', fotoId);
  if (!foto || foto.enviada) return;
  const base64 = await bufferParaBase64(foto.dados);
  await API.chamar('enviarFoto', { id: foto.id, fvsId: foto.fvsId, inspecao: foto.inspecao, itemOrdem: foto.itemOrdem, tiradaEm: foto.tiradaEm, base64 });
  foto.enviada = true; foto.enviadaEm = agoraISO();
  await DB.put('fotos', foto); // a imagem continua no celular como miniatura até a FVS ser encerrada
}

function bufferParaBase64(buf) {
  return new Promise((ok) => {
    const fr = new FileReader();
    fr.onload = () => ok(String(fr.result).split(',')[1]);
    fr.readAsDataURL(new Blob([buf], { type: 'image/jpeg' }));
  });
}

/* ============================================================
 *  Regras da FVS
 * ============================================================ */
const pesDe = (cod) => (S.boot ? S.boot.pes.find((p) => p.codigo === cod) : null);
const localDe = (id) => (S.boot ? S.boot.locais.find((l) => l.id === id) : null);

function pesAtivosDaObra(obra) {
  if (!S.boot) return [];
  const regras = S.boot.pesObra.filter((r) => r.obra === obra);
  return S.boot.pes.filter((p) => !regras.length || regras.some((r) => r.pes === p.codigo && r.ativo))
    .sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/** Todas as FVS conhecidas: as do servidor, substituídas pelas deste celular quando existirem. */
function todasFVS(obra) {
  const lista = {};
  ((S.boot && S.boot.situacao.fvs) || []).forEach((f) => { lista[f.id] = Object.assign({ origem: 'servidor' }, f); });
  Object.values(S.fvs).forEach((f) => { lista[f.id] = Object.assign({}, f, { origem: 'celular' }); });
  return Object.values(lista).filter((f) => (!obra || f.obra === obra) && f.status !== 'Cancelada');
}

function fvsAtual(obra, localId, pes) {
  return todasFVS(obra).filter((f) => f.localId === localId && f.pes === pes)
    .sort((a, b) => String(b.atualizadaEm || '').localeCompare(String(a.atualizadaEm || '')))[0] || null;
}

/** Encadeamento: quais serviços de origem ainda não liberaram este serviço neste local. */
function checarEncadeamento(obra, localId, pes) {
  const ativos = pesAtivosDaObra(obra).map((p) => p.codigo);
  const origens = (S.boot ? S.boot.encadeamento : []).filter((e) => e.destino === pes && ativos.includes(e.origem)).map((e) => e.origem);
  return origens.map((o) => {
    const f = fvsAtual(obra, localId, o);
    return { pes: o, titulo: (pesDe(o) || {}).titulo || o, fvs: f, ok: !!(f && STATUS_LIBERA.includes(f.status)) };
  });
}

function respostaAtual(f, it) { return it.respostas.find((r) => r.inspecao === f.inspecao) || null; }
function ultimaResposta(it) { return it.respostas[it.respostas.length - 1] || null; }
function itemEditavel(f, it) {
  const r = respostaAtual(f, it);
  if (!r) return false;
  if (f.status === 'Aguardando ensaio') return r.resultado === 'AE';
  return ['Aberta', 'Em inspeção'].includes(f.status);
}

function classeStatus(st) {
  return ({ 'Aprovada': 'Aprovada', 'Aprovada com ressalva': 'Ressalva', 'Reprovada': 'Reprovada', 'Aberta': 'Aberta',
            'Em inspeção': 'Aberta', 'Aguardando ensaio': 'Ensaio' })[st] || 'Nada';
}
function rotuloStatus(st) {
  return ({ 'Aprovada': '✓ Aprovada', 'Aprovada com ressalva': '◐ Ressalva', 'Reprovada': '✕ Reprovada', 'Aberta': '● Aberta',
            'Em inspeção': '● Em inspeção', 'Aguardando ensaio': '⧗ Ensaio' })[st] || st;
}

async function criarFVS(obra, localId, pes, equipe, liberacao) {
  const p = pesDe(pes); const loc = localDe(localId);
  const cont = ((await DB.get('kv', 'contProvisorio')) || 0) + 1; await DB.put('kv', cont, 'contProvisorio');
  const enc = checarEncadeamento(obra, localId, pes);
  const f = {
    id: uuid(), numero: null, numeroProvisorio: 'FVS-' + obra + '-' + pes.replace(/\D/g, '') + '-P' + String(cont).padStart(4, '0'),
    obra, localId, local: loc.caminho, pes, revisao: p.revisao, classificacao: p.classificacao,
    equipe, inspetor: S.boot.usuario.nome, status: 'Aberta', inspecao: 1, liberacao: liberacao || '',
    abertaEm: agoraISO(), concluidaEm: null, ncs: [],
    itens: S.boot.itens.filter((i) => i.pes === pes && String(i.revisao) === String(p.revisao)).sort((a, b) => a.ordem - b.ordem)
      .map((i) => {
        const auto = /^Sistema/i.test(i.instrumento || '');
        const r = { inspecao: 1, resultado: null, valor: '', obs: '', em: null, fotos: [] };
        if (auto) {
          r.resultado = enc.every((e) => e.ok) ? 'C' : 'C';
          r.obs = enc.every((e) => e.ok) ? 'Liberado pelo sistema: ' + enc.map((e) => e.pes + ' ' + (e.fvs ? e.fvs.status : '')).join(' · ')
                                         : 'Liberado pelo engenheiro: ' + (liberacao || '');
          r.em = agoraISO();
        }
        return Object.assign({}, i, { auto, respostas: [r] });
      })
  };
  await salvarFVS(f); await enfileirar('fvs', f.id);
  return f;
}

/** Resultado proposto ao concluir a inspeção. */
function avaliar(f) {
  const atuais = f.itens.map((it) => ({ it, r: respostaAtual(f, it) })).filter((x) => x.r);
  const semResposta = atuais.filter((x) => !x.r.resultado);
  // Foto: obrigatória quando o PES marca, e SEMPRE que o item é não conforme (evidência da NC).
  const semFoto = atuais.filter((x) => ((x.it.foto && ['C', 'NC'].includes(x.r.resultado)) || x.r.resultado === 'NC') && !(x.r.fotos || []).length);
  // considera também respostas anteriores (itens que não foram reinspecionados)
  const finais = f.itens.map((it) => ultimaResposta(it)).filter(Boolean);
  const ncCrit = f.itens.filter((it) => (ultimaResposta(it) || {}).resultado === 'NC' && it.critico);
  const ncNaoCrit = f.itens.filter((it) => (ultimaResposta(it) || {}).resultado === 'NC' && !it.critico);
  const ensaio = finais.some((r) => r.resultado === 'AE');
  let status;
  if (ncCrit.length) status = 'Reprovada';
  else if (ncNaoCrit.length) status = 'Reprovada';
  else if (ensaio) status = 'Aguardando ensaio';
  else status = 'Aprovada';
  return { semResposta, semFoto, ncCrit, ncNaoCrit, ensaio, status, podeRessalva: !ncCrit.length && ncNaoCrit.length > 0 };
}

async function concluir(f, statusEscolhido, ncsForm) {
  const ev = avaliar(f);
  f.status = statusEscolhido || ev.status;
  f.concluidaEm = agoraISO();
  // NCs dos itens não conformes desta inspeção
  const itensNC = f.itens.filter((it) => (ultimaResposta(it) || {}).resultado === 'NC');
  itensNC.forEach((it) => {
    const dados = ncsForm[it.ordem] || {};
    let nc = f.ncs.find((n) => n.itemOrdem === it.ordem && n.status !== 'Encerrada');
    if (!nc) { nc = { id: uuid(), numero: null, itemOrdem: it.ordem, status: 'Aberta', abertaEm: agoraISO() }; f.ncs.push(nc); }
    Object.assign(nc, dados);
  });
  // NCs cujo item agora está conforme: encerradas pela reinspeção
  f.ncs.forEach((n) => {
    const it = f.itens.find((i) => i.ordem === n.itemOrdem);
    const ult = it && ultimaResposta(it);
    if (n.status !== 'Encerrada' && ult && ['C', 'NA'].includes(ult.resultado)) { n.status = 'Encerrada'; n.encerradaEm = agoraISO(); }
  });
  await salvarFVS(f); await enfileirar('fvs', f.id);
}

async function iniciarReinspecao(f) {
  f.inspecao += 1;
  f.itens.forEach((it) => {
    const ult = ultimaResposta(it);
    if (ult && ult.resultado === 'NC') it.respostas.push({ inspecao: f.inspecao, resultado: null, valor: '', obs: '', em: null, fotos: [] });
  });
  f.status = 'Em inspeção';
  f.ncs.forEach((n) => { if (n.status === 'Aberta') n.status = 'Em tratamento'; });
  await salvarFVS(f); await enfileirar('fvs', f.id);
}

/* ============================================================
 *  Fotos: reduz, carimba e guarda no celular
 * ============================================================ */
async function processarFoto(file, f, it) {
  const img = await new Promise((ok, falha) => {
    const i = new Image(); i.onload = () => ok(i); i.onerror = falha; i.src = URL.createObjectURL(file);
  });
  const max = 1600; const esc = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * esc), h = Math.round(img.height * esc);
  const c = document.createElement('canvas'); c.width = w; c.height = h + 44;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, w, h);
  g.fillStyle = '#0F3D2E'; g.fillRect(0, h, w, 44);
  g.fillStyle = '#FFFFFF'; g.font = '600 18px Barlow, Arial, sans-serif'; g.textBaseline = 'middle';
  const texto = [f.obra, f.numero || f.numeroProvisorio, 'item ' + it.ordem, f.local, new Date().toLocaleString('pt-BR')].join(' · ');
  g.fillText(texto, 12, h + 22, w - 24);
  URL.revokeObjectURL(img.src);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.72));
  const dados = await blob.arrayBuffer();
  const foto = { id: uuid(), fvsId: f.id, inspecao: f.inspecao, itemOrdem: it.ordem, tiradaEm: agoraISO(), dados, enviada: false };
  await DB.put('fotos', foto);
  const r = respostaAtual(f, it); r.fotos = r.fotos || []; r.fotos.push(foto.id);
  await salvarFVS(f);
  await enfileirar('foto', foto.id); await enfileirar('fvs', f.id);
}

const urlsFotos = {};
async function urlFoto(id) {
  if (urlsFotos[id]) return urlsFotos[id];
  const f = await DB.get('fotos', id); if (!f || !f.dados) return null;
  urlsFotos[id] = URL.createObjectURL(new Blob([f.dados], { type: 'image/jpeg' }));
  return urlsFotos[id];
}

/* ============================================================
 *  Telas
 * ============================================================ */
function rota() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [caminho, qs] = h.split('?');
  const partes = caminho.split('/').filter(Boolean);
  return { tela: partes[0] || 'pend', id: partes[1], q: new URLSearchParams(qs || '') };
}

async function render() {
  const r = rota(); const v = $('#view');
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('ativo', a.dataset.nav === r.tela));
  if (!S.token) { v.innerHTML = telaSemToken(); return; }
  if (!S.boot) {
    v.innerHTML = '<div class="aviso info">' + ICON.info + '<div><strong>Preparando o celular.</strong> No primeiro acesso é preciso ter sinal para baixar a obra. Depois disso o app funciona sem internet.</div></div>' +
      '<button class="btn prim bloco" data-acao="sinc">Baixar obra agora</button>';
    return;
  }
  if (r.tela === 'mapa') v.innerHTML = telaMapa();
  else if (r.tela === 'abrir') v.innerHTML = telaAbrir(r.q);
  else if (r.tela === 'fvs') { v.innerHTML = await telaFVS(r.id); await pintarFotos(); }
  else if (r.tela === 'fechar') v.innerHTML = telaFechar(r.id);
  else if (r.tela === 'sync') v.innerHTML = telaSync();
  else v.innerHTML = telaPendencias();
}

function telaSemToken() {
  return '<h1>Acesso</h1><div class="aviso info">' + ICON.info + '<div>Abra o SQ-Rijo pelo <strong>link pessoal</strong> que o escritório enviou por WhatsApp ou e-mail. O link já identifica você e as suas obras.</div></div>';
}

function cabecalhoObra() {
  const o = S.boot.obras.find((x) => x.codigo === S.obra) || {};
  const seletor = S.boot.obras.length > 1
    ? '<label class="campo"><span class="rotulo">Obra</span><select data-acao="trocar-obra">' + S.boot.obras.map((x) => '<option value="' + esc(x.codigo) + '"' + (x.codigo === S.obra ? ' selected' : '') + '>' + esc(x.codigo + ' · ' + x.nome) + '</option>').join('') + '</select></label>'
    : '';
  return '<div><div style="display:flex;gap:8px;align-items:baseline"><span class="cod">' + esc(o.codigo || '') + '</span><span class="sub">' + esc(o.nome || '') + '</span></div></div>' + seletor;
}

function telaPendencias() {
  const todas = todasFVS(S.obra);
  const minhas = Object.values(S.fvs).filter((f) => f.obra === S.obra);
  const andamento = minhas.filter((f) => ['Aberta', 'Em inspeção'].includes(f.status));
  const reprovadas = todas.filter((f) => f.status === 'Reprovada');
  const ensaio = todas.filter((f) => f.status === 'Aguardando ensaio');
  const ncs = ncsAbertas(S.obra).sort((a, b) => String(a.prazo).localeCompare(String(b.prazo)));
  const cartaoFVS = (f) => '<a class="cartao" href="#/fvs/' + esc(f.id) + '"><div class="linha-tit"><strong>' + esc((pesDe(f.pes) || {}).titulo || f.pes) + '</strong><span class="pil st-' + classeStatus(f.status) + '">' + rotuloStatus(f.status) + '</span></div>' +
    '<span class="sub">' + esc(f.local) + (f.itens ? ' · ' + progressoTexto(f) : '') + '</span>' +
    '<span class="mono sub">' + esc(f.numero || f.numeroProvisorio) + (f.origem === 'servidor' ? ' · outro celular' : (!f.sincronizadaEm || f.atualizadaEm > f.sincronizadaEm ? ' · só no celular' : '')) + '</span></a>';
  return cabecalhoObra() +
    '<h1>Minhas pendências</h1>' +
    secao('Não conformidades em aberto', ncs.map(cartaoNC).join(''), 'Nenhuma NC em aberto.') +
    secao('FVS em andamento neste celular', andamento.map(cartaoFVS).join(''), 'Nenhuma FVS em andamento. Use "Abrir FVS".') +
    secao('Reprovadas: precisam de reinspeção', reprovadas.map(cartaoFVS).join(''), 'Nenhuma FVS reprovada.') +
    secao('Aguardando ensaio', ensaio.map(cartaoFVS).join(''), 'Nenhum ensaio pendente.');
}

function secao(titulo, html, vazio) {
  return '<section class="secao"><h2 class="rotulo">' + esc(titulo) + '</h2>' + (html || '<div class="vazio">' + esc(vazio) + '</div>') + '</section>';
}

function ncsAbertas(obra) {
  const lista = {};
  ((S.boot && S.boot.situacao.nc) || []).filter((n) => n.obra === obra).forEach((n) => { lista[n.id] = n; });
  Object.values(S.fvs).filter((f) => f.obra === obra).forEach((f) => (f.ncs || []).forEach((n) => {
    const it = f.itens.find((i) => i.ordem === n.itemOrdem);
    lista[n.id] = Object.assign({}, n, { fvsId: f.id, pes: f.pes, local: f.local, descricao: n.descricao || (it && it.descricao) });
  }));
  return Object.values(lista).filter((n) => n.status !== 'Encerrada');
}

function cartaoNC(n) {
  const vencida = n.prazo && new Date(dia(n.prazo) + 'T23:59:59') < new Date();
  const pil = vencida ? '<span class="pil st-Reprovada">✕ Vencida</span>' : '<span class="pil st-Aberta">Prazo ' + esc(dataBR(dia(n.prazo) + 'T12:00:00')) + '</span>';
  return '<a class="cartao" href="#/fvs/' + esc(n.fvsId) + '"><div class="linha-tit"><strong>' + esc((pesDe(n.pes) || {}).titulo || n.pes) + ' · ' + esc(String(n.local || '').split('›').pop().trim()) + '</strong>' + pil + '</div>' +
    '<span class="sub">' + esc(n.descricao || '') + (n.acao ? ' · Ação: ' + esc(n.acao) : '') + '</span>' +
    '<span class="mono sub">' + esc(n.numero || 'NC ainda não sincronizada') + ' · ' + esc(n.pes) + (n.responsavel ? ' · resp. ' + esc(n.responsavel) : '') + '</span></a>';
}

function progressoTexto(f) {
  const atuais = f.itens.map((it) => respostaAtual(f, it)).filter(Boolean);
  return atuais.filter((r) => r.resultado).length + ' de ' + atuais.length + ' itens';
}

function telaMapa() {
  const locais = S.boot.locais.filter((l) => l.obra === S.obra).sort((a, b) => a.ordem - b.ordem);
  const todas = todasFVS(S.obra);
  let servicos = pesAtivosDaObra(S.obra);
  if (S.filtroMapa === 'comFVS') servicos = servicos.filter((p) => todas.some((f) => f.pes === p.codigo));
  const cel = (l, p) => {
    const f = fvsAtual(S.obra, l.id, p.codigo);
    if (f) return '<a class="pil st-' + classeStatus(f.status) + '" href="#/fvs/' + esc(f.id) + '">' + rotuloStatus(f.status) + '</a>';
    const enc = checarEncadeamento(S.obra, l.id, p.codigo);
    if (enc.length && !enc.every((e) => e.ok)) return '<a class="pil st-Bloqueada" href="#/abrir?local=' + esc(l.id) + '&pes=' + esc(p.codigo) + '">⊘ Bloqueada</a>';
    return '<a class="pil st-Nada" href="#/abrir?local=' + esc(l.id) + '&pes=' + esc(p.codigo) + '" aria-label="Abrir FVS de ' + esc(p.titulo) + ' em ' + esc(l.caminho) + '">—</a>';
  };
  return cabecalhoObra() + '<h1>Mapa da obra</h1>' +
    '<div class="chips"><button class="chip" data-acao="filtro-mapa" data-v="comFVS" aria-pressed="' + (S.filtroMapa === 'comFVS') + '">Serviços com FVS</button>' +
    '<button class="chip" data-acao="filtro-mapa" data-v="todos" aria-pressed="' + (S.filtroMapa === 'todos') + '">Todos os serviços da obra</button></div>' +
    (servicos.length ? '<div class="mapa-wrap"><table class="mapa"><thead><tr><th class="loc" scope="col">Local</th>' +
      servicos.map((p) => '<th scope="col"><div class="mono" style="color:var(--verde)">' + esc(p.codigo.replace('PES-', '')) + '</div><div>' + esc(p.titulo.split(' ').slice(0, 2).join(' ')) + '</div></th>').join('') +
      '</tr></thead><tbody>' + locais.map((l) => '<tr><th class="loc" scope="row">' + esc(l.caminho) + '</th>' + servicos.map((p) => '<td>' + cel(l, p) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>' : '<div class="vazio">Nenhuma FVS ainda nesta obra. Mostre "Todos os serviços" para começar.</div>') +
    '<p class="sub">✓ Aprovada · ◐ Ressalva · ✕ Reprovada · ● Aberta · ⧗ Aguardando ensaio · ⊘ Bloqueada pelo serviço anterior · — Não iniciada. Situação conforme a última sincronização (' + esc(quandoBR(S.ultimaSinc)) + ').</p>';
}

function telaAbrir(q) {
  const locais = S.boot.locais.filter((l) => l.obra === S.obra).sort((a, b) => a.ordem - b.ordem);
  const servicos = pesAtivosDaObra(S.obra);
  const localId = q.get('local') || (locais[0] && locais[0].id);
  const pes = q.get('pes') || (servicos[0] && servicos[0].codigo);
  const p = pesDe(pes) || {};
  const qtdItens = S.boot.itens.filter((i) => i.pes === pes && String(i.revisao) === String(p.revisao)).length;
  const existente = fvsAtual(S.obra, localId, pes);
  const enc = checarEncadeamento(S.obra, localId, pes);
  const bloqueado = enc.some((e) => !e.ok);
  const engenheiro = ['engenheiro', 'admin'].includes(S.boot.usuario.papel);
  let blocoEnc = '';
  if (enc.length) {
    blocoEnc = '<section class="cartao" style="overflow:hidden">' +
      (bloqueado ? '<div class="aviso erro" style="border-radius:0">' + ICON.cadeado + '<div><strong>Serviço anterior não liberado.</strong> ' + esc(p.titulo) + ' só começa com estes serviços aprovados neste local.</div></div>'
                 : '<div class="aviso ok" style="border-radius:0">' + ICON.info + '<div><strong>Liberado.</strong> Os serviços anteriores estão aprovados neste local.</div></div>') +
      '<ul class="lista" style="padding:4px 14px">' + enc.map((e) => '<li><span><strong>' + esc(e.pes) + '</strong> ' + esc(e.titulo) + '</span>' +
        (e.fvs ? '<span class="pil st-' + classeStatus(e.fvs.status) + '">' + rotuloStatus(e.fvs.status) + '</span>' : '<span class="pil st-Bloqueada">Sem FVS</span>') + '</li>').join('') + '</ul>' +
      '<p class="sub" style="padding:0 14px 12px;margin:0">Conforme a última sincronização (' + esc(quandoBR(S.ultimaSinc)) + '). Se o serviço anterior foi aprovado em outro celular, sincronize antes.</p></section>';
  }
  return '<h1>Abrir FVS</h1>' + cabecalhoObra() +
    '<div class="cartao pad" style="display:flex;flex-direction:column;gap:14px">' +
    '<label class="campo"><span class="rotulo">Local</span><select data-acao="abrir-sel" name="local">' + locais.map((l) => '<option value="' + esc(l.id) + '"' + (l.id === localId ? ' selected' : '') + '>' + esc(l.caminho) + '</option>').join('') + '</select></label>' +
    '<label class="campo"><span class="rotulo">Serviço controlado</span><select data-acao="abrir-sel" name="pes">' + servicos.map((s) => '<option value="' + esc(s.codigo) + '"' + (s.codigo === pes ? ' selected' : '') + '>' + esc(s.codigo + ' · ' + s.titulo) + '</option>').join('') + '</select>' +
    '<span class="sub">Rev. ' + esc(p.revisao) + ' (' + esc(p.status) + ') · ' + qtdItens + ' itens · ' + esc(p.classificacao) + '</span></label>' +
    '<label class="campo"><span class="rotulo">Equipe executora</span><input id="equipe" type="text" placeholder="Ex.: equipe do encarregado José" autocomplete="off"></label>' +
    '</div>' +
    (existente && !['Aprovada', 'Aprovada com ressalva'].includes(existente.status)
      ? '<div class="aviso info">' + ICON.info + '<div>Já existe uma FVS deste serviço neste local: <a href="#/fvs/' + esc(existente.id) + '">' + esc(existente.numero || existente.numeroProvisorio) + ' (' + esc(existente.status) + ')</a>. Continue nela em vez de abrir outra.</div></div>' : '') +
    blocoEnc +
    '<div class="barra-acao">' +
    (bloqueado
      ? '<button class="btn bloco" disabled>Abrir FVS (bloqueado)</button>' +
        (engenheiro ? '<label class="campo"><span class="rotulo">Justificativa para liberar (engenheiro)</span><textarea id="justificativa" rows="2" placeholder="Por que liberar mesmo assim"></textarea></label><button class="btn bloco perigo" data-acao="abrir" data-liberar="1" data-local="' + esc(localId) + '" data-pes="' + esc(pes) + '">Liberar e abrir FVS</button>'
                    : '<p class="sub" style="margin:0;text-align:center">Só o engenheiro pode liberar, com justificativa registrada.</p>')
      : '<button class="btn prim bloco" data-acao="abrir" data-local="' + esc(localId) + '" data-pes="' + esc(pes) + '">Abrir FVS</button>') +
    '</div>';
}

async function telaFVS(id) {
  let f = S.fvs[id];
  if (!f) {
    const resumo = todasFVS().find((x) => x.id === id);
    if (!resumo) return '<div class="vazio">FVS não encontrada neste celular.</div>';
    return '<h1>' + esc((pesDe(resumo.pes) || {}).titulo || resumo.pes) + '</h1><div class="cartao pad"><div class="linha-tit"><span class="mono">' + esc(resumo.numero) + '</span><span class="pil st-' + classeStatus(resumo.status) + '">' + rotuloStatus(resumo.status) + '</span></div><p class="sub">' + esc(resumo.local) + ' · inspetor ' + esc(resumo.inspetor || '') + ' · feita em outro celular.</p></div>' +
      '<div class="aviso info">' + ICON.info + '<div>Para reinspecionar ou lançar ensaio aqui, baixe a FVS para este celular (precisa de sinal).</div></div>' +
      '<button class="btn prim bloco" data-acao="baixar-fvs" data-id="' + esc(id) + '">Baixar FVS para este celular</button>';
  }
  const etapas = ['Antes', 'Durante', 'Final', 'Desforma', 'Pós', 'Teste', 'Execução', 'Estrutura', 'Embutido', 'Fiação', 'Quadro', 'Aterramento', 'Rede externa', 'Marcação', 'Elevação', 'Montagem', 'Fixação', 'Fechamento', 'Peitoril', 'Janela', 'Telhas', 'Calhas', 'Rufos', 'Bancada', 'Louças', 'Metais', 'Acessibilidade', 'Grossa', 'Fina', 'Externa', 'Entrega', 'Acabamento', 'Enterrado', 'Antes de fechar']
    .filter((e) => f.itens.some((i) => i.etapa === e));
  f.itens.forEach((i) => { if (!etapas.includes(i.etapa)) etapas.push(i.etapa); });
  const etapaAtiva = S.etapa[f.id] || etapaPendente(f, etapas) || etapas[0];
  const editando = ['Aberta', 'Em inspeção', 'Aguardando ensaio'].includes(f.status);
  // Editando: conta só os itens desta inspeção. Fechada: mostra o resultado final de todos os itens.
  const respDe = (it) => (editando ? respostaAtual(f, it) : ultimaResposta(it));
  const atuais = f.itens.map(respDe).filter(Boolean);
  const feitos = atuais.filter((r) => r.resultado).length;
  const engenheiro = ['engenheiro', 'admin'].includes(S.boot.usuario.papel);
  const ev = avaliar(f);

  let acoes = '';
  if (editando) acoes = '<a class="btn prim bloco" href="#/fechar/' + esc(f.id) + '">' + (f.status === 'Aguardando ensaio' ? 'Lançar resultado do ensaio' : 'Concluir inspeção') + '</a>';
  else if (f.status === 'Reprovada') {
    acoes = '<button class="btn prim bloco" data-acao="reinspecao" data-id="' + esc(f.id) + '">Iniciar reinspeção dos itens reprovados</button>';
    if (engenheiro && ev.podeRessalva) acoes += '<button class="btn bloco" data-acao="ressalva" data-id="' + esc(f.id) + '">Aprovar com ressalva (engenheiro)</button>';
  }

  const tabs = '<div class="etapas" style="grid-template-columns:repeat(' + Math.min(etapas.length, 3) + ',minmax(0,1fr))" role="tablist">' + etapas.map((e) => {
    const its = f.itens.filter((i) => i.etapa === e).map(respDe).filter(Boolean);
    const ok = its.filter((r) => r.resultado).length;
    return '<button role="tab" aria-selected="' + (e === etapaAtiva) + '" class="' + (e === etapaAtiva ? 'ativo' : '') + '" data-acao="etapa" data-id="' + esc(f.id) + '" data-v="' + esc(e) + '">' + esc(e) + ' <span style="font-weight:600">' + ok + '/' + its.length + '</span></button>';
  }).join('') + '</div>';

  const itensHtml = f.itens.filter((it) => it.etapa === etapaAtiva).map((it) => cartaoItem(f, it)).join('');
  return '<div class="linha-tit"><div><h1 style="font-size:22px;line-height:26px">' + esc(f.pes) + ' ' + esc((pesDe(f.pes) || {}).titulo || '') + '</h1>' +
    '<div class="sub">' + esc(f.local) + ' · Rev. ' + esc(f.revisao) + (f.inspecao > 1 ? ' · ' + (f.inspecao - 1) + 'ª reinspeção' : '') + '</div></div>' +
    '<span class="pil st-' + classeStatus(f.status) + '">' + rotuloStatus(f.status) + '</span></div>' +
    '<div class="linha-tit sub"><span class="mono">' + esc(f.numero || f.numeroProvisorio) + '</span><span>' + feitos + ' de ' + atuais.length + ' itens</span></div>' +
    '<div class="progresso" role="progressbar" aria-valuemin="0" aria-valuemax="' + atuais.length + '" aria-valuenow="' + feitos + '" aria-label="Itens respondidos"><div style="width:' + (atuais.length ? Math.round(100 * feitos / atuais.length) : 0) + '%"></div></div>' +
    (f.liberacao ? '<div class="aviso erro">' + ICON.cadeado + '<div>Aberta com liberação do engenheiro: ' + esc(f.liberacao) + '</div></div>' : '') +
    (f.ncs || []).filter((n) => n.status !== 'Encerrada').map((n) => '<div class="aviso erro">' + ICON.info + '<div><strong>' + esc(n.numero || 'NC') + ' · item ' + n.itemOrdem + '</strong> · ' + esc(n.disposicao || '') + ' · ' + esc(n.acao || '') + ' · resp. ' + esc(n.responsavel || '') + ' · prazo ' + esc(dataBR(dia(n.prazo) + 'T12:00:00')) + '</div></div>').join('') +
    tabs + itensHtml +
    (acoes ? '<div class="barra-acao"><span class="sub" style="text-align:center">Salvo no celular ' + esc(quandoBR(f.atualizadaEm)) + '</span>' + acoes + '</div>' : '');
}

function etapaPendente(f, etapas) {
  return etapas.find((e) => f.itens.some((i) => i.etapa === e && respostaAtual(f, i) && !respostaAtual(f, i).resultado));
}

function cartaoItem(f, it) {
  const r = respostaAtual(f, it); const ult = ultimaResposta(it);
  const editavel = itemEditavel(f, it) && !it.auto;
  const mostra = r || ult;
  const hist = it.respostas.length > 1 ? '<div class="sub">Histórico: ' + it.respostas.map((x) => x.inspecao + 'ª ' + (x.resultado || '…')).join(' · ') + '</div>' : '';
  const cab = '<div class="linha-tit"><h3 style="margin:0;font-size:17px;line-height:22px">' + it.ordem + ' · ' + esc(it.descricao) + '</h3>' + (it.critico ? '<span class="critico">CRÍTICO</span>' : '') + '</div>' +
    '<p style="margin:0;font-size:15px;line-height:21px">' + esc(it.criterio) + '</p>' +
    '<p class="sub" style="margin:0">Instrumento: ' + esc(it.instrumento) + (it.foto ? ' · Foto obrigatória' : ' · Foto obrigatória se não conforme') + '</p>';
  if (!editavel) {
    const res = mostra && mostra.resultado;
    const pil = res ? '<span class="pil ' + ({ C: 'st-Aprovada', NC: 'st-Reprovada', NA: 'st-Bloqueada', AE: 'st-Ensaio' })[res] + '">' + ({ C: '✓ Conforme', NC: '✕ Não conforme', NA: 'N/A', AE: '⧗ Aguardando ensaio' })[res] + '</span>' : '<span class="pil st-Nada">—</span>';
    return '<article class="cartao item travado">' + cab + '<div>' + pil + (it.auto ? ' <span class="sub">(automático)</span>' : '') + '</div>' +
      (mostra && mostra.valor ? '<div class="sub">Medido: ' + esc(mostra.valor) + '</div>' : '') +
      (mostra && mostra.obs ? '<div class="sub">' + esc(mostra.obs) + '</div>' : '') +
      '<div class="fotos" data-fotos="' + esc(((mostra && mostra.fotos) || []).join(',')) + '"></div>' + hist + '</article>';
  }
  const opcoes = [['C', '✓ Conforme'], ['NC', '✕ Não conf.'], ['NA', 'N/A']];
  if (it.ensaio) opcoes.push(['AE', '⧗ Aguarda ensaio']);
  return '<article class="cartao item' + (r.resultado ? '' : ' foco') + '" id="item-' + it.ordem + '">' + cab +
    '<div class="res' + (it.ensaio ? ' com-ensaio' : '') + '" role="group" aria-label="Resultado do item ' + it.ordem + '">' +
    opcoes.filter((o) => !(f.status === 'Aguardando ensaio' && o[0] === 'AE')).map((o) => '<button type="button" class="' + o[0] + '" aria-pressed="' + (r.resultado === o[0]) + '" data-acao="resp" data-id="' + esc(f.id) + '" data-ordem="' + it.ordem + '" data-v="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>' +
    '<label class="campo"><span class="rotulo">Valor medido</span><input type="text" value="' + esc(r.valor) + '" data-acao="campo" data-campo="valor" data-id="' + esc(f.id) + '" data-ordem="' + it.ordem + '" placeholder="Ex.: 2 mm na régua"></label>' +
    '<label class="campo"><span class="rotulo">Observação</span><input type="text" value="' + esc(r.obs) + '" data-acao="campo" data-campo="obs" data-id="' + esc(f.id) + '" data-ordem="' + it.ordem + '" placeholder="Onde, o quê"></label>' +
    '<div class="fotos" data-fotos="' + esc((r.fotos || []).join(',')) + '"><button type="button" class="add-foto" data-acao="foto" data-id="' + esc(f.id) + '" data-ordem="' + it.ordem + '">' + ICON.camera + 'Foto</button></div>' + hist + '</article>';
}

async function pintarFotos() {
  for (const box of document.querySelectorAll('[data-fotos]')) {
    const ids = box.dataset.fotos ? box.dataset.fotos.split(',') : [];
    for (const id of ids.reverse()) {
      const u = await urlFoto(id);
      const el = document.createElement(u ? 'img' : 'div');
      if (u) { el.src = u; el.alt = 'Foto do item'; } else { el.className = 'ph'; el.title = 'Foto enviada ao servidor'; }
      box.prepend(el);
    }
  }
}

function telaFechar(id) {
  const f = S.fvs[id]; if (!f) return '<div class="vazio">FVS não encontrada.</div>';
  const ev = avaliar(f);
  const engenheiro = ['engenheiro', 'admin'].includes(S.boot.usuario.papel);
  if (ev.semResposta.length || ev.semFoto.length) {
    return '<h1>Falta pouco</h1>' +
      (ev.semResposta.length ? '<div class="aviso erro">' + ICON.info + '<div><strong>Itens sem resposta:</strong> ' + ev.semResposta.map((x) => esc(x.it.ordem + ' · ' + x.it.descricao)).join('; ') + '</div></div>' : '') +
      (ev.semFoto.length ? '<div class="aviso erro">' + ICON.camera + '<div><strong>Foto obrigatória faltando:</strong> ' + ev.semFoto.map((x) => esc(x.it.ordem + ' · ' + x.it.descricao)).join('; ') + '</div></div>' : '') +
      '<a class="btn prim bloco" href="#/fvs/' + esc(f.id) + '">Voltar aos itens</a>';
  }
  const itensNC = f.itens.filter((it) => (ultimaResposta(it) || {}).resultado === 'NC');
  const bloqueia = (S.boot.encadeamento || []).filter((e) => e.origem === f.pes).map((e) => e.destino);
  const titulo = { 'Reprovada': '✕ Reprovada', 'Aprovada': '✓ Aprovada', 'Aguardando ensaio': '⧗ Aguardando ensaio' }[ev.status];
  const corAviso = ev.status === 'Aprovada' ? 'ok' : (ev.status === 'Reprovada' ? 'erro' : 'info');
  const resumo = (() => {
    const fin = f.itens.map((it) => (ultimaResposta(it) || {}).resultado);
    const c = (v) => fin.filter((x) => x === v).length;
    return c('C') + ' conformes · ' + c('NC') + ' não conformes · ' + c('NA') + ' não se aplica' + (c('AE') ? ' · ' + c('AE') + ' aguardando ensaio' : '');
  })();
  const hoje = new Date(); hoje.setDate(hoje.getDate() + 5);
  const prazoPadrao = hoje.toISOString().slice(0, 10);
  const formNC = itensNC.map((it) => {
    const ult = ultimaResposta(it);
    const n = (f.ncs || []).find((x) => x.itemOrdem === it.ordem && x.status !== 'Encerrada') || {};
    const radio = (v, rot, desab) => '<label class="campo" style="flex-direction:row;align-items:center;gap:10px;min-height:48px;border:1px solid var(--linha-forte);border-radius:8px;padding:0 12px;' + (desab ? 'background:var(--papel-2);color:var(--texto-2)' : '') + '"><input type="radio" name="disp-' + it.ordem + '" value="' + v + '"' + ((n.disposicao || 'Refazer') === v ? ' checked' : '') + (desab ? ' disabled' : '') + ' style="width:20px;height:20px;min-height:0"><span>' + rot + '</span></label>';
    return '<section class="cartao pad" style="display:flex;flex-direction:column;gap:12px" data-nc="' + it.ordem + '">' +
      '<div class="linha-tit"><h2>Não conformidade · item ' + it.ordem + '</h2>' + (it.critico ? '<span class="critico">CRÍTICO</span>' : '') + '</div>' +
      '<label class="campo"><span class="rotulo">O que aconteceu</span><textarea rows="2" data-nc-campo="descricao">' + esc(n.descricao || (it.descricao + ': ' + (ult.obs || ult.valor || 'não atende ao critério'))) + '</textarea></label>' +
      '<fieldset style="border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:8px"><legend class="rotulo" style="margin-bottom:6px">O que fazer (disposição)</legend>' +
      radio('Refazer', '<strong>Refazer</strong>') + radio('Reparar', '<strong>Reparar</strong>') + radio('Concessão', '<strong>Aceitar com concessão</strong>' + (engenheiro ? '' : ' · só o engenheiro'), !engenheiro) + '</fieldset>' +
      '<label class="campo"><span class="rotulo">Ação</span><input type="text" data-nc-campo="acao" value="' + esc(n.acao || '') + '" placeholder="O que vai ser feito"></label>' +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">' +
      '<label class="campo"><span class="rotulo">Responsável</span><input type="text" data-nc-campo="responsavel" value="' + esc(n.responsavel || f.equipe || '') + '"></label>' +
      '<label class="campo"><span class="rotulo">Prazo</span><input type="date" data-nc-campo="prazo" value="' + esc(dia(n.prazo) || prazoPadrao) + '"></label></div></section>';
  }).join('');
  const botoes = ev.status === 'Reprovada'
    ? (engenheiro && ev.podeRessalva ? '<button class="btn bloco" data-acao="concluir" data-id="' + esc(f.id) + '" data-status="Aprovada com ressalva">Aprovar com ressalva (NC fica aberta)</button>' : '') +
      '<button class="btn prim bloco" data-acao="concluir" data-id="' + esc(f.id) + '" data-status="Reprovada">Fechar como reprovada e registrar NC</button>'
    : '<button class="btn prim bloco" data-acao="concluir" data-id="' + esc(f.id) + '" data-status="' + esc(ev.status) + '">' + (ev.status === 'Aprovada' ? 'Aprovar FVS' : 'Fechar aguardando ensaio') + '</button>';
  return '<h1>Concluir inspeção</h1><div class="sub">' + esc(f.pes) + ' · ' + esc(f.local) + '</div>' +
    '<div class="aviso ' + corAviso + '" style="flex-direction:column;gap:2px"><div style="font:700 22px/26px var(--cond)">' + titulo + '</div><div>' + resumo + '</div></div>' +
    (ev.status === 'Reprovada' && bloqueia.length ? '<div class="aviso info">' + ICON.cadeado + '<div>' + bloqueia.map((b) => '<strong>' + esc(b) + ' ' + esc((pesDe(b) || {}).titulo || '') + '</strong>').join(', ') + ' fica(m) bloqueado(s) neste local até a reinspeção ser aprovada.</div></div>' : '') +
    (ev.status === 'Reprovada' && !ev.ncCrit.length && !engenheiro ? '<div class="aviso info">' + ICON.info + '<div>Só há itens não críticos reprovados: o engenheiro pode aprovar com ressalva depois.</div></div>' : '') +
    formNC +
    '<div class="barra-acao"><span class="sub" style="text-align:center">' + esc(S.boot.usuario.nome) + ' · ' + esc(new Date().toLocaleString('pt-BR')) + ' (hora do celular)</span>' + botoes + '</div>';
}

function telaSync() {
  const pend = S.fila.filter((x) => x.estado === 'pendente');
  const rej = S.fila.filter((x) => x.estado === 'rejeitado');
  const fotos = pend.filter((x) => x.tipo === 'foto').length;
  return '<h1>Sincronizar</h1>' +
    '<div class="cartao pad" style="display:flex;flex-direction:column;gap:6px">' +
    '<div class="linha-tit"><span>Última sincronização</span><strong>' + esc(quandoBR(S.ultimaSinc)) + '</strong></div>' +
    '<div class="linha-tit"><span>Para enviar</span><strong>' + (pend.length - fotos) + ' registro(s) · ' + fotos + ' foto(s)</strong></div>' +
    (S.erroSinc ? '<div class="sub">Última tentativa: ' + esc(S.erroSinc) + '</div>' : '') +
    '</div>' +
    (rej.length ? '<div class="aviso erro">' + ICON.info + '<div><strong>' + rej.length + ' envio(s) recusado(s) pelo servidor.</strong> ' + rej.map((x) => esc(x.erro)).join('; ') + ' Avise o escritório.</div></div>' : '') +
    '<button class="btn prim bloco" data-acao="sinc"' + (S.sincronizando ? ' disabled' : '') + '>' + (S.sincronizando ? 'Sincronizando…' : 'Sincronizar agora') + '</button>' +
    '<div class="cartao pad sub" style="display:flex;flex-direction:column;gap:4px">' +
    '<div>Usuário: <strong>' + esc(S.boot ? S.boot.usuario.nome : '') + '</strong> (' + esc(S.boot ? S.boot.usuario.papel : '') + ')</div>' +
    '<div>App v' + VERSAO + (MODO_DEMO ? ' · <strong>modo demonstração</strong> (nada vai para o servidor)' : '') + '</div>' +
    '<div>Dica: sincronize pelo menos a cada ' + CFG.DIAS_ALERTA_SINC + ' dias. Se o celular quebrar com FVS não enviadas, elas se perdem.</div>' +
    (MODO_DEMO ? '<button class="btn" data-acao="zerar-demo" style="margin-top:8px">Recomeçar a demonstração</button>' : '') +
    '</div>';
}

/* ============================================================
 *  Cabeçalho e faixa de sinal
 * ============================================================ */
function atualizarCabecalho() {
  const pend = S.fila.filter((x) => x.estado === 'pendente').length;
  $('#nav-sync').textContent = pend ? 'Sincronizar (' + pend + ')' : 'Sincronizar';
  $('#cab-user').innerHTML = S.boot ? esc(S.boot.usuario.nome.split(' ')[0]) + '<br>' + esc(S.boot.usuario.papel) : '';
  const fx = $('#faixa');
  const atrasado = pend && diasDesde(S.ultimaSinc) > CFG.DIAS_ALERTA_SINC;
  if (S.sincronizando) fx.innerHTML = '<div class="faixa ok">Sincronizando…</div>';
  else if (atrasado) fx.innerHTML = '<div class="faixa erro">' + ICON.semSinal + '<div class="esp"><strong>Mais de ' + CFG.DIAS_ALERTA_SINC + ' dias sem enviar.</strong> ' + pend + ' envio(s) só neste celular.</div><button data-acao="sinc">Enviar</button></div>';
  else if (!navigator.onLine || S.erroSinc) fx.innerHTML = '<div class="faixa off">' + ICON.semSinal + '<div class="esp"><strong>Sem sinal.</strong> Tudo fica salvo no celular' + (pend ? ' · ' + pend + ' para enviar' : '') + '.</div></div>';
  else if (pend) fx.innerHTML = '<div class="faixa off"><div class="esp">' + pend + ' envio(s) pendente(s).</div><button data-acao="sinc">Enviar</button></div>';
  else fx.innerHTML = MODO_DEMO ? '<div class="faixa ok"><div class="esp">Modo demonstração · sincronizado ' + esc(quandoBR(S.ultimaSinc)) + '</div></div>' : '';
}

/* ============================================================
 *  Eventos
 * ============================================================ */
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-acao]'); if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const a = el.dataset.acao;
  if (a === 'sinc') return sincronizar(true);
  if (a === 'etapa') { S.etapa[el.dataset.id] = el.dataset.v; return render(); }
  if (a === 'filtro-mapa') { S.filtroMapa = el.dataset.v; return render(); }
  if (a === 'resp') {
    const f = S.fvs[el.dataset.id]; const it = f.itens.find((i) => i.ordem === Number(el.dataset.ordem));
    const r = respostaAtual(f, it); r.resultado = el.dataset.v; r.em = agoraISO();
    if (f.status === 'Aberta') f.status = 'Em inspeção';
    await salvarFVS(f); await enfileirar('fvs', f.id);
    const y = window.scrollY; await render(); window.scrollTo(0, y); return;
  }
  if (a === 'foto') {
    const inp = $('#arq-foto'); inp.value = '';
    inp.onchange = async () => {
      if (!inp.files[0]) return;
      const f = S.fvs[el.dataset.id]; const it = f.itens.find((i) => i.ordem === Number(el.dataset.ordem));
      try { await processarFoto(inp.files[0], f, it); toast('Foto guardada no celular.'); } catch (e) { toast('Não consegui ler a foto. Tente de novo.'); }
      const y = window.scrollY; await render(); window.scrollTo(0, y);
    };
    inp.click(); return;
  }
  if (a === 'abrir') {
    const just = el.dataset.liberar ? ($('#justificativa').value || '').trim() : '';
    if (el.dataset.liberar && just.length < 10) return toast('Escreva a justificativa da liberação (mínimo 10 letras).');
    const f = await criarFVS(S.obra, el.dataset.local, el.dataset.pes, ($('#equipe').value || '').trim(), just);
    location.hash = '#/fvs/' + f.id; sincronizar(); return;
  }
  if (a === 'concluir') {
    const f = S.fvs[el.dataset.id]; const forms = {}; let faltando = false;
    document.querySelectorAll('[data-nc]').forEach((sec) => {
      const o = {}; sec.querySelectorAll('[data-nc-campo]').forEach((c) => { o[c.dataset.ncCampo] = c.value.trim(); });
      const marc = sec.querySelector('input[type=radio]:checked'); o.disposicao = marc ? marc.value : 'Refazer';
      if (!o.descricao || !o.acao || !o.responsavel || !o.prazo) faltando = true;
      forms[Number(sec.dataset.nc)] = o;
    });
    if (faltando) return toast('Preencha o que aconteceu, a ação, o responsável e o prazo de cada NC.');
    await concluir(f, el.dataset.status, forms);
    toast(f.status === 'Aprovada' ? 'FVS aprovada.' : 'FVS fechada: ' + f.status + '.');
    location.hash = '#/fvs/' + f.id; sincronizar(); return;
  }
  if (a === 'reinspecao') { await iniciarReinspecao(S.fvs[el.dataset.id]); render(); sincronizar(); return; }
  if (a === 'ressalva') {
    const f = S.fvs[el.dataset.id]; f.status = 'Aprovada com ressalva'; await salvarFVS(f); await enfileirar('fvs', f.id);
    toast('Aprovada com ressalva. A NC continua aberta.'); render(); sincronizar(); return;
  }
  if (a === 'baixar-fvs') {
    try { const r = await API.chamar('obterFVS', { id: el.dataset.id });
      r.fvs.itens.forEach((it) => it.respostas.forEach((x) => { x.fotos = x.fotos || []; }));
      r.fvs.sincronizadaEm = agoraISO(); await salvarFVS(r.fvs); r.fvs.sincronizadaEm = r.fvs.atualizadaEm; await DB.put('fvs', r.fvs); toast('FVS baixada para este celular.'); render();
    } catch (e) { toast(e.message); }
    return;
  }
  if (a === 'zerar-demo') {
    for (const l of ['fvs', 'fila', 'fotos']) for (const x of await DB.all(l)) await DB.del(l, x.id);
    await DB.del('kv', 'demoServidor'); await DB.del('kv', 'boot'); S.fvs = {}; S.fila = []; S.boot = null;
    location.hash = '#/'; await sincronizar(true); return;
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.acao === 'trocar-obra') { S.obra = el.value; await DB.put('kv', S.obra, 'obra'); return render(); }
  if (el.dataset.acao === 'abrir-sel') {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    q.set(el.name, el.value); location.hash = '#/abrir?' + q.toString(); return;
  }
  if (el.dataset.acao === 'campo') {
    const f = S.fvs[el.dataset.id]; const it = f.itens.find((i) => i.ordem === Number(el.dataset.ordem));
    respostaAtual(f, it)[el.dataset.campo] = el.value; await salvarFVS(f); await enfileirar('fvs', f.id);
  }
});

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
window.addEventListener('online', () => { atualizarCabecalho(); sincronizar(); });
window.addEventListener('offline', atualizarCabecalho);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizar(); });

/* ============================================================
 *  Início
 * ============================================================ */
(async function iniciar() {
  const M = window.SQ_MARCA || {};
  if (M.LOGO_POS) $('#img-logo').src = M.LOGO_POS;
  if (M.SELO_ISO) $('#img-iso').src = M.SELO_ISO;
  if (M.SELO_PBQPH) $('#img-pbqph').src = M.SELO_PBQPH;

  await DB.abrir();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const url = new URL(location.href);
  const t = url.searchParams.get('t');
  if (t && t.length >= 20) { await DB.put('kv', t, 'token'); url.searchParams.delete('t'); history.replaceState(null, '', url.pathname + url.search + url.hash); }
  S.token = MODO_DEMO ? 'demo' : (t || (await DB.get('kv', 'token')));
  S.boot = await DB.get('kv', 'boot') || null;
  S.ultimaSinc = await DB.get('kv', 'ultimaSinc') || null;
  S.obra = (await DB.get('kv', 'obra')) || (S.boot && S.boot.obras[0] && S.boot.obras[0].codigo) || null;
  (await DB.all('fvs')).forEach((f) => { S.fvs[f.id] = f; });
  S.fila = await DB.all('fila');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  atualizarCabecalho(); await render();
  sincronizar();
  setInterval(() => { if (document.visibilityState === 'visible') sincronizar(); }, 60000);
})();
