import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";

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
    pushTest:    ()    => send("nr-tracker-push-test", {}).then(r => ({ ok: r.ok, status: r.status, data: r.data })),
    // Estado de suscripción neo-push: el parent llama NRPush.isSubscribed().
    // Timeout corto y resuelve a null (desconocido) si el bridge no responde,
    // para que Ajustes degrade con elegancia (nunca error ni spinner infinito).
    isSubscribed: ()   => send("nr-tracker-is-subscribed", null, 5000).then(r => (typeof r.subscribed === "boolean" ? r.subscribed : null)),
    // Scanner + Experto (proxy en el parent hacia /wp-json/nr-supp/v1).
    // Prefijo "nrx-" a propósito: el listener del snippet 144 responde
    // "Unknown request type" a cualquier nr-tracker-* que no conozca, así
    // que estos mensajes usan otro namespace y los atienden los snippets
    // "Scanner bridge" y "Metrics" (que responden con tipo nr-tracker-nrx-*).
    suppRecent:  ()    => send("nrx-supp-recent", null, 15000).then(r => r.data),
    suppProduct: (id)  => send("nrx-supp-product", { id }, 15000).then(r => r.data),
    suppScan:    (p)   => send("nrx-supp-scan", p, 120000).then(r => r.data),
    suppExpert:  (p)   => send("nrx-supp-expert", p, 90000).then(r => r.data),
    suppDelScan: (id)  => send("nrx-supp-del", { id }, 15000).then(r => r.data),
    // Métrica fire-and-forget: nunca lanza ni bloquea nada.
    metric:      (event, meta) => send("nrx-metric", { event, meta: meta || "" }, 4000).catch(() => {})
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

/* ───────────────── LOCAL DATE KEY ─────────────────
   Clave de día en la zona horaria LOCAL del dispositivo (antes se usaba
   toISOString = fecha UTC, y en América la app "cambiaba de día" por la
   tarde: a las 17:00 PDT ya era mañana en UTC, la rutina se reseteaba y
   los checks nocturnos caían en el día siguiente). */
const localDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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

/* ───────────────── SCANNER I18N ───────────────── */
const SCAN_T = {
  es: { scan_title:"Escáner de suplementos", scan_sub:"Fotografía la etiqueta de cualquier suplemento y obtén un análisis objetivo con puntuación de seguridad, eficacia y transparencia.", scan_cta:"Escanear suplemento", recent:"Escaneados recientemente", empty_recent:"Aún no has escaneado ningún producto.", step1:"Frontal del bote", step1s:"Nombre del producto y marca", step2:"Tabla de ingredientes", step2s:"Supplement Facts / Información nutricional", step3:"Otros ingredientes", step3s:"Resto de la etiqueta y advertencias", optional:"Opcional", add_photo:"Foto", retake:"Repetir", analyze:"Analizar", loading:["Leyendo la etiqueta…","Identificando ingredientes…","Calculando puntuaciones…","Casi listo…"], back:"Volver", overall:"Índice global", safety:"Seguridad", efficacy:"Eficacia", transparency:"Transparencia", good:"Lo bueno", bad:"Atención", ingredients:"Ingredientes", alternatives:"Cómo mejorarlo", expert:"Experto", expert_sub:"Pregunta cualquier duda sobre suplementos", expert_title:"¿Por dónde empezamos?", q1:"¿Qué magnesio ayuda a dormir mejor?", q2:"¿Puedo combinar probióticos y vitaminas?", q3:"¿Colágeno en polvo o en cápsulas?", type_msg:"Escribe tu pregunta…", err:"Algo ha fallado. Inténtalo de nuevo.", thinking:"Pensando…", confirm_del:"¿Eliminar?", add_routine:"Añadir a mi rutina", added:"✓ Añadido a tu rutina", already:"Ya está en tu rutina", ask_product:"Preguntar al experto sobre este producto", ask_product_msg:"Acabo de escanear \"{name}\"{brand}, puntuación {score}/100. ¿Qué opinas de este producto y cómo debería tomarlo?", pq_when:"¿Cuál es el mejor momento para tomar {a}?", pq_combo:"¿Puedo tomar {a} junto con {b}?", pq_food:"¿Con qué alimentos se absorbe mejor {a}?" },
  en: { scan_title:"Supplement scanner", scan_sub:"Photograph any supplement label and get an objective analysis with safety, efficacy and transparency scores.", scan_cta:"Scan supplement", recent:"Recently scanned", empty_recent:"You haven’t scanned any product yet.", step1:"Front of the bottle", step1s:"Product name and brand", step2:"Ingredients panel", step2s:"Supplement Facts", step3:"Other ingredients", step3s:"Rest of the label and warnings", optional:"Optional", add_photo:"Photo", retake:"Retake", analyze:"Analyze", loading:["Reading the label…","Identifying ingredients…","Calculating scores…","Almost there…"], back:"Back", overall:"Overall score", safety:"Safety", efficacy:"Efficacy", transparency:"Transparency", good:"Good", bad:"Watch out", ingredients:"Ingredients", alternatives:"How to improve it", expert:"Expert", expert_sub:"Ask any question about supplements", expert_title:"Where should we start?", q1:"Which magnesium helps you sleep best?", q2:"Can I mix probiotics and vitamins?", q3:"Collagen powder or capsules?", type_msg:"Type your question…", err:"Something went wrong. Try again.", thinking:"Thinking…", confirm_del:"Delete?", add_routine:"Add to my routine", added:"✓ Added to your routine", already:"Already in your routine", ask_product:"Ask the expert about this product", ask_product_msg:"I just scanned \"{name}\"{brand}, scored {score}/100. What do you think of this product and how should I take it?", pq_when:"What's the best time of day to take {a}?", pq_combo:"Can I take {a} together with {b}?", pq_food:"Which foods help absorb {a} best?" },
  fr: { scan_title:"Scanner de compléments", scan_sub:"Photographiez l’étiquette de n’importe quel complément et obtenez une analyse objective avec scores de sécurité, efficacité et transparence.", scan_cta:"Scanner un complément", recent:"Scannés récemment", empty_recent:"Vous n’avez encore scanné aucun produit.", step1:"Face avant du flacon", step1s:"Nom du produit et marque", step2:"Tableau des ingrédients", step2s:"Valeurs nutritionnelles", step3:"Autres ingrédients", step3s:"Reste de l’étiquette et avertissements", optional:"Optionnel", add_photo:"Photo", retake:"Reprendre", analyze:"Analyser", loading:["Lecture de l’étiquette…","Identification des ingrédients…","Calcul des scores…","Presque fini…"], back:"Retour", overall:"Score global", safety:"Sécurité", efficacy:"Efficacité", transparency:"Transparence", good:"Points forts", bad:"Attention", ingredients:"Ingrédients", alternatives:"Comment l’améliorer", expert:"Expert", expert_sub:"Posez toute question sur les compléments", expert_title:"Par où commençons-nous ?", q1:"Quel magnésium aide à mieux dormir ?", q2:"Puis-je combiner probiotiques et vitamines ?", q3:"Collagène en poudre ou en gélules ?", type_msg:"Écrivez votre question…", err:"Une erreur est survenue. Réessayez.", thinking:"Réflexion…", confirm_del:"Supprimer ?", add_routine:"Ajouter à ma routine", added:"✓ Ajouté à votre routine", already:"Déjà dans votre routine", ask_product:"Demander à l'expert à propos de ce produit", ask_product_msg:"Je viens de scanner « {name} »{brand}, note {score}/100. Que pensez-vous de ce produit et comment devrais-je le prendre ?", pq_when:"Quel est le meilleur moment pour prendre {a} ?", pq_combo:"Puis-je prendre {a} avec {b} ?", pq_food:"Avec quels aliments {a} s'absorbe-t-il le mieux ?" },
  it: { scan_title:"Scanner di integratori", scan_sub:"Fotografa l’etichetta di qualsiasi integratore e ottieni un’analisi oggettiva con punteggi di sicurezza, efficacia e trasparenza.", scan_cta:"Scansiona integratore", recent:"Scansionati di recente", empty_recent:"Non hai ancora scansionato nessun prodotto.", step1:"Fronte del flacone", step1s:"Nome del prodotto e marca", step2:"Tabella degli ingredienti", step2s:"Informazioni nutrizionali", step3:"Altri ingredienti", step3s:"Resto dell’etichetta e avvertenze", optional:"Opzionale", add_photo:"Foto", retake:"Ripeti", analyze:"Analizza", loading:["Lettura dell’etichetta…","Identificazione degli ingredienti…","Calcolo dei punteggi…","Quasi pronto…"], back:"Indietro", overall:"Punteggio globale", safety:"Sicurezza", efficacy:"Efficacia", transparency:"Trasparenza", good:"Punti di forza", bad:"Attenzione", ingredients:"Ingredienti", alternatives:"Come migliorarlo", expert:"Esperto", expert_sub:"Fai qualsiasi domanda sugli integratori", expert_title:"Da dove iniziamo?", q1:"Quale magnesio aiuta a dormire meglio?", q2:"Posso combinare probiotici e vitamine?", q3:"Collagene in polvere o in capsule?", type_msg:"Scrivi la tua domanda…", err:"Qualcosa è andato storto. Riprova.", thinking:"Sto pensando…", confirm_del:"Eliminare?", add_routine:"Aggiungi alla mia routine", added:"✓ Aggiunto alla tua routine", already:"Già nella tua routine", ask_product:"Chiedi all'esperto di questo prodotto", ask_product_msg:"Ho appena scansionato \"{name}\"{brand}, punteggio {score}/100. Cosa ne pensi di questo prodotto e come dovrei assumerlo?", pq_when:"Qual è il momento migliore per assumere {a}?", pq_combo:"Posso assumere {a} insieme a {b}?", pq_food:"Con quali alimenti si assorbe meglio {a}?" },
  de: { scan_title:"Supplement-Scanner", scan_sub:"Fotografieren Sie das Etikett eines Nahrungsergänzungsmittels und erhalten Sie eine objektive Analyse mit Bewertungen zu Sicherheit, Wirksamkeit und Transparenz.", scan_cta:"Supplement scannen", recent:"Zuletzt gescannt", empty_recent:"Sie haben noch kein Produkt gescannt.", step1:"Vorderseite der Flasche", step1s:"Produktname und Marke", step2:"Zutatentabelle", step2s:"Nährwertangaben", step3:"Weitere Zutaten", step3s:"Rest des Etiketts und Warnhinweise", optional:"Optional", add_photo:"Foto", retake:"Wiederholen", analyze:"Analysieren", loading:["Etikett wird gelesen…","Zutaten werden identifiziert…","Bewertungen werden berechnet…","Fast fertig…"], back:"Zurück", overall:"Gesamtbewertung", safety:"Sicherheit", efficacy:"Wirksamkeit", transparency:"Transparenz", good:"Stärken", bad:"Achtung", ingredients:"Zutaten", alternatives:"Verbesserungsmöglichkeiten", expert:"Experte", expert_sub:"Stellen Sie jede Frage zu Supplementen", expert_title:"Womit fangen wir an?", q1:"Welches Magnesium hilft beim Schlafen?", q2:"Kann ich Probiotika und Vitamine kombinieren?", q3:"Kollagen als Pulver oder Kapseln?", type_msg:"Schreiben Sie Ihre Frage…", err:"Etwas ist schiefgelaufen. Versuchen Sie es erneut.", thinking:"Denke nach…", confirm_del:"Löschen?", add_routine:"Zu meiner Routine hinzufügen", added:"✓ Zu Ihrer Routine hinzugefügt", already:"Bereits in Ihrer Routine", ask_product:"Den Experten zu diesem Produkt fragen", ask_product_msg:"Ich habe gerade \"{name}\"{brand} gescannt, Bewertung {score}/100. Was halten Sie von diesem Produkt und wie sollte ich es einnehmen?", pq_when:"Wann ist die beste Tageszeit für {a}?", pq_combo:"Kann ich {a} zusammen mit {b} einnehmen?", pq_food:"Mit welchen Lebensmitteln wird {a} am besten aufgenommen?" },
  pt: { scan_title:"Scanner de suplementos", scan_sub:"Fotografe o rótulo de qualquer suplemento e obtenha uma análise objetiva com pontuações de segurança, eficácia e transparência.", scan_cta:"Escanear suplemento", recent:"Escaneados recentemente", empty_recent:"Você ainda não escaneou nenhum produto.", step1:"Frente do frasco", step1s:"Nome do produto e marca", step2:"Tabela de ingredientes", step2s:"Informação nutricional", step3:"Outros ingredientes", step3s:"Resto do rótulo e advertências", optional:"Opcional", add_photo:"Foto", retake:"Repetir", analyze:"Analisar", loading:["Lendo o rótulo…","Identificando ingredientes…","Calculando pontuações…","Quase pronto…"], back:"Voltar", overall:"Índice global", safety:"Segurança", efficacy:"Eficácia", transparency:"Transparência", good:"Pontos fortes", bad:"Atenção", ingredients:"Ingredientes", alternatives:"Como melhorar", expert:"Especialista", expert_sub:"Pergunte qualquer dúvida sobre suplementos", expert_title:"Por onde começamos?", q1:"Qual magnésio ajuda a dormir melhor?", q2:"Posso combinar probióticos e vitaminas?", q3:"Colágeno em pó ou em cápsulas?", type_msg:"Escreva sua pergunta…", err:"Algo deu errado. Tente novamente.", thinking:"Pensando…", confirm_del:"Excluir?", add_routine:"Adicionar à minha rotina", added:"✓ Adicionado à sua rotina", already:"Já está na sua rotina", ask_product:"Perguntar ao especialista sobre este produto", ask_product_msg:"Acabei de escanear \"{name}\"{brand}, pontuação {score}/100. O que você acha deste produto e como devo tomá-lo?", pq_when:"Qual é o melhor momento para tomar {a}?", pq_combo:"Posso tomar {a} junto com {b}?", pq_food:"Com quais alimentos {a} é melhor absorvido?" },
  ea: { scan_title:"ماسح المكملات", scan_sub:"صوّر ملصق أي مكمل غذائي واحصل على تحليل موضوعي مع تقييمات الأمان والفعالية والشفافية.", scan_cta:"مسح مكمل", recent:"تم مسحها مؤخرًا", empty_recent:"لم تقم بمسح أي منتج بعد.", step1:"واجهة العبوة", step1s:"اسم المنتج والعلامة التجارية", step2:"جدول المكونات", step2s:"حقائق المكمل الغذائي", step3:"مكونات أخرى", step3s:"بقية الملصق والتحذيرات", optional:"اختياري", add_photo:"صورة", retake:"إعادة", analyze:"تحليل", loading:["قراءة الملصق…","تحديد المكونات…","حساب التقييمات…","اقتربنا…"], back:"رجوع", overall:"التقييم العام", safety:"الأمان", efficacy:"الفعالية", transparency:"الشفافية", good:"الإيجابيات", bad:"انتبه", ingredients:"المكونات", alternatives:"كيفية تحسينه", expert:"الخبير", expert_sub:"اسأل أي سؤال عن المكملات", expert_title:"من أين نبدأ؟", q1:"أي نوع من المغنيسيوم يساعد على النوم؟", q2:"هل يمكن الجمع بين البروبيوتيك والفيتامينات؟", q3:"الكولاجين بودرة أم كبسولات؟", type_msg:"اكتب سؤالك…", err:"حدث خطأ ما. حاول مرة أخرى.", thinking:"يفكر…", confirm_del:"حذف؟", add_routine:"أضِف إلى روتيني", added:"✓ تمت الإضافة إلى روتينك", already:"موجود بالفعل في روتينك", ask_product:"اسأل الخبير عن هذا المنتج", ask_product_msg:"لقد مسحت للتو \"{name}\"{brand} بتقييم {score}/100. ما رأيك في هذا المنتج وكيف يجب أن أتناوله؟", pq_when:"ما أفضل وقت في اليوم لتناول {a}؟", pq_combo:"هل يمكنني تناول {a} مع {b}؟", pq_food:"مع أي أطعمة يُمتص {a} بشكل أفضل؟" }
};

