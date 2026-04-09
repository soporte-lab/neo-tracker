import { useState, useEffect, useCallback, useRef, useMemo } from "react";

/* ───────────────── POSTMESSAGE BRIDGE (Fase 4) ───────────────── */
/**
 * La app vive en un iframe cross-origin respecto a WordPress. No puede llamar
 * directamente a los endpoints REST (cookies no viajan). En su lugar, manda
 * postMessage al parent, que hace los fetches internamente con nonce+cookie
 * y responde vía postMessage.
 *
 * Si la app se abre directamente (sin parent), el bridge queda marcado como
 * unavailable y la app funciona en modo local-only (sin sync, sin rutina IA).
 */
const bridge = (() => {
  const inIframe = (typeof window !== "undefined" && window.parent && window.parent !== window);

  // Origen del parent: intentamos sacarlo del referrer. Si no hay, usamos "*"
  // solo para el primer ping; luego lo fijamos al origen real que responda.
  let parentOrigin = "*";
  try {
    if (typeof document !== "undefined" && document.referrer) {
      parentOrigin = new URL(document.referrer).origin;
    }
  } catch {}

  // null = desconocido aún, true = bridge disponible, false = no hay parent válido
  let available = null;
  const pending = {};

  const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  const send = (type, payload, timeout = 15000) => {
    return new Promise((resolve, reject) => {
      if (!inIframe) {
        reject(new Error("not-in-iframe"));
        return;
      }
      if (available === false) {
        reject(new Error("bridge-unavailable"));
        return;
      }

      const requestId = genId();
      const timer = setTimeout(() => {
        delete pending[requestId];
        reject(new Error("bridge-timeout"));
      }, timeout);

      pending[requestId] = { resolve, reject, timer };

      try {
        window.parent.postMessage({ type, requestId, payload }, parentOrigin);
      } catch (e) {
        clearTimeout(timer);
        delete pending[requestId];
        reject(e);
      }
    });
  };

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      if (!event.data || typeof event.data !== "object") return;
      if (event.source !== window.parent) return;
      const { type, requestId } = event.data;
      if (!type || typeof type !== "string") return;
      if (type.indexOf("nr-tracker-") !== 0) return;

      // Fijar el origen real del parent cuando recibamos la primera respuesta válida
      if (event.origin && event.origin !== "null") {
        parentOrigin = event.origin;
      }

      const p = pending[requestId];
      if (!p) return;
      clearTimeout(p.timer);
      delete pending[requestId];

      if (event.data.ok === false) {
        p.reject(new Error(event.data.error || "bridge-error"));
      } else {
        p.resolve(event.data);
      }
    });
  }

  const handshake = async () => {
    if (!inIframe) {
      available = false;
      return false;
    }
    try {
      await send("nr-tracker-bridge-ping", null, 2000);
      available = true;
      return true;
    } catch {
      available = false;
      return false;
    }
  };

  return {
    handshake,
    isAvailable: () => available === true,
    isResolved:  () => available !== null,
    pullState:   ()    => send("nr-tracker-state-pull", null).then(r => r.data),
    pushState:   (p)   => send("nr-tracker-state-push", p).then(r => r.data),
    generate:    (p)   => send("nr-tracker-generate", p, 60000).then(r => ({ status: r.status, data: r.data, ok: r.ok })),
    quota:       ()    => send("nr-tracker-quota", null).then(r => r.data),
    onesignalTag: (action) => send("nr-tracker-onesignal-tag", { action: action || "add" }).then(r => r.data),
    pushTest:    ()    => send("nr-tracker-push-test", {}).then(r => ({ ok: r.ok, status: r.status, data: r.data })),
    requestPushPermission: () => send("nr-tracker-request-push-permission", null, 30000).then(r => ({ ok: r.ok, permission: r.permission, subscribed: r.subscribed, error: r.error }))
  };
})();

/* ───────────────── STORAGE + REMOTE SYNC ───────────────── */

/**
 * Mapeo: clave de localStorage → clave corta del endpoint /state.
 * Estas claves se sincronizan con wp_usermeta cross-device.
 * compact-manual se mantiene local (preferencia por dispositivo).
 */
const SYNCED_KEY_MAP = {
  "neo-profile": "profile",
  "neo-routine": "routine",
  "neo-history": "history",
  "neo-reminders": "reminders"
};

// Durante la hidratación no disparamos pushes al servidor (se acumulan y
// se mandan todos juntos al terminar).
let __nrSyncHydrating = true;
const setHydrating = (v) => { __nrSyncHydrating = v; };

// Buffer debounce de pushes al bridge
let __nrSyncTimer = null;
let __nrSyncPending = {};

const flushPendingPush = async () => {
  const batch = __nrSyncPending;
  __nrSyncPending = {};
  __nrSyncTimer = null;
  if (!bridge.isAvailable()) return;
  if (Object.keys(batch).length === 0) return;
  try {
    await bridge.pushState(batch);
  } catch {
    // Silent fail — el próximo cambio volverá a disparar un push
  }
};

const queueServerPush = (shortKey, value, ts) => {
  __nrSyncPending[shortKey] = value;
  __nrSyncPending[shortKey + "_ts"] = ts;

  // Si estamos hidratando, no armamos timer. flushHydrationQueue lo hará.
  if (__nrSyncHydrating) return;
  if (!bridge.isAvailable()) return;

  if (__nrSyncTimer) clearTimeout(__nrSyncTimer);
  __nrSyncTimer = setTimeout(flushPendingPush, 3000);
};

const storage = {
  get: (k) => {
    try {
      const v = localStorage.getItem(k);
      return Promise.resolve(v ? { value: v } : null);
    } catch { return Promise.resolve(null); }
  },
  set: (k, v) => {
    try { localStorage.setItem(k, v); } catch {}
    const shortKey = SYNCED_KEY_MAP[k];
    if (shortKey) {
      const ts = Date.now();
      try { localStorage.setItem(k + "-ts", String(ts)); } catch {}
      try {
        const parsed = JSON.parse(v);
        queueServerPush(shortKey, parsed, ts);
      } catch { /* no sync if not JSON */ }
    }
    return Promise.resolve(null);
  },
  delete: (k) => {
    try { localStorage.removeItem(k); } catch {}
    const shortKey = SYNCED_KEY_MAP[k];
    if (shortKey) {
      const ts = Date.now();
      try { localStorage.removeItem(k + "-ts"); } catch {}
      queueServerPush(shortKey, null, ts);
    }
    return Promise.resolve(null);
  }
};

/** Lee el timestamp local de una clave sincronizada. */
const getLocalTs = (k) => {
  try { return parseInt(localStorage.getItem(k + "-ts") || "0", 10) || 0; }
  catch { return 0; }
};

/**
 * Hace pull del servidor a través del bridge. Devuelve null si el bridge
 * no está disponible o falla.
 */
const pullServerState = async () => {
  if (!bridge.isAvailable()) return null;
  try {
    return await bridge.pullState();
  } catch {
    return null;
  }
};

/**
 * Durante la hidratación, si detectamos que el cliente tiene datos más nuevos
 * que el servidor para alguna clave, los acumulamos en __nrSyncPending.
 * Al terminar la hidratación, armamos el timer para flushear.
 */
const flushHydrationQueue = () => {
  if (Object.keys(__nrSyncPending).length === 0) return;
  if (!bridge.isAvailable()) return;
  if (__nrSyncTimer) clearTimeout(__nrSyncTimer);
  __nrSyncTimer = setTimeout(flushPendingPush, 100);
};

/* ───────────────── LANG DETECTION ───────────────── */
const detectLang = () => {
  const supported = ["es", "en", "fr", "de", "pt", "it", "ea"];
  try {
    // 1. Query param ?lang= (lo pasa el shortcode [neo_tracker] leyendo user_meta)
    const p = new URLSearchParams(window.location.search).get("lang");
    if (p && supported.includes(p.toLowerCase())) return p.toLowerCase();
    // 2. Prefijo de ruta /ea/, /en/, /fr/… (para el caso de abrir directo sin iframe)
    const pathMatch = window.location.pathname.match(/\/(ea|en|fr|de|pt|it)(\/|$)/);
    if (pathMatch) return pathMatch[1];
  } catch {}
  return "es";
};

