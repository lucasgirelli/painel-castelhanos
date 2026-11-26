(function () {
  "use strict";

  const PAID_THROUGH_DATE = todayISO();
  const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const numberFormat = new Intl.NumberFormat("pt-BR");
  const monthLong = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const monthShort = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const pageLabels = {
    dashboard: ["Visão geral", "ACOMPANHAMENTO DA CASA"],
    calendar: ["Calendário", "RESERVAS E DISPONIBILIDADE"],
    bookings: ["Locações", "RESERVAS E PAGAMENTOS"],
    expenses: ["Despesas", "CUSTOS DA PROPRIEDADE"],
    reports: ["Relatórios", "ANÁLISE FINANCEIRA"]
  };
  let db = { bookings: [], expenses: [], meta: {} };
  let selectedPage = "dashboard";
  let selectedYear = String(new Date().getFullYear());
  const initialCalendarDate = new Date();
  let calendarYear = initialCalendarDate.getFullYear();
  let calendarMonth = initialCalendarDate.getMonth();
  let calendarSelectedDate = todayISO();
  let toastTimer = null;
  const holidayMapCache = new Map();

  function byId(id) { return document.getElementById(id); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function safeArray(value) { return Array.isArray(value) ? value : []; }
  function numeric(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function amount(value) { const result = numeric(value); return result === null ? 0 : result; }
  function settlePastBookings(data) {
    let changed = false;
    safeArray(data.bookings).forEach(function (booking) {
      const total = numeric(booking.totalAmount);
      if (isPrivateUse(booking) || !booking.checkIn || booking.checkIn > PAID_THROUGH_DATE || total === null) return;
      if (numeric(booking.amountPaid) !== total) {
        booking.amountPaid = total;
        changed = true;
      }
      safeArray(booking.payments).forEach(function (payment) {
        if (payment.status !== "pago") {
          payment.status = "pago";
          changed = true;
        }
      });
    });
    return changed;
  }
  function money(value) { return currency.format(amount(value)); }
  function optionalMoney(value) { return numeric(value) === null ? "—" : money(value); }
  function escapeHTML(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function parseISODate(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const parts = value.split("-").map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    if (d.getFullYear() !== parts[0] || d.getMonth() !== parts[1] - 1 || d.getDate() !== parts[2]) return null;
    return d;
  }
  function localISODate(date) {
    const d = date || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function formatDate(value) {
    const d = parseISODate(value);
    if (!d) return "—";
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  }
  function shortDate(value) {
    const d = parseISODate(value);
    if (!d) return "—";
    return String(d.getDate()).padStart(2, "0") + " " + monthShort[d.getMonth()];
  }
  function dateDiff(start, end) {
    const a = parseISODate(start), b = parseISODate(end);
    if (!a || !b) return null;
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  }
  function yearOf(value) { return value && value.length >= 4 ? value.slice(0, 4) : ""; }
  function todayISO() { return localISODate(new Date()); }
  function normalizeDatabase(data) {
    return { bookings: safeArray(data && data.bookings), expenses: safeArray(data && data.expenses), meta: (data && data.meta) || {} };
  }
  // ---- Banco online (Supabase) ----
  // Cada locação e cada despesa é uma linha (id, dados jsonb). Ao salvar, só o que mudou
  // é enviado; mudanças feitas por outras pessoas chegam em tempo real.
  const LOCAL_STORAGE_KEY = "castelhanos-rental-dashboard-v1"; // dados da versão antiga (só neste navegador)
  const LOCAL_MIGRATED_KEY = "castelhanos-local-migrado";
  const CACHE_KEY = "castelhanos-cache-online-v1";
  const TABLES = { bookings: "locacoes", expenses: "despesas" };
  const config = window.PAINEL_CONFIG || {};
  const supa = window.supabase && config.supabaseUrl && config.supabaseAnonKey
    ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey)
    : null;
  const synced = { bookings: new Map(), expenses: new Map() };
  let saveQueue = Promise.resolve();
  let realtimeChannel = null;
  let appStarted = false;

  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().filter(function (k) { return value[k] !== undefined; }).map(function (k) {
        return JSON.stringify(k) + ":" + stable(value[k]);
      }).join(",") + "}";
    }
    return JSON.stringify(value === undefined ? null : value);
  }
  function writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(db)); } catch (error) {}
  }
  function setSyncStatus(state) {
    const label = { ok: "Sincronizado", saving: "Salvando…", error: "Erro ao salvar", loading: "Carregando…", offline: "Sem conexão" }[state] || state;
    byId("syncStatus").textContent = label;
    byId("syncDot").className = "privacy-dot sync-" + state;
  }
  async function pushChanges() {
    for (const key of Object.keys(TABLES)) {
      const current = new Map();
      db[key].forEach(function (item) { if (item && item.id) current.set(item.id, item); });
      const upserts = [];
      current.forEach(function (item, id) {
        if (synced[key].get(id) !== stable(item)) upserts.push({ id: id, dados: clone(item) });
      });
      const deletes = [];
      synced[key].forEach(function (_, id) { if (!current.has(id)) deletes.push(id); });
      if (upserts.length) {
        const result = await supa.from(TABLES[key]).upsert(upserts);
        if (result.error) throw result.error;
        upserts.forEach(function (row) { synced[key].set(row.id, stable(row.dados)); });
      }
      if (deletes.length) {
        const result = await supa.from(TABLES[key]).delete().in("id", deletes);
        if (result.error) throw result.error;
        deletes.forEach(function (id) { synced[key].delete(id); });
      }
    }
  }
  function saveDatabase(message) {
    settlePastBookings(db);
    writeCache();
    renderAll();
    setSyncStatus("saving");
    saveQueue = saveQueue.then(pushChanges).then(function () {
      setSyncStatus("ok");
      if (message) showToast(message);
    }, function (error) {
      console.error("Erro ao salvar online:", error);
      setSyncStatus("error");
      showToast("Não consegui salvar online. Confira a internet; a próxima alteração tenta de novo.");
    });
    return saveQueue;
  }
  async function loadRemote() {
    const keys = Object.keys(TABLES);
    const results = await Promise.all(keys.map(function (key) {
      return supa.from(TABLES[key]).select("id, dados").range(0, 9999);
    }));
    const next = { bookings: [], expenses: [], meta: db.meta || {} };
    results.forEach(function (result, index) {
      if (result.error) throw result.error;
      const key = keys[index];
      synced[key].clear();
      result.data.forEach(function (row) {
        synced[key].set(row.id, stable(row.dados));
        next[key].push(row.dados);
      });
    });
    db = next;
  }
  function applyRemoteChange(key, payload) {
    if (payload.eventType === "DELETE") {
      const id = payload.old && payload.old.id;
      if (!id) return;
      synced[key].delete(id);
      db[key] = db[key].filter(function (item) { return item.id !== id; });
    } else {
      const row = payload.new;
      if (!row || !row.id) return;
      synced[key].set(row.id, stable(row.dados));
      const index = db[key].findIndex(function (item) { return item.id === row.id; });
      if (index >= 0) db[key][index] = row.dados; else db[key].push(row.dados);
    }
    writeCache();
    renderAll();
  }
  function subscribeRealtime() {
    if (realtimeChannel) supa.removeChannel(realtimeChannel);
    realtimeChannel = supa.channel("painel-castelhanos");
    Object.keys(TABLES).forEach(function (key) {
      realtimeChannel.on("postgres_changes", { event: "*", schema: "public", table: TABLES[key] }, function (payload) {
        applyRemoteChange(key, payload);
      });
    });
    realtimeChannel.subscribe();
  }
  function offerLocalMigration() {
    let local = null;
    try {
      if (localStorage.getItem(LOCAL_MIGRATED_KEY) === "sim") return false;
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) local = normalizeDatabase(JSON.parse(stored));
    } catch (error) { return false; }
    if (!local) return false;
    const missing = { bookings: [], expenses: [] };
    Object.keys(missing).forEach(function (key) {
      missing[key] = local[key].filter(function (item) { return item && item.id && !synced[key].has(item.id); });
    });
    const total = missing.bookings.length + missing.expenses.length;
    try { localStorage.setItem(LOCAL_MIGRATED_KEY, "sim"); } catch (error) {}
    if (!total) return false;
    const ok = window.confirm("Encontrei dados da versão antiga salvos neste navegador: " +
      missing.bookings.length + " locação(ões) e " + missing.expenses.length + " despesa(s) que ainda não estão no banco online.\n\nEnviar para o banco online agora?");
    if (!ok) return false;
    db.bookings = db.bookings.concat(missing.bookings);
    db.expenses = db.expenses.concat(missing.expenses);
    saveDatabase("Dados deste navegador enviados para o banco online.");
    return true;
  }
  function showLogin(message) {
    byId("loginScreen").classList.remove("hidden");
    byId("appLayout").classList.add("hidden");
    byId("loginMessage").textContent = message || "";
  }
  async function enterApp(session) {
    if (appStarted) return;
    appStarted = true;
    byId("loginScreen").classList.add("hidden");
    byId("appLayout").classList.remove("hidden");
    byId("userEmail").textContent = session.user.email || "";
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) { db = normalizeDatabase(JSON.parse(cached)); renderAll(); }
    } catch (error) {}
    setSyncStatus("loading");
    try {
      const member = await supa.rpc("eh_membro");
      if (member.error) throw member.error;
      if (member.data !== true) {
        appStarted = false;
        try { localStorage.removeItem(CACHE_KEY); } catch (error) {}
        await supa.auth.signOut();
        showLogin("O e-mail " + session.user.email + " ainda não tem acesso. Peça para ser incluído no painel.");
        return;
      }
      await loadRemote();
      writeCache();
      renderAll();
      setSyncStatus("ok");
      subscribeRealtime();
      if (!offerLocalMigration() && settlePastBookings(db)) saveDatabase();
    } catch (error) {
      console.error("Erro ao carregar do banco online:", error);
      setSyncStatus("offline");
      showToast("Não consegui carregar os dados online. Mostrando a última cópia deste navegador.");
    }
  }
  async function startApp() {
    if (!supa) { showLogin("Falta configurar o banco (arquivo config.js)."); return; }
    supa.auth.onAuthStateChange(function (event, session) {
      // Adia para fora do callback, como a documentação do Supabase recomenda.
      setTimeout(function () {
        if (session && !appStarted) enterApp(session);
        if (event === "SIGNED_OUT") {
          appStarted = false;
          if (realtimeChannel) { supa.removeChannel(realtimeChannel); realtimeChannel = null; }
          try { localStorage.removeItem(CACHE_KEY); } catch (error) {}
          db = { bookings: [], expenses: [], meta: {} };
          showLogin();
        }
      }, 0);
    });
    const result = await supa.auth.getSession();
    if (!result.data.session) showLogin();
  }
  function initLogin() {
    byId("loginForm").addEventListener("submit", async function (event) {
      event.preventDefault();
      const email = byId("loginEmail").value.trim();
      const password = byId("loginPassword").value;
      if (!password) { byId("loginMessage").textContent = "Digite a senha ou use “Receber link por e-mail”."; return; }
      byId("loginMessage").textContent = "Entrando…";
      const result = await supa.auth.signInWithPassword({ email: email, password: password });
      if (result.error) byId("loginMessage").textContent = "Não consegui entrar: e-mail ou senha incorretos.";
    });
    byId("loginLinkBtn").addEventListener("click", async function () {
      const email = byId("loginEmail").value.trim();
      if (!email) { byId("loginMessage").textContent = "Digite seu e-mail primeiro."; return; }
      byId("loginMessage").textContent = "Enviando…";
      const result = await supa.auth.signInWithOtp({
        email: email,
        options: { shouldCreateUser: false, emailRedirectTo: window.location.origin + window.location.pathname }
      });
      byId("loginMessage").textContent = result.error
        ? "Não consegui enviar o link (" + result.error.message + ")."
        : "Pronto! Abra o link que chegou no seu e-mail, neste mesmo aparelho.";
    });
    byId("logoutBtn").addEventListener("click", function () { supa.auth.signOut(); });
  }
  function idFor(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return prefix + "-" + window.crypto.randomUUID();
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }
  function yearOptions() {
    const years = new Set([String(new Date().getFullYear())]);
    db.bookings.forEach(function (b) { if (yearOf(b.checkIn)) years.add(yearOf(b.checkIn)); });
    db.expenses.forEach(function (x) { if (yearOf(x.date)) years.add(yearOf(x.date)); });
    return Array.from(years).sort(function (a, b) { return Number(b) - Number(a); });
  }
  function selectedYearValue() { return byId("yearFilter").value || selectedYear; }
  function matchesYear(value, year) { return year === "all" || yearOf(value) === year; }
  function bookingsForYear(year) { return db.bookings.filter(function (b) { return matchesYear(b.checkIn, year); }); }
  function isPrivateUse(booking) { return booking && booking.type === "private"; }
  function bookingTypeLabel(booking) { return isPrivateUse(booking) ? "Uso particular" : "Locação paga"; }
  function rentalBookings(bookings) { return bookings.filter(function (booking) { return !isPrivateUse(booking); }); }
  function privateBookings(bookings) { return bookings.filter(isPrivateUse); }
  function expensesForYear(year) { return db.expenses.filter(function (x) { return matchesYear(x.date, year); }); }
  function sumValues(items, key, predicate) {
    return items.reduce(function (sum, item) {
      if (predicate && !predicate(item)) return sum;
      const value = numeric(item[key]);
      return sum + (value === null ? 0 : value);
    }, 0);
  }
  function remainingFor(booking) {
    if (isPrivateUse(booking)) return null;
    const total = numeric(booking.totalAmount), paid = numeric(booking.amountPaid);
    if (total === null) return null;
    return Math.max(0, total - (paid === null ? 0 : paid));
  }
  function bookingState(booking) {
    if (!booking.checkOut || !parseISODate(booking.checkOut) || !parseISODate(booking.checkIn) || (!isPrivateUse(booking) && (booking.totalAmount === null || booking.totalAmount === undefined))) {
      return { label: "Revisar dados", className: "review", filter: "review" };
    }
    const now = todayISO();
    if (booking.checkIn > now) return { label: "Futura", className: "future", filter: "future" };
    if (booking.checkOut >= now) return { label: "Em andamento", className: "active", filter: "active" };
    return { label: "Concluída", className: "done", filter: "done" };
  }
  function currentYearLabel(year) { return year === "all" ? "Todos os anos" : year; }
  function syncYearOptions() {
    const select = byId("yearFilter");
    const years = yearOptions();
    if (selectedYear !== "all" && !years.includes(selectedYear)) selectedYear = years[0] || String(new Date().getFullYear());
    const value = selectedYear || String(new Date().getFullYear());
    select.innerHTML = '<option value="all">Todos os anos</option>' + years.map(function (year) {
      return '<option value="' + year + '">' + year + "</option>";
    }).join("");
    select.value = value;
    if (select.value !== value) select.value = "all";
  }
  function metricCard(label, value, detail, symbol, variant) {
    return '<article class="metric-card ' + (variant || "") + '">' +
      '<div class="metric-top"><span class="metric-label">' + escapeHTML(label) + '</span><span class="metric-symbol" aria-hidden="true">' + symbol + "</span></div>" +
      '<strong class="metric-value">' + value + "</strong><span class=\"metric-detail\">" + escapeHTML(detail) + "</span></article>";
  }
  function renderMetrics(container, stats, mode) {
    const pendingExpense = stats.expenseTotal - stats.expensePaid;
    const bookingDetail = numberFormat.format(stats.rentals.length) + (stats.rentals.length === 1 ? " locação paga" : " locações pagas") + " · " +
      numberFormat.format(stats.privateUses.length) + (stats.privateUses.length === 1 ? " uso particular" : " usos particulares");
    if (mode === "report") {
      container.innerHTML =
        metricCard("Valor reservado", money(stats.reserved), bookingDetail, "▤", "") +
        metricCard("Recebido", money(stats.received), money(stats.pending) + " a receber", "＋", "") +
        metricCard("Despesas pagas", money(stats.expensePaid), money(pendingExpense) + " pendentes", "◌", "") +
        metricCard("Saldo de caixa", money(stats.cash), "Recebido menos despesas pagas", "◫", "highlight");
      return;
    }
    container.innerHTML =
      metricCard("Valor reservado", money(stats.reserved), bookingDetail + " no período", "▤", "") +
      metricCard("Recebido", money(stats.received), money(stats.pending) + " a receber", "＋", "") +
      metricCard("Despesas pagas", money(stats.expensePaid), money(pendingExpense) + " em despesas pendentes", "◌", "") +
      metricCard("Saldo de caixa", money(stats.cash), "Recebido menos despesas pagas", "◫", "highlight");
  }
  function getStats(year) {
    const bookings = bookingsForYear(year);
    const rentals = rentalBookings(bookings);
    const privateUses = privateBookings(bookings);
    const expenses = expensesForYear(year);
    const reserved = sumValues(rentals, "totalAmount");
    const received = sumValues(rentals, "amountPaid");
    const pending = rentals.reduce(function (sum, b) { return sum + (remainingFor(b) || 0); }, 0);
    const expenseTotal = sumValues(expenses, "amount");
    const expensePaid = sumValues(expenses, "amount", function (x) { return x.status !== "pendente"; });
    return { bookings: bookings, rentals: rentals, privateUses: privateUses, expenses: expenses, reserved: reserved, received: received, pending: pending, expenseTotal: expenseTotal, expensePaid: expensePaid, cash: received - expensePaid };
  }
  function renderDashboard() {
    const year = selectedYearValue();
    const stats = getStats(year);
    byId("dashboardCaption").textContent = year === "all"
      ? "Resumo das locações pagas, usos particulares e despesas cadastradas."
      : "Resumo das estadias com check-in em " + year + " e das despesas lançadas no mesmo ano.";
    renderMetrics(byId("metricGrid"), stats, "dashboard");
    renderMonthlyChart(year === "all" ? String(new Date().getFullYear()) : year);
    renderUpcoming(year);
    renderPending(year);
    renderRecent(year);
    byId("navBookingCount").textContent = numberFormat.format(db.bookings.length);
  }
  function renderMonthlyChart(year) {
    const reservations = new Array(12).fill(0);
    const costs = new Array(12).fill(0);
    db.bookings.forEach(function (b) {
      const d = parseISODate(b.checkIn);
      if (d && String(d.getFullYear()) === year && !isPrivateUse(b)) reservations[d.getMonth()] += amount(b.totalAmount);
    });
    db.expenses.forEach(function (x) {
      const d = parseISODate(x.date);
      if (d && String(d.getFullYear()) === year) costs[d.getMonth()] += amount(x.amount);
    });
    const max = Math.max.apply(null, reservations.concat(costs).concat([1]));
    byId("monthlyChart").innerHTML = monthShort.map(function (label, index) {
      const reservationHeight = reservations[index] ? Math.max(2, reservations[index] / max * 100) : 0;
      const expenseHeight = costs[index] ? Math.max(2, costs[index] / max * 100) : 0;
      const title = monthLong[index] + " de " + year + ": reservas " + money(reservations[index]) + ", despesas " + money(costs[index]);
      return '<div class="month-column" title="' + escapeHTML(title) + '">' +
        '<div class="bar-pair"><span class="bar reservation" style="height:' + reservationHeight + '%"></span><span class="bar expense" style="height:' + expenseHeight + '%"></span></div>' +
        '<span class="month-label">' + label + "</span></div>";
    }).join("");
  }
  function compactItem(date, title, detail, value, id, extraClass) {
    const d = parseISODate(date);
    const dateLabel = d ? '<span>' + String(d.getDate()).padStart(2, "0") + '<small>' + monthShort[d.getMonth()] + "</small></span>" : '<span>—<small></small></span>';
    return '<div class="compact-item ' + (extraClass || "") + '" data-open-booking="' + escapeHTML(id) + '" tabindex="0" role="button">' +
      '<span class="date-chip">' + dateLabel + "</span>" +
      '<span class="compact-main"><strong>' + escapeHTML(title) + '</strong><span>' + escapeHTML(detail) + "</span></span>" +
      '<strong class="compact-value">' + escapeHTML(value) + "</strong></div>";
  }
  function renderUpcoming(year) {
    const today = todayISO();
    const items = db.bookings.filter(function (b) {
      return b.checkIn && b.checkIn >= today && b.checkOut && matchesYear(b.checkIn, year);
    }).sort(function (a, b) { return a.checkIn.localeCompare(b.checkIn); }).slice(0, 4);
    byId("upcomingList").innerHTML = items.length ? items.map(function (b) {
      const time = b.arrivalTime ? "Entrada " + b.arrivalTime : "Entrada a combinar";
      return compactItem(b.checkIn, b.name, formatDate(b.checkOut) + " · " + time, isPrivateUse(b) ? "Uso particular" : optionalMoney(b.totalAmount), b.id, isPrivateUse(b) ? "private-use-item" : "");
    }).join("") : '<div class="empty-small">Nenhum check-in futuro neste período.</div>';
  }
  function pendingEntries(year) {
    const entries = [];
    bookingsForYear(year).forEach(function (b) {
      if (isPrivateUse(b)) return;
      const remaining = remainingFor(b);
      if (!remaining) return;
      const payments = safeArray(b.payments);
      if (payments.length) {
        payments.filter(function (p) { return p.status === "pendente" && amount(p.amount) > 0; }).forEach(function (p) {
          entries.push({ date: p.dueDate || b.checkIn, title: b.name, label: p.label || "Parcela em aberto", value: amount(p.amount), id: b.id, overdue: !!(p.dueDate && p.dueDate < todayISO()) });
        });
        const scheduledPending = payments.reduce(function (s, p) { return s + (p.status === "pendente" ? amount(p.amount) : 0); }, 0);
        if (remaining > scheduledPending + .01) entries.push({ date: b.checkIn, title: b.name, label: "Saldo sem parcela definida", value: remaining - scheduledPending, id: b.id, overdue: b.checkIn < todayISO() });
      } else {
        entries.push({ date: b.checkIn, title: b.name, label: b.checkIn && b.checkIn < todayISO() ? "Saldo em aberto" : "Saldo no check-in", value: remaining, id: b.id, overdue: !!(b.checkIn && b.checkIn < todayISO()) });
      }
    });
    return entries.sort(function (a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return String(a.date || "9999").localeCompare(String(b.date || "9999"));
    });
  }
  function renderPending(year) {
    const items = pendingEntries(year);
    byId("pendingCount").textContent = numberFormat.format(items.length);
    byId("pendingList").innerHTML = items.length ? items.slice(0, 4).map(function (entry) {
      const label = entry.overdue ? "Atrasado · " + entry.label : entry.label;
      return compactItem(entry.date, entry.title, label, money(entry.value), entry.id, entry.overdue ? "overdue-item" : "");
    }).join("") : '<div class="empty-small">Nenhum valor pendente neste período.</div>';
  }
  function renderRecent(year) {
    const items = bookingsForYear(year).slice().sort(function (a, b) { return String(b.checkIn).localeCompare(String(a.checkIn)); }).slice(0, 4);
    byId("recentList").innerHTML = items.length ? items.map(function (b) {
      const detail = (isPrivateUse(b) ? "Uso particular" : (b.channel || "Canal não informado")) + " · " + (b.checkIn ? formatDate(b.checkIn) : "sem data");
      return compactItem(b.checkIn, b.name, detail, isPrivateUse(b) ? "Uso particular" : optionalMoney(b.totalAmount), b.id, isPrivateUse(b) ? "private-use-item" : "");
    }).join("") : '<div class="empty-small">Cadastre a primeira locação para acompanhar os lançamentos.</div>';
  }
  function calendarMonthRange() {
    const start = new Date(calendarYear, calendarMonth, 1, 12);
    const end = new Date(calendarYear, calendarMonth + 1, 1, 12);
    return { start: localISODate(start), end: localISODate(end) };
  }
  function calendarEventsForDay(day) {
    return db.bookings.map(function (booking) {
      let kind = "";
      if (booking.checkIn === day) kind = "arrival";
      else if (booking.checkOut === day) kind = "departure";
      else if (booking.checkIn && booking.checkOut && booking.checkIn < day && booking.checkOut > day) kind = "stay";
      return kind ? { booking: booking, kind: kind } : null;
    }).filter(Boolean).sort(function (a, b) {
      const order = { arrival: 0, stay: 1, departure: 2 };
      return order[a.kind] - order[b.kind] || a.booking.name.localeCompare(b.booking.name, "pt-BR");
    });
  }
  function calendarKindLabel(kind) {
    if (kind === "arrival") return "Entrada";
    if (kind === "departure") return "Saída";
    return "Hospedado";
  }
  function calendarHolidaysForYear(year) {
    if (!holidayMapCache.has(year)) {
      const byDate = new Map();
      window.RENTAL_HOLIDAYS.forYear(year).forEach(function (item) {
        const list = byDate.get(item.date) || [];
        list.push(item);
        byDate.set(item.date, list);
      });
      holidayMapCache.set(year, byDate);
    }
    return holidayMapCache.get(year);
  }
  function calendarHolidaysForDate(date) {
    const year = Number(String(date || "").slice(0, 4));
    return calendarHolidaysForYear(year).get(date) || [];
  }
  function calendarSummaryMarkup() {
    const range = calendarMonthRange();
    const visible = db.bookings.filter(function (b) {
      if (!b.checkIn) return false;
      const overlaps = b.checkIn < range.end && (b.checkOut ? b.checkOut > range.start : b.checkIn >= range.start);
      return overlaps;
    });
    const arrivals = db.bookings.filter(function (b) { return b.checkIn && b.checkIn >= range.start && b.checkIn < range.end; }).length;
    const departures = db.bookings.filter(function (b) { return b.checkOut && b.checkOut >= range.start && b.checkOut < range.end; }).length;
    const reservedNights = visible.reduce(function (sum, b) {
      if (!b.checkIn || !b.checkOut) return sum;
      const from = b.checkIn > range.start ? b.checkIn : range.start;
      const to = b.checkOut < range.end ? b.checkOut : range.end;
      return sum + Math.max(0, dateDiff(from, to) || 0);
    }, 0);
    return '<div class="calendar-summary-card"><span>Check-ins no mês</span><strong>' + numberFormat.format(arrivals) + "</strong></div>" +
      '<div class="calendar-summary-card"><span>Check-outs no mês</span><strong>' + numberFormat.format(departures) + "</strong></div>" +
      '<div class="calendar-summary-card"><span>Noites reservadas</span><strong>' + numberFormat.format(reservedNights) + "</strong></div>" +
      '<div class="calendar-summary-card"><span>Estadias no período</span><strong>' + numberFormat.format(visible.length) + "</strong></div>";
  }
  function calendarDayMarkup(day, inMonth) {
    const date = localISODate(day);
    const isoToday = todayISO();
    const holidays = calendarHolidaysForDate(date);
    const classes = ["calendar-day"];
    if (!inMonth) classes.push("outside-month");
    if (date === isoToday) classes.push("today-day");
    if (date === calendarSelectedDate) classes.push("selected-day");
    if (holidays.length) classes.push("has-holiday");
    const holidayMarkup = holidays.map(function (item) {
      return '<span class="calendar-holiday" title="' + escapeHTML(item.scope + " · " + item.name) + '">' + escapeHTML(item.name) + "</span>";
    }).join("");
    const ariaLabel = "Selecionar " + formatDate(date) + (holidays.length ? " · Feriado: " + holidays.map(function (item) { return item.name; }).join(", ") : "");
    const events = calendarEventsForDay(date);
    const shown = events.slice(0, 2).map(function (entry) {
      const title = (isPrivateUse(entry.booking) ? "Uso particular · " : "") + calendarKindLabel(entry.kind) + ": " + entry.booking.name;
      return '<button type="button" class="calendar-event ' + entry.kind + (isPrivateUse(entry.booking) ? ' private-use' : '') + '" data-calendar-booking="' + escapeHTML(entry.booking.id) + '" title="' + escapeHTML(title) + '">' + escapeHTML(title) + "</button>";
    }).join("");
    const more = events.length > 2 ? '<span class="calendar-more">+' + (events.length - 2) + " reservas</span>" : "";
    return '<div class="' + classes.join(" ") + '" data-calendar-day="' + date + '">' +
      '<button type="button" class="calendar-day-number" data-select-calendar-day="' + date + '" aria-label="' + escapeHTML(ariaLabel) + '">' + day.getDate() + "</button>" +
      '<div class="calendar-holidays">' + holidayMarkup + "</div>" +
      '<div class="calendar-events">' + shown + more + "</div></div>";
  }
  function renderCalendarGrid() {
    const firstOfMonth = new Date(calendarYear, calendarMonth, 1, 12);
    const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0, 12).getDate();
    const leadingDays = firstOfMonth.getDay();
    const cellCount = Math.ceil((leadingDays + daysInMonth) / 7) * 7;
    const firstVisibleDay = new Date(calendarYear, calendarMonth, 1 - leadingDays, 12);
    let markup = "";
    for (let index = 0; index < cellCount; index += 1) {
      const day = new Date(firstVisibleDay.getFullYear(), firstVisibleDay.getMonth(), firstVisibleDay.getDate() + index, 12);
      markup += calendarDayMarkup(day, day.getMonth() === calendarMonth);
    }
    byId("calendarGrid").innerHTML = markup;
  }
  function renderCalendarDetails() {
    const day = calendarSelectedDate;
    const date = parseISODate(day);
    byId("calendarSelectedTitle").textContent = date
      ? "Dia " + date.getDate() + " de " + monthLong[date.getMonth()] + " de " + date.getFullYear()
      : "Selecione uma data";
    const events = calendarEventsForDay(day);
    const holidays = calendarHolidaysForDate(day);
    const arrivals = events.filter(function (entry) { return entry.kind === "arrival"; }).length;
    const departures = events.filter(function (entry) { return entry.kind === "departure"; }).length;
    const daySummary = events.length
      ? arrivals + " entrada(s) · " + departures + " saída(s) · " + (events.length - arrivals - departures) + " hospedado(s)"
      : "";
    const holidaySummary = holidays.length ? holidays.length + (holidays.length === 1 ? " feriado" : " feriados") : "";
    byId("calendarSelectedSubtitle").textContent = [daySummary, holidaySummary].filter(Boolean).join(" · ") || "Nenhuma hospedagem neste dia";
    const holidayMarkup = holidays.map(function (item) {
      return '<article class="calendar-holiday-detail"><div class="calendar-detail-top"><strong>' + escapeHTML(item.name) + '</strong><span class="holiday-scope">' + escapeHTML(item.scope) + "</span></div><p>Feriado</p></article>";
    }).join("");
    const bookingMarkup = events.length ? events.map(function (entry) {
      const booking = entry.booking;
      const nights = numeric(booking.nights) === null ? dateDiff(booking.checkIn, booking.checkOut) : booking.nights;
      const guests = booking.guests ? numberFormat.format(booking.guests) + " hóspedes" : "Hóspedes não informados";
      const dates = formatDate(booking.checkIn) + " a " + formatDate(booking.checkOut);
      const detailLabel = isPrivateUse(booking) ? "Uso particular" : (booking.channel || "Canal não informado");
      return '<button type="button" class="calendar-detail-item" data-calendar-booking="' + escapeHTML(booking.id) + '">' +
        '<span class="calendar-detail-top"><strong>' + escapeHTML(booking.name) + '</strong><span class="calendar-kind ' + entry.kind + (isPrivateUse(booking) ? ' private-use' : '') + '">' + calendarKindLabel(entry.kind) + "</span></span>" +
        '<span class="calendar-detail-meta"><span>' + escapeHTML(detailLabel) + " · " + escapeHTML(guests) + "</span>" +
        "<span>" + escapeHTML(dates) + (nights !== null ? " · " + numberFormat.format(nights) + " diárias" : "") + "</span>" +
        (isPrivateUse(booking) ? "" : "<span>" + optionalMoney(booking.totalAmount) + "</span>") + "</span></button>";
    }).join("") : (holidays.length ? "" : '<div class="calendar-empty">Selecione outra data ou navegue pelos meses para conferir as hospedagens.</div>');
    byId("calendarDayDetails").innerHTML = holidayMarkup + bookingMarkup;
  }
  function renderCalendar() {
    byId("calendarMonthTitle").textContent = monthLong[calendarMonth][0].toUpperCase() + monthLong[calendarMonth].slice(1) + " " + calendarYear;
    byId("calendarSummary").innerHTML = calendarSummaryMarkup();
    renderCalendarGrid();
    renderCalendarDetails();
  }
  function setCalendarMonth(year, month, preferToday) {
    const normalized = new Date(year, month, 1, 12);
    calendarYear = normalized.getFullYear();
    calendarMonth = normalized.getMonth();
    const now = new Date();
    if (preferToday && now.getFullYear() === calendarYear && now.getMonth() === calendarMonth) calendarSelectedDate = todayISO();
    else calendarSelectedDate = localISODate(normalized);
  }
  function moveCalendarMonth(delta) {
    setCalendarMonth(calendarYear, calendarMonth + delta, false);
    selectedYear = String(calendarYear);
    renderAll();
  }
  function filteredBookings() {
    const year = selectedYearValue();
    const search = byId("bookingSearch").value.trim().toLocaleLowerCase("pt-BR");
    const channel = byId("bookingChannelFilter").value;
    const type = byId("bookingTypeFilter").value;
    const status = byId("bookingStatusFilter").value;
    return bookingsForYear(year).filter(function (b) {
      const text = [b.name, b.channel, b.notes, b.source, bookingTypeLabel(b)].join(" ").toLocaleLowerCase("pt-BR");
      if (search && !text.includes(search)) return false;
      if (type === "private" && !isPrivateUse(b)) return false;
      if (type === "rental" && isPrivateUse(b)) return false;
      if (channel && b.channel !== channel) return false;
      if (status && bookingState(b).filter !== status) return false;
      return true;
    }).sort(function (a, b) { return String(b.checkIn || "").localeCompare(String(a.checkIn || "")); });
  }
  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    return (parts[0] ? parts[0][0] : "?").toUpperCase() + (parts.length > 1 ? parts[parts.length - 1][0].toUpperCase() : "");
  }
  function renderBookings() {
    const items = filteredBookings();
    byId("bookingCount").textContent = numberFormat.format(items.length) + (items.length === 1 ? " locação" : " locações");
    byId("bookingsEmpty").classList.toggle("hidden", items.length > 0);
    byId("bookingsBody").innerHTML = items.map(function (b) {
      const state = bookingState(b);
      const remaining = remainingFor(b);
      const privateUse = isPrivateUse(b);
      const name = escapeHTML(b.name || "Hóspede sem identificação");
      const category = escapeHTML(privateUse ? "Uso particular" : (b.channel || "Canal não informado"));
      const time = b.arrivalTime ? " · " + escapeHTML(b.arrivalTime) : "";
      const guests = b.guests ? numberFormat.format(b.guests) : "—";
      const reviewNote = b.notes ? '<small class="table-note">' + escapeHTML(b.notes) + "</small>" : "";
      return '<tr class="clickable" data-booking-id="' + escapeHTML(b.id) + '">' +
        '<td><div class="person-cell"><span class="avatar ' + (privateUse ? 'private-avatar' : '') + '">' + escapeHTML(initials(b.name)) + '</span><span><strong>' + name + '</strong><small><span class="type-label ' + (privateUse ? 'private-type' : '') + '">' + category + '</span>' + time + "</small>" + reviewNote + "</span></div></td>" +
        "<td>" + formatDate(b.checkIn) + "</td><td>" + formatDate(b.checkOut) + "</td>" +
        "<td>" + guests + "</td><td class=\"money-cell\">" + (privateUse ? "—" : optionalMoney(b.totalAmount)) + "</td>" +
        "<td>" + (privateUse ? "—" : optionalMoney(b.amountPaid)) + "</td><td class=\"money-pending\">" + (privateUse || remaining === null ? "—" : money(remaining)) + "</td>" +
        '<td><span class="status-pill ' + state.className + '">' + state.label + "</span></td>" +
        '<td><button type="button" class="row-action" aria-label="Editar ' + name + '">•••</button></td></tr>';
    }).join("");
  }
  function filteredExpenses() {
    const year = selectedYearValue();
    const search = byId("expenseSearch").value.trim().toLocaleLowerCase("pt-BR");
    const category = byId("expenseCategoryFilter").value;
    const status = byId("expenseStatusFilter").value;
    return expensesForYear(year).filter(function (x) {
      const text = [x.description, x.category, x.notes].join(" ").toLocaleLowerCase("pt-BR");
      if (search && !text.includes(search)) return false;
      if (category && x.category !== category) return false;
      if (status && x.status !== status) return false;
      return true;
    }).sort(function (a, b) { return String(b.date || "").localeCompare(String(a.date || "")); });
  }
  function renderExpenseSummary() {
    const expenses = expensesForYear(selectedYearValue());
    const total = sumValues(expenses, "amount");
    const paid = sumValues(expenses, "amount", function (x) { return x.status !== "pendente"; });
    const pending = total - paid;
    byId("expenseSummary").innerHTML =
      '<div class="expense-summary-card"><span>Total lançado</span><strong>' + money(total) + "</strong></div>" +
      '<div class="expense-summary-card"><span>Pago</span><strong>' + money(paid) + "</strong></div>" +
      '<div class="expense-summary-card"><span>Pendente</span><strong>' + money(pending) + "</strong></div>";
  }
  function renderExpenses() {
    const items = filteredExpenses();
    byId("expenseCount").textContent = numberFormat.format(items.length) + " despesas";
    byId("expensesEmpty").classList.toggle("hidden", items.length > 0);
    byId("expensesBody").innerHTML = items.map(function (x) {
      const status = x.status === "pendente" ? "pendente" : "pago";
      const statusText = status === "pago" ? "Paga" : "Pendente";
      return '<tr class="clickable" data-expense-id="' + escapeHTML(x.id) + '">' +
        "<td>" + formatDate(x.date) + "</td>" +
        '<td><strong class="expense-description">' + escapeHTML(x.description || "Despesa") + "</strong>" + (x.notes ? '<small class="table-note">' + escapeHTML(x.notes) + "</small>" : "") + "</td>" +
        "<td>" + escapeHTML(x.category || "Outros") + "</td>" +
        '<td><span class="status-pill ' + status + '">' + statusText + "</span></td>" +
        '<td class="money-cell">' + money(x.amount) + "</td>" +
        '<td><button type="button" class="row-action" aria-label="Editar despesa">•••</button></td></tr>';
    }).join("");
    renderExpenseSummary();
  }
  function annualRows() {
    const years = yearOptions();
    return years.map(function (year) {
      const stats = getStats(year);
      const nights = stats.bookings.reduce(function (sum, b) {
        const count = numeric(b.nights);
        return sum + (count === null ? Math.max(0, dateDiff(b.checkIn, b.checkOut) || 0) : count);
      }, 0);
      return { year: year, count: stats.rentals.length, privateUseCount: stats.privateUses.length, nights: nights, reserved: stats.reserved, received: stats.received, pending: stats.pending, expenses: stats.expenseTotal, cash: stats.cash };
    });
  }
  function renderReports() {
    const selected = selectedYearValue();
    const stats = getStats(selected);
    renderMetrics(byId("reportMetricGrid"), stats, "report");
    byId("annualReportBody").innerHTML = annualRows().map(function (row) {
      return '<tr class="year-row" data-set-year="' + row.year + '" tabindex="0" role="button">' +
        "<td><strong>" + row.year + "</strong></td><td>" + numberFormat.format(row.count) + "</td><td>" + numberFormat.format(row.privateUseCount) + "</td><td>" + numberFormat.format(row.nights) + "</td>" +
        '<td class="money-cell">' + money(row.reserved) + "</td><td>" + money(row.received) + "</td>" +
        '<td class="money-pending">' + money(row.pending) + "</td><td>" + money(row.expenses) + "</td><td class=\"money-cell\">" + money(row.cash) + "</td></tr>";
    }).join("");
    renderChannelReport(stats.bookings);
    renderCategoryReport(stats.expenses);
  }
  function renderChannelReport(bookings) {
    const groups = new Map();
    rentalBookings(bookings).forEach(function (b) {
      const channel = b.channel || "Outro";
      const entry = groups.get(channel) || { count: 0, value: 0 };
      entry.count += 1;
      entry.value += amount(b.totalAmount);
      groups.set(channel, entry);
    });
    const entries = Array.from(groups.entries()).sort(function (a, b) { return b[1].count - a[1].count; });
    const max = Math.max.apply(null, entries.map(function (x) { return x[1].count; }).concat([1]));
    byId("channelReport").innerHTML = entries.length ? entries.map(function (entry) {
      const width = Math.max(2, entry[1].count / max * 100);
      return '<div class="channel-line"><label>' + escapeHTML(entry[0]) + '</label><span class="channel-track"><span class="channel-bar" style="display:block;width:' + width + '%"></span></span><strong>' + numberFormat.format(entry[1].count) + " · " + money(entry[1].value) + "</strong></div>";
    }).join("") : '<div class="empty-small">Sem locações neste período.</div>';
  }
  function renderCategoryReport(expenses) {
    const groups = new Map();
    expenses.forEach(function (x) {
      const category = x.category || "Outros";
      groups.set(category, (groups.get(category) || 0) + amount(x.amount));
    });
    const entries = Array.from(groups.entries()).sort(function (a, b) { return b[1] - a[1]; });
    const max = Math.max.apply(null, entries.map(function (x) { return x[1]; }).concat([1]));
    byId("categoryReport").innerHTML = entries.length ? entries.map(function (entry) {
      const width = Math.max(2, entry[1] / max * 100);
      return '<div class="channel-line"><label>' + escapeHTML(entry[0]) + '</label><span class="channel-track"><span class="channel-bar expense-report-bar" style="display:block;width:' + width + '%"></span></span><strong>' + money(entry[1]) + "</strong></div>";
    }).join("") : '<div class="empty-small">Sem despesas neste período.</div>';
  }
  function renderAll() {
    syncYearOptions();
    renderDashboard();
    renderCalendar();
    renderBookings();
    renderExpenses();
    renderReports();
    let hideNote = false;
    try { hideNote = localStorage.getItem("castelhanos-hide-import-note") === "yes"; } catch (error) {}
    byId("importNote").classList.toggle("hidden", hideNote);
  }
  function showPage(page) {
    selectedPage = pageLabels[page] ? page : "dashboard";
    document.querySelectorAll(".page").forEach(function (section) { section.classList.toggle("active", section.id === "page-" + selectedPage); });
    document.querySelectorAll(".nav-item").forEach(function (button) { button.classList.toggle("active", button.getAttribute("data-page") === selectedPage); });
    byId("pageTitle").textContent = pageLabels[selectedPage][0];
    byId("pageKicker").textContent = pageLabels[selectedPage][1];
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function showToast(message) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("show"); }, 2800);
  }
  function openDialog(id) { const dialog = byId(id); if (dialog && !dialog.open) dialog.showModal(); }
  function closeDialog(id) { const dialog = byId(id); if (dialog && dialog.open) dialog.close(); }
  function setValue(id, value) { byId(id).value = value === null || value === undefined ? "" : value; }
  function syncBookingTypeFields() {
    const privateUse = byId("bookingType").value === "private";
    document.querySelectorAll(".rental-only").forEach(function (field) { field.classList.toggle("hidden", privateUse); });
    byId("bookingTotal").required = !privateUse;
    byId("bookingNameLabel").textContent = privateUse ? "Identificação *" : "Nome do hóspede *";
    byId("bookingName").placeholder = privateUse ? "Família ou identificação" : "Nome completo";
    byId("privateUseNote").classList.toggle("hidden", !privateUse);
  }
  function openBooking(id) {
    const existing = db.bookings.find(function (b) { return b.id === id; });
    byId("bookingForm").reset();
    byId("bookingModalTitle").textContent = existing ? "Editar locação" : "Nova locação";
    byId("bookingId").value = existing ? existing.id : "";
    setValue("bookingType", existing && isPrivateUse(existing) ? "private" : "rental");
    setValue("bookingName", existing ? existing.name : "");
    setValue("bookingChannel", existing ? existing.channel || "Direto" : "Direto");
    setValue("bookingContract", existing ? existing.contractStatus || "não informado" : "pendente");
    setValue("bookingCheckIn", existing ? existing.checkIn : "");
    setValue("bookingCheckOut", existing ? existing.checkOut : "");
    setValue("bookingArrivalTime", existing ? existing.arrivalTime || "" : "12:00");
    setValue("bookingDepartureTime", existing ? existing.departureTime || "" : "10:00");
    setValue("bookingGuests", existing ? existing.guests : "");
    setValue("bookingDailyRate", existing ? existing.dailyRate : "");
    setValue("bookingTotal", existing ? existing.totalAmount : "");
    setValue("bookingPaid", existing ? existing.amountPaid : "0");
    setValue("bookingCleaning", existing ? existing.cleaningFee : "");
    setValue("bookingLinens", existing ? existing.linensFee : "");
    setValue("bookingCommission", existing ? existing.commissionAmount : "");
    setValue("bookingNotes", existing ? existing.notes : "");
    renderPaymentRows(existing ? safeArray(existing.payments) : []);
    syncBookingTypeFields();
    byId("deleteBookingBtn").classList.toggle("hidden", !existing);
    openDialog("bookingDialog");
  }
  function paymentRow(payment) {
    const row = document.createElement("div");
    row.className = "payment-row";
    row.innerHTML = '<input type="date" data-payment="date" aria-label="Data da parcela">' +
      '<input type="text" data-payment="label" placeholder="Descrição" aria-label="Descrição da parcela">' +
      '<input type="number" data-payment="amount" min="0" step="0.01" placeholder="Valor" aria-label="Valor da parcela">' +
      '<select data-payment="status" aria-label="Situação da parcela"><option value="pendente">Pendente</option><option value="pago">Pago</option></select>' +
      '<button type="button" class="remove-payment" aria-label="Remover parcela">×</button>';
    row.querySelector('[data-payment="date"]').value = payment && payment.dueDate || "";
    row.querySelector('[data-payment="label"]').value = payment && payment.label || "";
    row.querySelector('[data-payment="amount"]').value = payment && payment.amount !== undefined ? payment.amount : "";
    row.querySelector('[data-payment="status"]').value = payment && payment.status || "pendente";
    return row;
  }
  function renderPaymentRows(payments) {
    const container = byId("paymentRows");
    container.innerHTML = "";
    const list = safeArray(payments);
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "schedule-empty";
      empty.textContent = "Nenhuma parcela informada.";
      container.appendChild(empty);
    } else list.forEach(function (p) { container.appendChild(paymentRow(p)); });
    updatePaidFromSchedule();
  }
  function collectPayments() {
    return Array.from(byId("paymentRows").querySelectorAll(".payment-row")).map(function (row) {
      return {
        dueDate: row.querySelector('[data-payment="date"]').value,
        label: row.querySelector('[data-payment="label"]').value.trim(),
        amount: numeric(row.querySelector('[data-payment="amount"]').value),
        status: row.querySelector('[data-payment="status"]').value
      };
    }).filter(function (p) { return p.amount !== null || p.dueDate || p.label; });
  }
  function updatePaidFromSchedule() {
    const rows = Array.from(byId("paymentRows").querySelectorAll(".payment-row"));
    const paidInput = byId("bookingPaid");
    if (!rows.length) {
      paidInput.readOnly = false;
      paidInput.classList.remove("readonly-field");
      return;
    }
    const sum = rows.reduce(function (total, row) {
      const status = row.querySelector('[data-payment="status"]').value;
      return total + (status === "pago" ? amount(row.querySelector('[data-payment="amount"]').value) : 0);
    }, 0);
    paidInput.value = sum.toFixed(2);
    paidInput.readOnly = true;
    paidInput.classList.add("readonly-field");
  }
  function bookingConflicts(checkIn, checkOut, currentId) {
    return db.bookings.filter(function (b) {
      if (b.id === currentId || !b.checkIn || !b.checkOut) return false;
      return checkIn < b.checkOut && checkOut > b.checkIn;
    });
  }
  function saveBooking(event) {
    event.preventDefault();
    const privateUse = byId("bookingType").value === "private";
    const name = byId("bookingName").value.trim();
    const checkIn = byId("bookingCheckIn").value;
    const checkOut = byId("bookingCheckOut").value;
    const total = numeric(byId("bookingTotal").value);
    const currentId = byId("bookingId").value;
    if (!name || !checkIn || !checkOut || (!privateUse && total === null)) {
      showToast(privateUse ? "Preencha identificação e datas." : "Preencha hóspede, datas e valor total.");
      return;
    }
    if (checkOut <= checkIn) {
      showToast("O check-out precisa ser depois do check-in.");
      return;
    }
    const conflicts = bookingConflicts(checkIn, checkOut, currentId);
    if (conflicts.length && !window.confirm("Há uma locação sobreposta nestas datas (" + conflicts.map(function (b) { return b.name; }).join(", ") + "). Salvar mesmo assim?")) return;
    const existing = db.bookings.find(function (b) { return b.id === currentId; });
    const payments = privateUse ? [] : collectPayments();
    const paid = privateUse ? null : (payments.length
      ? payments.reduce(function (sum, p) { return sum + (p.status === "pago" ? amount(p.amount) : 0); }, 0)
      : numeric(byId("bookingPaid").value));
    const booking = {
      id: currentId || idFor("booking"),
      type: privateUse ? "private" : "rental",
      name: name,
      channel: privateUse ? null : byId("bookingChannel").value,
      contractStatus: privateUse ? null : byId("bookingContract").value,
      checkIn: checkIn,
      checkOut: checkOut,
      nights: dateDiff(checkIn, checkOut),
      guests: numeric(byId("bookingGuests").value),
      dailyRate: privateUse ? null : numeric(byId("bookingDailyRate").value),
      totalAmount: privateUse ? null : total,
      amountPaid: paid,
      cleaningFee: privateUse ? null : numeric(byId("bookingCleaning").value),
      linensFee: privateUse ? null : numeric(byId("bookingLinens").value),
      commissionRate: privateUse ? null : (existing ? existing.commissionRate : null),
      commissionAmount: privateUse ? null : numeric(byId("bookingCommission").value),
      arrivalTime: byId("bookingArrivalTime").value,
      departureTime: byId("bookingDepartureTime").value,
      payments: payments,
      notes: byId("bookingNotes").value.trim(),
      source: existing && existing.source ? existing.source : "Cadastro manual"
    };
    if (existing) db.bookings = db.bookings.map(function (b) { return b.id === currentId ? booking : b; });
    else db.bookings.push(booking);
    closeDialog("bookingDialog");
    saveDatabase(existing ? "Locação atualizada." : "Locação cadastrada.");
  }
  function deleteBooking() {
    const id = byId("bookingId").value;
    const booking = db.bookings.find(function (b) { return b.id === id; });
    if (!booking || !window.confirm("Excluir a locação de " + booking.name + "? Essa ação não pode ser desfeita.")) return;
    db.bookings = db.bookings.filter(function (b) { return b.id !== id; });
    closeDialog("bookingDialog");
    saveDatabase("Locação excluída.");
  }
  function openExpense(id) {
    const existing = db.expenses.find(function (x) { return x.id === id; });
    byId("expenseForm").reset();
    byId("expenseModalTitle").textContent = existing ? "Editar despesa" : "Nova despesa";
    byId("expenseId").value = existing ? existing.id : "";
    setValue("expenseDate", existing ? existing.date : todayISO());
    setValue("expenseCategory", existing ? existing.category || "Outros" : "Limpeza");
    setValue("expenseDescription", existing ? existing.description : "");
    setValue("expenseAmount", existing ? existing.amount : "");
    setValue("expenseStatus", existing ? existing.status || "pago" : "pago");
    setValue("expenseNotes", existing ? existing.notes : "");
    byId("deleteExpenseBtn").classList.toggle("hidden", !existing);
    openDialog("expenseDialog");
  }
  function saveExpense(event) {
    event.preventDefault();
    const id = byId("expenseId").value;
    const date = byId("expenseDate").value;
    const description = byId("expenseDescription").value.trim();
    const value = numeric(byId("expenseAmount").value);
    if (!date || !description || value === null) {
      showToast("Preencha data, descrição e valor da despesa.");
      return;
    }
    const existing = db.expenses.find(function (x) { return x.id === id; });
    const expense = {
      id: id || idFor("expense"),
      date: date,
      category: byId("expenseCategory").value,
      description: description,
      amount: value,
      status: byId("expenseStatus").value,
      notes: byId("expenseNotes").value.trim(),
      source: existing && existing.source ? existing.source : "Cadastro manual"
    };
    if (existing) db.expenses = db.expenses.map(function (x) { return x.id === id ? expense : x; });
    else db.expenses.push(expense);
    closeDialog("expenseDialog");
    saveDatabase(existing ? "Despesa atualizada." : "Despesa cadastrada.");
  }
  function deleteExpense() {
    const id = byId("expenseId").value;
    const expense = db.expenses.find(function (x) { return x.id === id; });
    if (!expense || !window.confirm("Excluir a despesa “" + expense.description + "”? Essa ação não pode ser desfeita.")) return;
    db.expenses = db.expenses.filter(function (x) { return x.id !== id; });
    closeDialog("expenseDialog");
    saveDatabase("Despesa excluída.");
  }
  function csvCell(value) {
    const text = String(value === null || value === undefined ? "" : value);
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function csvDownload(filename, headers, rows) {
    const content = "\uFEFF" + [headers, ...rows].map(function (row) { return row.map(csvCell).join(";"); }).join("\r\n");
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }
  function exportCSV() {
    const year = selectedYearValue();
    const bookings = bookingsForYear(year).map(function (b) {
      const privateUse = isPrivateUse(b);
      return [bookingTypeLabel(b), b.name, privateUse ? "" : b.channel, formatDate(b.checkIn), formatDate(b.checkOut), b.guests, b.nights, privateUse ? "" : b.dailyRate, privateUse ? "" : b.totalAmount, privateUse ? "" : b.amountPaid, privateUse ? "" : remainingFor(b), privateUse ? "" : b.contractStatus, b.arrivalTime, b.departureTime, b.notes];
    });
    const expenses = expensesForYear(year).map(function (x) {
      return [formatDate(x.date), x.description, x.category, x.amount, x.status, x.notes];
    });
    const suffix = year === "all" ? "todos-os-anos" : year;
    csvDownload("locacoes-" + suffix + ".csv", ["Tipo", "Hóspede / identificação", "Canal", "Check-in", "Check-out", "Hóspedes", "Diárias", "Diária média", "Valor total", "Recebido", "A receber", "Contrato", "Entrada", "Saída", "Observações"], bookings);
    csvDownload("despesas-" + suffix + ".csv", ["Data", "Descrição", "Categoria", "Valor", "Pagamento", "Observações"], expenses);
    showToast("Arquivos CSV preparados.");
  }
  function exportReportCSV() {
    const rows = annualRows().map(function (r) { return [r.year, r.count, r.privateUseCount, r.nights, r.reserved, r.received, r.pending, r.expenses, r.cash]; });
    csvDownload("relatorio-anual-castelhanos.csv", ["Ano", "Locações pagas", "Uso particular", "Diárias", "Valor reservado", "Recebido", "A receber", "Despesas lançadas", "Saldo de caixa"], rows);
  }
  function downloadBackup() {
    const payload = { format: "castelhanos-rentals-backup", version: 1, exportedAt: new Date().toISOString(), data: db };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "backup-locacoes-castelhanos-" + todayISO() + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    showToast("Backup baixado.");
  }
  function mergeBackupRows(current, incoming) {
    const merged = safeArray(current).map(clone);
    const byId = new Map(merged.map(function (item, index) { return [String(item.id), index]; }));
    const counts = { added: 0, updated: 0, unchanged: 0 };
    safeArray(incoming).forEach(function (item) {
      if (!item || item.id === null || item.id === undefined || String(item.id) === "") throw new Error("registro sem identificador");
      const id = String(item.id);
      if (!byId.has(id)) {
        byId.set(id, merged.length);
        merged.push(clone(item));
        counts.added += 1;
      } else {
        const index = byId.get(id);
        if (JSON.stringify(merged[index]) === JSON.stringify(item)) counts.unchanged += 1;
        else {
          merged[index] = clone(item);
          counts.updated += 1;
        }
      }
    });
    return { rows: merged, counts: counts };
  }
  function restoreBackup(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        const source = parsed.data || parsed;
        if (!Array.isArray(source.bookings) || !Array.isArray(source.expenses)) throw new Error("formato");
        const mergedBookings = mergeBackupRows(db.bookings, source.bookings);
        const mergedExpenses = mergeBackupRows(db.expenses, source.expenses);
        const added = mergedBookings.counts.added + mergedExpenses.counts.added;
        const updated = mergedBookings.counts.updated + mergedExpenses.counts.updated;
        if (!added && !updated) {
          showToast("Esse backup já está incorporado aos dados online.");
          return;
        }
        const summary = "Serão adicionados " + added + " registros novos e atualizados " + updated +
          " registros com o mesmo código. Nenhum registro será apagado. Continuar?";
        if (!window.confirm(summary)) return;
        db = {
          bookings: mergedBookings.rows,
          expenses: mergedExpenses.rows,
          meta: Object.assign({}, db.meta || {}, source.meta || {})
        };
        saveDatabase("Backup mesclado e salvo online.");
      } catch (error) {
        showToast("Não consegui ler esse arquivo de backup.");
      }
      byId("importInput").value = "";
    };
    reader.readAsText(file);
  }
  function initEvents() {
    document.querySelectorAll(".nav-item").forEach(function (button) {
      button.addEventListener("click", function () { showPage(button.getAttribute("data-page")); });
    });
    document.querySelectorAll("[data-goto]").forEach(function (button) {
      button.addEventListener("click", function () { showPage(button.getAttribute("data-goto")); });
    });
    byId("yearFilter").addEventListener("change", function () {
      selectedYear = byId("yearFilter").value;
      if (selectedPage === "calendar" && selectedYear !== "all") setCalendarMonth(Number(selectedYear), calendarMonth, false);
      renderAll();
    });
    byId("calendarPrev").addEventListener("click", function () { moveCalendarMonth(-1); });
    byId("calendarNext").addEventListener("click", function () { moveCalendarMonth(1); });
    byId("calendarToday").addEventListener("click", function () {
      const now = new Date();
      setCalendarMonth(now.getFullYear(), now.getMonth(), true);
      selectedYear = String(now.getFullYear());
      renderAll();
    });
    byId("calendarGrid").addEventListener("click", function (event) {
      const bookingButton = event.target.closest("[data-calendar-booking]");
      if (bookingButton) {
        openBooking(bookingButton.getAttribute("data-calendar-booking"));
        return;
      }
      const dayButton = event.target.closest("[data-select-calendar-day]");
      if (!dayButton) return;
      const day = dayButton.getAttribute("data-select-calendar-day");
      const parsed = parseISODate(day);
      if (!parsed) return;
      setCalendarMonth(parsed.getFullYear(), parsed.getMonth(), false);
      calendarSelectedDate = day;
      selectedYear = String(parsed.getFullYear());
      renderAll();
    });
    byId("calendarDayDetails").addEventListener("click", function (event) {
      const bookingButton = event.target.closest("[data-calendar-booking]");
      if (bookingButton) openBooking(bookingButton.getAttribute("data-calendar-booking"));
    });
    byId("newBookingBtn").addEventListener("click", function () { openBooking(""); });
    byId("newBookingBtnList").addEventListener("click", function () { openBooking(""); });
    byId("newExpenseBtn").addEventListener("click", function () { openExpense(""); });
    byId("newExpenseBtnList").addEventListener("click", function () { openExpense(""); });
    byId("bookingForm").addEventListener("submit", saveBooking);
    byId("bookingType").addEventListener("change", syncBookingTypeFields);
    byId("expenseForm").addEventListener("submit", saveExpense);
    byId("deleteBookingBtn").addEventListener("click", deleteBooking);
    byId("deleteExpenseBtn").addEventListener("click", deleteExpense);
    document.querySelectorAll("[data-close]").forEach(function (button) {
      button.addEventListener("click", function () { closeDialog(button.getAttribute("data-close")); });
    });
    byId("addPaymentRow").addEventListener("click", function () {
      const container = byId("paymentRows");
      const empty = container.querySelector(".schedule-empty");
      if (empty) empty.remove();
      container.appendChild(paymentRow({ status: "pendente" }));
      updatePaidFromSchedule();
    });
    byId("paymentRows").addEventListener("input", updatePaidFromSchedule);
    byId("paymentRows").addEventListener("change", updatePaidFromSchedule);
    byId("paymentRows").addEventListener("click", function (event) {
      const button = event.target.closest(".remove-payment");
      if (!button) return;
      button.closest(".payment-row").remove();
      if (!byId("paymentRows").querySelector(".payment-row")) {
        const empty = document.createElement("div");
        empty.className = "schedule-empty";
        empty.textContent = "Nenhuma parcela informada.";
        byId("paymentRows").appendChild(empty);
      }
      updatePaidFromSchedule();
    });
    byId("bookingSearch").addEventListener("input", renderBookings);
    byId("bookingChannelFilter").addEventListener("change", renderBookings);
    byId("bookingTypeFilter").addEventListener("change", renderBookings);
    byId("bookingStatusFilter").addEventListener("change", renderBookings);
    byId("expenseSearch").addEventListener("input", renderExpenses);
    byId("expenseCategoryFilter").addEventListener("change", renderExpenses);
    byId("expenseStatusFilter").addEventListener("change", renderExpenses);
    byId("bookingsBody").addEventListener("click", function (event) {
      const row = event.target.closest("tr[data-booking-id]");
      if (row) openBooking(row.getAttribute("data-booking-id"));
    });
    byId("expensesBody").addEventListener("click", function (event) {
      const row = event.target.closest("tr[data-expense-id]");
      if (row) openExpense(row.getAttribute("data-expense-id"));
    });
    ["upcomingList", "pendingList", "recentList"].forEach(function (id) {
      byId(id).addEventListener("click", function (event) {
        const item = event.target.closest("[data-open-booking]");
        if (item) openBooking(item.getAttribute("data-open-booking"));
      });
      byId(id).addEventListener("keydown", function (event) {
        const item = event.target.closest("[data-open-booking]");
        if (item && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          openBooking(item.getAttribute("data-open-booking"));
        }
      });
    });
    byId("annualReportBody").addEventListener("click", function (event) {
      const row = event.target.closest("[data-set-year]");
      if (!row) return;
      selectedYear = row.getAttribute("data-set-year");
      showPage("dashboard");
      renderAll();
    });
    byId("annualReportBody").addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("[data-set-year]");
      if (row) {
        event.preventDefault();
        selectedYear = row.getAttribute("data-set-year");
        showPage("dashboard");
        renderAll();
      }
    });
    byId("exportCsvBtn").addEventListener("click", exportCSV);
    byId("reportCsvBtn").addEventListener("click", exportReportCSV);
    byId("sideBackupBtn").addEventListener("click", downloadBackup);
    byId("sideImportBtn").addEventListener("click", function () { byId("importInput").click(); });
    byId("importInput").addEventListener("change", function (event) { restoreBackup(event.target.files[0]); });
    byId("dismissImportNote").addEventListener("click", function () {
      byId("importNote").classList.add("hidden");
      try { localStorage.setItem("castelhanos-hide-import-note", "yes"); } catch (error) {}
    });
  }

  initEvents();
  if (supa) initLogin();
  startApp();
})();
