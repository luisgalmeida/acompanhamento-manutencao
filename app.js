"use strict";
/* ===== Dados da planilha ===== */
const EQUIPAMENTOS = ["Bateria", "Drone", "Carregador", "Gerador", "Controle", "Motor", "Placa", "Outros"];
const MODELOS = ["T10", "T20", "T20P", "T25", "T25P", "T30", "T40", "T50", "T55P", "T70", "T70P", "T100", "T100 Dual", "Consumer", "Aviônica", "Outros"];
const GARANTIAS = ["Sim", "Não", "Condenado"];

/* ===== Kanbans e regras para entrar em cada um ===== */
const BASE = [
  { id: "chegada", name: "Chegada de Equipamento" },
  { id: "analise", name: "Aguardando Análise" },
  { id: "aprov", name: "Aguardando Aprovação" },
  { id: "fila", name: "Fila de Manutenção" },
  { id: "exec", name: "Em Execução" },
  { id: "teste", name: "Teste de Equipamento" },
  { id: "final", name: "Finalizado" },
  { id: "condenado", name: "Equipamentos Condenados" },
  { id: "pronto", name: "Prontos para Envio" },
  { id: "enviado", name: "Enviados" }
];
const FLUXO = BASE.filter(b => b.id !== "condenado");   // etapas sequenciais (condenado é saída lateral)
const REQ = {
  chegada: ["equipamento", "modelo", "serie", "dChegada"],
  analise: ["os", "cliente", "garantia", "vendedor", "valorProposta"],
  aprov: ["dAnalise", "tecnico"],
  fila: ["dAprovacao"],
  exec: ["dExecucao"],
  teste: ["dTeste"],
  final: ["dFinalizado"],
  pronto: [],
  enviado: ["dEnvio", "rastreio"],
  condenado: []
};
const LABEL = {
  vendedor: "Vendedor", valorProposta: "Valor da Proposta",
  valorAlterado: "Alterar o Valor da Proposta (diferente do valor na chegada à análise)",
  os: "Ordem de Serviço", cliente: "Cliente", equipamento: "Equipamento",
  modelo: "Modelo", serie: "Nº Série", garantia: "Garantia", tecnico: "Técnico Responsável",
  enviado: "Enviado ao Cliente", rastreio: "Código de Rastreio", dChegada: "Data de chegada",
  dAnalise: "Data de análise", dAprovacao: "Data de aprovação", dExecucao: "Data de execução",
  dTeste: "Data de teste de equipamento", dFinalizado: "Data de finalizado", dEnvio: "Data de envio"
};

/* ===== Estado ===== */
let S = { cols: [], cards: [] };
let termo = "";

/* ===== Perfis de acesso (o que cada perfil vê na tela; as regras reais ficam no banco — veja schema.sql) ===== */
const TODOS_TILES = ["aberto", "analise", "aprov", "fila", "exec", "teste", "final", "pronto"];
const PERFIS = {
  admin:      { nome: "Administrador", cols: null, criar: true,  kanbans: true,  valores: true,  editarTudo: true,  excluir: true,  tiles: TODOS_TILES },
  vendedor:   { nome: "Vendedor",      cols: null, criar: true,  kanbans: false, valores: true,  editarTudo: false, excluir: false, tiles: TODOS_TILES },
  manutencao: { nome: "Manutenção",    cols: ["analise", "fila", "exec", "teste"], criar: false, kanbans: false, valores: false, editarTudo: false, excluir: false, tiles: ["analise", "fila", "exec", "teste"] },
  expedicao:  { nome: "Expedição",     cols: ["chegada", "final", "condenado", "pronto", "enviado"], criar: true, kanbans: false, valores: false, editarTudo: false, excluir: false, tiles: ["chegada", "final", "condenado", "pronto", "enviado"] }
};
const TILE_LABEL = { analise: "Aguardando análise", aprov: "Aguardando aprovação", fila: "Fila de manutenção", exec: "Em execução",
  teste: "Teste de equipamento", final: "Finalizado", pronto: "Prontos para envio", chegada: "Chegada de equipamento",
  condenado: "Equipamentos condenados", enviado: "Enviados" };
let ROLE = null;
const P = () => PERFIS[ROLE] || {};
const colVisivel = id => !P().cols || P().cols.includes(id);
const rotulo = k => (!P().valores && (k === "valorProposta" || k === "valorAlterado")) ? "atualização do valor da proposta (a cargo do Vendedor)" : LABEL[k];
// fora do Administrador, o que já foi salvo não é editado (exceto o valor da proposta enquanto a OS está em análise)
const bloqueado = (k, c) => !P().editarTudo && String(c[k] || "").trim() !== "" && !(k === "valorProposta" && c.col === "analise");
const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, ch => { const r = Math.random() * 16 | 0; return (ch === "x" ? r : (r & 3 | 8)).toString(16); }));