/* ───────────────── TRANSLATIONS ───────────────── */
const T = {
  es: { trackerSub:"Supplement Tracker", today_label:"hoy", tab_today:"Hoy", tab_progress:"Progreso", tab_settings:"Ajustes", morning:"Mañana", afternoon:"Tarde", night:"Noche", morning_hint:"Al despertar · Con desayuno", afternoon_hint:"Mediodía · Con comida", night_hint:"Antes de dormir · Con cena", morning_notif:"Mañana", afternoon_notif:"Tarde", night_notif:"Noche", freq_alternate:"Cada 2-3 días", freq_weekly:"2-3×/semana", hide_info:"Ocultar", more_info:"Más info", step1_title:"¿Cuáles son tus objetivos?", step1_sub:"Selecciona todos los que apliquen. Adaptaremos tu rutina.", step2_title:"Contraindicaciones", step2_sub:"Es importante para tu seguridad. Sé honesto/a.", step3_title:"¡Todo listo!", step3_sub:"Crearemos tu rutina personalizada basada en el método NeoRejuvenation.", step3_disclaimer:"Esta información es educativa. Consulta siempre con un profesional sanitario antes de iniciar cualquier suplementación.", btn_back:"Atrás", btn_continue:"Continuar", btn_create:"Crear mi rutina", gen_title:"Creando tu rutina personalizada", gen_sub:"Estamos analizando tus objetivos y diseñando la combinación óptima de suplementos NeoRejuvenation", ai_label:"Tu rutina personalizada", today_header:"Tu rutina de hoy", streak_label:"días en racha", complete_title:"¡Rutina completada!", complete_sub:"Has completado todos tus suplementos de hoy. Tu cuerpo te lo agradece.", progress_title:"Tu progreso", progress_sub:"Últimos 30 días", streak_card_label:"Racha activa", streak_days:"días consecutivos", record_label:"Récord", record_days:"días", last7:"Últimos 7 días", weekly_avg:"Prom.", routine_title:"Tu rutina actual", total_supps:"suplementos en total", settings_title:"Ajustes", reminders_title:"Recordatorios", notif_btn:"Activar notificaciones", notif_granted:"Notificaciones activadas", notif_hint:"Los recordatorios funcionan mientras tengas esta página abierta.", routine_section:"Rutina", regenerate_hint:"¿Quieres ajustar tus objetivos o regenerar tu rutina?", regenerate_btn:"Crear nueva rutina", reminder_prefix:"Recordatorio", fallback_msg:"Tu rutina base NeoRejuvenation está lista. Vitamina C + Reishi son los pilares fundamentales de tu regeneración celular diaria.", fallback_warning:"Consulta con un médico antes de iniciar cualquier suplementación.", compact_label:"Modo compacto", compact_hint:"Oculta los beneficios para ver más suplementos de un vistazo", viewing_past:"Viendo día pasado", back_to_today:"Volver a hoy", swipe_hint:"Desliza ← → para cambiar de día", milestone_cta:"Continuar", day_names:["D","L","M","X","J","V","S"], date_locale:"es-ES" },
  en: { trackerSub:"Supplement Tracker", today_label:"today", tab_today:"Today", tab_progress:"Progress", tab_settings:"Settings", morning:"Morning", afternoon:"Afternoon", night:"Night", morning_hint:"Upon waking · With breakfast", afternoon_hint:"Midday · With lunch", night_hint:"Before sleep · With dinner", morning_notif:"Morning", afternoon_notif:"Afternoon", night_notif:"Night", freq_alternate:"Every 2-3 days", freq_weekly:"2-3×/week", hide_info:"Hide", more_info:"More info", step1_title:"What are your goals?", step1_sub:"Select all that apply. We'll adapt your routine.", step2_title:"Contraindications", step2_sub:"This is important for your safety. Please be honest.", step3_title:"All set!", step3_sub:"We'll create your personalized routine based on the NeoRejuvenation method.", step3_disclaimer:"This information is educational. Always consult a healthcare professional before starting any supplementation.", btn_back:"Back", btn_continue:"Continue", btn_create:"Create my routine", gen_title:"Creating your personalized routine", gen_sub:"We're analyzing your goals and designing the optimal NeoRejuvenation supplement combination", ai_label:"Your personalized routine", today_header:"Your routine today", streak_label:"day streak", complete_title:"Routine complete!", complete_sub:"You have completed all your supplements for today. Your body thanks you.", progress_title:"Your progress", progress_sub:"Last 30 days", streak_card_label:"Active streak", streak_days:"consecutive days", record_label:"Record", record_days:"days", last7:"Last 7 days", weekly_avg:"Avg.", routine_title:"Your current routine", total_supps:"supplements total", settings_title:"Settings", reminders_title:"Reminders", notif_btn:"Enable notifications", notif_granted:"Notifications enabled", notif_hint:"Reminders work while this page is open.", routine_section:"Routine", regenerate_hint:"Want to adjust your goals or regenerate your routine?", regenerate_btn:"Create new routine", reminder_prefix:"Reminder", fallback_msg:"Your base NeoRejuvenation routine is ready. Vitamin C + Reishi are the fundamental pillars of your daily cellular regeneration.", fallback_warning:"Consult a doctor before starting any supplementation.", compact_label:"Compact mode", compact_hint:"Hide benefits to see more supplements at a glance", viewing_past:"Viewing past day", back_to_today:"Back to today", swipe_hint:"Swipe ← → to change day", milestone_cta:"Continue", day_names:["Su","Mo","Tu","We","Th","Fr","Sa"], date_locale:"en-US" },
  fr: { trackerSub:"Supplement Tracker", today_label:"aujourd'hui", tab_today:"Aujourd'hui", tab_progress:"Progrès", tab_settings:"Réglages", morning:"Matin", afternoon:"Après-midi", night:"Nuit", morning_hint:"Au réveil · Avec le petit-déjeuner", afternoon_hint:"Midi · Avec le déjeuner", night_hint:"Avant de dormir · Avec le dîner", morning_notif:"Matin", afternoon_notif:"Après-midi", night_notif:"Nuit", freq_alternate:"Tous les 2-3 jours", freq_weekly:"2-3×/semaine", hide_info:"Masquer", more_info:"Plus d'infos", step1_title:"Quels sont vos objectifs ?", step1_sub:"Sélectionnez tout ce qui s'applique. Nous adapterons votre routine.", step2_title:"Contre-indications", step2_sub:"C'est important pour votre sécurité. Soyez honnête.", step3_title:"Tout est prêt !", step3_sub:"Nous créerons votre routine personnalisée basée sur la méthode NeoRejuvenation.", step3_disclaimer:"Ces informations sont éducatives. Consultez toujours un professionnel de santé.", btn_back:"Retour", btn_continue:"Continuer", btn_create:"Créer ma routine", gen_title:"Création de votre routine", gen_sub:"Nous analysons vos objectifs et conçoit la combinaison optimale", ai_label:"Votre routine personnalisée", today_header:"Votre routine du jour", streak_label:"jours de suite", complete_title:"Routine complète !", complete_sub:"Vous avez pris tous vos suppléments aujourd'hui. Votre corps vous remercie.", progress_title:"Votre progrès", progress_sub:"30 derniers jours", streak_card_label:"Série active", streak_days:"jours consécutifs", record_label:"Record", record_days:"jours", last7:"7 derniers jours", weekly_avg:"Moy.", routine_title:"Votre routine actuelle", total_supps:"suppléments au total", settings_title:"Réglages", reminders_title:"Rappels", notif_btn:"Activer les notifications", notif_granted:"Notifications activées", notif_hint:"Les rappels fonctionnent tant que cette page est ouverte.", routine_section:"Routine", regenerate_hint:"Voulez-vous ajuster vos objectifs ou régénérer votre routine ?", regenerate_btn:"Créer une nouvelle routine", reminder_prefix:"Rappel", fallback_msg:"Votre routine NeoRejuvenation de base est prête. Vitamine C + Reishi sont les piliers fondamentaux.", fallback_warning:"Consultez un médecin avant de commencer toute supplémentation.", compact_label:"Mode compact", compact_hint:"Masquer les bénéfices pour voir plus de suppléments d'un coup d'œil", viewing_past:"Visualisation d'un jour passé", back_to_today:"Retour à aujourd'hui", swipe_hint:"Glissez ← → pour changer de jour", milestone_cta:"Continuer", day_names:["Di","Lu","Ma","Me","Je","Ve","Sa"], date_locale:"fr-FR" },
  de: { trackerSub:"Supplement Tracker", today_label:"heute", tab_today:"Heute", tab_progress:"Fortschritt", tab_settings:"Einstellungen", morning:"Morgen", afternoon:"Nachmittag", night:"Nacht", morning_hint:"Beim Aufwachen · Mit dem Frühstück", afternoon_hint:"Mittags · Mit dem Mittagessen", night_hint:"Vor dem Schlafen · Mit dem Abendessen", morning_notif:"Morgen", afternoon_notif:"Nachmittag", night_notif:"Nacht", freq_alternate:"Alle 2-3 Tage", freq_weekly:"2-3×/Woche", hide_info:"Weniger", more_info:"Mehr Info", step1_title:"Was sind Ihre Ziele?", step1_sub:"Wählen Sie alles Zutreffende. Wir passen Ihre Routine an.", step2_title:"Kontraindikationen", step2_sub:"Dies ist wichtig für Ihre Sicherheit.", step3_title:"Alles bereit!", step3_sub:"Wir erstellen Ihre personalisierte Routine basierend auf der NeoRejuvenation-Methode.", step3_disclaimer:"Diese Informationen sind pädagogisch. Konsultieren Sie immer einen Arzt.", btn_back:"Zurück", btn_continue:"Weiter", btn_create:"Meine Routine erstellen", gen_title:"Ihre Routine wird erstellt", gen_sub:"Wir analysieren Ihre Ziele und entwirft die optimale Supplementkombination", ai_label:"Ihre personalisierte Routine", today_header:"Ihre Routine heute", streak_label:"Tage in Folge", complete_title:"Routine abgeschlossen!", complete_sub:"Sie haben alle heutigen Supplemente eingenommen.", progress_title:"Ihr Fortschritt", progress_sub:"Letzte 30 Tage", streak_card_label:"Aktive Serie", streak_days:"aufeinanderfolgende Tage", record_label:"Rekord", record_days:"Tage", last7:"Letzte 7 Tage", weekly_avg:"Ø", routine_title:"Ihre aktuelle Routine", total_supps:"Supplemente insgesamt", settings_title:"Einstellungen", reminders_title:"Erinnerungen", notif_btn:"Benachrichtigungen aktivieren", notif_granted:"Benachrichtigungen aktiviert", notif_hint:"Erinnerungen funktionieren solange diese Seite geöffnet ist.", routine_section:"Routine", regenerate_hint:"Möchten Sie Ihre Ziele anpassen oder Ihre Routine neu generieren?", regenerate_btn:"Neue Routine erstellen", reminder_prefix:"Erinnerung", fallback_msg:"Ihre NeoRejuvenation-Basisroutine ist bereit. Vitamin C + Reishi sind die grundlegenden Säulen.", fallback_warning:"Konsultieren Sie einen Arzt.", compact_label:"Kompakter Modus", compact_hint:"Vorteile ausblenden, um mehr Supplemente auf einen Blick zu sehen", viewing_past:"Vergangener Tag", back_to_today:"Zurück zu heute", swipe_hint:"Wischen ← → um den Tag zu wechseln", milestone_cta:"Weiter", day_names:["So","Mo","Di","Mi","Do","Fr","Sa"], date_locale:"de-DE" },
  pt: { trackerSub:"Supplement Tracker", today_label:"hoje", tab_today:"Hoje", tab_progress:"Progresso", tab_settings:"Configurações", morning:"Manhã", afternoon:"Tarde", night:"Noite", morning_hint:"Ao acordar · Com o café da manhã", afternoon_hint:"Ao meio-dia · Com o almoço", night_hint:"Antes de dormir · Com o jantar", morning_notif:"Manhã", afternoon_notif:"Tarde", night_notif:"Noite", freq_alternate:"A cada 2-3 dias", freq_weekly:"2-3×/semana", hide_info:"Ocultar", more_info:"Mais info", step1_title:"Quais são os seus objetivos?", step1_sub:"Selecione todos os que se aplicam. Adaptaremos sua rotina.", step2_title:"Contraindicações", step2_sub:"É importante para a sua segurança.", step3_title:"Tudo pronto!", step3_sub:"Criaremos sua rotina personalizada baseada no método NeoRejuvenation.", step3_disclaimer:"Esta informação é educacional. Consulte sempre um profissional de saúde.", btn_back:"Voltar", btn_continue:"Continuar", btn_create:"Criar minha rotina", gen_title:"Criando sua rotina personalizada", gen_sub:"Estamos analisando seus objetivos e projetando a combinação ideal", ai_label:"Sua rotina personalizada", today_header:"Sua rotina de hoje", streak_label:"dias seguidos", complete_title:"Rotina concluída!", complete_sub:"Você completou todos os seus suplementos hoje.", progress_title:"Seu progresso", progress_sub:"Últimos 30 dias", streak_card_label:"Sequência ativa", streak_days:"dias consecutivos", record_label:"Recorde", record_days:"dias", last7:"Últimos 7 dias", weekly_avg:"Méd.", routine_title:"Sua rotina atual", total_supps:"suplementos no total", settings_title:"Configurações", reminders_title:"Lembretes", notif_btn:"Ativar notificações", notif_granted:"Notificações ativadas", notif_hint:"Os lembretes funcionam enquanto esta página estiver aberta.", routine_section:"Rotina", regenerate_hint:"Quer ajustar seus objetivos ou regenerar sua rotina?", regenerate_btn:"Criar nova rotina", reminder_prefix:"Lembrete", fallback_msg:"Sua rotina base NeoRejuvenation está pronta. Vitamina C + Reishi são os pilares fundamentais.", fallback_warning:"Consulte um médico antes de iniciar qualquer suplementação.", compact_label:"Modo compacto", compact_hint:"Oculta os benefícios para ver mais suplementos de relance", viewing_past:"Vendo dia passado", back_to_today:"Voltar para hoje", swipe_hint:"Deslize ← → para mudar de dia", milestone_cta:"Continuar", day_names:["D","S","T","Q","Q","S","S"], date_locale:"pt-BR" },
  it: { trackerSub:"Supplement Tracker", today_label:"oggi", tab_today:"Oggi", tab_progress:"Progressi", tab_settings:"Impostazioni", morning:"Mattina", afternoon:"Pomeriggio", night:"Notte", morning_hint:"Al risveglio · Con la colazione", afternoon_hint:"Mezzogiorno · Con il pranzo", night_hint:"Prima di dormire · Con la cena", morning_notif:"Mattina", afternoon_notif:"Pomeriggio", night_notif:"Notte", freq_alternate:"Ogni 2-3 giorni", freq_weekly:"2-3×/settimana", hide_info:"Nascondi", more_info:"Più info", step1_title:"Quali sono i tuoi obiettivi?", step1_sub:"Seleziona tutto ciò che si applica. Adatteremo la tua routine.", step2_title:"Controindicazioni", step2_sub:"È importante per la tua sicurezza.", step3_title:"Tutto pronto!", step3_sub:"Creeremo la tua routine personalizzata basata sul metodo NeoRejuvenation.", step3_disclaimer:"Queste informazioni sono educative. Consulta sempre un professionista sanitario.", btn_back:"Indietro", btn_continue:"Continua", btn_create:"Crea la mia routine", gen_title:"Creazione della tua routine", gen_sub:"Stiamo analizzando i tuoi obiettivi e progettando la combinazione ottimale", ai_label:"La tua routine personalizzata", today_header:"La tua routine di oggi", streak_label:"giorni di seguito", complete_title:"Routine completata!", complete_sub:"Hai completato tutti i tuoi integratori di oggi.", progress_title:"I tuoi progressi", progress_sub:"Ultimi 30 giorni", streak_card_label:"Serie attiva", streak_days:"giorni consecutivi", record_label:"Record", record_days:"giorni", last7:"Ultimi 7 giorni", weekly_avg:"Media", routine_title:"La tua routine attuale", total_supps:"integratori in totale", settings_title:"Impostazioni", reminders_title:"Promemoria", notif_btn:"Attiva notifiche", notif_granted:"Notifiche attivate", notif_hint:"I promemoria funzionano finché questa pagina è aperta.", routine_section:"Routine", regenerate_hint:"Vuoi modificare i tuoi obiettivi o rigenerare la tua routine?", regenerate_btn:"Crea nuova routine", reminder_prefix:"Promemoria", fallback_msg:"La tua routine base NeoRejuvenation è pronta. Vitamina C + Reishi sono i pilastri fondamentali.", fallback_warning:"Consulta un medico prima di iniziare qualsiasi integrazione.", compact_label:"Modalità compatta", compact_hint:"Nascondi i benefici per vedere più integratori a colpo d'occhio", viewing_past:"Visualizzazione giorno passato", back_to_today:"Torna a oggi", swipe_hint:"Scorri ← → per cambiare giorno", milestone_cta:"Continua", day_names:["Do","Lu","Ma","Me","Gi","Ve","Sa"], date_locale:"it-IT" },
  ea: { trackerSub:"متتبع المكملات", today_label:"اليوم", tab_today:"اليوم", tab_progress:"التقدم", tab_settings:"الإعدادات", morning:"الصباح", afternoon:"الظهيرة", night:"الليل", morning_hint:"عند الاستيقاظ · مع الإفطار", afternoon_hint:"الظهر · مع الغداء", night_hint:"قبل النوم · مع العشاء", morning_notif:"الصباح", afternoon_notif:"الظهيرة", night_notif:"الليل", freq_alternate:"كل 2-3 أيام", freq_weekly:"2-3 مرات/أسبوع", hide_info:"إخفاء", more_info:"المزيد", step1_title:"ما هي أهدافك؟", step1_sub:"اختر كل ما ينطبق. سنكيّف روتينك.", step2_title:"موانع الاستعمال", step2_sub:"هذا مهم لسلامتك. كن صادقًا.", step3_title:"كل شيء جاهز!", step3_sub:"سننشئ روتينك الشخصي بناءً على منهج NeoRejuvenation.", step3_disclaimer:"هذه المعلومات تعليمية. استشر دائمًا أخصائيًا صحيًا قبل البدء بأي مكملات.", btn_back:"رجوع", btn_continue:"متابعة", btn_create:"إنشاء روتيني", gen_title:"نقوم بإنشاء روتينك الشخصي", gen_sub:"نحلل أهدافك ونصمم التركيبة المثلى من مكملات NeoRejuvenation", ai_label:"روتينك الشخصي", today_header:"روتينك اليوم", streak_label:"أيام متتالية", complete_title:"اكتمل الروتين!", complete_sub:"لقد أكملت كل مكملاتك اليوم. جسدك يشكرك.", progress_title:"تقدمك", progress_sub:"آخر 30 يومًا", streak_card_label:"السلسلة النشطة", streak_days:"أيام متتالية", record_label:"الرقم القياسي", record_days:"أيام", last7:"آخر 7 أيام", weekly_avg:"المتوسط", routine_title:"روتينك الحالي", total_supps:"مكمل إجمالاً", settings_title:"الإعدادات", reminders_title:"التذكيرات", notif_btn:"تفعيل الإشعارات", notif_granted:"الإشعارات مفعّلة", notif_hint:"تعمل التذكيرات طالما هذه الصفحة مفتوحة.", routine_section:"الروتين", regenerate_hint:"هل تريد تعديل أهدافك أو إعادة إنشاء روتينك؟", regenerate_btn:"إنشاء روتين جديد", reminder_prefix:"تذكير", fallback_msg:"روتين NeoRejuvenation الأساسي جاهز. فيتامين C والريشي هما الركيزتان الأساسيتان لتجديد خلاياك يوميًا.", fallback_warning:"استشر طبيبك قبل البدء بأي مكملات.", compact_label:"الوضع المضغوط", compact_hint:"إخفاء الفوائد لرؤية المزيد من المكملات بلمحة", viewing_past:"عرض يوم سابق", back_to_today:"العودة إلى اليوم", swipe_hint:"اسحب ← → لتغيير اليوم", milestone_cta:"متابعة", day_names:["ح","ن","ث","ر","خ","ج","س"], date_locale:"ar-AE" }
};

/* ───────────────── NOTIFICATION GATE TRANSLATIONS ───────────────── */
const NOTIF_GATE = {
  es: { title:"Activa las notificaciones", body:"Para usar el Supplement Tracker necesitas activar las notificaciones. Así podremos recordarte tomar tus suplementos en los momentos correctos del día — esencial para mantener tu rutina de regeneración celular.", btn:"Activar notificaciones", denied_title:"Notificaciones bloqueadas", denied_body:"Las notificaciones están bloqueadas en tu navegador. Para usar el Supplement Tracker, actívalas manualmente: haz clic en el candado junto a la URL y cambia 'Notificaciones' a 'Permitir', luego recarga esta página.", retry:"Ya las he activado", unsupported_title:"Navegador no compatible", unsupported_body:"Tu navegador no soporta notificaciones web. Si estás en iPhone, instala la app desde Safari en 'Añadir a pantalla de inicio'.", unsupported_continue:"Continuar sin notificaciones" },
  en: { title:"Enable notifications", body:"To use the Supplement Tracker you need to enable notifications. This way we can remind you to take your supplements at the right times of the day — essential to maintain your cellular regeneration routine.", btn:"Enable notifications", denied_title:"Notifications blocked", denied_body:"Notifications are blocked in your browser. To use the Supplement Tracker, enable them manually: click the lock icon next to the URL and change 'Notifications' to 'Allow', then reload this page.", retry:"I've enabled them", unsupported_title:"Browser not supported", unsupported_body:"Your browser doesn't support web notifications. If you're on iPhone, install the app from Safari via 'Add to Home Screen'.", unsupported_continue:"Continue without notifications" },
  fr: { title:"Activez les notifications", body:"Pour utiliser le Supplement Tracker, vous devez activer les notifications. Nous pourrons ainsi vous rappeler de prendre vos suppléments aux bons moments de la journée — essentiel pour maintenir votre routine de régénération cellulaire.", btn:"Activer les notifications", denied_title:"Notifications bloquées", denied_body:"Les notifications sont bloquées dans votre navigateur. Pour utiliser le Supplement Tracker, activez-les manuellement : cliquez sur l'icône de cadenas à côté de l'URL et changez 'Notifications' en 'Autoriser', puis rechargez cette page.", retry:"Je les ai activées", unsupported_title:"Navigateur non compatible", unsupported_body:"Votre navigateur ne prend pas en charge les notifications web. Si vous êtes sur iPhone, installez l'app depuis Safari via 'Sur l'écran d'accueil'.", unsupported_continue:"Continuer sans notifications" },
  de: { title:"Benachrichtigungen aktivieren", body:"Um den Supplement Tracker zu nutzen, müssen Sie Benachrichtigungen aktivieren. So können wir Sie zu den richtigen Tageszeiten an die Einnahme Ihrer Supplemente erinnern — unerlässlich für Ihre Zellregenerationsroutine.", btn:"Benachrichtigungen aktivieren", denied_title:"Benachrichtigungen blockiert", denied_body:"Benachrichtigungen sind in Ihrem Browser blockiert. Um den Supplement Tracker zu nutzen, aktivieren Sie sie manuell: Klicken Sie auf das Schloss-Symbol neben der URL und ändern Sie 'Benachrichtigungen' auf 'Zulassen', dann laden Sie diese Seite neu.", retry:"Ich habe sie aktiviert", unsupported_title:"Browser nicht unterstützt", unsupported_body:"Ihr Browser unterstützt keine Web-Benachrichtigungen. Auf iPhone installieren Sie die App aus Safari über 'Zum Home-Bildschirm'.", unsupported_continue:"Ohne Benachrichtigungen fortfahren" },
  pt: { title:"Ative as notificações", body:"Para usar o Supplement Tracker você precisa ativar as notificações. Assim podemos lembrá-lo de tomar seus suplementos nos momentos certos do dia — essencial para manter sua rotina de regeneração celular.", btn:"Ativar notificações", denied_title:"Notificações bloqueadas", denied_body:"As notificações estão bloqueadas no seu navegador. Para usar o Supplement Tracker, ative-as manualmente: clique no ícone de cadeado ao lado da URL e mude 'Notificações' para 'Permitir', depois recarregue esta página.", retry:"Já as ativei", unsupported_title:"Navegador não compatível", unsupported_body:"Seu navegador não suporta notificações web. Se você está no iPhone, instale o app pelo Safari em 'Adicionar à Tela de Início'.", unsupported_continue:"Continuar sem notificações" },
  it: { title:"Attiva le notifiche", body:"Per usare il Supplement Tracker devi attivare le notifiche. Così potremo ricordarti di prendere i tuoi integratori nei momenti giusti della giornata — essenziale per mantenere la tua routine di rigenerazione cellulare.", btn:"Attiva le notifiche", denied_title:"Notifiche bloccate", denied_body:"Le notifiche sono bloccate nel tuo browser. Per usare il Supplement Tracker, attivale manualmente: fai clic sull'icona del lucchetto accanto all'URL e cambia 'Notifiche' in 'Consenti', poi ricarica questa pagina.", retry:"Le ho attivate", unsupported_title:"Browser non compatibile", unsupported_body:"Il tuo browser non supporta le notifiche web. Se sei su iPhone, installa l'app da Safari tramite 'Aggiungi a Home'.", unsupported_continue:"Continua senza notifiche" },
  ea: { title:"تفعيل الإشعارات", body:"لاستخدام Supplement Tracker، يجب تفعيل الإشعارات. بهذه الطريقة يمكننا تذكيرك بتناول مكملاتك في الأوقات الصحيحة من اليوم — أمر ضروري للحفاظ على روتين تجديد خلاياك.", btn:"تفعيل الإشعارات", denied_title:"الإشعارات محظورة", denied_body:"الإشعارات محظورة في متصفحك. لاستخدام Supplement Tracker، قم بتفعيلها يدويًا: انقر على أيقونة القفل بجانب الرابط وغيّر 'الإشعارات' إلى 'السماح'، ثم أعد تحميل هذه الصفحة.", retry:"لقد قمت بتفعيلها", unsupported_title:"المتصفح غير مدعوم", unsupported_body:"متصفحك لا يدعم إشعارات الويب. إذا كنت تستخدم iPhone، ثبّت التطبيق من Safari عبر 'أضف إلى الشاشة الرئيسية'.", unsupported_continue:"المتابعة بدون إشعارات" }
};