/* ───────────────── FEATURE FLAGS ───────────────── */
// Notas del día ocultas de la UI. Reversible: poner a true.
// No se toca el esquema de estado ni el sync — los datos de notas
// existentes en history[fecha].note se conservan intactos.
const SHOW_DAILY_NOTES = false;

// Marcas de suplementos ocultas en la VISUALIZACIÓN de las rutinas.
// Reversible: poner a true. NO se toca el catálogo, ni el prompt de la IA,
// ni los datos guardados — el campo `brand` sigue existiendo en el JSON
// (rutinas nuevas y antiguas), simplemente deja de pintarse en las tarjetas.
const SHOW_BRANDS = false;

// Lista negra de marcas para limpiar textos libres (notas, mensaje de la IA,
// avisos) donde la marca puede venir incrustada dentro de una frase.
// Solo se aplica en render — el dato original queda intacto.
const BRAND_RE = /(SOLARAY(\s+Retard)?|Kinoko|Solgar|Revidox|Douglas|Soria Natural|Lamberts|Keriba|Ana Mar[ií]a Lajusticia|Redenhair)/gi;
const sanitizeText = (txt) => {
  if (SHOW_BRANDS || !txt) return txt;
  return txt
    .replace(BRAND_RE, "")
    .replace(/(^|[\s(])\/+([\s)]|$)/g, "$1$2") // slash huérfano tras "Solgar/Revidox"
    .replace(/\(\s*\)/g, "")                    // paréntesis vacíos
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:·)])/g, "$1")
    .replace(/(^|[.!?¡¿]\s*)[,;:·]\s*/g, "$1")
    .trim();
};