/* ===== Banco de dados (Supabase) ===== */
const sb = (typeof supabase !== "undefined" && CONFIG && !String(CONFIG.url).startsWith("COLE_"))
  ? supabase.createClient(CONFIG.url, CONFIG.anonKey) : null;
const CAMPOS_OS = ["col", "equipamento", "modelo", "serie", "os", "cliente", "garantia", "tecnico", "vendedor", "enviado", "rastreio",
  "dChegada", "dAnalise", "dAprovacao", "dExecucao", "dTeste", "dFinalizado", "dEnvio"];
const CAMPOS_DATA = new Set(["dChegada", "dAnalise", "dAprovacao", "dExecucao", "dTeste", "dFinalizado", "dEnvio"]);
const snake = k => k.replace(/[A-Z]/g, m => "_" + m.toLowerCase());

let snap = {}, snapCols = "[]", pendente = false, fila = Promise.resolve(), escrevendo = 0;
function snapshot() { snap = {}; S.cards.forEach(c => snap[c.id] = JSON.stringify(c)); snapCols = JSON.stringify(S.cols); }

function linhaParaCard(r) {
  const c = { id: r.id };
  CAMPOS_OS.forEach(k => { const v = r[snake(k)]; c[k] = v == null ? "" : v; });
  const v = Array.isArray(r.os_valores) ? r.os_valores[0] : r.os_valores;
  c.valorProposta = v && v.valor_proposta || "";
  c.valorBase = v && v.valor_base || "";
  return c;
}
async function carregar(avisar, imediato) {
  if (!sb || !ROLE) return;
  if (!imediato) await fila;                    // espera as gravações pendentes terminarem
  const [co, os] = await Promise.all([
    sb.from("colunas").select("*").order("ordem"),
    sb.from("ordens").select("*, os_valores(valor_proposta, valor_base)").order("criado_em")
  ]);
  if (co.error || os.error) { toast("Erro ao carregar: " + (co.error || os.error).message); return; }
  S = { cols: co.data.map(c => ({ id: c.id, name: c.nome, custom: c.custom })), cards: os.data.map(linhaParaCard) };
  snapshot(); render();
  if (avisar) toast("Informações atualizadas");
}
const sincronizar = avisar => carregar(avisar);

async function ok(p) {
  const r = await p;
  if (r.error) throw r.error;
  if (r.count === 0) throw new Error("sem permissão para alterar esta OS");
  return r;
}
async function gravarCard(p) {
  if (p.del) { await ok(sb.from("ordens").delete({ count: "exact" }).eq("id", p.del)); return; }
  const c = p.c, a = p.antes || {}, row = {};
  CAMPOS_OS.forEach(k => {
    if (p.novo || c[k] !== a[k]) row[snake(k)] = CAMPOS_DATA.has(k) ? (c[k] || null) : (c[k] == null ? "" : c[k]);
  });
  if (p.novo) { row.id = c.id; await ok(sb.from("ordens").insert(row)); }
  else if (Object.keys(row).length) await ok(sb.from("ordens").update(row, { count: "exact" }).eq("id", c.id));
  if (P().valores && (c.valorProposta || c.valorBase) && (p.novo || c.valorProposta !== a.valorProposta || c.valorBase !== a.valorBase))
    await ok(sb.from("os_valores").upsert({ ordem_id: c.id, valor_proposta: c.valorProposta || "", valor_base: c.valorBase || "" }));
}
async function gravarCols(cols, removidos) {
  await ok(sb.from("colunas").upsert(cols.map((c, i) => ({ id: c.id, nome: c.name, ordem: i, custom: !!c.custom }))));
  if (removidos.length) await ok(sb.from("colunas").delete().in("id", removidos));
}
// save() continua síncrono: compara com o último estado conhecido e envia só o que mudou
function save() {
  if (!sb) return;
  const tarefas = [];
  const atuais = new Set(S.cards.map(c => c.id));
  S.cards.forEach(c => {
    const js = JSON.stringify(c);
    if (snap[c.id] === js) return;
    const p = { novo: snap[c.id] === undefined, c: JSON.parse(js), antes: snap[c.id] ? JSON.parse(snap[c.id]) : null };
    tarefas.push(() => gravarCard(p));
  });
  Object.keys(snap).forEach(id => { if (!atuais.has(id)) tarefas.push(() => gravarCard({ del: id })); });
  if (JSON.stringify(S.cols) !== snapCols && P().kanbans) {
    const antes = JSON.parse(snapCols).map(c => c.id), cols = JSON.parse(JSON.stringify(S.cols));
    tarefas.push(() => gravarCols(cols, antes.filter(id => !cols.some(c => c.id === id))));
  }
  snapshot();
  tarefas.forEach(t => {
    escrevendo++;
    fila = fila.then(t).catch(e => { toast("Não foi possível salvar: " + (e.message || e)); return carregar(false, true); })
      .then(() => { if (--escrevendo === 0 && pendente && $("overlay").hidden) { pendente = false; carregar(); } });
  });
}
let inscrito = false, agenda = null;
function assinarMudancas() {                   // outro acesso salvou algo -> atualiza sozinho
  if (!sb || inscrito) return; inscrito = true;
  const aviso = () => {
    clearTimeout(agenda);
    agenda = setTimeout(() => { if (!ROLE) return; if ($("overlay").hidden && $("conf").hidden && !escrevendo) carregar(); else pendente = true; }, 500);
  };
  let ch = sb.channel("mudancas");
  ["ordens", "colunas", "os_valores"].forEach(t => { ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, aviso); });
  ch.subscribe();
}