/* ───────────────── EXTRA TRANSLATIONS (added in phase 2 features) ───────────────── */
const EXTRA_T = {
  es: { mark_all:"Marcar todos", unmark_all:"Desmarcar todos", regen_confirm_title:"¿Regenerar tu rutina?", regen_confirm_body:"Tu racha de {streak} días se mantendrá intacta. Se generará una nueva rutina basada en objetivos actualizados.", regen_confirm_body_nostreak:"Se generará una nueva rutina basada en objetivos actualizados.", regen_confirm_btn:"Sí, regenerar", regen_cancel_btn:"Cancelar", note_label:"Nota del día", note_placeholder:"Cómo te has sentido hoy (opcional)…", grace_day:"Día de gracia usado", none_excludes:"Al seleccionar \"ninguna\", las demás opciones se desactivan", push_test_btn:"Probar notificación", push_test_ok:"✓ Notificación enviada — debería llegar en unos segundos", push_test_no_sub:"Activa primero las notificaciones en este navegador", ios_install_title:"Instala la app para recibir notificaciones", ios_install_body:"En iPhone, las notificaciones solo funcionan con NeoRejuvenation instalada en tu pantalla de inicio. Son 3 pasos:", ios_install_step1:"Toca el botón Compartir en la barra inferior de Safari", ios_install_step2:"Busca y toca \"Añadir a pantalla de inicio\"", ios_install_step3:"Abre NeoRejuvenation desde el icono de tu pantalla de inicio", ios_install_note:"Importante: debes abrir siempre la app desde el icono del home, no desde Safari.", ios_install_cta:"Entendido" },
  en: { mark_all:"Mark all", unmark_all:"Unmark all", regen_confirm_title:"Regenerate your routine?", regen_confirm_body:"Your {streak}-day streak will stay intact. A new routine will be generated based on updated goals.", regen_confirm_body_nostreak:"A new routine will be generated based on updated goals.", regen_confirm_btn:"Yes, regenerate", regen_cancel_btn:"Cancel", note_label:"Today's note", note_placeholder:"How have you felt today (optional)…", grace_day:"Grace day used", none_excludes:"Selecting \"none\" disables the other options", push_test_btn:"Test notification", push_test_ok:"✓ Notification sent — it should arrive in a few seconds", push_test_no_sub:"Enable notifications in this browser first", ios_install_title:"Install the app to receive notifications", ios_install_body:"On iPhone, notifications only work with NeoRejuvenation installed on your home screen. It takes 3 steps:", ios_install_step1:"Tap the Share button in Safari's bottom bar", ios_install_step2:"Find and tap \"Add to Home Screen\"", ios_install_step3:"Open NeoRejuvenation from the icon on your home screen", ios_install_note:"Important: always open the app from the home screen icon, not from Safari.", ios_install_cta:"Got it" },
  fr: { mark_all:"Tout marquer", unmark_all:"Tout démarquer", regen_confirm_title:"Régénérer votre routine ?", regen_confirm_body:"Votre série de {streak} jours restera intacte. Une nouvelle routine sera générée sur la base d'objectifs mis à jour.", regen_confirm_body_nostreak:"Une nouvelle routine sera générée sur la base d'objectifs mis à jour.", regen_confirm_btn:"Oui, régénérer", regen_cancel_btn:"Annuler", note_label:"Note du jour", note_placeholder:"Comment vous sentez-vous aujourd'hui (facultatif)…", grace_day:"Jour de grâce utilisé", none_excludes:"En sélectionnant « aucune », les autres options sont désactivées", push_test_btn:"Tester la notification", push_test_ok:"✓ Notification envoyée — elle devrait arriver dans quelques secondes", push_test_no_sub:"Activez d'abord les notifications dans ce navigateur", ios_install_title:"Installez l'app pour recevoir des notifications", ios_install_body:"Sur iPhone, les notifications ne fonctionnent qu'avec NeoRejuvenation installée sur votre écran d'accueil. Cela prend 3 étapes :", ios_install_step1:"Touchez le bouton Partager dans la barre inférieure de Safari", ios_install_step2:"Trouvez et touchez « Sur l'écran d'accueil »", ios_install_step3:"Ouvrez NeoRejuvenation depuis l'icône de votre écran d'accueil", ios_install_note:"Important : ouvrez toujours l'app depuis l'icône de l'écran d'accueil, pas depuis Safari.", ios_install_cta:"Compris" },
  de: { mark_all:"Alle markieren", unmark_all:"Alle demarkieren", regen_confirm_title:"Ihre Routine neu generieren?", regen_confirm_body:"Ihre {streak}-Tage-Serie bleibt erhalten. Eine neue Routine wird auf Basis aktualisierter Ziele erstellt.", regen_confirm_body_nostreak:"Eine neue Routine wird auf Basis aktualisierter Ziele erstellt.", regen_confirm_btn:"Ja, neu generieren", regen_cancel_btn:"Abbrechen", note_label:"Tagesnotiz", note_placeholder:"Wie haben Sie sich heute gefühlt (optional)…", grace_day:"Kulanztag verwendet", none_excludes:"Bei Auswahl von „keine\" werden die anderen Optionen deaktiviert", push_test_btn:"Benachrichtigung testen", push_test_ok:"✓ Benachrichtigung gesendet — sie sollte in wenigen Sekunden ankommen", push_test_no_sub:"Aktivieren Sie zunächst die Benachrichtigungen in diesem Browser", ios_install_title:"Installieren Sie die App für Benachrichtigungen", ios_install_body:"Auf dem iPhone funktionieren Benachrichtigungen nur, wenn NeoRejuvenation auf Ihrem Home-Bildschirm installiert ist. Es sind 3 Schritte:", ios_install_step1:"Tippen Sie auf den Teilen-Button in der unteren Leiste von Safari", ios_install_step2:"Suchen und tippen Sie auf „Zum Home-Bildschirm“", ios_install_step3:"Öffnen Sie NeoRejuvenation über das Symbol auf Ihrem Home-Bildschirm", ios_install_note:"Wichtig: Öffnen Sie die App immer über das Symbol des Home-Bildschirms, nicht über Safari.", ios_install_cta:"Verstanden" },
  pt: { mark_all:"Marcar todos", unmark_all:"Desmarcar todos", regen_confirm_title:"Regenerar sua rotina?", regen_confirm_body:"Sua sequência de {streak} dias permanecerá intacta. Uma nova rotina será gerada com base em objetivos atualizados.", regen_confirm_body_nostreak:"Uma nova rotina será gerada com base em objetivos atualizados.", regen_confirm_btn:"Sim, regenerar", regen_cancel_btn:"Cancelar", note_label:"Nota do dia", note_placeholder:"Como você se sentiu hoje (opcional)…", grace_day:"Dia de graça usado", none_excludes:"Ao selecionar \"nenhuma\", as outras opções ficam desativadas", push_test_btn:"Testar notificação", push_test_ok:"✓ Notificação enviada — deve chegar em alguns segundos", push_test_no_sub:"Ative primeiro as notificações neste navegador", ios_install_title:"Instale o app para receber notificações", ios_install_body:"No iPhone, as notificações só funcionam com NeoRejuvenation instalada na sua tela inicial. São 3 passos:", ios_install_step1:"Toque no botão Compartilhar na barra inferior do Safari", ios_install_step2:"Encontre e toque em \"Adicionar à Tela de Início\"", ios_install_step3:"Abra NeoRejuvenation pelo ícone na sua tela inicial", ios_install_note:"Importante: sempre abra o app pelo ícone da tela inicial, não pelo Safari.", ios_install_cta:"Entendi" },
  it: { mark_all:"Seleziona tutti", unmark_all:"Deseleziona tutti", regen_confirm_title:"Rigenerare la tua routine?", regen_confirm_body:"La tua serie di {streak} giorni rimarrà intatta. Verrà generata una nuova routine basata su obiettivi aggiornati.", regen_confirm_body_nostreak:"Verrà generata una nuova routine basata su obiettivi aggiornati.", regen_confirm_btn:"Sì, rigenera", regen_cancel_btn:"Annulla", note_label:"Nota del giorno", note_placeholder:"Come ti sei sentito oggi (facoltativo)…", grace_day:"Giorno di grazia usato", none_excludes:"Selezionando \"nessuna\", le altre opzioni vengono disattivate", push_test_btn:"Prova notifica", push_test_ok:"✓ Notifica inviata — dovrebbe arrivare in pochi secondi", push_test_no_sub:"Attiva prima le notifiche in questo browser", ios_install_title:"Installa l'app per ricevere le notifiche", ios_install_body:"Su iPhone, le notifiche funzionano solo con NeoRejuvenation installata nella tua schermata Home. Sono 3 passaggi:", ios_install_step1:"Tocca il pulsante Condividi nella barra inferiore di Safari", ios_install_step2:"Trova e tocca \"Aggiungi a Home\"", ios_install_step3:"Apri NeoRejuvenation dall'icona sulla tua schermata Home", ios_install_note:"Importante: apri sempre l'app dall'icona della schermata Home, non da Safari.", ios_install_cta:"Capito" },
  ea: { mark_all:"تحديد الكل", unmark_all:"إلغاء التحديد", regen_confirm_title:"إعادة إنشاء روتينك؟", regen_confirm_body:"سلسلتك البالغة {streak} يومًا ستبقى سليمة. سيتم إنشاء روتين جديد بناءً على أهداف محدّثة.", regen_confirm_body_nostreak:"سيتم إنشاء روتين جديد بناءً على أهداف محدّثة.", regen_confirm_btn:"نعم، إعادة الإنشاء", regen_cancel_btn:"إلغاء", note_label:"ملاحظة اليوم", note_placeholder:"كيف شعرت اليوم (اختياري)…", grace_day:"تم استخدام يوم السماح", none_excludes:"عند اختيار \"لا شيء\"، يتم تعطيل الخيارات الأخرى", push_test_btn:"اختبر الإشعار", push_test_ok:"✓ تم إرسال الإشعار — يجب أن يصل خلال ثوانٍ", push_test_no_sub:"فعّل الإشعارات أولاً في هذا المتصفح", ios_install_title:"ثبّت التطبيق لتلقي الإشعارات", ios_install_body:"على iPhone، تعمل الإشعارات فقط عند تثبيت NeoRejuvenation على الشاشة الرئيسية. الأمر يتطلب 3 خطوات:", ios_install_step1:"اضغط على زر المشاركة في شريط Safari السفلي", ios_install_step2:"ابحث واضغط على \"إضافة إلى الشاشة الرئيسية\"", ios_install_step3:"افتح NeoRejuvenation من الأيقونة على شاشتك الرئيسية", ios_install_note:"مهم: افتح التطبيق دائمًا من أيقونة الشاشة الرئيسية، وليس من Safari.", ios_install_cta:"فهمت" }
};

/* ───────────────── GOALS & CONTRAINDICATIONS ───────────────── */
const GOALS_I18N = {
  es:[{id:"antiaging",label:"Anti-Aging & Regeneración",desc:"Frenar el envejecimiento celular"},{id:"energy",label:"Energía & Rendimiento",desc:"Aumentar vitalidad y resistencia física"},{id:"immune",label:"Sistema Inmune",desc:"Fortalecer defensas naturales"},{id:"brain",label:"Cerebro & Concentración",desc:"Memoria, foco y claridad mental"},{id:"skin",label:"Piel & Belleza",desc:"Colágeno, hidratación y luminosidad"},{id:"hair",label:"Cabello & Canas",desc:"Densidad capilar y prevención de canas"},{id:"cardiovascular",label:"Cardiovascular",desc:"Salud del corazón y circulación"},{id:"detox",label:"Detox Hepático",desc:"Depuración y regeneración del hígado"},{id:"joints",label:"Articulaciones & Tejidos",desc:"Cartílagos, tendones y movilidad"},{id:"stress",label:"Estrés & Sueño",desc:"Equilibrio nervioso y calidad del sueño"}],
  en:[{id:"antiaging",label:"Anti-Aging & Regeneration",desc:"Slow down cellular aging"},{id:"energy",label:"Energy & Performance",desc:"Boost vitality and physical endurance"},{id:"immune",label:"Immune System",desc:"Strengthen natural defenses"},{id:"brain",label:"Brain & Focus",desc:"Memory, focus and mental clarity"},{id:"skin",label:"Skin & Beauty",desc:"Collagen, hydration and radiance"},{id:"hair",label:"Hair & Grey Hair",desc:"Hair density and grey hair prevention"},{id:"cardiovascular",label:"Cardiovascular",desc:"Heart health and circulation"},{id:"detox",label:"Liver Detox",desc:"Liver purification and regeneration"},{id:"joints",label:"Joints & Tissues",desc:"Cartilage, tendons and mobility"},{id:"stress",label:"Stress & Sleep",desc:"Nervous balance and sleep quality"}],
  fr:[{id:"antiaging",label:"Anti-âge & Régénération",desc:"Ralentir le vieillissement cellulaire"},{id:"energy",label:"Énergie & Performance",desc:"Augmenter la vitalité"},{id:"immune",label:"Système Immunitaire",desc:"Renforcer les défenses naturelles"},{id:"brain",label:"Cerveau & Concentration",desc:"Mémoire, concentration et clarté"},{id:"skin",label:"Peau & Beauté",desc:"Collagène, hydratation et luminosité"},{id:"hair",label:"Cheveux & Cheveux Blancs",desc:"Densité capillaire et prévention"},{id:"cardiovascular",label:"Cardiovasculaire",desc:"Santé cardiaque et circulation"},{id:"detox",label:"Détox Hépatique",desc:"Purification et régénération du foie"},{id:"joints",label:"Articulations & Tissus",desc:"Cartilages, tendons et mobilité"},{id:"stress",label:"Stress & Sommeil",desc:"Équilibre nerveux et qualité du sommeil"}],
  de:[{id:"antiaging",label:"Anti-Aging & Regeneration",desc:"Zelluläre Alterung verlangsamen"},{id:"energy",label:"Energie & Leistung",desc:"Vitalität und Ausdauer steigern"},{id:"immune",label:"Immunsystem",desc:"Natürliche Abwehrkräfte stärken"},{id:"brain",label:"Gehirn & Konzentration",desc:"Gedächtnis, Fokus und Klarheit"},{id:"skin",label:"Haut & Schönheit",desc:"Kollagen, Hydratation und Ausstrahlung"},{id:"hair",label:"Haare & graue Haare",desc:"Haardichte und Prävention"},{id:"cardiovascular",label:"Herz-Kreislauf",desc:"Herzgesundheit und Durchblutung"},{id:"detox",label:"Leber-Detox",desc:"Leberreinigung und -regeneration"},{id:"joints",label:"Gelenke & Gewebe",desc:"Knorpel, Sehnen und Beweglichkeit"},{id:"stress",label:"Stress & Schlaf",desc:"Nervöses Gleichgewicht und Schlafqualität"}],
  pt:[{id:"antiaging",label:"Anti-Envelhecimento",desc:"Desacelerar o envelhecimento"},{id:"energy",label:"Energia & Desempenho",desc:"Aumentar vitalidade e resistência"},{id:"immune",label:"Sistema Imunológico",desc:"Fortalecer as defesas naturais"},{id:"brain",label:"Cérebro & Concentração",desc:"Memória, foco e clareza mental"},{id:"skin",label:"Pele & Beleza",desc:"Colágeno, hidratação e luminosidade"},{id:"hair",label:"Cabelo & Cabelos Brancos",desc:"Densidade capilar e prevenção"},{id:"cardiovascular",label:"Cardiovascular",desc:"Saúde do coração e circulação"},{id:"detox",label:"Detox Hepático",desc:"Purificação e regeneração do fígado"},{id:"joints",label:"Articulações & Tecidos",desc:"Cartilagens, tendões e mobilidade"},{id:"stress",label:"Estresse & Sono",desc:"Equilíbrio nervoso e qualidade do sono"}],
  it:[{id:"antiaging",label:"Anti-Age & Rigenerazione",desc:"Rallentare l'invecchiamento"},{id:"energy",label:"Energia & Performance",desc:"Aumentare vitalità e resistenza"},{id:"immune",label:"Sistema Immunitario",desc:"Rafforzare le difese naturali"},{id:"brain",label:"Cervello & Concentrazione",desc:"Memoria, focus e chiarezza"},{id:"skin",label:"Pelle & Bellezza",desc:"Collagene, idratazione e luminosità"},{id:"hair",label:"Capelli & Capelli Bianchi",desc:"Densità capillare e prevenzione"},{id:"cardiovascular",label:"Cardiovascolare",desc:"Salute del cuore e circolazione"},{id:"detox",label:"Detox Epatico",desc:"Purificazione e rigenerazione"},{id:"joints",label:"Articolazioni & Tessuti",desc:"Cartilagini, tendini e mobilità"},{id:"stress",label:"Stress & Sonno",desc:"Equilibrio nervoso e qualità del sonno"}],
  ea:[{id:"antiaging",label:"مكافحة الشيخوخة والتجديد",desc:"إبطاء شيخوخة الخلايا"},{id:"energy",label:"الطاقة والأداء",desc:"زيادة الحيوية والقدرة على التحمل"},{id:"immune",label:"الجهاز المناعي",desc:"تقوية الدفاعات الطبيعية"},{id:"brain",label:"الدماغ والتركيز",desc:"الذاكرة والتركيز والوضوح الذهني"},{id:"skin",label:"البشرة والجمال",desc:"الكولاجين والترطيب والإشراق"},{id:"hair",label:"الشعر والشيب",desc:"كثافة الشعر ومنع الشيب"},{id:"cardiovascular",label:"القلب والأوعية",desc:"صحة القلب والدورة الدموية"},{id:"detox",label:"إزالة سموم الكبد",desc:"تنقية الكبد وتجديده"},{id:"joints",label:"المفاصل والأنسجة",desc:"الغضاريف والأوتار والحركة"},{id:"stress",label:"التوتر والنوم",desc:"التوازن العصبي وجودة النوم"}]
};