/* ───────────────── TRANSLATIONS ───────────────── */
const T = {
  es: { trackerSub:"Supplement Tracker", today_label:"hoy", tab_today:"Hoy", tab_progress:"Progreso", tab_settings:"Ajustes", morning:"Mañana", afternoon:"Tarde", night:"Noche", morning_hint:"Al despertar · Con desayuno", afternoon_hint:"Mediodía · Con comida", night_hint:"Antes de dormir · Con cena", morning_notif:"Mañana", afternoon_notif:"Tarde", night_notif:"Noche", freq_alternate:"Cada 2-3 días", freq_weekly:"2-3×/semana", hide_info:"Ocultar", more_info:"Más info", step1_title:"¿Cuáles son tus objetivos?", step1_sub:"Selecciona todos los que apliquen. Adaptaremos tu rutina.", step2_title:"Contraindicaciones", step2_sub:"Es importante para tu seguridad. Sé honesto/a.", step3_title:"¡Todo listo!", step3_sub:"Crearemos tu rutina personalizada basada en el método NeoRejuvenation.", step3_disclaimer:"Esta información es educativa. Consulta siempre con un profesional sanitario antes de iniciar cualquier suplementación.", btn_back:"Atrás", btn_continue:"Continuar", btn_create:"Crear mi rutina", gen_title:"Creando tu rutina personalizada", gen_sub:"Estamos analizando tus objetivos y diseñando la combinación óptima de suplementos NeoRejuvenation", ai_label:"Tu rutina personalizada", today_header:"Tu rutina de hoy", streak_label:"días en racha", complete_title:"¡Rutina completada!", complete_sub:"Has completado todos tus suplementos de hoy. Tu cuerpo te lo agradece.", progress_title:"Tu progreso", progress_sub:"Últimos 30 días", streak_card_label:"Racha activa", streak_days:"días consecutivos", record_label:"Récord", record_days:"días", last7:"Últimos 7 días", weekly_avg:"Prom.", routine_title:"Tu rutina actual", total_supps:"suplementos en total", settings_title:"Ajustes", reminders_title:"Recordatorios", notif_granted:"Notificaciones activadas", notif_hint:"Los recordatorios funcionan mientras tengas esta página abierta.", routine_section:"Rutina", regenerate_hint:"¿Quieres ajustar tus objetivos o regenerar tu rutina?", regenerate_btn:"Crear nueva rutina", reminder_prefix:"Recordatorio", fallback_msg:"Tu rutina base NeoRejuvenation está lista. Vitamina C + Reishi son los pilares fundamentales de tu regeneración celular diaria.", fallback_warning:"Consulta con un médico antes de iniciar cualquier suplementación.", compact_label:"Modo compacto", compact_hint:"Oculta los beneficios para ver más suplementos de un vistazo", viewing_past:"Viendo día pasado", back_to_today:"Volver a hoy", swipe_hint:"Desliza ← → para cambiar de día", milestone_cta:"Continuar", day_names:["D","L","M","X","J","V","S"], date_locale:"es-ES" },
  en: { trackerSub:"Supplement Tracker", today_label:"today", tab_today:"Today", tab_progress:"Progress", tab_settings:"Settings", morning:"Morning", afternoon:"Afternoon", night:"Night", morning_hint:"Upon waking · With breakfast", afternoon_hint:"Midday · With lunch", night_hint:"Before sleep · With dinner", morning_notif:"Morning", afternoon_notif:"Afternoon", night_notif:"Night", freq_alternate:"Every 2-3 days", freq_weekly:"2-3×/week", hide_info:"Hide", more_info:"More info", step1_title:"What are your goals?", step1_sub:"Select all that apply. We'll adapt your routine.", step2_title:"Contraindications", step2_sub:"This is important for your safety. Please be honest.", step3_title:"All set!", step3_sub:"We'll create your personalized routine based on the NeoRejuvenation method.", step3_disclaimer:"This information is educational. Always consult a healthcare professional before starting any supplementation.", btn_back:"Back", btn_continue:"Continue", btn_create:"Create my routine", gen_title:"Creating your personalized routine", gen_sub:"We're analyzing your goals and designing the optimal NeoRejuvenation supplement combination", ai_label:"Your personalized routine", today_header:"Your routine today", streak_label:"day streak", complete_title:"Routine complete!", complete_sub:"You have completed all your supplements for today. Your body thanks you.", progress_title:"Your progress", progress_sub:"Last 30 days", streak_card_label:"Active streak", streak_days:"consecutive days", record_label:"Record", record_days:"days", last7:"Last 7 days", weekly_avg:"Avg.", routine_title:"Your current routine", total_supps:"supplements total", settings_title:"Settings", reminders_title:"Reminders", notif_granted:"Notifications enabled", notif_hint:"Reminders work while this page is open.", routine_section:"Routine", regenerate_hint:"Want to adjust your goals or regenerate your routine?", regenerate_btn:"Create new routine", reminder_prefix:"Reminder", fallback_msg:"Your base NeoRejuvenation routine is ready. Vitamin C + Reishi are the fundamental pillars of your daily cellular regeneration.", fallback_warning:"Consult a doctor before starting any supplementation.", compact_label:"Compact mode", compact_hint:"Hide benefits to see more supplements at a glance", viewing_past:"Viewing past day", back_to_today:"Back to today", swipe_hint:"Swipe ← → to change day", milestone_cta:"Continue", day_names:["Su","Mo","Tu","We","Th","Fr","Sa"], date_locale:"en-US" },
  fr: { trackerSub:"Supplement Tracker", today_label:"aujourd'hui", tab_today:"Aujourd'hui", tab_progress:"Progrès", tab_settings:"Réglages", morning:"Matin", afternoon:"Après-midi", night:"Nuit", morning_hint:"Au réveil · Avec le petit-déjeuner", afternoon_hint:"Midi · Avec le déjeuner", night_hint:"Avant de dormir · Avec le dîner", morning_notif:"Matin", afternoon_notif:"Après-midi", night_notif:"Nuit", freq_alternate:"Tous les 2-3 jours", freq_weekly:"2-3×/semaine", hide_info:"Masquer", more_info:"Plus d'infos", step1_title:"Quels sont vos objectifs ?", step1_sub:"Sélectionnez tout ce qui s'applique. Nous adapterons votre routine.", step2_title:"Contre-indications", step2_sub:"C'est important pour votre sécurité. Soyez honnête.", step3_title:"Tout est prêt !", step3_sub:"Nous créerons votre routine personnalisée basée sur la méthode NeoRejuvenation.", step3_disclaimer:"Ces informations sont éducatives. Consultez toujours un professionnel de santé.", btn_back:"Retour", btn_continue:"Continuer", btn_create:"Créer ma routine", gen_title:"Création de votre routine", gen_sub:"Nous analysons vos objectifs et conçoit la combinaison optimale", ai_label:"Votre routine personnalisée", today_header:"Votre routine du jour", streak_label:"jours de suite", complete_title:"Routine complète !", complete_sub:"Vous avez pris tous vos suppléments aujourd'hui. Votre corps vous remercie.", progress_title:"Votre progrès", progress_sub:"30 derniers jours", streak_card_label:"Série active", streak_days:"jours consécutifs", record_label:"Record", record_days:"jours", last7:"7 derniers jours", weekly_avg:"Moy.", routine_title:"Votre routine actuelle", total_supps:"suppléments au total", settings_title:"Réglages", reminders_title:"Rappels", notif_granted:"Notifications activées", notif_hint:"Les rappels fonctionnent tant que cette page est ouverte.", routine_section:"Routine", regenerate_hint:"Voulez-vous ajuster vos objectifs ou régénérer votre routine ?", regenerate_btn:"Créer une nouvelle routine", reminder_prefix:"Rappel", fallback_msg:"Votre routine NeoRejuvenation de base est prête. Vitamine C + Reishi sont les piliers fondamentaux.", fallback_warning:"Consultez un médecin avant de commencer toute supplémentation.", compact_label:"Mode compact", compact_hint:"Masquer les bénéfices pour voir plus de suppléments d'un coup d'œil", viewing_past:"Visualisation d'un jour passé", back_to_today:"Retour à aujourd'hui", swipe_hint:"Glissez ← → pour changer de jour", milestone_cta:"Continuer", day_names:["Di","Lu","Ma","Me","Je","Ve","Sa"], date_locale:"fr-FR" },
  de: { trackerSub:"Supplement Tracker", today_label:"heute", tab_today:"Heute", tab_progress:"Fortschritt", tab_settings:"Einstellungen", morning:"Morgen", afternoon:"Nachmittag", night:"Nacht", morning_hint:"Beim Aufwachen · Mit dem Frühstück", afternoon_hint:"Mittags · Mit dem Mittagessen", night_hint:"Vor dem Schlafen · Mit dem Abendessen", morning_notif:"Morgen", afternoon_notif:"Nachmittag", night_notif:"Nacht", freq_alternate:"Alle 2-3 Tage", freq_weekly:"2-3×/Woche", hide_info:"Weniger", more_info:"Mehr Info", step1_title:"Was sind Ihre Ziele?", step1_sub:"Wählen Sie alles Zutreffende. Wir passen Ihre Routine an.", step2_title:"Kontraindikationen", step2_sub:"Dies ist wichtig für Ihre Sicherheit.", step3_title:"Alles bereit!", step3_sub:"Wir erstellen Ihre personalisierte Routine basierend auf der NeoRejuvenation-Methode.", step3_disclaimer:"Diese Informationen sind pädagogisch. Konsultieren Sie immer einen Arzt.", btn_back:"Zurück", btn_continue:"Weiter", btn_create:"Meine Routine erstellen", gen_title:"Ihre Routine wird erstellt", gen_sub:"Wir analysieren Ihre Ziele und entwirft die optimale Supplementkombination", ai_label:"Ihre personalisierte Routine", today_header:"Ihre Routine heute", streak_label:"Tage in Folge", complete_title:"Routine abgeschlossen!", complete_sub:"Sie haben alle heutigen Supplemente eingenommen.", progress_title:"Ihr Fortschritt", progress_sub:"Letzte 30 Tage", streak_card_label:"Aktive Serie", streak_days:"aufeinanderfolgende Tage", record_label:"Rekord", record_days:"Tage", last7:"Letzte 7 Tage", weekly_avg:"Ø", routine_title:"Ihre aktuelle Routine", total_supps:"Supplemente insgesamt", settings_title:"Einstellungen", reminders_title:"Erinnerungen", notif_granted:"Benachrichtigungen aktiviert", notif_hint:"Erinnerungen funktionieren solange diese Seite geöffnet ist.", routine_section:"Routine", regenerate_hint:"Möchten Sie Ihre Ziele anpassen oder Ihre Routine neu generieren?", regenerate_btn:"Neue Routine erstellen", reminder_prefix:"Erinnerung", fallback_msg:"Ihre NeoRejuvenation-Basisroutine ist bereit. Vitamin C + Reishi sind die grundlegenden Säulen.", fallback_warning:"Konsultieren Sie einen Arzt.", compact_label:"Kompakter Modus", compact_hint:"Vorteile ausblenden, um mehr Supplemente auf einen Blick zu sehen", viewing_past:"Vergangener Tag", back_to_today:"Zurück zu heute", swipe_hint:"Wischen ← → um den Tag zu wechseln", milestone_cta:"Weiter", day_names:["So","Mo","Di","Mi","Do","Fr","Sa"], date_locale:"de-DE" },
  pt: { trackerSub:"Supplement Tracker", today_label:"hoje", tab_today:"Hoje", tab_progress:"Progresso", tab_settings:"Configurações", morning:"Manhã", afternoon:"Tarde", night:"Noite", morning_hint:"Ao acordar · Com o café da manhã", afternoon_hint:"Ao meio-dia · Com o almoço", night_hint:"Antes de dormir · Com o jantar", morning_notif:"Manhã", afternoon_notif:"Tarde", night_notif:"Noite", freq_alternate:"A cada 2-3 dias", freq_weekly:"2-3×/semana", hide_info:"Ocultar", more_info:"Mais info", step1_title:"Quais são os seus objetivos?", step1_sub:"Selecione todos os que se aplicam. Adaptaremos sua rotina.", step2_title:"Contraindicações", step2_sub:"É importante para a sua segurança.", step3_title:"Tudo pronto!", step3_sub:"Criaremos sua rotina personalizada baseada no método NeoRejuvenation.", step3_disclaimer:"Esta informação é educacional. Consulte sempre um profissional de saúde.", btn_back:"Voltar", btn_continue:"Continuar", btn_create:"Criar minha rotina", gen_title:"Criando sua rotina personalizada", gen_sub:"Estamos analisando seus objetivos e projetando a combinação ideal", ai_label:"Sua rotina personalizada", today_header:"Sua rotina de hoje", streak_label:"dias seguidos", complete_title:"Rotina concluída!", complete_sub:"Você completou todos os seus suplementos hoje.", progress_title:"Seu progresso", progress_sub:"Últimos 30 dias", streak_card_label:"Sequência ativa", streak_days:"dias consecutivos", record_label:"Recorde", record_days:"dias", last7:"Últimos 7 dias", weekly_avg:"Méd.", routine_title:"Sua rotina atual", total_supps:"suplementos no total", settings_title:"Configurações", reminders_title:"Lembretes", notif_granted:"Notificações ativadas", notif_hint:"Os lembretes funcionam enquanto esta página estiver aberta.", routine_section:"Rotina", regenerate_hint:"Quer ajustar seus objetivos ou regenerar sua rotina?", regenerate_btn:"Criar nova rotina", reminder_prefix:"Lembrete", fallback_msg:"Sua rotina base NeoRejuvenation está pronta. Vitamina C + Reishi são os pilares fundamentais.", fallback_warning:"Consulte um médico antes de iniciar qualquer suplementação.", compact_label:"Modo compacto", compact_hint:"Oculta os benefícios para ver mais suplementos de relance", viewing_past:"Vendo dia passado", back_to_today:"Voltar para hoje", swipe_hint:"Deslize ← → para mudar de dia", milestone_cta:"Continuar", day_names:["D","S","T","Q","Q","S","S"], date_locale:"pt-BR" },
  it: { trackerSub:"Supplement Tracker", today_label:"oggi", tab_today:"Oggi", tab_progress:"Progressi", tab_settings:"Impostazioni", morning:"Mattina", afternoon:"Pomeriggio", night:"Notte", morning_hint:"Al risveglio · Con la colazione", afternoon_hint:"Mezzogiorno · Con il pranzo", night_hint:"Prima di dormire · Con la cena", morning_notif:"Mattina", afternoon_notif:"Pomeriggio", night_notif:"Notte", freq_alternate:"Ogni 2-3 giorni", freq_weekly:"2-3×/settimana", hide_info:"Nascondi", more_info:"Più info", step1_title:"Quali sono i tuoi obiettivi?", step1_sub:"Seleziona tutto ciò che si applica. Adatteremo la tua routine.", step2_title:"Controindicazioni", step2_sub:"È importante per la tua sicurezza.", step3_title:"Tutto pronto!", step3_sub:"Creeremo la tua routine personalizzata basata sul metodo NeoRejuvenation.", step3_disclaimer:"Queste informazioni sono educative. Consulta sempre un professionista sanitario.", btn_back:"Indietro", btn_continue:"Continua", btn_create:"Crea la mia routine", gen_title:"Creazione della tua routine", gen_sub:"Stiamo analizzando i tuoi obiettivi e progettando la combinazione ottimale", ai_label:"La tua routine personalizzata", today_header:"La tua routine di oggi", streak_label:"giorni di seguito", complete_title:"Routine completata!", complete_sub:"Hai completato tutti i tuoi integratori di oggi.", progress_title:"I tuoi progressi", progress_sub:"Ultimi 30 giorni", streak_card_label:"Serie attiva", streak_days:"giorni consecutivi", record_label:"Record", record_days:"giorni", last7:"Ultimi 7 giorni", weekly_avg:"Media", routine_title:"La tua routine attuale", total_supps:"integratori in totale", settings_title:"Impostazioni", reminders_title:"Promemoria", notif_granted:"Notifiche attivate", notif_hint:"I promemoria funzionano finché questa pagina è aperta.", routine_section:"Routine", regenerate_hint:"Vuoi modificare i tuoi obiettivi o rigenerare la tua routine?", regenerate_btn:"Crea nuova routine", reminder_prefix:"Promemoria", fallback_msg:"La tua routine base NeoRejuvenation è pronta. Vitamina C + Reishi sono i pilastri fondamentali.", fallback_warning:"Consulta un medico prima di iniziare qualsiasi integrazione.", compact_label:"Modalità compatta", compact_hint:"Nascondi i benefici per vedere più integratori a colpo d'occhio", viewing_past:"Visualizzazione giorno passato", back_to_today:"Torna a oggi", swipe_hint:"Scorri ← → per cambiare giorno", milestone_cta:"Continua", day_names:["Do","Lu","Ma","Me","Gi","Ve","Sa"], date_locale:"it-IT" },
  ea: { trackerSub:"متتبع المكملات", today_label:"اليوم", tab_today:"اليوم", tab_progress:"التقدم", tab_settings:"الإعدادات", morning:"الصباح", afternoon:"الظهيرة", night:"الليل", morning_hint:"عند الاستيقاظ · مع الإفطار", afternoon_hint:"الظهر · مع الغداء", night_hint:"قبل النوم · مع العشاء", morning_notif:"الصباح", afternoon_notif:"الظهيرة", night_notif:"الليل", freq_alternate:"كل 2-3 أيام", freq_weekly:"2-3 مرات/أسبوع", hide_info:"إخفاء", more_info:"المزيد", step1_title:"ما هي أهدافك؟", step1_sub:"اختر كل ما ينطبق. سنكيّف روتينك.", step2_title:"موانع الاستعمال", step2_sub:"هذا مهم لسلامتك. كن صادقًا.", step3_title:"كل شيء جاهز!", step3_sub:"سننشئ روتينك الشخصي بناءً على منهج NeoRejuvenation.", step3_disclaimer:"هذه المعلومات تعليمية. استشر دائمًا أخصائيًا صحيًا قبل البدء بأي مكملات.", btn_back:"رجوع", btn_continue:"متابعة", btn_create:"إنشاء روتيني", gen_title:"نقوم بإنشاء روتينك الشخصي", gen_sub:"نحلل أهدافك ونصمم التركيبة المثلى من مكملات NeoRejuvenation", ai_label:"روتينك الشخصي", today_header:"روتينك اليوم", streak_label:"أيام متتالية", complete_title:"اكتمل الروتين!", complete_sub:"لقد أكملت كل مكملاتك اليوم. جسدك يشكرك.", progress_title:"تقدمك", progress_sub:"آخر 30 يومًا", streak_card_label:"السلسلة النشطة", streak_days:"أيام متتالية", record_label:"الرقم القياسي", record_days:"أيام", last7:"آخر 7 أيام", weekly_avg:"المتوسط", routine_title:"روتينك الحالي", total_supps:"مكمل إجمالاً", settings_title:"الإعدادات", reminders_title:"التذكيرات", notif_granted:"الإشعارات مفعّلة", notif_hint:"تعمل التذكيرات طالما هذه الصفحة مفتوحة.", routine_section:"الروتين", regenerate_hint:"هل تريد تعديل أهدافك أو إعادة إنشاء روتينك؟", regenerate_btn:"إنشاء روتين جديد", reminder_prefix:"تذكير", fallback_msg:"روتين NeoRejuvenation الأساسي جاهز. فيتامين C والريشي هما الركيزتان الأساسيتان لتجديد خلاياك يوميًا.", fallback_warning:"استشر طبيبك قبل البدء بأي مكملات.", compact_label:"الوضع المضغوط", compact_hint:"إخفاء الفوائد لرؤية المزيد من المكملات بلمحة", viewing_past:"عرض يوم سابق", back_to_today:"العودة إلى اليوم", swipe_hint:"اسحب ← → لتغيير اليوم", milestone_cta:"متابعة", day_names:["ح","ن","ث","ر","خ","ج","س"], date_locale:"ar-AE" }
};