const $ = id => document.getElementById(id);
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

/* ===== Datas e regra de status (mesma fórmula da planilha) ===== */
const parse = s => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmt = d => d ? d.toLocaleDateString("pt-BR") : "";
const numValor = v => {                // "R$ 1.500,50" | "1500.5" | "1.500" -> número
  let t = String(v || "").replace(/[^\d.,-]/g, "");
  if (!t) return 0;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = parseFloat(t); return isNaN(n) ? 0 : n;
};
const brl = n => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

function prazo(eq) {
  if (eq === "Drone" || eq === "Bateria") return 5;
  if (eq === "Placa") return 1;
  if (eq === "Carregador" || eq === "Gerador") return 7;
  return 10;
}
function workday(d, n) {               // DIATRABALHO
  const r = new Date(d);
  while (n > 0) { r.setDate(r.getDate() + 1); const w = r.getDay(); if (w !== 0 && w !== 6) n--; }
  return r;
}
function diasUteisAtraso(limite) {     // dias úteis entre o limite e hoje
  const r = new Date(limite), h = hoje(); let n = 0;
  while (r < h) { r.setDate(r.getDate() + 1); const w = r.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
function info(c) {
  const p = prazo(c.equipamento), h = hoje();
  let status = "", limite = null, atrasado = false;
  if (c.col === "condenado") return { status: "Equipamento Condenado", limite, atrasado, diasAtraso: 0 };
  if (c.dFinalizado) status = "Manutenção Finalizada";
  else if (c.dTeste) status = "Teste de Equipamento";
  else if (c.dExecucao) {
    limite = workday(parse(c.dExecucao), p);
    atrasado = limite < h; status = atrasado ? "Manutenção em Atraso" : "Em manutenção";
  } else if (c.dAprovacao) status = "Aguardando Execução";
  else if (c.dAnalise) status = "Aguardando Aprovação";
  else if (c.dChegada) {
    limite = workday(parse(c.dChegada), p);
    atrasado = limite < h; status = atrasado ? "Análise Atrasada" : "Aguardando Análise";
  }
  return { status, limite, atrasado, diasAtraso: atrasado ? diasUteisAtraso(limite) : 0 };
}

/* ===== Regras de movimentação ===== */
const baseIdx = id => FLUXO.findIndex(b => b.id === id);
const proxima = id => { const i = FLUXO.findIndex(b => b.id === id); return i < 0 ? null : S.cols.slice(S.cols.findIndex(x => x.id === id) + 1).find(x => x.id !== "condenado") || null; };
const anterior = id => { const k = S.cols.findIndex(x => x.id === id); return S.cols.slice(0, k).reverse().find(x => x.id !== "condenado") || null; };
const DATA_COL = { chegada: "dChegada", analise: "dChegada", aprov: "dAnalise", fila: "dAprovacao", exec: "dExecucao",
  teste: "dTeste", final: "dFinalizado", pronto: "dFinalizado", enviado: "dEnvio" };   // data que levou a OS à coluna
const vazio = (c, k) => !String(c[k] || "").trim();

const semValor = c => c.garantia === "Sim";   // equipamento em garantia dispensa o valor da proposta
function exigidos(c, de, t) {                  // campos exigidos para ir da etapa de+1 até a etapa t
  const falta = [];
  for (let i = Math.max(de, -1) + 1; i <= t; i++)
    REQ[FLUXO[i].id].forEach(k => {
      if (vazio(c, k) && !falta.includes(k) && !(semValor(c) && k === "valorProposta")) falta.push(k);
    });
  return falta;
}
function faltando(c, colId) {
  const t = baseIdx(colId);
  if (t < 0 || colId === "condenado") return [];
  const de = baseIdx(c.col);
  if (t <= de) return [];               // voltar etapa não exige nada
  const falta = exigidos(c, de, t);
  // saindo de Aguardando Análise para Aguardando Aprovação: o valor da proposta precisa ter sido alterado
  if (c.col === "analise" && t >= baseIdx("aprov") && !semValor(c) && numValor(c.valorProposta) === numValor(c.valorBase) && !falta.includes("valorProposta"))
    falta.push("valorAlterado");
  return falta;
}
const pendentes = c => { const t = baseIdx(c.col); return t < 0 ? [] : exigidos(c, -1, t); };   // o que já deveria estar preenchido no kanban atual
function mover(c, colId, silencioso) {
  const f = faltando(c, colId);
  if (f.length && !P().editarTudo) {       // só o Administrador move com campos pendentes
    if (!silencioso) toast("Para mover para “" + colName(colId) + "” preencha: " + f.map(rotulo).join(", "));
    return false;
  }
  c.col = colId;
  if (colId === "analise") c.valorBase = c.valorProposta || "";
  if (colId === "enviado") c.enviado = "Sim";
  save(); render();
  if (f.length && !silencioso) toast("OS movida com campos pendentes (em amarelo na OS): " + f.map(rotulo).join(", "));
  else if (!colVisivel(colId)) toast("OS enviada para “" + colName(colId) + "”");
  return true;
}
const colName = id => (S.cols.find(c => c.id === id) || {}).name || "";

/* ===== Render ===== */
function visiveis() {
  const sem = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const t = sem(termo).trim();
  const soAtrasadas = t.startsWith("atras");
  return S.cards.filter(c => {
    if (!colVisivel(c.col)) return false;
    const i = info(c);
    if (!t) return true;
    if (soAtrasadas) return i.atrasado;
    return [c.os, c.cliente, c.serie, c.equipamento, c.modelo, c.tecnico, c.rastreio, i.status].some(v => sem(v).includes(t));
  });
}
function cardHtml(c) {
  const i = info(c);
  const gar = c.garantia === "Sim" ? '<span class="tag warn">Garantia</span> ' : c.garantia === "Condenado" ? '<span class="tag">Condenado</span> ' : "";
  let prazoTxt = "";
  if (i.atrasado) prazoTxt = `<span class="tag late">⚠ Atrasada${i.diasAtraso ? " · " + i.diasAtraso + " d.u." : ""}</span>`;
  else if (i.limite) prazoTxt = `<span class="tag">Prazo: ${fmt(i.limite)}</span>`;
  const ico = i.atrasado ? '<svg class="lateico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><title>Atrasada</title><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>' : "";
  return `<div class="card ${i.atrasado ? "late" : ""}" draggable="true" data-id="${c.id}">
    <h3><span>${esc(c.equipamento)} ${esc(c.modelo)}</span>${ico}</h3>
    <p>${esc(c.cliente || "Cliente não informado")}</p>
    <p>Série: ${esc(c.serie)}</p>
    <div>${gar}${prazoTxt}</div>
    <div class="foot"><span>${c.os ? "OS " + esc(c.os) : "Sem OS"}</span><span>${esc(i.status)}</span></div>
  </div>`;
}
function render() {
  if (!ROLE) return;
  const board = $("board");
  const sl = board.scrollLeft;
  const tops = [...board.querySelectorAll(".cards")].map(e => e.scrollTop);

  const vis = visiveis();
  const kb = P().kanbans;
  board.innerHTML = S.cols.filter(col => colVisivel(col.id)).map(col => {
    const dk = DATA_COL[col.id] || "dChegada";           // mais antigo no topo (pela data de entrada na coluna)
    const dataOrd = c => c[dk] || c.dChegada || "9999-99-99";
    const its = vis.filter(c => c.col === col.id).sort((a, b) =>
      dataOrd(a).localeCompare(dataOrd(b)) || (a.dChegada || "").localeCompare(b.dChegada || "") || String(a.id).localeCompare(String(b.id)));
    const total = S.cards.filter(c => c.col === col.id).length;
    return `<div class="col" data-col="${col.id}">
      <h2><span class="ttl" ${kb ? 'data-act="rename" title="Clique para renomear"' : ""}>${esc(col.name)}</span>
        ${kb ? '<button class="ib" data-act="rename" title="Renomear">✎</button>' : ""}
        ${kb && col.custom && !total ? '<button class="ib" data-act="del" title="Excluir kanban">✕</button>' : ""}
        <b>${its.length}</b></h2>
      <div class="cards">${its.map(cardHtml).join("") || '<div class="empty">Sem OS</div>'}</div>
    </div>`;
  }).join("") + (kb ? '<div class="col add" data-act="addcol">+ Novo kanban</div>' : "");
  board.scrollLeft = sl;
  board.querySelectorAll(".cards").forEach((e, i) => { if (tops[i]) e.scrollTop = tops[i]; });

  // painel
  const n = id => S.cards.filter(c => c.col === id).length;
  const atr = S.cards.filter(c => colVisivel(c.col) && info(c).atrasado).length;
  const aberto = S.cards.filter(c => c.col !== "enviado" && c.col !== "condenado").length;
  const COM_VALOR = ["analise", "aprov", "fila", "exec", "teste", "final"];
  const soma = id => P().valores && COM_VALOR.includes(id) ? brl(S.cards.filter(c => c.col === id).reduce((t, c) => t + numValor(c.valorProposta), 0)) : "";
  const tiles = P().tiles.map(id => id === "aberto" ? ["Em aberto", aberto, ""] : [TILE_LABEL[id], n(id), "", soma(id)]);
  const tile = ([l, v, k, valor]) => `<div class="stat ${k}"><span class="n">${v}</span><span class="l">${l}</span>${valor ? `<span class="v">${valor}</span>` : ""}</div>`;
  $("stats").innerHTML = tiles.map(tile).join("") + tile(["Atrasadas", atr, "late"]);
}

/* ===== Eventos do quadro ===== */
$("board").addEventListener("click", e => {
  const card = e.target.closest(".card");
  if (card) return abrir(card.dataset.id);
  const act = e.target.closest("[data-act]");
  if (!act || !P().kanbans) return;
  const colEl = e.target.closest(".col");
  if (act.dataset.act === "addcol") {
    const id = "c" + Date.now();
    S.cols.push({ id, name: "Novo kanban", custom: true });
    save(); render();
    const t = $("board").querySelector(`[data-col="${id}"] .ttl`);
    $("board").scrollLeft = $("board").scrollWidth;
    if (t) renomear(id);
  } else if (act.dataset.act === "rename") renomear(colEl.dataset.col);
  else if (act.dataset.act === "del") {
    S.cols = S.cols.filter(c => c.id !== colEl.dataset.col); save(); render();
  }
});
function renomear(id) {
  const h2 = $("board").querySelector(`[data-col="${id}"] h2`);
  const col = S.cols.find(c => c.id === id);
  if (!h2 || h2.querySelector("input")) return;
  const inp = document.createElement("input");
  inp.value = col.name;
  h2.querySelector(".ttl").replaceWith(inp);
  inp.focus(); inp.select();
  let feito = false;
  const fim = ok => {
    if (feito) return; feito = true;
    if (ok && inp.value.trim()) col.name = inp.value.trim();
    save(); render();
  };
  inp.onblur = () => fim(true);
  inp.onkeydown = e => { if (e.key === "Enter") fim(true); if (e.key === "Escape") fim(false); };
}

let arrastando = null;
$("board").addEventListener("dragstart", e => {
  const c = e.target.closest(".card"); if (!c) return;
  arrastando = c.dataset.id; c.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(arrastando));
});
$("board").addEventListener("dragend", () => { arrastando = null; render(); });
$("board").addEventListener("dragover", e => {
  const col = e.target.closest(".col[data-col]"); if (!col || arrastando == null) return;
  e.preventDefault();
  $("board").querySelectorAll(".col.over").forEach(x => x !== col && x.classList.remove("over"));
  col.classList.add("over");
});
$("board").addEventListener("drop", e => {
  const col = e.target.closest(".col[data-col]"); if (!col || arrastando == null) return;
  e.preventDefault();
  const c = S.cards.find(x => x.id === arrastando); arrastando = null;
  if (c && c.col !== col.dataset.col) mover(c, col.dataset.col); else render();
});

/* ===== Modal ===== */
let modal = null; // {modo:'novo'|'edit', id}
const val = k => ($("f_" + k) ? $("f_" + k).value.trim() : "");

const campo = (k, tipo, extra = "") => `<div><label for="f_${k}">${LABEL[k]}</label>${tipo === "date" ? `<input type="date" id="f_${k}">` : tipo === "text" ? `<input id="f_${k}" ${extra}>` : tipo}</div>`;
const sel = (k, opts, vazioTxt = "Selecione…") => `<div><label for="f_${k}">${LABEL[k]}</label><select id="f_${k}"><option value="">${vazioTxt}</option>${opts.map(o => `<option>${esc(o)}</option>`).join("")}</select></div>`;

const comAtual = (lista, atual) => atual && !lista.includes(atual) ? [...lista, atual] : lista;
function abrirModal(titulo, body, foot) {
  $("m-title").textContent = titulo; $("m-body").innerHTML = body; $("m-foot").innerHTML = foot;
  $("overlay").hidden = false;
}
function fechar() {
  $("overlay").hidden = true; modal = null;
  if (pendente) { pendente = false; sincronizar(); }
}
$("m-x").onclick = fechar;
$("overlay").addEventListener("mousedown", e => { if (e.target === $("overlay")) fechar(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("overlay").hidden) fechar(); });

/* ===== Estatísticas (dias corridos, como na planilha) ===== */
function estatisticas(c) {
  const dif = (a, b) => (c[a] && c[b]) ? Math.round((parse(c[b]) - parse(c[a])) / 864e5) : null;
  const an = dif("dChegada", "dAnalise"), ap = dif("dAnalise", "dAprovacao"), fi = dif("dAprovacao", "dExecucao"),
    ex = dif("dExecucao", "dTeste"), te = dif("dTeste", "dFinalizado"), tot = dif("dChegada", "dEnvio");
  const man = [an, fi, ex, te].every(v => v !== null) ? an + fi + ex + te : null;
  const f = v => v === null ? "—" : v;
  return [["Tempo de Análise", f(an)], ["Tempo de Aprovação", f(ap)], ["Tempo de Fila", f(fi)],
    ["Tempo de Execução", f(ex)], ["Tempo de Teste de Equipamento", f(te)],
    ["Total de Dias de Manutenção", f(man)], ["Total de Dias", f(tot)]];
}


function novaOS() {
  if (!P().criar) return;
  modal = { modo: "novo" };
  abrirModal("Nova OS — Chegada de equipamento",
    `<p class="hint">Equipamento, modelo, série e data de chegada são obrigatórios; a garantia é opcional.</p>
     <div class="grid sec">${sel("equipamento", EQUIPAMENTOS)}${sel("modelo", MODELOS)}
     ${campo("serie", "text", 'placeholder="Ex.: 57PPL7QDA3006L ou SEM N/S"')}
     ${campo("dChegada", "date")}${sel("garantia", ["Sim", "Não"], "Não informado")}</div>`,
    `<button class="btn" onclick="fechar()">Cancelar</button><button class="btn green" id="b-salvar" disabled>Registrar chegada</button>`);
  $("f_dChegada").value = iso(hoje());
  ["f_equipamento", "f_modelo", "f_serie", "f_dChegada"].forEach(i => { $(i).oninput = validarNovo; $(i).onchange = validarNovo; });
  $("b-salvar").onclick = () => {
    if (validarNovo()) return;
    const c = { id: novoId(), col: "chegada", equipamento: val("equipamento"), modelo: val("modelo"), serie: val("serie"), dChegada: val("dChegada"), garantia: val("garantia"), enviado: "Não" };
    S.cards.push(c); save(); fechar(); render(); toast("OS registrada em “" + colName("chegada") + "”");
  };
}
function validarNovo() {      // retorna true se há algo faltando
  const falta = REQ.chegada.some(k => !val(k));
  const b = $("b-salvar"); if (b) b.disabled = falta;
  return falta;
}

function abrir(id) {
  const c = S.cards.find(x => x.id === id); if (!c) return;
  modal = { modo: "edit", id };
  const idx = S.cols.findIndex(x => x.id === c.col);
  const prox = proxima(c.col), ant = anterior(c.col);
  const tecnicos = [...new Set(S.cards.map(x => x.tecnico).filter(Boolean))];
  const i = info(c);
  abrirModal(`${c.equipamento} ${c.modelo}${c.os ? " — OS " + c.os : ""}`,
    `<p class="hint">Kanban: <b>${esc(colName(c.col))}</b>${i.status ? " · Status: <b>" + esc(i.status) + "</b>" : ""}${i.limite ? " · Prazo: " + fmt(i.limite) : ""}</p>
     <div class="sec"><h4>1 · Identificação</h4><div class="grid">
       ${campo("os", "text")}${campo("cliente", "text")}
       ${sel("equipamento", comAtual(EQUIPAMENTOS, c.equipamento))}${sel("modelo", comAtual(MODELOS, c.modelo))}${campo("serie", "text")}
     </div></div>
     <div class="sec"><h4>2 · Garantia e técnico</h4><div class="grid">
       ${sel("garantia", GARANTIAS)}${campo("tecnico", "text", 'list="dl-tec"')}
       ${campo("vendedor", "text")}${P().valores ? campo("valorProposta", "text", 'inputmode="decimal" placeholder="R$ 0,00"') : ""}
       <datalist id="dl-tec">${tecnicos.map(t => `<option value="${esc(t)}">`).join("")}</datalist>
     </div></div>
     <div class="sec"><h4>3 · Envio ao cliente</h4><div class="grid">
       ${sel("enviado", ["Sim", "Não"], "—")}${campo("rastreio", "text")}
     </div></div>
     <div class="sec"><h4>4 · Datas</h4><div class="grid">
       ${campo("dChegada", "date")}${campo("dAnalise", "date")}${campo("dAprovacao", "date")}${campo("dExecucao", "date")}
       ${campo("dTeste", "date")}${campo("dFinalizado", "date")}${campo("dEnvio", "date")}
     </div></div>
     <div class="sec"><h4>5 · Estatísticas (dias)</h4><div class="grid" id="m-stats"></div></div>
     <p class="hint" id="m-falta"></p>`,
    `${P().excluir ? '<button class="btn danger" id="b-del">Excluir</button>' : ""}
     ${ant ? `<button class="btn" id="b-volta">← ${esc(ant.name)}</button>` : ""}
     <button class="btn" id="b-salvar">Salvar</button>
     ${prox ? `<button class="btn green" id="b-prox">Avançar → ${esc(prox.name)}</button>` : ""}`);
  Object.keys(LABEL).forEach(k => {
    const el = $("f_" + k); if (!el) return;
    el.value = c[k] || "";
    if (bloqueado(k, c)) el.disabled = true;     // já salvo: só o Administrador edita
  });
  if (!P().editarTudo) $("m-body").insertAdjacentHTML("afterbegin", '<p class="hint">Campos já salvos ficam bloqueados; apenas o Administrador pode alterá-los.</p>');

  const atualizaFalta = () => {
    const tmp = { ...c }; Object.keys(LABEL).forEach(k => { if ($("f_" + k)) tmp[k] = val(k); });
    $("m-stats").innerHTML = estatisticas(tmp).map(([l, v]) => `<div class="statrow"><span>${l}</span><b>${v}</b></div>`).join("");
    const adm = P().editarTudo;
    const pend = adm ? pendentes(tmp) : [];       // Administrador: campos exigidos e vazios ficam em amarelo
    Object.keys(LABEL).forEach(k => { const el = $("f_" + k); if (el) el.classList.toggle("pend", pend.includes(k)); });
    if (!prox) { $("m-falta").textContent = pend.length ? "Campos pendentes (em amarelo): " + pend.map(rotulo).join(", ") : ""; return; }
    const f = faltando(tmp, prox.id);
    $("m-falta").textContent = f.length
      ? (adm ? "Para avançar sem pendências, preencha: " : "Para avançar, preencha: ") + f.map(rotulo).join(", ")
      : (pend.length ? "Campos pendentes (em amarelo): " + pend.map(rotulo).join(", ") : "");
    $("b-prox").disabled = f.length > 0 && !adm;
  };
  $("m-body").oninput = atualizaFalta;
  $("m-body").onchange = atualizaFalta;
  atualizaFalta();

  const gravar = () => {
    const faltaIni = REQ.chegada.filter(k => !val(k));
    if (faltaIni.length) {
      faltaIni.forEach(k => $("f_" + k).classList.add("bad"));
      toast("Campos iniciais obrigatórios: " + faltaIni.map(k => LABEL[k]).join(", ")); return false;
    }
    Object.keys(LABEL).forEach(k => { if ($("f_" + k)) c[k] = val(k); });
    save(); return true;
  };
  $("b-salvar").onclick = () => { if (gravar()) { fechar(); render(); } };
  if (prox) $("b-prox").onclick = () => { if (gravar()) { const ok = mover(c, prox.id); if (ok) fechar(); } };
  if (ant) $("b-volta").onclick = () => { if (gravar() && mover(c, ant.id)) fechar(); };

  // escolher "Condenado" na garantia pede confirmação e leva a OS ao kanban de condenados
  let garAnt = c.garantia || "";
  $("f_garantia").addEventListener("change", () => {
    if ($("f_garantia").value !== "Condenado") { garAnt = $("f_garantia").value; return; }
    confirmarCondenado(c, () => {
      if (!gravar()) { $("f_garantia").value = garAnt; return; }
      c.col = "condenado"; save(); fechar(); render();
      toast("OS movida para “" + colName("condenado") + "”");
    }, () => { $("f_garantia").value = garAnt; atualizaFalta(); });
  });
  if ($("b-del")) $("b-del").onclick = () => {
    if (confirm("Excluir esta OS definitivamente?")) { S.cards = S.cards.filter(x => x.id !== id); S.deleted = [...(S.deleted || []), id]; save(); fechar(); render(); }
  };
}

function confirmarCondenado(c, sim, nao) {
  $("conf-msg").innerHTML = `Tem certeza que deseja marcar <b>${esc(c.equipamento)} ${esc(c.modelo)}${c.os ? " — OS " + esc(c.os) : ""}</b> como <b>Condenado</b>?<br>A OS será movida automaticamente para “${esc(colName("condenado"))}”.`;
  $("conf").hidden = false;
  const fim = cb => { $("conf").hidden = true; document.removeEventListener("keydown", esc_); cb(); };
  const esc_ = e => { if (e.key === "Escape") { e.stopImmediatePropagation(); fim(nao); } };
  document.addEventListener("keydown", esc_, true);
  $("conf-yes").onclick = () => fim(sim);
  $("conf-no").onclick = $("conf-x").onclick = () => fim(nao);
}

let tt;
function toast(m) {
  const t = $("toast"); t.textContent = m; t.hidden = false;
  clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 4500);
}