const CONTRA_I18N = {
  es:[{id:"anticoagulants",label:"Tomo anticoagulantes"},{id:"autoimmune",label:"Tengo enfermedad autoinmune"},{id:"surgery",label:"Operación próxima (< 2 semanas)"},{id:"diabetes",label:"Tengo diabetes"},{id:"antipsychotics",label:"Tomo antipsicóticos"},{id:"pregnancy",label:"Estoy embarazada o en lactancia"},{id:"antiretrovirals",label:"Tomo antirretrovirales"},{id:"hemochromatosis",label:"Tengo hemocromatosis"},{id:"kidney",label:"Problemas renales"},{id:"none",label:"Ninguna de las anteriores"}],
  en:[{id:"anticoagulants",label:"I take anticoagulants"},{id:"autoimmune",label:"I have an autoimmune disease"},{id:"surgery",label:"Upcoming surgery (< 2 weeks)"},{id:"diabetes",label:"I have diabetes"},{id:"antipsychotics",label:"I take antipsychotics"},{id:"pregnancy",label:"I am pregnant or breastfeeding"},{id:"antiretrovirals",label:"I take antiretrovirals"},{id:"hemochromatosis",label:"I have hemochromatosis"},{id:"kidney",label:"Kidney problems"},{id:"none",label:"None of the above"}],
  fr:[{id:"anticoagulants",label:"Je prends des anticoagulants"},{id:"autoimmune",label:"J'ai une maladie auto-immune"},{id:"surgery",label:"Opération prochaine (< 2 semaines)"},{id:"diabetes",label:"J'ai le diabète"},{id:"antipsychotics",label:"Je prends des antipsychotiques"},{id:"pregnancy",label:"Je suis enceinte ou j'allaite"},{id:"antiretrovirals",label:"Je prends des antirétroviraux"},{id:"hemochromatosis",label:"J'ai une hémochromatose"},{id:"kidney",label:"Problèmes rénaux"},{id:"none",label:"Aucune de celles-ci"}],
  de:[{id:"anticoagulants",label:"Ich nehme Blutverdünner"},{id:"autoimmune",label:"Ich habe eine Autoimmunerkrankung"},{id:"surgery",label:"Bevorstehende Operation (< 2 Wochen)"},{id:"diabetes",label:"Ich habe Diabetes"},{id:"antipsychotics",label:"Ich nehme Antipsychotika"},{id:"pregnancy",label:"Ich bin schwanger oder stille"},{id:"antiretrovirals",label:"Ich nehme antiretrovirale Medikamente"},{id:"hemochromatosis",label:"Ich habe Hämochromatose"},{id:"kidney",label:"Nierenprobleme"},{id:"none",label:"Keine der oben genannten"}],
  pt:[{id:"anticoagulants",label:"Tomo anticoagulantes"},{id:"autoimmune",label:"Tenho doença autoimune"},{id:"surgery",label:"Cirurgia próxima (< 2 semanas)"},{id:"diabetes",label:"Tenho diabetes"},{id:"antipsychotics",label:"Tomo antipsicóticos"},{id:"pregnancy",label:"Estou grávida ou amamentando"},{id:"antiretrovirals",label:"Tomo antirretrovirais"},{id:"hemochromatosis",label:"Tenho hemocromatose"},{id:"kidney",label:"Problemas renais"},{id:"none",label:"Nenhuma das anteriores"}],
  it:[{id:"anticoagulants",label:"Prendo anticoagulanti"},{id:"autoimmune",label:"Ho una malattia autoimmune"},{id:"surgery",label:"Operazione imminente (< 2 settimane)"},{id:"diabetes",label:"Ho il diabete"},{id:"antipsychotics",label:"Prendo antipsicotici"},{id:"pregnancy",label:"Sono incinta o allatto"},{id:"antiretrovirals",label:"Prendo antiretrovirali"},{id:"hemochromatosis",label:"Ho l'emocromatosi"},{id:"kidney",label:"Problemi renali"},{id:"none",label:"Nessuna delle precedenti"}],
  ea:[{id:"anticoagulants",label:"أتناول مضادات التخثر"},{id:"autoimmune",label:"لديّ مرض مناعي ذاتي"},{id:"surgery",label:"عملية قريبة (أقل من أسبوعين)"},{id:"diabetes",label:"لديّ مرض السكري"},{id:"antipsychotics",label:"أتناول مضادات الذهان"},{id:"pregnancy",label:"أنا حامل أو مرضعة"},{id:"antiretrovirals",label:"أتناول مضادات الفيروسات القهقرية"},{id:"hemochromatosis",label:"لديّ داء ترسب الأصبغة الدموية"},{id:"kidney",label:"مشاكل في الكلى"},{id:"none",label:"لا شيء مما سبق"}]
};

/* ───────────────── STREAK MILESTONE MESSAGES (Antonio Moll, first person) ───────────────── */
const MILESTONE_MSG = {
  es: {
    7: { title: "7 días siendo constante", body: "Esta es la primera barrera. El cuerpo empieza a registrar los cambios en tus niveles de vitamina C y cortisol. Sigue así, las próximas semanas son las que marcan la diferencia." },
    14: { title: "14 días en el camino", body: "Dos semanas de constancia. Tu hígado ya está notando el efecto del Reishi, la regeneración celular se está activando de forma real. Esto ya no es solo un hábito, es química." },
    30: { title: "Un mes completo", body: "Has cruzado la barrera que la mayoría no cruza. El 80% de las personas abandona antes de los 30 días. Tú no. Los cambios que vienen ahora son los que permanecen." },
    60: { title: "60 días de regeneración", body: "Dos meses. Tu piel, tu energía y tu sistema inmune están entrando en una fase nueva. Esto ya no es un experimento, es una forma distinta de habitar tu cuerpo." },
    100: { title: "100 días, 100 razones", body: "Eres parte del 3% que lleva esto hasta el final. Estás escribiendo una historia distinta para tu cuerpo y tu mente. Gracias por confiar en el método. Esto es NeoRejuvenation de verdad." }
  },
  en: {
    7: { title: "7 days of consistency", body: "This is the first barrier. Your body is starting to register the changes in your vitamin C and cortisol levels. Keep going — the next few weeks are the ones that make the difference." },
    14: { title: "14 days on the path", body: "Two weeks of consistency. Your liver is already noticing the effect of Reishi, cellular regeneration is truly activating. This is no longer just a habit, it's chemistry." },
    30: { title: "A full month", body: "You've crossed the barrier most people don't. 80% of people give up before day 30. You didn't. The changes coming now are the ones that stay." },
    60: { title: "60 days of regeneration", body: "Two months. Your skin, your energy and your immune system are entering a new phase. This is no longer an experiment, it's a different way of inhabiting your body." },
    100: { title: "100 days, 100 reasons", body: "You're part of the 3% that takes this all the way. You're writing a different story for your body and mind. Thank you for trusting the method. This is real NeoRejuvenation." }
  },
  fr: {
    7: { title: "7 jours de constance", body: "C'est la première barrière. Votre corps commence à enregistrer les changements dans vos niveaux de vitamine C et de cortisol. Continuez, les prochaines semaines font la différence." },
    14: { title: "14 jours sur le chemin", body: "Deux semaines de constance. Votre foie ressent déjà l'effet du Reishi, la régénération cellulaire s'active vraiment. Ce n'est plus une habitude, c'est de la chimie." },
    30: { title: "Un mois complet", body: "Vous avez franchi la barrière que la plupart ne franchissent pas. 80% abandonnent avant 30 jours. Pas vous. Les changements qui arrivent maintenant sont ceux qui restent." },
    60: { title: "60 jours de régénération", body: "Deux mois. Votre peau, votre énergie et votre système immunitaire entrent dans une nouvelle phase. Ce n'est plus une expérience, c'est une autre façon d'habiter votre corps." },
    100: { title: "100 jours, 100 raisons", body: "Vous faites partie des 3% qui vont jusqu'au bout. Vous écrivez une histoire différente pour votre corps et votre esprit. Merci de faire confiance à la méthode." }
  },
  de: {
    7: { title: "7 Tage Konstanz", body: "Das ist die erste Hürde. Ihr Körper beginnt, die Veränderungen in Ihrem Vitamin-C- und Cortisolspiegel zu registrieren. Machen Sie weiter — die nächsten Wochen machen den Unterschied." },
    14: { title: "14 Tage auf dem Weg", body: "Zwei Wochen Konstanz. Ihre Leber spürt bereits die Wirkung des Reishi, die Zellregeneration aktiviert sich wirklich. Das ist keine Gewohnheit mehr, das ist Chemie." },
    30: { title: "Ein ganzer Monat", body: "Sie haben die Hürde überwunden, die die meisten nicht überwinden. 80% geben vor Tag 30 auf. Sie nicht. Die Veränderungen, die jetzt kommen, bleiben." },
    60: { title: "60 Tage Regeneration", body: "Zwei Monate. Ihre Haut, Ihre Energie und Ihr Immunsystem treten in eine neue Phase ein. Das ist kein Experiment mehr, es ist eine andere Art, Ihren Körper zu bewohnen." },
    100: { title: "100 Tage, 100 Gründe", body: "Sie gehören zu den 3%, die das bis zum Ende durchziehen. Sie schreiben eine andere Geschichte für Ihren Körper und Geist. Danke, dass Sie der Methode vertrauen." }
  },
  pt: {
    7: { title: "7 dias de constância", body: "Esta é a primeira barreira. Seu corpo começa a registrar as mudanças nos níveis de vitamina C e cortisol. Continue, as próximas semanas são as que fazem a diferença." },
    14: { title: "14 dias no caminho", body: "Duas semanas de constância. Seu fígado já está sentindo o efeito do Reishi, a regeneração celular está se ativando de verdade. Isto já não é um hábito, é química." },
    30: { title: "Um mês completo", body: "Você cruzou a barreira que a maioria não cruza. 80% desiste antes dos 30 dias. Você não. As mudanças que vêm agora são as que permanecem." },
    60: { title: "60 dias de regeneração", body: "Dois meses. Sua pele, sua energia e seu sistema imunológico estão entrando em uma nova fase. Isto já não é um experimento, é uma forma diferente de habitar seu corpo." },
    100: { title: "100 dias, 100 razões", body: "Você faz parte dos 3% que levam isto até o fim. Está escrevendo uma história diferente para seu corpo e sua mente. Obrigado por confiar no método." }
  },
  it: {
    7: { title: "7 giorni di costanza", body: "Questa è la prima barriera. Il tuo corpo inizia a registrare i cambiamenti nei livelli di vitamina C e cortisolo. Continua — le prossime settimane fanno la differenza." },
    14: { title: "14 giorni sulla strada", body: "Due settimane di costanza. Il tuo fegato sta già notando l'effetto del Reishi, la rigenerazione cellulare si sta attivando davvero. Non è più un'abitudine, è chimica." },
    30: { title: "Un mese intero", body: "Hai superato la barriera che la maggior parte non supera. L'80% abbandona prima dei 30 giorni. Tu no. I cambiamenti che arrivano ora sono quelli che restano." },
    60: { title: "60 giorni di rigenerazione", body: "Due mesi. La tua pelle, la tua energia e il tuo sistema immunitario stanno entrando in una nuova fase. Non è più un esperimento, è un modo diverso di abitare il tuo corpo." },
    100: { title: "100 giorni, 100 ragioni", body: "Fai parte del 3% che porta questo fino in fondo. Stai scrivendo una storia diversa per il tuo corpo e la tua mente. Grazie per aver creduto nel metodo." }
  },
  ea: {
    7: { title: "7 أيام من الالتزام", body: "هذا هو الحاجز الأول. جسدك يبدأ في تسجيل التغييرات في مستويات فيتامين C والكورتيزول. استمر، فالأسابيع القادمة هي التي تصنع الفرق." },
    14: { title: "14 يومًا على الطريق", body: "أسبوعان من الالتزام. كبدك يشعر فعلاً بتأثير الريشي، وتجديد الخلايا يتنشط بشكل حقيقي. هذه لم تعد عادة، بل كيمياء." },
    30: { title: "شهر كامل", body: "لقد عبرت الحاجز الذي لا يعبره الأغلبية. 80% من الناس يستسلمون قبل اليوم الثلاثين. أنت لم تستسلم. التغييرات القادمة الآن هي التي تبقى." },
    60: { title: "60 يومًا من التجديد", body: "شهران. بشرتك وطاقتك وجهازك المناعي يدخلون مرحلة جديدة. هذه لم تعد تجربة، بل طريقة مختلفة لتسكن جسدك." },
    100: { title: "100 يوم، 100 سبب", body: "أنت جزء من الـ 3% الذين يذهبون إلى النهاية. أنت تكتب قصة مختلفة لجسدك وعقلك. شكرًا لثقتك بالمنهج. هذا هو NeoRejuvenation الحقيقي." }
  }
};

const MILESTONES = [7, 14, 30, 60, 100];

/* ───────────────── PROMPT ───────────────── */
const buildPrompt = (lang) => {
  const ln = {es:"Spanish",en:"English",fr:"French",de:"German",pt:"Portuguese",it:"Italian",ea:"Arabic"}[lang]||"English";
  const native = {es:"español",en:"English",fr:"français",de:"Deutsch",pt:"português",it:"italiano",ea:"العربية"}[lang]||"English";
  return `You are NeoRejuvenation assistant by Antonio Moll.

⚠️ CRITICAL LANGUAGE REQUIREMENT ⚠️
You MUST respond EXCLUSIVELY in ${ln} (${native}). Every single text field — name, dose, brand, benefits, notes, personalMessage, warnings — MUST be written in ${ln}. DO NOT use English for any field unless ${ln} IS English. If you write any text in a language other than ${ln}, the response is invalid.

FUNDAMENTAL: Vitamin C (morning+night, SOLARAY 1000mg Retard), Reishi (morning+night with food, Kinoko 1500mg — CONTRAINDICATED: anticoagulants/autoimmune/surgery).
OPTIONAL: Hyaluronic Acid (night, Solgar), Resveratrol (morning, Solgar/Revidox), Cordyceps (night — CONTRA: pregnancy/antipsychotics/anticoagulants), Shiitake+Maitake (morning), SOD (morning, Douglas), Milk Thistle (morning, Soria Natural), Omega-3 (night, Lamberts), Pomegranate 2-3x/wk (Keriba), Collagen+Mg every 2-3 days (Ana Maria Lajusticia), Horsetail+B (morning, Redenhair — CONTRA: pregnancy/antiretrovirals).
RULES: VitC+Reishi mandatory unless contraindicated. Min 3 max 8. Respect all contraindications.

Respond ONLY with valid JSON (no markdown, no explanations): {"routine":{"morning":[{"id":"string","name":"string in ${ln}","dose":"string in ${ln}","brand":"string","benefits":["string in ${ln}"],"notes":"string in ${ln}","frequency":"daily|alternate|2-3weekly"}],"afternoon":[],"night":[]},"personalMessage":"string in ${ln}","warnings":["string in ${ln}"]}

REMINDER: ALL text fields must be in ${ln} (${native}). Product brand names (SOLARAY, Kinoko, Solgar, etc.) stay as-is. Everything else in ${ln}.`;
};

/* ───────────────── LIGHT THEME COLORS ───────────────── */
const C = {
  bg: "#ffffff",
  bgSoft: "#f7f8fb",
  surface: "#ffffff",
  surfaceDone: "#fafbfd",
  border: "#eef0f6",
  borderStrong: "#e4e7ef",
  text: "#1a2240",
  textDim: "#4a5578",
  textMuted: "#8590aa",
  textGhost: "#b5bdd0",
  brand1: "#0f6e56",
  brand2: "#5DCAA5",
  brandGrad: "linear-gradient(135deg,#0f6e56,#5DCAA5)",
  morning: { bg: "#fff6ec", border: "#fae2c4", text: "#854f0b", icon: "#b7791f" },
  afternoon: { bg: "#fdeee6", border: "#f6d3c2", text: "#993c1d", icon: "#c25420" },
  night: { bg: "#eeedfe", border: "#d8d5f2", text: "#3c3489", icon: "#534ab7" },
  success: "#0f6e56",
  successBg: "#e1f5ee",
  warning: "#854f0b",
  warningBg: "#fff6ec",
};