/* ───────────────── EXTRA TRANSLATIONS (added in phase 2 features) ───────────────── */
const EXTRA_T = {
  es: { mark_all:"Marcar todos", unmark_all:"Desmarcar todos", regen_confirm_title:"¿Regenerar tu rutina?", regen_confirm_body:"Tu racha de {streak} días se mantendrá intacta. Se generará una nueva rutina basada en objetivos actualizados.", regen_confirm_body_nostreak:"Se generará una nueva rutina basada en objetivos actualizados.", regen_confirm_btn:"Sí, regenerar", regen_cancel_btn:"Cancelar", note_label:"Nota del día", note_placeholder:"Cómo te has sentido hoy (opcional)…", grace_day:"Día de gracia usado", none_excludes:"Al seleccionar \"ninguna\", las demás opciones se desactivan", push_test_btn:"Probar notificación", push_test_ok:"✓ Notificación enviada — debería llegar en unos segundos", push_test_no_sub:"Activa primero las notificaciones en este navegador", nav_tracker:"Suplementos", nav_scanner:"Escáner", nav_expert:"Experto", del_title:"¿Eliminar de tu rutina?", del_body:"¿Seguro que quieres eliminar \"{name}\" de tu rutina?", del_btn:"Sí, eliminar" },
  en: { mark_all:"Mark all", unmark_all:"Unmark all", regen_confirm_title:"Regenerate your routine?", regen_confirm_body:"Your {streak}-day streak will stay intact. A new routine will be generated based on updated goals.", regen_confirm_body_nostreak:"A new routine will be generated based on updated goals.", regen_confirm_btn:"Yes, regenerate", regen_cancel_btn:"Cancel", note_label:"Today's note", note_placeholder:"How have you felt today (optional)…", grace_day:"Grace day used", none_excludes:"Selecting \"none\" disables the other options", push_test_btn:"Test notification", push_test_ok:"✓ Notification sent — it should arrive in a few seconds", push_test_no_sub:"Enable notifications in this browser first", nav_tracker:"Supplements", nav_scanner:"Scanner", nav_expert:"Expert", del_title:"Remove from your routine?", del_body:"Are you sure you want to remove \"{name}\" from your routine?", del_btn:"Yes, remove" },
  fr: { mark_all:"Tout marquer", unmark_all:"Tout démarquer", regen_confirm_title:"Régénérer votre routine ?", regen_confirm_body:"Votre série de {streak} jours restera intacte. Une nouvelle routine sera générée sur la base d'objectifs mis à jour.", regen_confirm_body_nostreak:"Une nouvelle routine sera générée sur la base d'objectifs mis à jour.", regen_confirm_btn:"Oui, régénérer", regen_cancel_btn:"Annuler", note_label:"Note du jour", note_placeholder:"Comment vous sentez-vous aujourd'hui (facultatif)…", grace_day:"Jour de grâce utilisé", none_excludes:"En sélectionnant « aucune », les autres options sont désactivées", push_test_btn:"Tester la notification", push_test_ok:"✓ Notification envoyée — elle devrait arriver dans quelques secondes", push_test_no_sub:"Activez d'abord les notifications dans ce navigateur", nav_tracker:"Suppléments", nav_scanner:"Scanner", nav_expert:"Expert", del_title:"Retirer de votre routine ?", del_body:"Voulez-vous vraiment retirer « {name} » de votre routine ?", del_btn:"Oui, retirer" },
  de: { mark_all:"Alle markieren", unmark_all:"Alle demarkieren", regen_confirm_title:"Ihre Routine neu generieren?", regen_confirm_body:"Ihre {streak}-Tage-Serie bleibt erhalten. Eine neue Routine wird auf Basis aktualisierter Ziele erstellt.", regen_confirm_body_nostreak:"Eine neue Routine wird auf Basis aktualisierter Ziele erstellt.", regen_confirm_btn:"Ja, neu generieren", regen_cancel_btn:"Abbrechen", note_label:"Tagesnotiz", note_placeholder:"Wie haben Sie sich heute gefühlt (optional)…", grace_day:"Kulanztag verwendet", none_excludes:"Bei Auswahl von „keine\" werden die anderen Optionen deaktiviert", push_test_btn:"Benachrichtigung testen", push_test_ok:"✓ Benachrichtigung gesendet — sie sollte in wenigen Sekunden ankommen", push_test_no_sub:"Aktivieren Sie zunächst die Benachrichtigungen in diesem Browser", nav_tracker:"Supplemente", nav_scanner:"Scanner", nav_expert:"Experte", del_title:"Aus Ihrer Routine entfernen?", del_body:"Möchten Sie \"{name}\" wirklich aus Ihrer Routine entfernen?", del_btn:"Ja, entfernen" },
  pt: { mark_all:"Marcar todos", unmark_all:"Desmarcar todos", regen_confirm_title:"Regenerar sua rotina?", regen_confirm_body:"Sua sequência de {streak} dias permanecerá intacta. Uma nova rotina será gerada com base em objetivos atualizados.", regen_confirm_body_nostreak:"Uma nova rotina será gerada com base em objetivos atualizados.", regen_confirm_btn:"Sim, regenerar", regen_cancel_btn:"Cancelar", note_label:"Nota do dia", note_placeholder:"Como você se sentiu hoje (opcional)…", grace_day:"Dia de graça usado", none_excludes:"Ao selecionar \"nenhuma\", as outras opções ficam desativadas", push_test_btn:"Testar notificação", push_test_ok:"✓ Notificação enviada — deve chegar em alguns segundos", push_test_no_sub:"Ative primeiro as notificações neste navegador", nav_tracker:"Suplementos", nav_scanner:"Scanner", nav_expert:"Especialista", del_title:"Remover da sua rotina?", del_body:"Tem certeza de que deseja remover \"{name}\" da sua rotina?", del_btn:"Sim, remover" },
  it: { mark_all:"Seleziona tutti", unmark_all:"Deseleziona tutti", regen_confirm_title:"Rigenerare la tua routine?", regen_confirm_body:"La tua serie di {streak} giorni rimarrà intatta. Verrà generata una nuova routine basata su obiettivi aggiornati.", regen_confirm_body_nostreak:"Verrà generata una nuova routine basata su obiettivi aggiornati.", regen_confirm_btn:"Sì, rigenera", regen_cancel_btn:"Annulla", note_label:"Nota del giorno", note_placeholder:"Come ti sei sentito oggi (facoltativo)…", grace_day:"Giorno di grazia usato", none_excludes:"Selezionando \"nessuna\", le altre opzioni vengono disattivate", push_test_btn:"Prova notifica", push_test_ok:"✓ Notifica inviata — dovrebbe arrivare in pochi secondi", push_test_no_sub:"Attiva prima le notifiche in questo browser", nav_tracker:"Integratori", nav_scanner:"Scanner", nav_expert:"Esperto", del_title:"Rimuovere dalla tua routine?", del_body:"Vuoi davvero rimuovere \"{name}\" dalla tua routine?", del_btn:"Sì, rimuovi" },
  ea: { mark_all:"تحديد الكل", unmark_all:"إلغاء التحديد", regen_confirm_title:"إعادة إنشاء روتينك؟", regen_confirm_body:"سلسلتك البالغة {streak} يومًا ستبقى سليمة. سيتم إنشاء روتين جديد بناءً على أهداف محدّثة.", regen_confirm_body_nostreak:"سيتم إنشاء روتين جديد بناءً على أهداف محدّثة.", regen_confirm_btn:"نعم، إعادة الإنشاء", regen_cancel_btn:"إلغاء", note_label:"ملاحظة اليوم", note_placeholder:"كيف شعرت اليوم (اختياري)…", grace_day:"تم استخدام يوم السماح", none_excludes:"عند اختيار \"لا شيء\"، يتم تعطيل الخيارات الأخرى", push_test_btn:"اختبر الإشعار", push_test_ok:"✓ تم إرسال الإشعار — يجب أن يصل خلال ثوانٍ", push_test_no_sub:"فعّل الإشعارات أولاً في هذا المتصفح", nav_tracker:"المكملات", nav_scanner:"الماسح", nav_expert:"الخبير", del_title:"إزالة من روتينك؟", del_body:"هل أنت متأكد أنك تريد إزالة \"{name}\" من روتينك؟", del_btn:"نعم، إزالة" }
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
/* ───────────────── FALLBACK ROUTINE (localizada) ─────────────────
   Se usa cuando la generación con IA falla (límite diario, error de API,
   JSON inválido o bridge no disponible). Antes estaba hardcodeada en
   inglés y a usuarios no-EN les salía "Vitamin C / With breakfast". */
const FALLBACK_T = {
  es: { vc:"Vitamina C", b1:["Antioxidante","Colágeno","Inmunidad"], n1:"Con el desayuno.", b2:["Antienvejecimiento","Sistema inmune","Hígado"], n2:"Con la Vitamina C y comida.", b3:["Antioxidante","Regeneración"], n3:"Dosis de la noche.", b4:["Sueño","Antiestrés"], n4:"Regeneración nocturna." },
  en: { vc:"Vitamin C", b1:["Antioxidant","Collagen","Immunity"], n1:"With breakfast.", b2:["Anti-aging","Immune","Liver"], n2:"With Vitamin C and food.", b3:["Antioxidant","Regeneration"], n3:"Evening dose.", b4:["Sleep","Anti-stress"], n4:"Night regeneration." },
  fr: { vc:"Vitamine C", b1:["Antioxydant","Collagène","Immunité"], n1:"Avec le petit-déjeuner.", b2:["Anti-âge","Immunité","Foie"], n2:"Avec la Vitamine C et de la nourriture.", b3:["Antioxydant","Régénération"], n3:"Dose du soir.", b4:["Sommeil","Anti-stress"], n4:"Régénération nocturne." },
  de: { vc:"Vitamin C", b1:["Antioxidans","Kollagen","Immunsystem"], n1:"Zum Frühstück.", b2:["Anti-Aging","Immunsystem","Leber"], n2:"Mit Vitamin C und Essen.", b3:["Antioxidans","Regeneration"], n3:"Abenddosis.", b4:["Schlaf","Anti-Stress"], n4:"Nächtliche Regeneration." },
  it: { vc:"Vitamina C", b1:["Antiossidante","Collagene","Immunità"], n1:"Con la colazione.", b2:["Anti-età","Sistema immunitario","Fegato"], n2:"Con la Vitamina C e cibo.", b3:["Antiossidante","Rigenerazione"], n3:"Dose serale.", b4:["Sonno","Anti-stress"], n4:"Rigenerazione notturna." },
  pt: { vc:"Vitamina C", b1:["Antioxidante","Colágeno","Imunidade"], n1:"Com o café da manhã.", b2:["Antienvelhecimento","Sistema imune","Fígado"], n2:"Com a Vitamina C e comida.", b3:["Antioxidante","Regeneração"], n3:"Dose da noite.", b4:["Sono","Antiestresse"], n4:"Regeneração noturna." },
  ea: { vc:"فيتامين C", b1:["مضاد للأكسدة","الكولاجين","المناعة"], n1:"مع الفطور.", b2:["مكافحة الشيخوخة","المناعة","الكبد"], n2:"مع فيتامين C ومع الطعام.", b3:["مضاد للأكسدة","التجديد"], n3:"جرعة المساء.", b4:["النوم","مضاد للتوتر"], n4:"تجديد ليلي." }
};

const buildFallbackRoutine = (lang) => {
  const f = FALLBACK_T[lang] || FALLBACK_T.es;
  return {
    morning: [
      { id: "vc-am", name: f.vc, dose: "1000mg", brand: "SOLARAY 1000mg Retard", benefits: f.b1, notes: f.n1, frequency: "daily" },
      { id: "rei-am", name: "Reishi", dose: "1500mg", brand: "Kinoko Reishi 1500mg", benefits: f.b2, notes: f.n2, frequency: "daily" }
    ],
    afternoon: [],
    night: [
      { id: "vc-pm", name: f.vc, dose: "1000mg", brand: "Solgar 500mg", benefits: f.b3, notes: f.n3, frequency: "daily" },
      { id: "rei-pm", name: "Reishi", dose: "1500mg", brand: "Kinoko Reishi 1500mg", benefits: f.b4, notes: f.n4, frequency: "daily" }
    ]
  };
};

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
  text: "rgba(26,34,64,0.85)",
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
  s.textContent = `*{box-sizing:border-box;margin:0;padding:0}body{background:${C.bg};font-feature-settings:"cv11","ss01","ss03";-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}.nr-tnum{font-variant-numeric:tabular-nums}.nr-expert-msg .nr-md-h{display:block;color:${C.text};font-family:Oswald,sans-serif;font-size:16px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;line-height:1.25;margin:24px 0 10px}.nr-expert-msg .nr-md-h:first-child{margin-top:2px}.nr-expert-msg p{margin:0 0 13px}.nr-expert-msg p:last-child{margin-bottom:0}.nr-expert-msg ul,.nr-expert-msg ol{margin:4px 0 16px;padding-inline-start:20px}.nr-expert-msg li{margin-bottom:8px}.nr-expert-msg li::marker{color:${C.brand1}}.nr-expert-msg strong{color:${C.brand1};font-weight:700}.nr-expert-msg code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;background:#e8f5ef;padding:1px 6px;border-radius:5px}.nr-mono{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-feature-settings:"zero","ss01"}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#d6dbe8;border-radius:2px}@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes breathe{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.05);opacity:1}}@keyframes checkPop{0%{transform:scale(0)}60%{transform:scale(1.2)}100%{transform:scale(1)}}@keyframes modalIn{from{opacity:0;transform:translateY(20px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes d1{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}@keyframes d2{0%,20%,80%,100%{transform:scale(0)}60%{transform:scale(1)}}@keyframes d3{0%,40%,100%{transform:scale(0)}80%{transform:scale(1.2)}}@keyframes orbRing{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.7);opacity:0}}@keyframes orbBreathe{0%,100%{transform:scale(1);opacity:.95}50%{transform:scale(1.06);opacity:1}}`;
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
  scan: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/></svg>,
  chat: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  pill: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 20.5 3.5 13.5a4.95 4.95 0 1 1 7-7l7 7a4.95 4.95 0 1 1-7 7z"/><line x1="8.5" y1="8.5" x2="15.5" y2="15.5"/></svg>,
  chart: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  gear: (s = 16) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
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
      const k = localDateKey(d);
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
function SuppCard({ supp, checked, onToggle, compact, dense, ultra, t, readOnly, onDelete, isRTL }) {
  const [exp, setExp] = useState(false);
  const [dragX, setDragX] = useState(0);
  const touch = useRef({ x: 0, y: 0, locked: null, moved: false });

  // Cuando activamos modo compacto, colapsar la card automáticamente.
  // Evita que cards previamente expandidas sigan abiertas tras cambiar el toggle.
  useEffect(() => {
    if (compact) setExp(false);
  }, [compact]);

  /* Swipe para eliminar (solo con onDelete). Dirección: hacia el inicio de
     lectura (izquierda en LTR, derecha en RTL) — coincide con la dirección
     "hacia el futuro" del swipe de día, que está bloqueada en HOY, así que
     no compite con el cambio de día. Una vez bloqueado el gesto como
     horizontal-de-borrado, se corta la propagación al contenedor. */
  const DEL_DIR = isRTL ? 1 : -1; // signo de dx que dispara el borrado
  const onCardTouchStart = (e) => {
    if (!onDelete) return;
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, locked: null, moved: false };
  };
  const onCardTouchMove = (e) => {
    if (!onDelete) return;
    const dx = e.touches[0].clientX - touch.current.x;
    const dy = e.touches[0].clientY - touch.current.y;
    if (touch.current.locked === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      touch.current.locked = (Math.abs(dx) > Math.abs(dy) && dx * DEL_DIR > 0) ? "delete" : "other";
    }
    if (touch.current.locked === "delete") {
      e.stopPropagation();
      touch.current.moved = true;
      const mag = Math.min(Math.abs(dx), 96);
      setDragX(mag * DEL_DIR);
    }
  };
  const onCardTouchEnd = (e) => {
    if (!onDelete) return;
    if (touch.current.locked === "delete") {
      e.stopPropagation();
      if (Math.abs(dragX) > 70) { haptic(12); onDelete(supp); }
      setDragX(0);
    }
    // Suprimir el click-toggle que sigue a un arrastre
    if (touch.current.moved) {
      setTimeout(() => { touch.current.moved = false; }, 50);
    }
  };

  const showExpanded = !compact || exp;
  const hasNotes = !!supp.notes;

  // Marca visible solo si SHOW_BRANDS. Los datos guardados no se tocan,
  // solo se omite en el render. Benefits pasan a ser el primer segmento.
  const brandShown = SHOW_BRANDS && !!supp.brand;
  const hasBenefits = supp.benefits && supp.benefits.length > 0;

  return (
    <div style={{ position: "relative", marginBottom: ultra ? 4 : dense ? 5 : 8 }}>
      {/* Indicador de borrado revelado tras la card */}
      {onDelete && dragX !== 0 && (
        <div style={{
          position: "absolute", inset: 0, borderRadius: 14,
          background: C.afternoon.bg, border: `1px solid ${C.afternoon.border}`,
          display: "flex", alignItems: "center",
          justifyContent: isRTL ? "flex-start" : "flex-end",
          padding: "0 18px", color: C.afternoon.icon,
          opacity: Math.min(Math.abs(dragX) / 70, 1)
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </div>
      )}
      <div
        onClick={() => { if (readOnly || touch.current.moved) return; onToggle(supp.id); }}
        onTouchStart={onCardTouchStart}
        onTouchMove={onCardTouchMove}
        onTouchEnd={onCardTouchEnd}
        style={{
          transform: dragX !== 0 ? `translateX(${dragX}px)` : "none",
          background: checked ? C.surfaceDone : C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: 14,
          padding: ultra ? "5px 9px" : dense ? "7px 10px" : compact ? "10px 12px" : "13px 14px",
          cursor: readOnly ? "default" : "pointer",
          transition: dragX !== 0 ? "none" : "all 0.2s",
          animation: "fadeUp 0.25s",
          opacity: readOnly ? 0.75 : 1
      }}
    >
      <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
        <div style={{
          width: ultra ? 17 : dense ? 19 : 22, height: ultra ? 17 : dense ? 19 : 22, borderRadius: "50%", flexShrink: 0, marginTop: 1,
          border: checked ? "none" : `1.5px solid ${C.borderStrong}`,
          background: checked ? C.brandGrad : C.surface,
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "all 0.2s",
          animation: checked ? "checkPop 0.3s" : "none"
        }}>
          {checked && Icon.check(ultra ? 9 : dense ? 10 : 12)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            <span style={{
              fontFamily: "Oswald,sans-serif",
              fontWeight: 600,
              fontSize: ultra ? 13.5 : dense ? 15 : 18,
              color: checked ? C.textMuted : C.text,
              textDecoration: checked ? "line-through" : "none"
            }}>{supp.name}</span>
            <span style={{
              fontSize: ultra ? 9.5 : 11,
              color: checked ? C.textGhost : C.textMuted,
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontFeatureSettings: '"zero", "ss01"',
              letterSpacing: "-0.01em"
            }}>{supp.dose}</span>
            {dense && hasNotes && !exp && (
              <button
                onClick={e => { e.stopPropagation(); setExp(true); }}
                style={{
                  background: "none", border: "none", color: C.textGhost,
                  fontSize: 10, cursor: "pointer", padding: 0, textDecoration: "underline",
                  fontFamily: "Inter, sans-serif"
                }}
              >{t.more_info}</button>
            )}
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
              {brandShown && supp.brand}
              {hasBenefits && <>{brandShown ? " · " : ""}{supp.benefits.join(" · ")}</>}
              {hasNotes && (
                <>
                  {(brandShown || hasBenefits) ? " · " : ""}
                  <button
                    onClick={e => { e.stopPropagation(); setExp(v => !v); }}
                    style={{
                      background: "none", border: "none", color: C.textMuted,
                      fontSize: 10, cursor: "pointer", padding: 0, textDecoration: "underline",
                      fontFamily: "Inter, sans-serif"
                    }}
                  >
                    {exp ? t.hide_info : t.more_info}
                  </button>
                </>
              )}
            </div>
          )}
          {/* En modo compacto (sin brand/beneficios visibles) mostramos "Más info" en su propia línea */}
          {!showExpanded && hasNotes && !dense && (
            <div style={{ marginTop: 4 }}>
              <button
                onClick={e => { e.stopPropagation(); setExp(v => !v); }}
                style={{
                  background: "none", border: "none", color: C.textMuted,
                  fontSize: 10, cursor: "pointer", padding: 0, textDecoration: "underline",
                  fontFamily: "Inter, sans-serif"
                }}
              >
                {exp ? t.hide_info : t.more_info}
              </button>
            </div>
          )}
          {hasNotes && exp && (
            <div style={{ marginTop: 6, padding: "8px 10px", background: C.bgSoft, borderRadius: 8, fontSize: 11, color: C.textDim, lineHeight: 1.55 }}>
              {sanitizeText(supp.notes)}
            </div>
          )}
        </div>
      </div>
    </div>
    </div>
  );
}

/* ───────────────── PERIOD SECTION ───────────────── */
function PeriodSection({ period, supplements, checks, onToggle, onMarkAll, compact, dense, ultra, t, readOnly, isLast, onDelete, isRTL }) {
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
    <div style={{ marginBottom: isLast ? 0 : (ultra ? 8 : dense ? 12 : compact ? 14 : 22) }}>
      <div
        onClick={handleHeaderClick}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          marginBottom: ultra ? 3 : dense ? 4 : compact ? 7 : 10, cursor: readOnly ? "default" : "pointer",
          padding: "4px 6px", margin: "-4px -6px 6px", borderRadius: 10,
          transition: "background 0.15s",
          userSelect: "none"
        }}
        onMouseEnter={e => { if (!readOnly) e.currentTarget.style.background = C.bgSoft; }}
        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: ultra ? 24 : dense ? 28 : 38, height: ultra ? 24 : dense ? 28 : 38, borderRadius: ultra ? 8 : dense ? 9 : 12, background: tone.bg, color: tone.icon, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <SectionIcon period={period} size={ultra ? 13 : dense ? 15 : 20} />
          </div>
          <div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: ultra ? 14 : dense ? 16 : 22, color: tone.icon, letterSpacing: "0.01em", lineHeight: 1.15 }}>
              {t[period]}
            </div>
            {!dense && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t[period + "_hint"]}</div>}
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
        <SuppCard key={s.id} supp={s} checked={!!checks[s.id]} onToggle={onToggle} compact={compact} dense={dense} ultra={ultra} t={t} readOnly={readOnly} isRTL={isRTL} onDelete={onDelete ? (supp) => onDelete(supp, period) : null} />
      ))}
      {!isLast && <div style={{ height: 1, background: C.border, margin: ultra ? "8px -20px 0" : dense ? "12px -20px 0" : compact ? "14px -20px 0" : "22px -20px 0" }} />}
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