/* ===== Início ===== */
$("b-nova2").onclick = novaOS;
$("user").onclick = () => { termo = ""; $("busca").value = ""; render(); };
$("busca").oninput = e => { termo = e.target.value; render(); };
$("b-atualizar").onclick = () => sincronizar(true);
$("hoje").textContent = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
snapshot();

/* ===== Login ===== */
let perfilSel = null;
function aplicarPerfil() {
  $("b-nova2").hidden = !P().criar;
  $("perfil-nome").textContent = P().nome;
  $("user").textContent = P().nome.slice(0, 2).toUpperCase();
  termo = ""; $("busca").value = "";
}
function entrar(role) {
  ROLE = role;
  $("login").hidden = true;
  aplicarPerfil(); S = { cols: [], cards: [] }; snapshot(); render();
  assinarMudancas(); carregar();
}
async function sair() {
  ROLE = null;
  if (sb) await sb.auth.signOut();
  S = { cols: [], cards: [] }; snapshot();
  fechar(); $("conf").hidden = true;
  perfilSel = null; $("login-senha").value = ""; $("login-erro").textContent = "";
  document.querySelectorAll(".perfil-op").forEach(b => b.classList.remove("sel"));
  $("login-senha-box").hidden = true;
  $("login").hidden = false;
}
$("perfis").innerHTML = Object.entries(PERFIS).map(([k, p]) => `<button class="perfil-op" data-p="${k}">${p.nome}</button>`).join("");
$("perfis").addEventListener("click", e => {
  const b = e.target.closest(".perfil-op"); if (!b) return;
  perfilSel = b.dataset.p;
  document.querySelectorAll(".perfil-op").forEach(x => x.classList.toggle("sel", x === b));
  $("login-senha-box").hidden = false; $("login-erro").textContent = "";
  $("login-senha").value = ""; $("login-senha").focus();
});
async function perfilDoUsuario(uid) {
  const r = await sb.from("perfis").select("perfil").eq("user_id", uid).maybeSingle();
  return r.data && PERFIS[r.data.perfil] ? r.data.perfil : null;
}
async function tentarLogin() {
  if (!perfilSel) return;
  const erro = m => { $("login-erro").textContent = m; $("login-ok").disabled = false; };
  if (!sb) return erro("Sistema sem configuração: preencha a URL e a chave do Supabase em config.js.");
  $("login-ok").disabled = true; $("login-erro").textContent = "";
  const r = await sb.auth.signInWithPassword({ email: `${perfilSel}@${CONFIG.dominio}`, password: $("login-senha").value });
  if (r.error) return erro(/invalid/i.test(r.error.message) ? "Senha incorreta." : "Erro ao entrar: " + r.error.message);
  const perfil = await perfilDoUsuario(r.data.user.id);
  if (perfil !== perfilSel) { await sb.auth.signOut(); return erro("Este usuário não tem o perfil selecionado."); }
  $("login-ok").disabled = false;
  entrar(perfil);
}
$("login-ok").onclick = tentarLogin;
$("login-senha").onkeydown = e => { if (e.key === "Enter") tentarLogin(); };
$("b-sair").onclick = sair;
(async function retomarSessao() {            // já estava conectado neste navegador
  if (!sb) { $("login-erro").textContent = "Preencha a URL e a chave do Supabase em config.js."; return; }
  const { data } = await sb.auth.getSession();
  if (!data.session) return;
  const perfil = await perfilDoUsuario(data.session.user.id);
  if (perfil) entrar(perfil); else await sb.auth.signOut();
})();
let diaAtual = iso(hoje());
setInterval(() => {                    // na virada do dia, recalcula atrasos e pede novas justificativas
  if (iso(hoje()) !== diaAtual) { diaAtual = iso(hoje()); render(); }
}, 60 * 1000);