/* ───────────────── FONT + GLOBAL STYLES ───────────────── */
const injectFonts = () => {
  if (document.getElementById("neo-fonts")) return;
  const l = document.createElement("link");
  l.id = "neo-fonts"; l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Almarai:wght@400;700&display=swap";
  document.head.appendChild(l);
  const s = document.createElement("style");
  s.textContent = `*{box-sizing:border-box;margin:0;padding:0}body{background:${C.bg};font-feature-settings:"cv11","ss01","ss03";-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.nr-tnum{font-variant-numeric:tabular-nums}.nr-mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-feature-settings:"zero","ss01"}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#d6dbe8;border-radius:2px}@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes breathe{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.05);opacity:1}}@keyframes checkPop{0%{transform:scale(0)}60%{transform:scale(1.2)}100%{transform:scale(1)}}@keyframes modalIn{from{opacity:0;transform:translateY(20px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes d1{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}@keyframes d2{0%,20%,80%,100%{transform:scale(0)}60%{transform:scale(1)}}@keyframes d3{0%,40%,100%{transform:scale(0)}80%{transform:scale(1.2)}}@keyframes orbRing{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.7);opacity:0}}@keyframes orbBreathe{0%,100%{transform:scale(1);opacity:.95}50%{transform:scale(1.06);opacity:1}}`;
  document.head.appendChild(s);
};

/* ───────────────── CONFETTI (CDN, lazy-loaded) ───────────────── */
const fireConfetti = () => {
  const fire = () => {
    if (!window.confetti) return;
    window.confetti({
      particleCount: 90, spread: 75, origin: { y: 0.6 },
      colors: ["#0f6e56", "#5DCAA5", "#7ed9b8", "#ffd700", "#ffffff"],
      zIndex: 9999
    });
    setTimeout(() => window.confetti({ particleCount: 50, angle: 60, spread: 55, origin: { x: 0, y: 0.7 }, colors: ["#0f6e56", "#5DCAA5"] }), 250);
    setTimeout(() => window.confetti({ particleCount: 50, angle: 120, spread: 55, origin: { x: 1, y: 0.7 }, colors: ["#5DCAA5", "#7ed9b8"] }), 400);
  };
  if (window.confetti) { fire(); return; }
  if (document.getElementById("neo-confetti-lib")) { setTimeout(fire, 300); return; }
  const s = document.createElement("script");
  s.id = "neo-confetti-lib";
  s.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js";
  s.onload = fire;
  document.head.appendChild(s);
};

/* ───────────────── HAPTIC FEEDBACK ───────────────── */
const haptic = (ms = 10) => {
  try { if ("vibrate" in navigator) navigator.vibrate(ms); } catch {}
};

/* ───────────────── SVG ICONS ───────────────── */
const Icon = {
  sun: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>,
  sunHigh: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
  moon: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  flame: (s = 14) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>,
  check: (s = 12) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  chevLeft: (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>,
  chevRight: (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
  close: (s = 18) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  bell: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  refresh: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
};

const SectionIcon = ({ period, size = 16 }) => {
  if (period === "morning") return Icon.sun(size);
  if (period === "afternoon") return Icon.sunHigh(size);
  return Icon.moon(size);
};

/* ───────────────── GOAL CATEGORY ICONS (line-art SVG) ───────────────── */
const GOAL_ICON = {
  antiaging: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><circle cx="12" cy="12" r="1.5"/></svg>,
  energy: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  immune: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  brain: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/></svg>,
  skin: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"/></svg>,
  hair: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7c2 2 4 2 6 0s4-2 6 0 4 2 6 0"/><path d="M3 12c2 2 4 2 6 0s4-2 6 0 4 2 6 0"/><path d="M3 17c2 2 4 2 6 0s4-2 6 0 4 2 6 0"/></svg>,
  cardiovascular: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>,
  detox: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/></svg>,
  joints: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c.28 0 .5.22.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5Z"/></svg>,
  stress: (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
};

/* ───────────────── BRAND ORB (favicon with breathing rings) ───────────────── */
const NR_FAVICON_URL = "https://media.neorejuvenation.app/2026/03/cropped-NR-favicon-1.png";

function BrandOrb({ size = 84, variant = "brand" }) {
  const [imgFailed, setImgFailed] = useState(false);

  const isSuccess = variant === "success";
  // brand → rings azules (cyan + azul) | success → rings verdes (teal + verde)
  const ringA = isSuccess ? "#0f6e56" : "#1abfe8";
  const ringB = isSuccess ? "#5DCAA5" : "#5b7fd4";

  // El wrapper es 1.5× el tamaño del logo → deja aire para los rings
  // sin tener que cambiar los `size` que se pasan desde fuera.
  const wrapperSize = Math.round(size * 1.5);

  const ringStyle = (delay, color) => ({
    position: "absolute", inset: 0, borderRadius: "50%",
    border: `2px solid ${color}`,
    animation: `orbRing 2.6s ease-out infinite ${delay}s`,
    pointerEvents: "none"
  });

  const centerCommon = {
    width: size, height: size, borderRadius: "50%",
    position: "relative", zIndex: 2,
    animation: "orbBreathe 2.8s ease-in-out infinite"
  };

  const checkSize = Math.round(size * 0.5);

  return (
    <div style={{ position: "relative", width: wrapperSize, height: wrapperSize, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <div style={ringStyle(0, ringA)} />
      <div style={ringStyle(0.9, ringB)} />
      <div style={ringStyle(1.8, ringA)} />
      {isSuccess ? (
        <div style={{
          ...centerCommon,
          background: "linear-gradient(135deg,#0f6e56,#5DCAA5)",
          display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <svg width={checkSize} height={checkSize} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
      ) : imgFailed ? (
        <div style={{ ...centerCommon, background: C.brandGrad }} />
      ) : (
        <img
          src={NR_FAVICON_URL}
          alt="NeoRejuvenation"
          onError={() => setImgFailed(true)}
          style={{ ...centerCommon, objectFit: "contain", background: "transparent" }}
        />
      )}
    </div>
  );
}

/* ───────────────── SPARKLINE ───────────────── */
function Sparkline({ history, days = 30, width = 70, height = 22 }) {
  const points = useMemo(() => {
    const arr = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const k = d.toISOString().slice(0, 10);
      arr.push(history[k]?.completionRate ?? 0);
    }
    return arr;
  }, [history, days]);

  const step = width / (days - 1);
  const pad = 2;
  const h = height - pad * 2;
  const path = points.map((p, i) => `${(i * step).toFixed(1)},${(pad + h - p * h).toFixed(1)}`).join(" ");
  const gradId = "spark-grad-" + days;

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor={C.brand1} />
          <stop offset="100%" stopColor={C.brand2} />
        </linearGradient>
      </defs>
      <polyline points={path} fill="none" stroke={`url(#${gradId})`} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ───────────────── RING ───────────────── */
const Ring = ({ pct, size = 72, stroke = 6, showLabel = true }) => {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const gradId = "ring-grad-" + size;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={C.brand1} />
            <stop offset="100%" stopColor={C.brand2} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={C.border} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${gradId})`} strokeWidth={stroke} strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" style={{ transition: "stroke-dasharray 0.6s" }} />
      </svg>
      {showLabel && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: size * 0.27, color: C.text, lineHeight: 1 }}>
            {Math.round(pct)}<span style={{ fontSize: size * 0.16 }}>%</span>
          </div>
        </div>
      )}
    </div>
  );
};

/* ───────────────── SUPPLEMENT CARD ───────────────── */
function SuppCard({ supp, checked, onToggle, compact, t, readOnly }) {
  const [exp, setExp] = useState(false);

  // Cuando activamos modo compacto, colapsar la card automáticamente.
  // Evita que cards previamente expandidas sigan abiertas tras cambiar el toggle.
  useEffect(() => {
    if (compact) setExp(false);
  }, [compact]);

  const showExpanded = !compact || exp;
  const hasNotes = !!supp.notes;

  return (
    <div
      onClick={() => { if (readOnly) return; onToggle(supp.id); }}
      style={{
        background: checked ? C.surfaceDone : C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        padding: compact ? "10px 12px" : "13px 14px",
        marginBottom: 8,
        cursor: readOnly ? "default" : "pointer",
        transition: "all 0.2s",
        animation: "fadeUp 0.25s",
        opacity: readOnly ? 0.75 : 1
      }}
    >
      <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%", flexShrink: 0, marginTop: 1,
          border: checked ? "none" : `1.5px solid ${C.borderStrong}`,
          background: checked ? C.brandGrad : C.surface,
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.2s",
          animation: checked ? "checkPop 0.3s" : "none"
        }}>
          {checked && Icon.check(12)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            <span style={{
              fontFamily: "Oswald,sans-serif",
              fontWeight: 600,
              fontSize: 13,
              color: checked ? C.textMuted : C.text,
              textDecoration: checked ? "line-through" : "none"
            }}>{supp.name}</span>
            <span style={{
              fontSize: 11,
              color: checked ? C.textGhost : C.textMuted,
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontFeatureSettings: '"zero", "ss01"',
              letterSpacing: "-0.01em"
            }}>{supp.dose}</span>
            {supp.frequency && supp.frequency !== "daily" && (
              <span style={{
                fontSize: 9, padding: "2px 7px", borderRadius: 20,
                background: C.night.bg, color: C.night.text, fontWeight: 500, marginLeft: "auto"
              }}>
                {supp.frequency === "alternate" ? t.freq_alternate : t.freq_weekly}
              </span>
            )}
          </div>
          {showExpanded && (
            <div style={{
              fontSize: 10, color: checked ? C.textGhost : C.textMuted, marginTop: 4, lineHeight: 1.4,
              textDecoration: checked ? "line-through" : "none"
            }}>
              {supp.brand}
              {supp.benefits && supp.benefits.length > 0 && <> · {supp.benefits.join(" · ")}</>}
            </div>
          )}
          {/* Botón "Más info" visible siempre si hay notas, incluso en modo compacto */}
          {hasNotes && (
            <div style={{ marginTop: compact && !exp ? 4 : 6 }}>
              <button
                onClick={e => { e.stopPropagation(); setExp(v => !v); }}
                style={{
                  background: "none", border: "none", color: C.textMuted,
                  fontSize: 10, cursor: "pointer", padding: 0, textDecoration: "underline"
                }}
              >
                {exp ? t.hide_info : t.more_info}
              </button>
            </div>
          )}
          {hasNotes && exp && (
            <div style={{ marginTop: 6, padding: "8px 10px", background: C.bgSoft, borderRadius: 8, fontSize: 11, color: C.textDim, lineHeight: 1.55 }}>
              {supp.notes}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ───────────────── PERIOD SECTION ───────────────── */
function PeriodSection({ period, supplements, checks, onToggle, onMarkAll, compact, t, readOnly, isLast }) {
  const tone = C[period];
  if (!supplements.length) return null;
  const done = supplements.filter(s => checks[s.id]).length;
  const total = supplements.length;
  const allDone = done === total;
  const handleHeaderClick = () => {
    if (readOnly) return;
    onMarkAll(period, !allDone);
  };
  return (
    <div style={{ marginBottom: isLast ? 0 : 22 }}>
      <div
        onClick={handleHeaderClick}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: 10, cursor: readOnly ? "default" : "pointer",
          padding: "4px 6px", margin: "-4px -6px 6px", borderRadius: 10,
          transition: "background 0.15s",
          userSelect: "none"
        }}
        onMouseEnter={e => { if (!readOnly) e.currentTarget.style.background = C.bgSoft; }}
        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: tone.bg, color: tone.icon, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <SectionIcon period={period} size={20} />
          </div>
          <div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 18, color: tone.icon, letterSpacing: "0.01em", lineHeight: 1.15 }}>
              {t[period]}
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t[period + "_hint"]}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!readOnly && (
            <span style={{ fontSize: 10, color: C.textMuted, fontFamily: "Inter, sans-serif", fontWeight: 500 }}>
              {allDone ? t.unmark_all : t.mark_all}
            </span>
          )}
          <div style={{ fontSize: 11, color: allDone ? tone.icon : C.textMuted, fontFamily: "Oswald,sans-serif", fontWeight: 600 }}>
            {done} / {total}
          </div>
        </div>
      </div>
      {supplements.map(s => (
        <SuppCard key={s.id} supp={s} checked={!!checks[s.id]} onToggle={onToggle} compact={compact} t={t} readOnly={readOnly} />
      ))}
      {!isLast && <div style={{ height: 1, background: C.border, margin: "22px -20px 0" }} />}
    </div>
  );
}

/* ───────────────── MILESTONE MODAL ───────────────── */
function MilestoneModal({ days, lang, onClose, t }) {
  const msg = (MILESTONE_MSG[lang] || MILESTONE_MSG.es)[days];
  if (!msg) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,22,40,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 200, padding: 20, animation: "fadeIn 0.3s", backdropFilter: "blur(4px)"
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 20, maxWidth: 380, width: "100%",
        padding: "30px 24px 24px", animation: "modalIn 0.4s cubic-bezier(.2,.9,.3,1.2)",
        border: `1px solid ${C.border}`, position: "relative"
      }}>
        <button onClick={onClose} aria-label="Close" style={{
          position: "absolute", top: 14, right: 14, background: "transparent",
          border: "none", color: C.textMuted, cursor: "pointer", padding: 6, borderRadius: 8
        }}>{Icon.close(18)}</button>

        <div style={{
          width: 72, height: 72, borderRadius: "50%",
          background: "linear-gradient(135deg,#fff6ec,#e8f5ef)",
          border: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 18px", color: "#b7791f",
          animation: "breathe 2.5s ease-in-out infinite"
        }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            {Icon.flame(22)}
            <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 18, color: C.brand1, lineHeight: 1 }}>{days}</div>
          </div>
        </div>

        <h3 style={{
          fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 20,
          color: C.text, textAlign: "center", marginBottom: 12
        }}>{msg.title}</h3>

        <p style={{
          fontSize: 13, color: C.textDim, lineHeight: 1.65,
          textAlign: "center", marginBottom: 22, fontStyle: "italic"
        }}>"{msg.body}"</p>

        <div style={{ fontSize: 11, color: C.textMuted, textAlign: "center", marginBottom: 22, letterSpacing: "0.05em" }}>
          — Antonio Moll
        </div>

        <button onClick={onClose} style={{
          width: "100%", padding: 13, borderRadius: 12,
          background: C.brandGrad, border: "none", color: "#fff",
          fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 13,
          letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer"
        }}>
          {t.milestone_cta}
        </button>
      </div>
    </div>
  );
}

/* ───────────────── NOTIFICATION GATE ───────────────── */
function NotificationGate({ lang, onGranted }) {
  const g = NOTIF_GATE[lang] || NOTIF_GATE.es;
  const [state, setState] = useState(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    return Notification.permission;
  });
  const [loading, setLoading] = useState(false);

  const request = async () => {
    if (!("Notification" in window)) return;
    setLoading(true);
    try {
      const p = await Notification.requestPermission();
      setState(p);
      if (p === "granted") {
        haptic(20);
        setTimeout(() => onGranted(), 400);
      }
    } catch {
      setState("denied");
    } finally {
      setLoading(false);
    }
  };

  const recheck = () => {
    if (!("Notification" in window)) return;
    const p = Notification.permission;
    setState(p);
    if (p === "granted") onGranted();
  };

  const isUnsupported = state === "unsupported";
  const isDenied = state === "denied";
  const isDefault = state === "default";

  const iconBg = isDenied ? C.warningBg : "linear-gradient(135deg,#fafefb,#e8f5ef)";
  const iconColor = isDenied ? C.warning : C.brand1;

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "70vh", padding: "20px 16px",
      textAlign: "center", animation: "fadeUp 0.4s"
    }}>
      <div style={{
        width: 88, height: 88, borderRadius: "50%",
        background: iconBg, border: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        marginBottom: 24, color: iconColor,
        animation: isDefault ? "breathe 2.5s ease-in-out infinite" : "none"
      }}>
        <div style={{ transform: "scale(1.8)" }}>{Icon.bell(20)}</div>
      </div>

      <h2 style={{
        fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 22,
        color: C.text, marginBottom: 12, lineHeight: 1.2, maxWidth: 320
      }}>
        {isUnsupported ? g.unsupported_title : isDenied ? g.denied_title : g.title}
      </h2>

      <p style={{
        fontSize: 13, color: C.textDim, lineHeight: 1.65,
        maxWidth: 340, marginBottom: 28
      }}>
        {isUnsupported ? g.unsupported_body : isDenied ? g.denied_body : g.body}
      </p>

      {isDefault && (
        <button onClick={request} disabled={loading} style={{
          padding: "14px 32px", borderRadius: 12,
          background: C.brandGrad, border: "none", color: "#fff",
          fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 13,
          letterSpacing: "0.04em", textTransform: "uppercase",
          cursor: loading ? "wait" : "pointer",
          display: "inline-flex", alignItems: "center", gap: 10,
          opacity: loading ? 0.7 : 1, transition: "opacity 0.2s"
        }}>
          {Icon.bell(15)} {g.btn}
        </button>
      )}

      {isDenied && (
        <button onClick={recheck} style={{
          padding: "14px 28px", borderRadius: 12,
          background: "transparent", border: `1px solid ${C.borderStrong}`,
          color: C.textDim, fontSize: 13, cursor: "pointer",
          fontFamily: "Inter, sans-serif", fontWeight: 500
        }}>
          {g.retry}
        </button>
      )}

      {isUnsupported && (
        <button onClick={onGranted} style={{
          padding: "14px 28px", borderRadius: 12,
          background: "transparent", border: `1px solid ${C.borderStrong}`,
          color: C.textDim, fontSize: 13, cursor: "pointer",
          fontFamily: "Inter, sans-serif", fontWeight: 500
        }}>
          {g.unsupported_continue}
        </button>
      )}
    </div>
  );
}

/* ───────────────── REGEN CONFIRM MODAL ───────────────── */
function RegenConfirmModal({ streak, t, onCancel, onConfirm }) {
  const body = streak > 0
    ? (t.regen_confirm_body || "").replace("{streak}", streak)
    : t.regen_confirm_body_nostreak;
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,22,40,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 200, padding: 20, animation: "fadeIn 0.3s", backdropFilter: "blur(4px)"
    }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 20, maxWidth: 380, width: "100%",
        padding: "28px 24px 22px", animation: "modalIn 0.4s cubic-bezier(.2,.9,.3,1.2)",
        border: `1px solid ${C.border}`
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: "50%",
          background: "#e8f5ef", border: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 18px", color: C.brand1
        }}>
          {Icon.refresh(24)}
        </div>
        <h3 style={{
          fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 19,
          color: C.text, textAlign: "center", marginBottom: 12
        }}>{t.regen_confirm_title}</h3>
        <p style={{
          fontSize: 13, color: C.textDim, lineHeight: 1.6,
          textAlign: "center", marginBottom: 22
        }}>{body}</p>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: 13, borderRadius: 12,
            background: "transparent", border: `1px solid ${C.borderStrong}`,
            color: C.textDim, fontSize: 13, cursor: "pointer",
            fontFamily: "Inter, sans-serif", fontWeight: 500
          }}>{t.regen_cancel_btn}</button>
          <button onClick={onConfirm} style={{
            flex: 1.3, padding: 13, borderRadius: 12,
            background: C.brandGrad, border: "none", color: "#fff",
            fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 13,
            letterSpacing: "0.03em", cursor: "pointer"
          }}>{t.regen_confirm_btn}</button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────── iOS INSTALL PWA MODAL ───────────────── */
function IOSInstallPWAModal({ t, onClose }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(15,22,40,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 200, padding: 20, animation: "fadeIn 0.3s", backdropFilter: "blur(4px)"
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, borderRadius: 20, maxWidth: 400, width: "100%",
        padding: "28px 24px 22px", animation: "modalIn 0.4s cubic-bezier(.2,.9,.3,1.2)",
        border: `1px solid ${C.border}`, position: "relative", maxHeight: "90vh", overflowY: "auto"
      }}>
        <button onClick={onClose} aria-label="Close" style={{
          position: "absolute", top: 14, right: 14, background: "transparent",
          border: "none", color: C.textMuted, cursor: "pointer", padding: 6, borderRadius: 8, zIndex: 1
        }}>{Icon.close(18)}</button>

        <div style={{
          width: 56, height: 56, borderRadius: "50%",
          background: "#e8f5ef", border: `1px solid ${C.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 18px", color: C.brand1
        }}>
          {Icon.bell(24)}
        </div>

        <h3 style={{
          fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 19,
          color: C.text, textAlign: "center", marginBottom: 10, lineHeight: 1.25
        }}>{t.ios_install_title}</h3>

        <p style={{
          fontSize: 13, color: C.textDim, lineHeight: 1.6,
          textAlign: "center", marginBottom: 22
        }}>{t.ios_install_body}</p>

        {/* 3 pasos visuales */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 22 }}>
          {[
            { n: 1, text: t.ios_install_step1, icon: "⬆️" },
            { n: 2, text: t.ios_install_step2, icon: "➕" },
            { n: 3, text: t.ios_install_step3, icon: "🏠" }
          ].map(step => (
            <div key={step.n} style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "12px 14px", background: C.bgSoft,
              borderRadius: 12, border: `1px solid ${C.border}`
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                background: C.brandGrad, color: "#fff",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 13,
                flexShrink: 0
              }}>{step.n}</div>
              <div style={{ flex: 1, fontSize: 12, color: C.textDim, lineHeight: 1.5 }}>
                {step.text}
              </div>
              <div style={{ fontSize: 18, flexShrink: 0 }}>{step.icon}</div>
            </div>
          ))}
        </div>

        <div style={{
          padding: "10px 12px", background: C.warningBg,
          border: `1px solid ${C.morning.border}`, borderRadius: 10,
          fontSize: 11, color: C.warning, lineHeight: 1.5, marginBottom: 18
        }}>
          ⚠️ {t.ios_install_note}
        </div>

        <button onClick={onClose} style={{
          width: "100%", padding: 13, borderRadius: 12,
          background: C.brandGrad, border: "none", color: "#fff",
          fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 13,
          letterSpacing: "0.03em", cursor: "pointer"
        }}>{t.ios_install_cta}</button>
      </div>
    </div>
  );
}

/* ───────────────── ONBOARDING ───────────────── */
function Onboarding({ onComplete, GOALS, CONTRA, t, draft, onDraftChange }) {
  const [step, setStep] = useState(draft?.step || 0);
  const [goals, setGoals] = useState(draft?.goals || []);
  const [conds, setConds] = useState(draft?.conds || []);

  // Persist draft on every change
  useEffect(() => {
    onDraftChange?.({ step, goals, conds });
  }, [step, goals, conds]);

  const MAX_GOALS = 5;
  const tg = id => setGoals(g => {
    if (g.includes(id)) return g.filter(x => x !== id);
    if (g.length >= MAX_GOALS) { haptic(8); return g; }
    return [...g, id];
  });
  const tc = id => {
    if (id === "none") { setConds(["none"]); return; }
    setConds(c => { const n = c.filter(x => x !== "none"); return n.includes(id) ? n.filter(x => x !== id) : [...n, id]; });
  };

  const noneSelected = conds.includes("none");

  const steps = [
    {
      ti: t.step1_title, su: t.step1_sub, ok: goals.length > 0,
      body: (
        <>
          <div style={{
            textAlign: "center", marginBottom: 14,
            fontSize: 12, color: C.textMuted, fontWeight: 600,
            fontFamily: "Oswald,sans-serif", letterSpacing: "0.05em"
          }}>
            <span style={{ color: goals.length >= MAX_GOALS ? "#0f6e56" : C.textMuted }}>
              {goals.length}
            </span>
            {" / "}{MAX_GOALS}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {GOALS.map(g => {
              const sel = goals.includes(g.id);
              const capped = !sel && goals.length >= MAX_GOALS;
              return (
                <div key={g.id} onClick={() => tg(g.id)} style={{
                  padding: "14px 12px", borderRadius: 14,
                  cursor: capped ? "not-allowed" : "pointer",
                  border: `1px solid ${sel ? "#0f6e56" : C.border}`,
                  background: sel ? "#e8f5ef" : C.surface,
                  opacity: capped ? 0.4 : 1,
                  filter: capped ? "grayscale(0.5)" : "none",
                  transition: "all 0.2s"
                }}>
                  <div style={{ marginBottom: 8, color: sel ? "#0f6e56" : C.textDim, display: "flex", alignItems: "center", height: 22 }}>
                    {GOAL_ICON[g.id] ? GOAL_ICON[g.id](22) : null}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: sel ? "#0f6e56" : C.text, lineHeight: 1.3, fontFamily: "Oswald,sans-serif" }}>{g.label}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, lineHeight: 1.4 }}>{g.desc}</div>
                </div>
              );
            })}
          </div>
        </>
      )
    },
    {
      ti: t.step2_title, su: t.step2_sub, ok: conds.length > 0,
      body: (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {CONTRA.map(c => {
            const sel = conds.includes(c.id);
            const color = c.id === "none" ? C.success : C.warning;
            const bgCol = c.id === "none" ? C.successBg : C.warningBg;
            const disabled = noneSelected && c.id !== "none";
            return (
              <div key={c.id} onClick={() => { if (!disabled) tc(c.id); }} style={{
                padding: "13px 14px", borderRadius: 12,
                cursor: disabled ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: 12,
                border: `1px solid ${sel ? color : C.border}`,
                background: sel ? bgCol : C.surface,
                transition: "all 0.25s",
                opacity: disabled ? 0.35 : 1,
                filter: disabled ? "grayscale(0.5)" : "none",
                pointerEvents: disabled ? "none" : "auto"
              }}>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  border: sel ? "none" : `1.5px solid ${C.borderStrong}`,
                  background: sel ? color : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
                }}>
                  {sel && Icon.check(11)}
                </div>
                <span style={{ fontSize: 13, color: sel ? color : C.textDim }}>{c.label}</span>
              </div>
            );
          })}
          {noneSelected && (
            <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginTop: 4, textAlign: "center", lineHeight: 1.5 }}>
              {t.none_excludes}
            </div>
          )}
        </div>
      )
    },
    {
      ti: t.step3_title, su: t.step3_sub, ok: true,
      body: (
        <div style={{ textAlign: "center", padding: "60px 0 20px" }}>
          <div style={{ marginBottom: 36, display: "flex", justifyContent: "center" }}><BrandOrb size={72} /></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", marginBottom: 32 }}>
            {GOALS.filter(g => goals.includes(g.id)).map(g => (
              <span key={g.id} style={{
                fontSize: 11, padding: "5px 12px 5px 10px", borderRadius: 20,
                background: "#e8f5ef", color: C.brand1, border: `1px solid ${C.border}`,
                display: "inline-flex", alignItems: "center", gap: 6
              }}>{GOAL_ICON[g.id] ? GOAL_ICON[g.id](12) : null} {g.label}</span>
            ))}
          </div>
          <div style={{
            padding: "14px", background: C.warningBg, borderRadius: 12,
            border: `1px solid ${C.morning.border}`, fontSize: 12, color: C.warning, lineHeight: 1.6, textAlign: "left"
          }}>⚠️ {t.step3_disclaimer}</div>
        </div>
      )
    }
  ];

  const cur = steps[step];
  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 4px" }}>
      <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 30 }}>
        {steps.map((_, i) => (
          <div key={i} style={{
            height: 3, borderRadius: 2,
            background: i <= step ? C.brandGrad : C.border,
            transition: "all 0.3s", width: i === step ? 24 : 12
          }} />
        ))}
      </div>
      <h2 style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 22, color: C.text, marginBottom: 6 }}>{cur.ti}</h2>
      <p style={{ fontSize: 13, color: C.textMuted, marginBottom: 22, lineHeight: 1.55 }}>{cur.su}</p>
      <div style={{ marginBottom: 26 }}>{cur.body}</div>
      <div style={{ display: "flex", gap: 12 }}>
        {step > 0 && (
          <button onClick={() => setStep(s => s - 1)} style={{
            flex: 1, padding: 14, borderRadius: 12, background: "transparent",
            border: `1px solid ${C.borderStrong}`, color: C.textDim, fontSize: 13, cursor: "pointer"
          }}>{t.btn_back}</button>
        )}
        <button onClick={() => step < 2 ? setStep(s => s + 1) : onComplete(goals, conds)} disabled={!cur.ok} style={{
          flex: 2, padding: 14, borderRadius: 12,
          background: cur.ok ? C.brandGrad : C.border, border: "none",
          color: cur.ok ? "#fff" : C.textMuted, fontSize: 13,
          fontFamily: "Oswald,sans-serif", fontWeight: 600, letterSpacing: "0.03em",
          textTransform: "uppercase", cursor: cur.ok ? "pointer" : "not-allowed"
        }}>
          {step < 2 ? t.btn_continue : t.btn_create}
        </button>
      </div>
    </div>
  );
}