/* ───────────────── DELETE SUPP CONFIRM MODAL ───────────────── */
function DeleteSuppModal({ supp, t, onCancel, onConfirm }) {
  const body = (t.del_body || "").replace("{name}", supp.name || "");
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
          background: C.afternoon.bg, border: `1px solid ${C.afternoon.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 18px", color: C.afternoon.icon
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </div>
        <h3 style={{
          fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 19,
          color: C.text, textAlign: "center", marginBottom: 12
        }}>{t.del_title}</h3>
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
            background: C.afternoon.icon, border: "none", color: "#fff",
            fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 13,
            letterSpacing: "0.03em", cursor: "pointer"
          }}>{t.del_btn}</button>
        </div>
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
      const k = localDateKey(d);
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
function SettingsView({ rems, onRem, subscribed, onRegen, routine, compactManual, onCompactToggle, t, onPushTest }) {
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
        {/* Estado informativo de suscripción neo-push. El permiso/suscripción
            se gestiona en el GATE de /supplement/ (WordPress), aguas arriba —
            el tracker ya no pide permiso. subscribed: true → activado + test;
            false/null (bridge no disponible o estado desconocido) → no se
            muestra nada (degradación elegante, nunca error ni spinner). */}
        {subscribed === true && (
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
/* ───────────────── SCANNER + EXPERTO (integrados) ─────────────────
   Portado del shortcode [nr_supp_scanner] al estilo del tracker.
   Backend igual (nr-supp/v1) pero vía bridge postMessage: el parent
   (snippet "NR Tracker — Scanner bridge") hace los fetch con nonce. */

const scanScoreColor = (v) => (v >= 75 ? C.brand1 : v >= 50 ? C.morning.icon : C.afternoon.icon);

/* Mini-Markdown seguro para las respuestas del Experto (escapa primero). */
const escHtml = (s) => { const d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; };
const mdInline = (line) => line
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
const mdToHtml = (text) => {
  const lines = escHtml(text).split("\n");
  const out = []; let inUl = false, inOl = false;
  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  lines.forEach(l => {
    const h = l.match(/^#{1,4}\s+(.+)/);
    const ul = l.match(/^\s*[-*•]\s+(.+)/);
    const ol = l.match(/^\s*\d+[.)]\s+(.+)/);
    if (h)       { closeLists(); out.push('<span class="nr-md-h">' + mdInline(h[1]) + "</span>"); }
    else if (ul) { if (inOl) { out.push("</ol>"); inOl = false; } if (!inUl) { out.push("<ul>"); inUl = true; } out.push("<li>" + mdInline(ul[1]) + "</li>"); }
    else if (ol) { if (inUl) { out.push("</ul>"); inUl = false; } if (!inOl) { out.push("<ol>"); inOl = true; } out.push("<li>" + mdInline(ol[1]) + "</li>"); }
    else if (l.trim() === "") { closeLists(); }
    else { closeLists(); out.push("<p>" + mdInline(l) + "</p>"); }
  });
  closeLists();
  return out.join("");
};

/* Compresión de foto a JPEG ≤1280px (mismo comportamiento que el shortcode). */
const compressPhoto = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    const MAX = 1280;
    let w = img.width, h = img.height;
    if (w > MAX || h > MAX) {
      if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
      else { w = Math.round(w * MAX / h); h = MAX; }
    }
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    resolve(c.toDataURL("image/jpeg", 0.82));
  };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("img")); };
  img.src = url;
});

function ScoreRing({ score, label }) {
  const R = 62, CIRC = 2 * Math.PI * R;
  const [off, setOff] = useState(CIRC);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setOff(CIRC * (1 - score / 100))));
    return () => cancelAnimationFrame(id);
  }, [score, CIRC]);
  return (
    <div style={{ display: "flex", justifyContent: "center", margin: "6px 0 18px" }}>
      <div style={{ position: "relative", width: 150, height: 150 }}>
        <svg width="150" height="150" viewBox="0 0 150 150" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="75" cy="75" r={R} fill="none" strokeWidth="9" stroke={C.border} />
          <circle cx="75" cy="75" r={R} fill="none" strokeWidth="9" strokeLinecap="round"
            stroke={scanScoreColor(score)} strokeDasharray={CIRC} strokeDashoffset={off}
            style={{ transition: "stroke-dashoffset 1s cubic-bezier(.22,1,.36,1)" }} />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <strong className="nr-mono" style={{ fontSize: 36, fontWeight: 700, lineHeight: 1, color: scanScoreColor(score) }}>{score}</strong>
          <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: C.textMuted, marginTop: 4 }}>{label}</span>
        </div>
      </div>
    </div>
  );
}

const fillTpl = (s, vars) => String(s || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ""));

function ScannerView({ lang, active, t, routine, onAddToRoutine }) {
  const st = SCAN_T[lang] || SCAN_T.es;
  const [sub, setSub] = useState("home"); // home | scan | loading | product | expert
  const [photos, setPhotos] = useState([null, null, null]);
  const [product, setProduct] = useState(null);
  const [recent, setRecent] = useState([]);
  const [chat, setChat] = useState([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [error, setError] = useState(null);
  const [loadMsg, setLoadMsg] = useState(0);
  const [addFeedback, setAddFeedback] = useState(null); // "added" | "already"
  const [confirmDelId, setConfirmDelId] = useState(null); // id de scan pendiente de confirmar borrado
  const loadedRef = useRef(false);
  const fileRefs = [useRef(null), useRef(null), useRef(null)];
  const chatEndRef = useRef(null);

  const loadRecent = useCallback(() => {
    bridge.suppRecent().then(list => setRecent(list || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (active && !loadedRef.current) { loadedRef.current = true; loadRecent(); }
  }, [active, loadRecent]);

  /* Rotación de mensajes de carga */
  useEffect(() => {
    if (sub !== "loading") return;
    setLoadMsg(0);
    const id = setInterval(() => setLoadMsg(i => Math.min(i + 1, st.loading.length - 1)), 3500);
    return () => clearInterval(id);
  }, [sub, st.loading.length]);

  /* Autoscroll del chat */
  useEffect(() => {
    if (sub === "expert" && chatEndRef.current) chatEndRef.current.scrollIntoView({ block: "end" });
  }, [chat, chatBusy, sub]);

  const onPhoto = (i, file) => {
    if (!file) return;
    compressPhoto(file).then(dataUrl => {
      setPhotos(p => { const n = [...p]; n[i] = dataUrl; return n; });
    }).catch(() => setError(st.err));
  };

  const doScan = () => {
    setSub("loading"); setError(null); setAddFeedback(null);
    bridge.suppScan({ photos: photos.filter(Boolean), lang }).then(p => {
      setProduct(p); setSub("product"); loadRecent();
      bridge.metric("scan", p.product_name || "");
    }).catch(e => {
      setError(e.message || st.err); setSub("scan");
    });
  };

  const openProduct = (id) => {
    setSub("loading"); setError(null); setAddFeedback(null);
    bridge.suppProduct(id).then(p => { setProduct(p); setSub("product"); })
      .catch(e => { setError(e.message || st.err); setSub("home"); });
  };

  const sendExpert = (text) => {
    const next = [...chat, { role: "user", content: text }];
    setChat(next); setChatBusy(true); setError(null); setChatInput("");
    bridge.metric("expert");
    bridge.suppExpert({ messages: next, lang }).then(r => {
      setChat(c => [...c, { role: "assistant", content: r.reply || "" }]);
      setChatBusy(false);
    }).catch(e => { setChatBusy(false); setError(e.message || st.err); });
  };

  /* ── estilos compartidos ── */
  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 };
  const h1 = { fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 22, lineHeight: 1.15, color: C.text, letterSpacing: "-0.01em", margin: 0 };
  const sectionTitle = { fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.text, margin: "22px 0 8px" };
  const backBtn = { background: "none", border: 0, cursor: "pointer", padding: "6px 0", fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textMuted, marginBottom: 10, display: "inline-flex", alignItems: "center", gap: 4 };
  const gradBtn = { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "15px 20px", border: 0, borderRadius: 14, fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", background: C.brandGrad, color: "#fff", boxShadow: "0 4px 22px rgba(15,110,86,0.25)" };
  const errBox = error ? (
    <div style={{ background: C.afternoon.bg, border: `1px solid ${C.afternoon.border}`, color: C.afternoon.text, borderRadius: 12, padding: "12px 14px", fontSize: 13, margin: "12px 0" }}>{error}</div>
  ) : null;

  /* ── HOME ── */
  if (sub === "home") return (
    <div>
      <h1 style={h1}>{st.scan_title}</h1>
      <p style={{ fontSize: 13, color: C.textDim, lineHeight: 1.55, margin: "8px 0 18px" }}>{st.scan_sub}</p>
      {errBox}
      <button style={gradBtn} onClick={() => { haptic(8); setPhotos([null, null, null]); setError(null); setSub("scan"); }}>
        {Icon.scan(16)} {st.scan_cta}
      </button>

      {/* Experto: opción bajo el escáner */}
      <button
        onClick={() => { haptic(8); setError(null); setSub("expert"); }}
        style={{ ...card, width: "100%", marginTop: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, textAlign: "inherit", fontFamily: "inherit" }}
      >
        <div style={{ width: 38, height: 38, borderRadius: 12, background: "#e8f5ef", color: C.brand1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          {Icon.chat(17)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontWeight: 600, fontSize: 15, color: C.text }}>{st.expert}</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{st.expert_sub}</div>
        </div>
        <span style={{ color: C.textGhost }}>{Icon.chevRight(16)}</span>
      </button>

      <h2 style={sectionTitle}>{st.recent}</h2>
      {recent.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(130px,1fr))", gap: 10 }}>
          {recent.map(p => confirmDelId === p.id ? (
            <div key={p.id} style={{ ...card, padding: "14px 12px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, color: C.text, textAlign: "center" }}>{st.confirm_del}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => {
                    setRecent(r => r.filter(x => x.id !== p.id));
                    setConfirmDelId(null);
                    bridge.suppDelScan(p.id).catch(() => loadRecent());
                  }}
                  style={{ width: 34, height: 34, borderRadius: "50%", border: 0, cursor: "pointer", background: C.afternoon.icon, color: "#fff", fontSize: 14, fontWeight: 700 }}
                >✓</button>
                <button
                  onClick={() => setConfirmDelId(null)}
                  style={{ width: 34, height: 34, borderRadius: "50%", border: `1px solid ${C.borderStrong}`, cursor: "pointer", background: "transparent", color: C.textDim, fontSize: 13 }}
                >✕</button>
              </div>
            </div>
          ) : (
            <div key={p.id} style={{ position: "relative" }}>
              <div role="button" tabIndex={0} onClick={() => openProduct(p.id)} style={{ ...card, padding: "14px 12px", cursor: "pointer" }}>
                <div className="nr-mono" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: scanScoreColor(p.overall_score) }}>{p.overall_score}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, margin: "8px 0 2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.product_name}</div>
                <div style={{ fontSize: 11, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.brand}</div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); haptic(8); setConfirmDelId(p.id); }}
                aria-label={st.confirm_del}
                style={{
                  position: "absolute", top: 6, insetInlineEnd: 6,
                  width: 22, height: 22, borderRadius: "50%", border: 0, cursor: "pointer",
                  background: C.bgSoft, color: C.textMuted, fontSize: 11, lineHeight: 1,
                  display: "flex", alignItems: "center", justifyContent: "center"
                }}
              >✕</button>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: C.textMuted, padding: "16px 0", textAlign: "center" }}>{st.empty_recent}</div>
      )}
    </div>
  );

  /* ── SCAN ── */
  if (sub === "scan") {
    const steps = [
      { title: st.step1, s: st.step1s, opt: false },
      { title: st.step2, s: st.step2s, opt: true },
      { title: st.step3, s: st.step3s, opt: true }
    ];
    return (
      <div>
        <button style={backBtn} onClick={() => { setSub("home"); loadRecent(); }}>{Icon.chevLeft(13)} {st.back}</button>
        <h1 style={h1}>{st.scan_cta}</h1>
        {errBox}
        <div style={{ marginTop: 14 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ ...card, display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
              <div
                onClick={() => fileRefs[i].current && fileRefs[i].current.click()}
                style={{ width: 64, height: 64, borderRadius: 12, flexShrink: 0, border: photos[i] ? `1.5px solid ${C.brand1}` : `1.5px dashed ${C.borderStrong}`, background: C.bgSoft, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: C.textMuted, overflow: "hidden", cursor: "pointer" }}
              >
                {photos[i] ? <img src={photos[i]} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : "✛"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{s.title}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{s.s}{s.opt ? " · " + st.optional : ""}</div>
                <button
                  onClick={() => fileRefs[i].current && fileRefs[i].current.click()}
                  style={{ fontFamily: "Oswald,sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.brand1, background: "none", border: 0, cursor: "pointer", padding: "4px 0" }}
                >
                  {photos[i] ? st.retake : "📷 " + st.add_photo}
                </button>
              </div>
              <input ref={fileRefs[i]} type="file" accept="image/*" capture="environment" hidden onChange={e => onPhoto(i, e.target.files && e.target.files[0])} />
            </div>
          ))}
        </div>
        <button style={{ ...gradBtn, marginTop: 6, ...(photos[0] ? {} : { background: C.border, color: C.textMuted, boxShadow: "none", cursor: "not-allowed" }) }} disabled={!photos[0]} onClick={doScan}>
          {st.analyze}
        </button>
      </div>
    );
  }

  /* ── LOADING ── */
  if (sub === "loading") return (
    <div style={{ textAlign: "center", padding: "60px 20px" }}>
      <div style={{ width: 44, height: 44, margin: "0 auto 18px", borderRadius: "50%", border: `3px solid ${C.border}`, borderTop: `3px solid ${C.brand1}`, animation: "spin 1s linear infinite" }} />
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted }}>{st.loading[loadMsg]}</div>
    </div>
  );

  /* ── PRODUCT ── */
  if (sub === "product") {
    const p = product || {};
    const s = p.scores || {};
    const bar = (label, val) => (
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "10px 0" }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: C.textMuted, width: 105, flexShrink: 0 }}>{label}</span>
        <div style={{ flex: 1, height: 7, borderRadius: 99, background: C.border, overflow: "hidden" }}>
          <div style={{ height: "100%", borderRadius: 99, width: (val || 0) + "%", background: scanScoreColor(val || 0), transition: "width 0.9s cubic-bezier(.22,1,.36,1)" }} />
        </div>
        <span className="nr-mono" style={{ fontSize: 13, fontWeight: 700, width: 32, textAlign: "end", flexShrink: 0, color: C.text }}>{val || 0}</span>
      </div>
    );
    const list = (items, good) => (
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0 }}>
        {items.map((x, i) => (
          <li key={i} style={{ display: "flex", gap: 10, fontSize: 13.5, lineHeight: 1.45, marginBottom: 9, color: C.text }}>
            <span style={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff", background: good ? C.brand1 : C.afternoon.icon }}>{good ? "+" : "–"}</span>
            <span>{x}</span>
          </li>
        ))}
      </ul>
    );
    return (
      <div>
        <button style={backBtn} onClick={() => { setSub("home"); loadRecent(); }}>{Icon.chevLeft(13)} {st.back}</button>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>{p.brand}</div>
        <h1 style={{ ...h1, marginBottom: 4 }}>{p.product_name}</h1>
        <ScoreRing score={s.overall || 0} label={st.overall} />
        <div style={card}>
          {bar(st.safety, s.safety)}
          {bar(st.efficacy, s.efficacy)}
          {bar(st.transparency, s.transparency)}
          {p.safety_summary && <p style={{ fontSize: 13, lineHeight: 1.55, color: C.textDim, margin: "10px 0 0" }}>{p.safety_summary}</p>}
        </div>
        {p.description && <p style={{ fontSize: 13.5, lineHeight: 1.55, color: C.text, margin: "12px 0 0" }}>{p.description}</p>}
        {p.good && p.good.length > 0 && <><h2 style={sectionTitle}>{st.good}</h2>{list(p.good, true)}</>}
        {p.bad && p.bad.length > 0 && <><h2 style={sectionTitle}>{st.bad}</h2>{list(p.bad, false)}</>}
        {p.ingredients && p.ingredients.length > 0 && (
          <>
            <h2 style={sectionTitle}>{st.ingredients}</h2>
            <div style={card}>
              <table className="nr-mono" style={{ fontSize: 12, width: "100%", borderCollapse: "collapse", color: C.text }}>
                <tbody>
                  {p.ingredients.map((ing, i) => (
                    <tr key={i}>
                      <td style={{ padding: "7px 4px", borderBottom: i === p.ingredients.length - 1 ? 0 : `1px solid ${C.border}` }}>{ing.name}</td>
                      <td style={{ padding: "7px 4px", borderBottom: i === p.ingredients.length - 1 ? 0 : `1px solid ${C.border}`, textAlign: "end", whiteSpace: "nowrap", color: C.textMuted }}>{[ing.amount, ing.unit].filter(Boolean).join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {p.alternatives_hint && p.alternatives_hint.length > 0 && <><h2 style={sectionTitle}>{st.alternatives}</h2>{list(p.alternatives_hint, true)}</>}

        {/* Añadir a mi rutina */}
        <h2 style={sectionTitle}>{st.add_routine}</h2>
        {addFeedback ? (
          <div style={{ ...card, textAlign: "center", fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, letterSpacing: "0.04em", color: addFeedback === "added" ? C.brand1 : C.textDim, background: addFeedback === "added" ? "#e8f5ef" : C.bgSoft }}>
            {addFeedback === "added" ? st.added : st.already}
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            {["morning", "afternoon", "night"].map(per => (
              <button
                key={per}
                onClick={() => { haptic(8); setAddFeedback(onAddToRoutine(p, per)); }}
                style={{ flex: 1, padding: "11px 4px", border: `1px solid ${C[per].border}`, borderRadius: 12, cursor: "pointer", background: C[per].bg, color: C[per].text, fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
              >
                <SectionIcon period={per} size={13} /> {t[per]}
              </button>
            ))}
          </div>
        )}

        {/* Preguntar al experto sobre este producto */}
        <button
          onClick={() => {
            haptic(8);
            setSub("expert");
            sendExpert(fillTpl(st.ask_product_msg, {
              name: p.product_name || "",
              brand: p.brand ? " (" + p.brand + ")" : "",
              score: s.overall || 0
            }));
          }}
          style={{ ...card, width: "100%", marginTop: 10, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, textAlign: "inherit", fontFamily: "inherit" }}
        >
          <div style={{ width: 34, height: 34, borderRadius: 10, background: "#e8f5ef", color: C.brand1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{Icon.chat(15)}</div>
          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: C.text }}>{st.ask_product}</span>
          <span style={{ color: C.textGhost }}>{Icon.chevRight(15)}</span>
        </button>

        {p.disclaimer && <p style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.5, marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>{p.disclaimer}</p>}
      </div>
    );
  }

  /* ── EXPERT ── */
  // Preguntas iniciales personalizadas desde la rutina real; genéricas si no hay.
  const suppNames = [...new Set(
    ["morning", "afternoon", "night"]
      .flatMap(per => (routine && routine[per]) || [])
      .map(x => (x.name || "").trim())
      .filter(Boolean)
  )];
  const starterQs = suppNames.length >= 2
    ? [fillTpl(st.pq_when, { a: suppNames[0] }), fillTpl(st.pq_combo, { a: suppNames[0], b: suppNames[1] }), fillTpl(st.pq_food, { a: suppNames[1] })]
    : suppNames.length === 1
      ? [fillTpl(st.pq_when, { a: suppNames[0] }), fillTpl(st.pq_food, { a: suppNames[0] }), st.q2]
      : [st.q1, st.q2, st.q3];

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "55vh" }}>
      <button style={backBtn} onClick={() => { setSub("home"); loadRecent(); }}>{Icon.chevLeft(13)} {st.back}</button>
      {chat.length === 0 ? (
        <div>
          <div style={{ textAlign: "center", margin: "26px 0 20px" }}>
            <div style={{ width: 46, height: 46, borderRadius: 14, background: "#e8f5ef", color: C.brand1, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>{Icon.chat(20)}</div>
            <h1 style={{ ...h1, fontSize: 20 }}>{st.expert_title}</h1>
          </div>
          {starterQs.map((q, i) => (
            <button key={i} onClick={() => sendExpert(q)} style={{ ...card, width: "100%", padding: "13px 16px", fontSize: 13.5, color: C.text, cursor: "pointer", marginBottom: 8, textAlign: "inherit", fontFamily: "inherit", transition: "border-color 0.12s" }}>
              {q}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
          {chat.map((m, i) => m.role === "user" ? (
            <div key={i} style={{ alignSelf: lang === "ea" ? "flex-start" : "flex-end", maxWidth: "85%", padding: "11px 14px", borderRadius: 16, borderBottomRightRadius: lang === "ea" ? 16 : 4, borderBottomLeftRadius: lang === "ea" ? 4 : 16, fontSize: 13.5, lineHeight: 1.5, background: C.brandGrad, color: "#fff", whiteSpace: "pre-wrap" }}>{m.content}</div>
          ) : (
            <div key={i} className="nr-expert-msg" style={{ ...card, padding: "14px 16px", fontSize: 14, lineHeight: 1.65, color: C.text }} dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />
          ))}
          {chatBusy && (
            <div style={{ ...card, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10, color: C.textMuted, fontSize: 12, fontFamily: "Oswald,sans-serif", letterSpacing: "0.08em", textTransform: "uppercase" }}>
              <span style={{ display: "inline-flex", gap: 4 }}>
                <i style={{ width: 7, height: 7, borderRadius: "50%", background: C.brand1, display: "inline-block", animation: "d1 1.2s ease-in-out infinite" }} />
                <i style={{ width: 7, height: 7, borderRadius: "50%", background: C.brand1, display: "inline-block", animation: "d2 1.2s ease-in-out infinite" }} />
                <i style={{ width: 7, height: 7, borderRadius: "50%", background: C.brand1, display: "inline-block", animation: "d3 1.2s ease-in-out infinite" }} />
              </span>
              {st.thinking}
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
      )}
      {errBox}
      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <input
          type="text"
          value={chatInput}
          disabled={chatBusy}
          placeholder={st.type_msg}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && chatInput.trim()) sendExpert(chatInput.trim()); }}
          style={{ flex: 1, padding: "13px 16px", borderRadius: 999, border: `1.5px solid ${C.borderStrong}`, fontFamily: "inherit", fontSize: 14, background: C.surface, color: C.text, outline: "none" }}
        />
        <button
          onClick={() => { if (chatInput.trim()) sendExpert(chatInput.trim()); }}
          disabled={chatBusy || !chatInput.trim()}
          style={{ width: 48, height: 48, borderRadius: "50%", border: 0, cursor: chatBusy ? "default" : "pointer", background: (chatBusy || !chatInput.trim()) ? C.border : C.brandGrad, color: "#fff", fontSize: 18, flexShrink: 0 }}
        >↑</button>
      </div>
    </div>
  );
}

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
  // Estado de suscripción neo-push (informativo). null = desconocido (bridge
  // no disponible / aún sin responder), true/false = estado real vía el parent.
  // El permiso/suscripción lo gobierna el GATE de /supplement/, aguas arriba.
  const [subscribed, setSubscribed] = useState(null);
  const [aiMsg, setAiMsg] = useState(null);
  const [warns, setWarns] = useState([]);
  const [toast, setToast] = useState(null);
  const [viewDate, setViewDate] = useState(() => localDateKey());
  const [compactManual, setCompactManual] = useState(null);
  const [milestone, setMilestone] = useState(null);
  const [shownMilestones, setShownMilestones] = useState([]);
  const [onboardingDraft, setOnboardingDraft] = useState(null);
  const [showRegenConfirm, setShowRegenConfirm] = useState(false);
  const [showRoutineInfo, setShowRoutineInfo] = useState(false);

  const today = localDateKey();
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

        // 2b. Estado de suscripción neo-push para el badge informativo de Ajustes.
        //     Fire-and-forget: no bloquea la hidratación y degrada a null si el
        //     parent no responde (nunca error ni spinner).
        bridge.isSubscribed().then(setSubscribed).catch(() => {});
        bridge.metric("open");

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

          // reminders (fix: faltaba en el merge — si localStorage se vacía,
          // p.ej. ITP de Safari en iframes cross-origin, las horas volvían a
          // los defaults aunque el servidor tuviera las buenas)
          const localRemsTs = getLocalTs("neo-reminders");
          if (remote.reminders_ts > localRemsTs && remote.reminders) {
            const rr = { ...remote.reminders };
            const currentTz = (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC") || "UTC";
            if (rr.tz !== currentTz) {
              // La tz del dispositivo manda (el cron la necesita real):
              // storage.set guarda local y repushea con ts nuevo
              rr.tz = currentTz;
              storage.set("neo-reminders", JSON.stringify(rr));
            } else {
              try { localStorage.setItem("neo-reminders", JSON.stringify(rr)); } catch {}
              try { localStorage.setItem("neo-reminders-ts", String(remote.reminders_ts)); } catch {}
            }
            setRems(rr);
          } else if (localRemsTs > remote.reminders_ts) {
            try {
              const cur = localStorage.getItem("neo-reminders");
              if (cur) {
                __nrSyncPending.reminders = JSON.parse(cur);
                __nrSyncPending.reminders_ts = localRemsTs;
              }
            } catch { /* ignore */ }
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
      const k = localDateKey(d);
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
      const first = new Date(keys[0] + "T12:00:00"); // mediodía local: evita off-by-one en tz negativas
      const last = new Date();
      let run = 0, graces = 0;
      for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
        const k = localDateKey(d);
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
          // Recordatorio local best-effort mientras la página está abierta.
          // Los recordatorios reales llegan por neo-push (cron server-side).
          if (subscribed === true && "Notification" in window) new Notification("NeoRejuvenation", { body: msg });
          setToast(msg);
          setTimeout(() => setToast(null), 6000);
        }
      });
    }, 30000);
    return () => clearInterval(reminderRef.current);
  }, [appState, rems, routine, subscribed, t]);

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
      bridge.metric("day_complete");
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

  /* Densidad automática Y medida: nivel base por nº de suplementos
     (≤4 normal · 5-7 compacto · ≥8 denso) y, tras renderizar, se mide la
     altura real contra la pantalla: si no cabe, sube un nivel (hasta
     "ultra", tipografía reducida) hasta que quepa todo sin scroll. */
  const totalCount = allSupps.length;
  const [densityBump, setDensityBump] = useState(0);
  const baseLevel = totalCount >= 8 ? 2 : totalCount >= 5 ? 1 : (compactManual ? 1 : 0);
  const level = Math.min(3, baseLevel + densityBump);
  const compact = level >= 1;
  const dense = level >= 2;
  const ultra = level >= 3;

  // Recalibración por época: el ajuste medido vuelve a 0 (pre-pintado, sin
  // parpadeo) siempre que cambia el contexto de layout, y la medición vuelve
  // a escalar solo lo necesario. Antes solo sabía subir y se quedaba pegado
  // en niveles altos (hueco vacío bajo la lista).
  useLayoutEffect(() => { setDensityBump(0); }, [totalCount, viewDate, view]);
  useEffect(() => {
    const onResize = () => setDensityBump(0);
    window.addEventListener("resize", onResize);
    // Las fuentes web cambian las métricas del texto: recalibrar al cargar
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => setDensityBump(0)).catch(() => {});
    }
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Medición síncrona pre-pintado: ¿desborda la pantalla? → sube un nivel
  useLayoutEffect(() => {
    if (appState !== "dashboard" || view !== "today") return;
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    if (overflow > 4 && level < 3) setDensityBump(b => b + 1);
  }, [appState, view, level, totalCount, viewDate]);

  /* Handlers */
  const [deleteTarget, setDeleteTarget] = useState(null); // { supp, period }

  const requestDeleteSupp = useCallback((supp, period) => {
    setDeleteTarget({ supp, period });
  }, []);

  const confirmDeleteSupp = useCallback(() => {
    if (!deleteTarget || !routine) { setDeleteTarget(null); return; }
    const { supp, period } = deleteTarget;
    const next = { ...routine, [period]: (routine[period] || []).filter(x => x.id !== supp.id) };
    setRoutine(next);
    storage.set("neo-routine", JSON.stringify({ routine: next, personalMessage: aiMsg, warnings: warns }));
    setDeleteTarget(null);
  }, [deleteTarget, routine, aiMsg, warns]);

  const addSuppToRoutine = useCallback((product, period) => {
    if (!routine || !["morning", "afternoon", "night"].includes(period)) return "err";
    const name = (product.product_name || "").trim();
    if (!name) return "err";
    const exists = (routine[period] || []).some(s => (s.name || "").trim().toLowerCase() === name.toLowerCase());
    if (exists) return "already";
    const supp = {
      id: "scan-" + (product.id || "x") + "-" + Date.now().toString(36),
      name,
      dose: "",
      brand: product.brand || "",
      benefits: [],
      notes: "",
      frequency: "daily"
    };
    const next = { ...routine, [period]: [...(routine[period] || []), supp] };
    setRoutine(next);
    storage.set("neo-routine", JSON.stringify({ routine: next, personalMessage: aiMsg, warnings: warns }));
    bridge.metric("add_routine", name);
    return "added";
  }, [routine, aiMsg, warns]);

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
    const newKey = localDateKey(d);
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
        model: "claude-sonnet-4-6",
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
        routine: buildFallbackRoutine(lang),
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

  /* Nav superior condensada: Suplementos | Progreso | Escáner | Ajustes.
     "scanner" es una vista interna (Escáner + Experto integrados vía bridge). */
  const tabs = [
    { id: "today", l: t.nav_tracker, icon: Icon.pill },
    { id: "progress", l: t.tab_progress, icon: Icon.chart },
    { id: "scanner", l: t.nav_scanner, icon: Icon.scan },
    { id: "settings", l: t.tab_settings, icon: Icon.gear }
  ];

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

      {/* Delete supplement confirmation modal */}
      {deleteTarget && (
        <DeleteSuppModal
          supp={deleteTarget.supp}
          t={t}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDeleteSupp}
        />
      )}

      {/* Regen confirmation modal */}
      {showRegenConfirm && (
        <RegenConfirmModal
          streak={streak}
          t={t}
          onCancel={() => setShowRegenConfirm(false)}
          onConfirm={confirmRegen}
        />
      )}

      {/* Top tabs (only in dashboard) */}
      {appState === "dashboard" && (
        <div style={{
          padding: "16px 20px 0",
          position: "sticky", top: 0, zIndex: 10,
          background: `${C.bg}ee`, backdropFilter: "blur(20px)"
        }}>
          <div style={{
            display: "flex", gap: 4, padding: 5,
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 999, boxShadow: "0 6px 24px rgba(26,34,64,0.08)"
          }}>
            {tabs.map(tab => {
              const active = view === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => { if (!active) { haptic(8); setView(tab.id); } }}
                  style={{
                    flex: 1, padding: "7px 2px 6px", border: "none",
                    background: active ? "#e8f5ef" : "transparent",
                    cursor: active ? "default" : "pointer",
                    color: active ? C.brand1 : C.textMuted,
                    fontSize: 9.5,
                    fontWeight: 600,
                    borderRadius: 999,
                    transition: "all 0.2s",
                    fontFamily: "Oswald,sans-serif",
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center", gap: 3,
                    whiteSpace: "nowrap", overflow: "hidden"
                  }}
                >
                  {tab.icon(15)} {tab.l}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ padding: "20px", paddingBottom: 24 }}>
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

        {appState === "dashboard" && routine && (
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

                {/* HERO: date + swipe hint + ring */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: ultra ? 5 : dense ? 8 : compact ? 10 : 14 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 500, marginBottom: 4 }}>
                      {eyebrowDate}
                    </div>
                    <h1 style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, fontSize: 22, lineHeight: 1.15, color: C.text, letterSpacing: "-0.01em" }}>
                      {t.today_header}
                    </h1>
                  </div>
                  <div style={{
                    alignSelf: "center", flexShrink: 0,
                    display: "flex", alignItems: "center", gap: 4,
                    fontSize: 10, color: C.textGhost,
                    maxWidth: 120, textAlign: "center", lineHeight: 1.3
                  }}>
                    {Icon.chevLeft(12)} {t.swipe_hint} {Icon.chevRight(12)}
                  </div>
                  <Ring pct={pct} size={ultra ? 48 : dense ? 56 : compact ? 62 : 72} stroke={ultra ? 4.5 : dense ? 5 : compact ? 5.5 : 6} />
                </div>

                {/* Streak pill */}
                {streak > 0 && (
                  <div style={{ display: "flex", alignItems: "center", marginBottom: ultra ? 8 : dense ? 10 : compact ? 12 : 22 }}>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      padding: "5px 11px 5px 9px", borderRadius: 20,
                      background: C.morning.bg, border: `1px solid ${C.morning.border}`,
                      color: C.morning.text, fontSize: 11, fontWeight: 600,
                      fontFamily: "Oswald,sans-serif"
                    }}>
                      {Icon.flame(13)} {streak} {t.streak_label}
                    </span>
                  </div>
                )}

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
                        {sanitizeText(aiMsg) || (warns.length > 0 ? `⚠️ ${sanitizeText(warns[0])}` : "")}
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
                            <p style={{ fontSize: 12, color: C.textDim, lineHeight: 1.55, margin: 0 }}>{sanitizeText(aiMsg)}</p>
                          </div>
                        )}
                        {warns.map((w, i) => (
                          <div key={i} style={{
                            padding: "10px 13px", background: C.warningBg,
                            border: `1px solid ${C.morning.border}`, borderRadius: 10,
                            marginBottom: 6, fontSize: 11, color: C.warning
                          }}>⚠️ {sanitizeText(w)}</div>
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
                      dense={dense}
                      ultra={ultra}
                      t={t}
                      readOnly={!isToday}
                      isLast={isLastNonEmpty}
                      isRTL={isRTL}
                      onDelete={isToday ? requestDeleteSupp : null}
                    />
                  );
                })}

                {/* Daily note (oculta tras flag SHOW_DAILY_NOTES — datos y sync intactos) */}
                {SHOW_DAILY_NOTES && (
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
                )}

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

            {/* Escáner + Experto: siempre montado para conservar chat/fotos al cambiar de tab */}
            <div style={{ display: view === "scanner" ? "block" : "none" }}>
              <ScannerView lang={lang} active={view === "scanner"} t={t} routine={routine} onAddToRoutine={addSuppToRoutine} />
            </div>

            {view === "settings" && (
              <SettingsView
                rems={rems} onRem={remUpdate}
                subscribed={subscribed} onRegen={regen} routine={routine}
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