/* ───────────────── GENERATING ───────────────── */
function Generating({ t }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 28, padding: 24, textAlign: "center" }}>
      <BrandOrb size={84} />
      <div>
        <h2 style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 20, color: C.text, marginBottom: 8 }}>{t.gen_title}</h2>
        <p style={{ color: C.textMuted, fontSize: 13, lineHeight: 1.6, maxWidth: 300 }}>{t.gen_sub}</p>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: "#1abfe8", animation: `d${i + 1} 1.4s ease-in-out infinite` }} />
        ))}
      </div>
    </div>
  );
}

/* ───────────────── PROGRESS VIEW ───────────────── */
function ProgressView({ history, streak, record, routine, t }) {
  const last7 = useMemo(() => {
    const arr = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const k = d.toISOString().slice(0, 10);
      arr.push({ k, label: t.day_names[d.getDay()], rate: history[k]?.completionRate ?? null, isToday: i === 0 });
    }
    return arr;
  }, [history, t]);

  const validRates = last7.filter(d => d.rate !== null);
  const avg = validRates.length ? validRates.reduce((s, d) => s + d.rate, 0) / validRates.length : 0;

  const barColor = (r) => {
    if (r === null) return C.border;
    if (r >= 1) return C.brandGrad;
    if (r >= 0.5) return "#b8e0cf";
    return "#eef0f6";
  };

  return (
    <div style={{ animation: "fadeUp 0.3s" }}>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 4 }}>{t.progress_sub}</div>
        <h2 style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 22, color: C.text, lineHeight: 1.15 }}>{t.progress_title}</h2>
      </div>

      {/* Streak hero card with sparkline */}
      <div style={{
        padding: 18, border: `1px solid ${C.border}`, borderRadius: 16,
        marginBottom: 14, background: "linear-gradient(135deg,#fafefb,#e8f5ef)"
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: C.morning.icon, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 500, marginBottom: 6 }}>
              {Icon.flame(12)} {t.streak_card_label}
            </div>
            <div style={{
              fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 42, lineHeight: 1,
              background: C.brandGrad, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text"
            }}>{streak}</div>
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{t.streak_days}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 500 }}>{t.record_label}</div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 20, color: C.text, marginTop: 2 }}>{record}</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 8 }}>{t.record_days}</div>
            <Sparkline history={history} days={30} width={70} height={22} />
          </div>
        </div>
      </div>

      {/* 7-day bars */}
      <div style={{ padding: "18px 16px", border: `1px solid ${C.border}`, borderRadius: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500 }}>{t.last7}</div>
          <div style={{ fontSize: 11, color: C.textMuted }}>
            {t.weekly_avg} <strong style={{ color: C.text }}>{Math.round(avg * 100)}%</strong>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", height: 60 }}>
          {last7.map(d => {
            const r = d.rate ?? 0;
            const h = d.rate !== null ? Math.max(r * 100, 6) : 6;
            return (
              <div key={d.k} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%" }}>
                <div style={{ flex: 1, width: "100%", display: "flex", alignItems: "flex-end" }}>
                  <div style={{
                    width: "100%", height: `${h}%`, borderRadius: 5,
                    background: barColor(d.rate),
                    transition: "height 0.6s"
                  }} />
                </div>
                <span style={{ fontSize: 10, color: d.isToday ? C.brand1 : C.textMuted, fontWeight: d.isToday ? 600 : 400 }}>{d.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Routine summary */}
      <div style={{ padding: "18px 16px", border: `1px solid ${C.border}`, borderRadius: 16 }}>
        <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 14 }}>{t.routine_title}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {["morning", "afternoon", "night"].map((p, i, arr) => (
            <div key={p}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 28, height: 28, borderRadius: 9, background: C[p].bg, color: C[p].icon, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <SectionIcon period={p} size={14} />
                </div>
                <div style={{ flex: 1, fontSize: 12, color: C.text }}>{t[p]}</div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 14, color: C.text }}>{routine?.[p]?.length || 0}</div>
              </div>
              {i < arr.length - 1 && <div style={{ height: 1, background: C.border, marginTop: 10 }} />}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.textMuted, textAlign: "center" }}>
          <strong style={{ color: C.text }}>
            {(routine?.morning?.length || 0) + (routine?.afternoon?.length || 0) + (routine?.night?.length || 0)}
          </strong> {t.total_supps}
        </div>
      </div>
    </div>
  );
}

/* ───────────────── SETTINGS VIEW ───────────────── */
function SettingsView({ rems, onRem, onNotif, notifOk, onRegen, routine, compactManual, onCompactToggle, t, onPushTest }) {
  const ps = [
    { id: "morning", c: C.morning },
    { id: "afternoon", c: C.afternoon },
    { id: "night", c: C.night }
  ];
  return (
    <div style={{ animation: "fadeUp 0.3s" }}>
      <h2 style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 22, color: C.text, marginBottom: 22 }}>{t.settings_title}</h2>

      {/* Reminders */}
      <div style={{ padding: 18, border: `1px solid ${C.border}`, borderRadius: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>
          {Icon.bell(12)} {t.reminders_title}
        </div>
        {!notifOk && (
          <button onClick={onNotif} style={{
            width: "100%", padding: 12, borderRadius: 12,
            background: "#e8f5ef", border: `1px solid ${C.border}`,
            color: C.brand1, fontSize: 13, cursor: "pointer", marginBottom: 14, fontWeight: 500
          }}>{t.notif_btn}</button>
        )}
        {notifOk && (
          <>
            <div style={{ padding: "8px 12px", background: C.successBg, borderRadius: 10, marginBottom: 10, fontSize: 12, color: C.success }}>
              ✓ {t.notif_granted}
            </div>
            <button onClick={onPushTest} style={{
              width: "100%", padding: 10, borderRadius: 10,
              background: "transparent", border: `1px solid ${C.border}`,
              color: C.textDim, fontSize: 12, cursor: "pointer", marginBottom: 14, fontWeight: 500,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6
            }}>
              {Icon.bell(12)} {t.push_test_btn}
            </button>
          </>
        )}
        {ps.map(p => {
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 0", borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 26, height: 26, borderRadius: 8, background: p.c.bg, color: p.c.icon, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <SectionIcon period={p.id} size={13} />
                </div>
                <span style={{ fontSize: 13, color: C.text }}>{t[p.id]}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="time" value={rems[p.id]?.time || "08:00"} onChange={e => onRem(p.id, "time", e.target.value)} style={{
                  background: C.bgSoft, border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: "6px 10px", color: C.text, fontSize: 12,
                  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                  fontFeatureSettings: '"zero", "ss01"'
                }} />
                <div onClick={() => onRem(p.id, "enabled", !rems[p.id]?.enabled)} style={{
                  width: 38, height: 22, borderRadius: 11,
                  background: rems[p.id]?.enabled ? C.brandGrad : C.borderStrong,
                  position: "relative", cursor: "pointer", transition: "background 0.2s"
                }}>
                  <div style={{
                    width: 18, height: 18, borderRadius: "50%", background: "#fff",
                    position: "absolute", top: 2, left: rems[p.id]?.enabled ? 18 : 2,
                    transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)"
                  }} />
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ marginTop: 12, fontSize: 11, color: C.textMuted, lineHeight: 1.5 }}>{t.notif_hint}</div>
      </div>

      {/* Display */}
      <div style={{ padding: 18, border: `1px solid ${C.border}`, borderRadius: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ flex: 1, paddingRight: 12 }}>
            <div style={{ fontSize: 13, color: C.text, fontWeight: 500, marginBottom: 3 }}>{t.compact_label}</div>
            <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.45 }}>{t.compact_hint}</div>
          </div>
          <div onClick={() => onCompactToggle(!compactManual)} style={{
            width: 38, height: 22, borderRadius: 11,
            background: compactManual ? C.brandGrad : C.borderStrong,
            position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: "50%", background: "#fff",
              position: "absolute", top: 2, left: compactManual ? 18 : 2,
              transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)"
            }} />
          </div>
        </div>
      </div>

      {/* Regenerate */}
      <div style={{ padding: 18, border: `1px solid ${C.border}`, borderRadius: 16 }}>
        <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 12 }}>{t.routine_section}</div>
        <p style={{ fontSize: 12, color: C.textDim, marginBottom: 14, lineHeight: 1.55 }}>{t.regenerate_hint}</p>
        <button onClick={onRegen} style={{
          width: "100%", padding: 12, borderRadius: 12,
          background: "transparent", border: `1px solid ${C.night.border}`,
          color: C.night.icon, fontSize: 13, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8
        }}>
          {Icon.refresh(14)} {t.regenerate_btn}
        </button>
      </div>
    </div>
  );
}

/* ───────────────── MAIN APP ───────────────── */
export default function App() {
  const [lang] = useState(() => detectLang());
  const t = { ...(T[lang] || T.es), ...(EXTRA_T[lang] || EXTRA_T.es) };
  const GOALS = GOALS_I18N[lang] || GOALS_I18N.es;
  const CONTRA = CONTRA_I18N[lang] || CONTRA_I18N.es;

  const [appState, setAppState] = useState("loading");
  const [view, setView] = useState("today");
  const [profile, setProfile] = useState(null);
  const [routine, setRoutine] = useState(null);
  const [checks, setChecks] = useState({});
  const [history, setHistory] = useState({});
  const [streak, setStreak] = useState(0);
  const [record, setRecord] = useState(0);
 const [rems, setRems] = useState({
    morning: { time: "08:00", enabled: true },
    afternoon: { time: "14:00", enabled: false },
    night: { time: "21:00", enabled: true },
    tz: (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC") || "UTC"
  });
  const [notif, setNotif] = useState(false);
  const [notifState, setNotifState] = useState("default"); // "default" | "granted" | "denied" | "unsupported"
  const [notifBypassed, setNotifBypassed] = useState(false); // for unsupported browsers
  const [aiMsg, setAiMsg] = useState(null);
  const [warns, setWarns] = useState([]);
  const [toast, setToast] = useState(null);
  const [viewDate, setViewDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [compactManual, setCompactManual] = useState(null);
  const [milestone, setMilestone] = useState(null);
  const [shownMilestones, setShownMilestones] = useState([]);
  const [onboardingDraft, setOnboardingDraft] = useState(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [showIOSInstall, setShowIOSInstall] = useState(false);
  const [showRoutineInfo, setShowRoutineInfo] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const isToday = viewDate === today;
  const reminderRef = useRef(null);
  const completedRef = useRef(false);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);

  useEffect(() => {
    injectFonts();

    // Registrar service worker para cachear assets del bundle.
    // Solo en producción (no en dev local de Vite) y solo si el navegador lo soporta.
    if ('serviceWorker' in navigator && window.location.hostname !== 'localhost') {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => {
          // Silent fail — la app funciona perfecto sin SW, solo pierde el caching
          if (window.console) console.warn('[nr-tracker] SW register failed:', err);
        });
    }
  }, []);

/* Check notification permission on load */
  useEffect(() => {
    if (typeof window === "undefined") return;

    // PASO 1: Detectar iframe ANTES de mirar Notification API.
    // Si estamos embebidos en WordPress (o cualquier parent cross-origin),
    // bypaseamos el gate incondicionalmente. Esto cubre tanto navegadores
    // que soportan Notification pero la bloquean en iframes, como iPhone
    // Safari donde Notification ni siquiera existe fuera de PWA.
    // Las push reales llegarán vía OneSignal desde el dominio padre (Fase 5).
    let inIframe = false;
    try {
      inIframe = window.parent !== window;
    } catch {
      // cross-origin access error = estamos en un iframe foráneo
      inIframe = true;
    }

    if (inIframe) {
      setNotifBypassed(true);
      // Aun así, si Notification existe, reflejamos el estado real
      // por si en algún momento queremos mostrarlo en Ajustes.
      if ("Notification" in window) {
        setNotifState(Notification.permission);
        setNotif(Notification.permission === "granted");
      } else {
        setNotifState("unsupported");
      }
      return;
    }

    // PASO 2: Standalone (no iframe). Aquí sí importa el soporte real.
    if (!("Notification" in window)) {
      setNotifState("unsupported");
      return;
    }
    setNotifState(Notification.permission);
    setNotif(Notification.permission === "granted");
  }, []);

  /* Load persisted state — hidratación local inmediata + pull del bridge en background */
  useEffect(() => {
    (async () => {
      setHydrating(true);
      try {
        // 1. Hidratación local inmediata (la app arranca al instante)
        const [pR, rR, hR, cR, remR, mR, cmR, odR] = await Promise.all([
          "neo-profile", "neo-routine", "neo-history", `neo-checks-${today}`,
          "neo-reminders", "neo-milestones-shown", "neo-compact-manual", "neo-onboarding-draft"
        ].map(k => storage.get(k)));

        const localProfile = pR ? JSON.parse(pR.value) : null;
        const localRoutineWrap = rR ? JSON.parse(rR.value) : null;
        const localHistory = hR ? JSON.parse(hR.value) : {};

        if (localProfile) setProfile(localProfile);
        if (localRoutineWrap) {
          setRoutine(localRoutineWrap.routine);
          setAiMsg(localRoutineWrap.personalMessage);
          setWarns(localRoutineWrap.warnings || []);
        }
        if (localHistory && Object.keys(localHistory).length) setHistory(localHistory);
        if (cR) setChecks(JSON.parse(cR.value));
        if (remR) {
          const parsedRems = JSON.parse(remR.value);
          const currentTz = (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC") || "UTC";
          if (parsedRems.tz !== currentTz) {
            parsedRems.tz = currentTz;
            setRems(parsedRems);
            storage.set("neo-reminders", JSON.stringify(parsedRems));
          } else {
            setRems(parsedRems);
          }
        }
        if (mR) setShownMilestones(JSON.parse(mR.value));
        if (cmR) setCompactManual(JSON.parse(cmR.value));
        if (odR) setOnboardingDraft(JSON.parse(odR.value));

        setAppState((localProfile && localRoutineWrap) ? "dashboard" : "onboarding");

        // 2. Handshake con el bridge (2s timeout). Si no hay parent WordPress,
        //    salimos del modo hydrating y operamos local-only.
        const bridgeOk = await bridge.handshake();
        if (!bridgeOk) {
          setHydrating(false);
          return;
        }

        // 3. Pull del servidor. Si el servidor tiene algo más nuevo, lo aplicamos
        //    al estado React y al localStorage; si local es más nuevo, queda en
        //    __nrSyncPending para flushear.
        const remote = await pullServerState();

        if (remote) {
          const localProfileTs = getLocalTs("neo-profile");
          const localRoutineTs = getLocalTs("neo-routine");
          const localHistoryTs = getLocalTs("neo-history");

          // profile
          if (remote.profile_ts > localProfileTs && remote.profile) {
            try { localStorage.setItem("neo-profile", JSON.stringify(remote.profile)); } catch {}
            try { localStorage.setItem("neo-profile-ts", String(remote.profile_ts)); } catch {}
            setProfile(remote.profile);
            if (!localRoutineWrap && remote.routine) setAppState("dashboard");
          } else if (localProfileTs > remote.profile_ts && localProfile) {
            __nrSyncPending.profile = localProfile;
            __nrSyncPending.profile_ts = localProfileTs;
          }

          // routine
          if (remote.routine_ts > localRoutineTs && remote.routine) {
            try { localStorage.setItem("neo-routine", JSON.stringify(remote.routine)); } catch {}
            try { localStorage.setItem("neo-routine-ts", String(remote.routine_ts)); } catch {}
            const rw = remote.routine;
            setRoutine(rw.routine || null);
            setAiMsg(rw.personalMessage || null);
            setWarns(rw.warnings || []);
            if (rw.routine) setAppState("dashboard");
          } else if (localRoutineTs > remote.routine_ts && localRoutineWrap) {
            __nrSyncPending.routine = localRoutineWrap;
            __nrSyncPending.routine_ts = localRoutineTs;
          }

          // history
          if (remote.history_ts > localHistoryTs && remote.history) {
            try { localStorage.setItem("neo-history", JSON.stringify(remote.history)); } catch {}
            try { localStorage.setItem("neo-history-ts", String(remote.history_ts)); } catch {}
            setHistory(remote.history);
          } else if (localHistoryTs > remote.history_ts && localHistory && Object.keys(localHistory).length) {
            __nrSyncPending.history = localHistory;
            __nrSyncPending.history_ts = localHistoryTs;
          }
        }
      } catch {
        // Si algo falla, al menos la app ya está hidratada localmente
      } finally {
        // 4. Salir del modo hidratación y flushear lo pendiente
        setHydrating(false);
        flushHydrationQueue();
      }
    })();
  }, []);

  /* Calculate streak + record with "1 grace day per week" rule */
  useEffect(() => {
    const n = new Date();

    // Current streak walking backward with grace logic
    let s = 0;
    let gracesUsed = 0;
    for (let i = 0; i < 365; i++) {
      const d = new Date(n);
      d.setDate(d.getDate() - i);
      const k = d.toISOString().slice(0, 10);
      const done = history[k]?.completedOnce || (history[k]?.completionRate >= 0.5);
      if (done) {
        s++;
      } else {
        // Grace allowance: 1 base + 1 per every 7 consecutive done days so far
        const gracesAllowed = 1 + Math.floor(s / 7);
        if (gracesUsed < gracesAllowed && s > 0) {
          gracesUsed++;
          // Grace day doesn't increment streak but doesn't break it either
        } else {
          break;
        }
      }
    }
    setStreak(s);

    // Compute longest streak (record) over full history with same grace rule
    const keys = Object.keys(history).sort();
    let longest = 0;
    if (keys.length) {
      const first = new Date(keys[0]);
      const last = new Date();
      let run = 0, graces = 0;
      for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
        const k = d.toISOString().slice(0, 10);
        const done = history[k]?.completedOnce || (history[k]?.completionRate >= 0.5);
        if (done) {
          run++;
          longest = Math.max(longest, run);
        } else {
          const gracesAllowed = 1 + Math.floor(run / 7);
          if (graces < gracesAllowed && run > 0) {
            graces++;
          } else {
            run = 0; graces = 0;
          }
        }
      }
    }
    setRecord(Math.max(longest, s));
  }, [history]);

  /* Persist today's checks + update history (maintains `completedOnce` flag) */
  useEffect(() => {
    if (appState !== "dashboard" || !routine || !isToday) return;
    const all = [...(routine.morning || []), ...(routine.afternoon || []), ...(routine.night || [])];
    const rate = all.length ? all.filter(s => checks[s.id]).length / all.length : 0;
    storage.set(`neo-checks-${today}`, JSON.stringify(checks));
    // Once a day reaches 50%+, `completedOnce` sticks at true so regenerating the
    // routine or unchecking items later can't retroactively break the streak.
    const prevCompleted = history[today]?.completedOnce ?? false;
    const completedOnce = prevCompleted || rate >= 0.5;
    const nh = { ...history, [today]: { checks, completionRate: rate, completedOnce } };
    setHistory(nh);
    storage.set("neo-history", JSON.stringify(nh));
  }, [checks]);

  /* Reminder interval */
  useEffect(() => {
    if (appState !== "dashboard") return;
    reminderRef.current = setInterval(() => {
      const n = new Date();
      const ts = `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
      Object.entries(rems).forEach(([p, cfg]) => {
        if (cfg.enabled && cfg.time === ts) {
          const periodLabels = { morning: t.morning_notif, afternoon: t.afternoon_notif, night: t.night_notif };
          const msg = `${t.reminder_prefix} ${periodLabels[p]}: ${(routine?.[p] || []).map(s => s.name).join(", ")}`;
          if (notif && "Notification" in window) new Notification("NeoRejuvenation", { body: msg });
          setToast(msg);
          setTimeout(() => setToast(null), 6000);
        }
      });
    }, 30000);
    return () => clearInterval(reminderRef.current);
  }, [appState, rems, routine, notif, t]);

  /* Derived: current checks (today or past) */
  const currentChecks = isToday ? checks : (history[viewDate]?.checks || {});
  const allSupps = [...(routine?.morning || []), ...(routine?.afternoon || []), ...(routine?.night || [])];
  const pct = allSupps.length ? Math.round(allSupps.filter(s => currentChecks[s.id]).length / allSupps.length * 100) : 0;

  /* Confetti on 100% (today only) */
  useEffect(() => {
    if (!isToday || appState !== "dashboard") return;
    if (pct === 100 && !completedRef.current) {
      completedRef.current = true;
      fireConfetti();
      haptic([30, 60, 30]);
    }
    if (pct < 100) completedRef.current = false;
  }, [pct, isToday, appState]);

  /* Milestone detection */
  useEffect(() => {
    if (appState !== "dashboard") return;
    const hit = MILESTONES.find(m => streak === m && !shownMilestones.includes(m));
    if (hit) {
      setTimeout(() => {
        setMilestone(hit);
        const nw = [...shownMilestones, hit];
        setShownMilestones(nw);
        storage.set("neo-milestones-shown", JSON.stringify(nw));
      }, 800);
    }
  }, [streak, appState]);

  /* Auto compact mode */
  const totalCount = allSupps.length;
  const compact = compactManual;

  /* Handlers */
  const toggle = useCallback((id) => {
    if (!isToday) return;
    haptic(12);
    setChecks(p => ({ ...p, [id]: !p[id] }));
  }, [isToday]);

  const markAll = useCallback((period, value) => {
    if (!isToday || !routine) return;
    haptic(value ? [20, 40, 20] : 15);
    const supps = routine[period] || [];
    setChecks(p => {
      const next = { ...p };
      supps.forEach(s => { next[s.id] = value; });
      return next;
    });
  }, [isToday, routine]);

  /* Daily note: save into history[viewDate].note (debounced via effect below) */
  const currentNote = isToday
    ? (history[today]?.note || "")
    : (history[viewDate]?.note || "");

  const updateNote = (text) => {
    if (!isToday) return; // Only editable for today
    const prevEntry = history[today] || { checks: {}, completionRate: 0, completedOnce: false };
    const nh = { ...history, [today]: { ...prevEntry, note: text } };
    setHistory(nh);
    storage.set("neo-history", JSON.stringify(nh));
  };

  const remUpdate = (p, f, v) => {
    const n = { ...rems, [p]: { ...rems[p], [f]: v } };
    setRems(n);
    storage.set("neo-reminders", JSON.stringify(n));
  };

  const toggleCompactManual = (v) => {
    setCompactManual(v);
    storage.set("neo-compact-manual", JSON.stringify(v));
  };

  const regen = () => {
    // Trigger confirmation modal first; actual regen happens in confirmRegen()
    setShowRegenConfirm(true);
  };

const confirmRegen = () => {
    setShowRegenConfirm(false);
    setAppState("onboarding");
    setView("today"); // Reset tab para que al volver a dashboard se vea la rutina nueva, no Ajustes
    setRoutine(null);
    // Note: we do NOT clear `checks`, `history`, or `neo-checks-${today}` — this
    // preserves the user's streak and today's progress. The new routine's
    // supplement IDs won't match old checks, so % naturally resets to 0, but
    // history[today].completedOnce remains true if they'd already hit 50%.
    storage.delete("neo-routine");
    storage.delete("neo-profile");
    storage.delete("neo-onboarding-draft");
    setOnboardingDraft(null);
  };

  const saveOnboardingDraft = useCallback((d) => {
    setOnboardingDraft(d);
    storage.set("neo-onboarding-draft", JSON.stringify(d));
  }, []);

  /* Swipe navigation */
  const onTouchStart = (e) => { touchStartX.current = e.touches[0].clientX; touchEndX.current = e.touches[0].clientX; };
  const onTouchMove = (e) => { touchEndX.current = e.touches[0].clientX; };
  const onTouchEnd = () => {
    const dx = touchEndX.current - touchStartX.current;
    if (Math.abs(dx) < 60) return;
    // In RTL: swipe right = forward (toward next day), swipe left = back (previous)
    // In LTR: swipe right = back, swipe left = forward
    const rtl = lang === "ea";
    const delta = dx > 0 ? (rtl ? 1 : -1) : (rtl ? -1 : 1);
    const d = new Date(viewDate + "T12:00:00");
    d.setDate(d.getDate() + delta);
    const newKey = d.toISOString().slice(0, 10);
    if (newKey > today) return; // no future
    // Limit to last 30 days
    const limit = new Date(); limit.setDate(limit.getDate() - 30);
    if (d < limit) return;
    haptic(8);
    setViewDate(newKey);
  };

  /* Onboarding completion */
  const finish = async (goals, conds) => {
    const p = { goals, contraindications: conds, lang };
    setProfile(p); setAppState("generating");
    await storage.set("neo-profile", JSON.stringify(p));
    // Clear the onboarding draft — no longer needed
    storage.delete("neo-onboarding-draft");
    setOnboardingDraft(null);
    const goalList = GOALS.filter(g => p.goals.includes(g.id)).map(g => g.label).join(", ");
    const ln = { es: "Spanish", en: "English", fr: "French", de: "German", pt: "Portuguese", it: "Italian", ea: "Arabic" }[lang] || "English";
    try {
      if (!bridge.isAvailable()) {
        // Sin bridge: no podemos llamar al proxy Anthropic desde el iframe.
        // Caemos al fallback predeterminado.
        throw new Error("bridge-unavailable");
      }

      const result = await bridge.generate({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: buildPrompt(lang),
        messages: [{ role: "user", content: `Goals: ${goalList}. Contraindications: ${conds.join(", ")}. JSON only in ${ln}.` }]
      });

      if (!result.ok) {
        const errMsg = (result.data && result.data.message) || `HTTP ${result.status || "?"}`;
        setToast(errMsg);
        setTimeout(() => setToast(null), 8000);
        throw new Error(errMsg);
      }

      const data = result.data || {};
      const txt = (data.content?.find(c => c.type === "text")?.text || "{}").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(txt);
      await storage.set("neo-routine", JSON.stringify(parsed));
      setRoutine(parsed.routine); setAiMsg(parsed.personalMessage); setWarns(parsed.warnings || []);
      setAppState("dashboard");
    } catch {
      const fb = {
        routine: {
          morning: [
            { id: "vc-am", name: "Vitamin C", dose: "1000mg", brand: "SOLARAY 1000mg Retard", benefits: ["Antioxidant", "Collagen", "Immunity"], notes: "With breakfast.", frequency: "daily" },
            { id: "rei-am", name: "Reishi", dose: "1500mg", brand: "Kinoko Reishi 1500mg", benefits: ["Anti-aging", "Immune", "Liver"], notes: "With Vitamin C and food.", frequency: "daily" }
          ],
          afternoon: [],
          night: [
            { id: "vc-pm", name: "Vitamin C", dose: "1000mg", brand: "Solgar 500mg", benefits: ["Antioxidant", "Regeneration"], notes: "Evening dose.", frequency: "daily" },
            { id: "rei-pm", name: "Reishi", dose: "1500mg", brand: "Kinoko Reishi 1500mg", benefits: ["Sleep", "Anti-stress"], notes: "Night regeneration.", frequency: "daily" }
          ]
        },
        personalMessage: t.fallback_msg,
        warnings: [t.fallback_warning]
      };
      await storage.set("neo-routine", JSON.stringify(fb));
      setRoutine(fb.routine); setAiMsg(fb.personalMessage); setWarns(fb.warnings);
      setAppState("dashboard");
    }
  };

  /* Format view date */
  const viewDateObj = new Date(viewDate + "T12:00:00");
  const eyebrowDate = viewDateObj.toLocaleDateString(t.date_locale, { weekday: "long", day: "numeric", month: "long" });

  const tabs = [
    { id: "today", l: t.tab_today },
    { id: "progress", l: t.tab_progress },
    { id: "settings", l: t.tab_settings }
  ];

  /* Notification gate: block dashboard until notifications are granted (or bypassed on unsupported) */
  const needsNotifGate = appState === "dashboard" && notifState !== "granted" && !notifBypassed;

  const handleNotifGranted = () => {
    setNotifState("granted");
    setNotif(true);
    setNotifBypassed(true); // covers unsupported-browser bypass case
  };

  const isRTL = lang === "ea";
  const bodyFont = isRTL
    ? "Almarai, -apple-system, BlinkMacSystemFont, sans-serif"
    : "Inter, -apple-system, BlinkMacSystemFont, sans-serif";

  return (
    <div dir={isRTL ? "rtl" : "ltr"} style={{
      fontFamily: bodyFont,
      background: C.bg, minHeight: "100vh", color: C.text,
      maxWidth: 520, margin: "0 auto", position: "relative"
    }}>
      {/* Toast */}
      {toast && (
        <div style={{
          position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
          zIndex: 100, background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 14, padding: "12px 18px", maxWidth: 340, width: "90%",
          animation: "fadeUp 0.3s", boxShadow: "0 8px 32px rgba(26,34,64,0.12)",
          fontSize: 13, color: C.text, lineHeight: 1.5
        }}>{toast}</div>
      )}

      {/* Milestone modal */}
      {milestone && <MilestoneModal days={milestone} lang={lang} onClose={() => setMilestone(null)} t={t} />}

      {/* Regen confirmation modal */}
      {showRegenConfirm && (
        <RegenConfirmModal
          streak={streak}
          t={t}
          onCancel={() => setShowRegenConfirm(false)}
          onConfirm={confirmRegen}
        />
      )}

      {/* iOS install PWA educational modal */}
      {showIOSInstall && (
        <IOSInstallPWAModal
          t={t}
          onClose={() => setShowIOSInstall(false)}
        />
      )}

      {/* Top tabs (only in dashboard, hidden while notification gate is showing) */}
      {appState === "dashboard" && !needsNotifGate && (
        <div style={{
          padding: "16px 20px 0",
          position: "sticky", top: 0, zIndex: 10,
          background: `${C.bg}ee`, backdropFilter: "blur(20px)"
        }}>
          <div style={{
            display: "flex", gap: 4, padding: 5, background: C.bgSoft,
            borderRadius: 14, border: `1px solid ${C.border}`
          }}>
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setView(tab.id)} style={{
                flex: 1, padding: "10px 4px", border: "none",
                background: view === tab.id ? C.surface : "transparent",
                cursor: "pointer",
                color: view === tab.id ? C.text : C.textMuted,
                fontSize: 12,
                fontWeight: view === tab.id ? 600 : 500,
                borderRadius: 10,
                transition: "all 0.2s",
                boxShadow: view === tab.id ? "0 1px 3px rgba(26,34,64,0.08)" : "none",
                fontFamily: "Oswald,sans-serif",
                letterSpacing: "0.02em"
              }}>{tab.l}</button>
            ))}
          </div>
        </div>
      )}

      <div style={{ padding: "20px", paddingBottom: 40 }}>
        {appState === "loading" && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
            <div style={{ width: 36, height: 36, border: `3px solid ${C.border}`, borderTop: `3px solid ${C.brand1}`, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
          </div>
        )}

        {appState === "onboarding" && (
          <Onboarding
            onComplete={finish}
            GOALS={GOALS}
            CONTRA={CONTRA}
            t={t}
            draft={onboardingDraft}
            onDraftChange={saveOnboardingDraft}
          />
        )}

        {appState === "generating" && <Generating t={t} />}

        {appState === "dashboard" && needsNotifGate && (
          <NotificationGate lang={lang} onGranted={handleNotifGranted} />
        )}

        {appState === "dashboard" && !needsNotifGate && routine && (
          <>
            {view === "today" && (
              <div
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                style={{ animation: "fadeIn 0.25s", touchAction: "pan-y" }}
              >
                {/* Past day banner */}
                {!isToday && (
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 14px", background: C.bgSoft, borderRadius: 12,
                    marginBottom: 16, border: `1px solid ${C.border}`
                  }}>
                    <div style={{ fontSize: 11, color: C.textMuted }}>{t.viewing_past}</div>
                    <button onClick={() => setViewDate(today)} style={{
                      background: "none", border: "none", color: C.brand1,
                      fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0
                    }}>{t.back_to_today}</button>
                  </div>
                )}

                {/* HERO: date + ring */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 14 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 4 }}>
                      {eyebrowDate}
                    </div>
                    <h1 style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 22, lineHeight: 1.15, color: C.text, letterSpacing: "-0.01em" }}>
                      {t.today_header}
                    </h1>
                  </div>
                  <Ring pct={pct} size={72} stroke={6} />
                </div>

                {/* Streak pill + swipe hint */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap", gap: 8 }}>
                  {streak > 0 ? (
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "5px 11px 5px 9px", borderRadius: 20,
                      background: C.morning.bg, border: `1px solid ${C.morning.border}`,
                      color: C.morning.text, fontSize: 11, fontWeight: 600,
                      fontFamily: "Oswald,sans-serif"
                    }}>
                      {Icon.flame(13)} {streak} {t.streak_label}
                    </span>
                  ) : <span />}
                  <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: C.textGhost }}>
                    {Icon.chevLeft(12)} {t.swipe_hint} {Icon.chevRight(12)}
                  </div>
                </div>

             {/* Collapsible info (opción B): preview truncado siempre visible + expandir */}
                {isToday && (aiMsg || warns.length > 0) && (
                  <div style={{ marginBottom: 18 }}>
                    <button
                      onClick={() => setShowRoutineInfo(v => !v)}
                      style={{
                        width: "100%",
                        display: "flex", alignItems: "center", gap: 10,
                        padding: "11px 14px",
                        background: showRoutineInfo ? C.bgSoft : "linear-gradient(135deg,#fafefb,#e8f5ef)",
                        border: `1px solid ${C.border}`,
                        borderRadius: 12,
                        cursor: "pointer",
                        textAlign: lang === "ea" ? "right" : "left",
                        transition: "background 0.2s"
                      }}
                    >
                      <span style={{
                        flex: 1, minWidth: 0,
                        fontSize: 12, color: C.textDim, lineHeight: 1.55,
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                      }}>
                        {aiMsg || (warns.length > 0 ? `⚠️ ${warns[0]}` : "")}
                      </span>
                      <span style={{
                        flexShrink: 0,
                        display: "inline-flex", alignItems: "center", gap: 4,
                        fontSize: 11, color: C.brand1, fontWeight: 600,
                        fontFamily: "Oswald,sans-serif",
                        letterSpacing: "0.02em"
                      }}>
                        {showRoutineInfo ? t.hide_info : t.more_info}
                        <span style={{
                          display: "inline-flex",
                          transform: showRoutineInfo ? "rotate(90deg)" : "rotate(0deg)",
                          transition: "transform 0.2s"
                        }}>
                          {Icon.chevRight(13)}
                        </span>
                      </span>
                    </button>

                    {showRoutineInfo && (
                      <div style={{ marginTop: 8, animation: "fadeIn 0.2s" }}>
                        {aiMsg && (
                          <div style={{
                            padding: "12px 14px",
                            background: "linear-gradient(135deg,#fafefb,#e8f5ef)",
                            border: `1px solid ${C.border}`,
                            borderRadius: 12,
                            marginBottom: warns.length > 0 ? 8 : 0
                          }}>
                            <div style={{ fontSize: 10, color: C.brand1, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>
                              {t.ai_label}
                            </div>
                            <p style={{ fontSize: 12, color: C.textDim, lineHeight: 1.55, margin: 0 }}>{aiMsg}</p>
                          </div>
                        )}
                        {warns.map((w, i) => (
                          <div key={i} style={{
                            padding: "10px 13px", background: C.warningBg,
                            border: `1px solid ${C.morning.border}`, borderRadius: 10,
                            marginBottom: 6, fontSize: 11, color: C.warning
                          }}>⚠️ {w}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                
                {/* Periods */}
                {["morning", "afternoon", "night"].map((p, i, arr) => {
                  const nonEmpty = arr.filter(x => (routine[x] || []).length > 0);
                  const isLastNonEmpty = nonEmpty[nonEmpty.length - 1] === p;
                  return (
                    <PeriodSection
                      key={p} period={p}
                      supplements={routine[p] || []}
                      checks={currentChecks}
                      onToggle={toggle}
                      onMarkAll={markAll}
                      compact={compact}
                      t={t}
                      readOnly={!isToday}
                      isLast={isLastNonEmpty}
                    />
                  );
                })}

                {/* Daily note */}
                <div style={{
                  marginTop: 24, padding: "14px 16px",
                  background: C.bgSoft, border: `1px solid ${C.border}`,
                  borderRadius: 14
                }}>
                  <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 500, marginBottom: 8 }}>
                    {t.note_label}
                  </div>
                  {isToday ? (
                    <textarea
                      value={currentNote}
                      onChange={(e) => updateNote(e.target.value)}
                      placeholder={t.note_placeholder}
                      rows={2}
                      maxLength={280}
                      style={{
                        width: "100%", border: "none", background: "transparent",
                        fontFamily: "inherit", fontSize: 13, color: C.text,
                        resize: "none", outline: "none", lineHeight: 1.55,
                        direction: isRTL ? "rtl" : "ltr"
                      }}
                    />
                  ) : (
                    <div style={{
                      fontSize: 13, color: currentNote ? C.textDim : C.textGhost,
                      lineHeight: 1.55, fontStyle: currentNote ? "normal" : "italic",
                      minHeight: 20
                    }}>
                      {currentNote || "—"}
                    </div>
                  )}
                </div>

                {/* 100% celebration */}
                {isToday && pct === 100 && (
                  <div style={{
                    marginTop: 24, padding: "28px 20px 24px",
                    background: "linear-gradient(135deg,#e1f5ee,#e8f5ef)",
                    border: `1px solid ${C.success}22`, borderRadius: 16, textAlign: "center",
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 18,
                    animation: "fadeUp 0.4s"
                  }}>
                    <BrandOrb size={76} variant="success" />
                    <div>
                      <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 17, color: C.success, marginBottom: 4 }}>
                        {t.complete_title}
                      </div>
                      <div style={{ fontSize: 12, color: C.textDim, lineHeight: 1.55, maxWidth: 300 }}>{t.complete_sub}</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {view === "progress" && <ProgressView history={history} streak={streak} record={record} routine={routine} t={t} />}

            {view === "settings" && (
              <SettingsView
                rems={rems} onRem={remUpdate}
                onNotif={async () => {
                  // ── Detección de iOS sin PWA instalada ──
                  // En iOS Safari, web push solo funciona con PWA en home screen.
                  // Si detectamos iOS + no-standalone, mostramos modal educativo
                  // en lugar de intentar pedir permiso (que fallaría silenciosamente).
                  const ua = navigator.userAgent || "";
                  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
                                (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

                  if (isIOS && bridge.isAvailable()) {
                    // Preguntamos al parent si está en standalone (PWA instalada).
                    // El parent responde con isStandalone en la misma respuesta de requestPushPermission.
                    try {
                      const res = await bridge.requestPushPermission();

                      if (res.ok && res.permission === "granted") {
                        setNotif(true);
                        setNotifState("granted");
                        setToast(t.notif_granted);
                        setTimeout(() => setToast(null), 4000);
                        return;
                      }

                      // Si el permiso no llegó a "granted" Y estamos en iOS, muy probable
                      // que sea porque no está instalada la PWA. Mostrar modal educativo.
                      setShowIOSInstall(true);
                      return;
                    } catch (e) {
                      // Cualquier error en iOS → asumimos no-PWA y mostramos el modal
                      setShowIOSInstall(true);
                      return;
                    }
                  }

                  // ── Caso general (Android, desktop, etc.) ──
                  // Dentro del iframe de WordPress → delegar al parent vía bridge.
                  if (bridge.isAvailable()) {
                    try {
                      const res = await bridge.requestPushPermission();
                      if (res.ok && res.permission === "granted") {
                        setNotif(true);
                        setNotifState("granted");
                        setToast(t.notif_granted);
                        setTimeout(() => setToast(null), 4000);
                      } else {
                        setNotif(false);
                      }
                    } catch (e) {
                      // Bridge falló → fallback al permission local si existe
                      if ("Notification" in window) {
                        const p = await Notification.requestPermission();
                        setNotif(p === "granted");
                      }
                    }
                    return;
                  }

                  // ── Caso standalone sin bridge (sin iframe) ──
                  if ("Notification" in window) {
                    const p = await Notification.requestPermission();
                    setNotif(p === "granted");
                  }
                }}
                notifOk={notif} onRegen={regen} routine={routine}
                compactManual={compactManual} onCompactToggle={toggleCompactManual}
                onPushTest={async () => {
                  if (!bridge.isAvailable()) return;
                  try {
                    const res = await bridge.pushTest();
                    if (res.ok && res.data?.ok) {
                      setToast(t.push_test_ok);
                    } else {
                      setToast(t.push_test_no_sub);
                    }
                  } catch {
                    setToast(t.push_test_no_sub);
                  }
                  setTimeout(() => setToast(null), 5000);
                }}
                t={t}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
