import { useState, useEffect, useRef } from "react";

/* ═══════════════════════════════════════════════════════════════
   NEO SUBCONSCIENTE — Fase 1 (MVP)
   Método NeoRejuvenation · Módulo 2 (Antonio Moll)
   Liberación de memorias subconscientes: vasos de cristal + mantras.
   Misma arquitectura que neo-tracker: bridge postMessage + localStorage.
   Namespace propio de mensajes: "nrm-*" (los atiende un snippet nuevo
   en WordPress; ver README-SUBCONSCIENTE.md).
   ═══════════════════════════════════════════════════════════════ */

/* ───────────────── POSTMESSAGE BRIDGE ───────────────── */
const bridge = (() => {
  const inIframe = (typeof window !== "undefined" && window.parent && window.parent !== window);
  let parentOrigin = "*";
  try {
    if (typeof document !== "undefined" && document.referrer) {
      parentOrigin = new URL(document.referrer).origin;
    }
  } catch {}
  let available = null;
  const pending = {};
  const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  const send = (type, payload, timeout = 15000) => {
    return new Promise((resolve, reject) => {
      if (!inIframe) { reject(new Error("not-in-iframe")); return; }
      if (available === false) { reject(new Error("bridge-unavailable")); return; }
      const requestId = genId();
      const timer = setTimeout(() => { delete pending[requestId]; reject(new Error("bridge-timeout")); }, timeout);
      pending[requestId] = { resolve, reject, timer };
      try {
        window.parent.postMessage({ type, requestId, payload }, parentOrigin);
      } catch (e) {
        clearTimeout(timer); delete pending[requestId]; reject(e);
      }
    });
  };

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      if (!event.data || typeof event.data !== "object") return;
      if (event.source !== window.parent) return;
      const { type, requestId } = event.data;
      if (!type || typeof type !== "string") return;
      if (type.indexOf("nrm-") !== 0) return;
      if (event.origin && event.origin !== "null") parentOrigin = event.origin;
      const p = pending[requestId];
      if (!p) return;
      clearTimeout(p.timer);
      delete pending[requestId];
      if (event.data.ok === false) p.reject(new Error(event.data.error || "bridge-error"));
      else p.resolve(event.data);
    });
  }

  const handshake = async () => {
    if (!inIframe) { available = false; return false; }
    try { await send("nrm-bridge-ping", null, 2000); available = true; return true; }
    catch { available = false; return false; }
  };

  return {
    handshake,
    isAvailable: () => available === true,
    pullState: () => send("nrm-state-pull", null).then(r => r.data),
    pushState: (p) => send("nrm-state-push", p).then(r => r.data),
    metric: (event, meta) => send("nrm-metric", { event, meta: meta || "" }, 4000).catch(() => {})
  };
})();

/* ───────────────── STORAGE (local-first + sync opcional) ───────────────── */
const SYNCED_KEY_MAP = {
  "nrm-profile": "profile",
  "nrm-releases": "releases",
  "nrm-history": "history",
  "nrm-reminders": "reminders"
};
let __syncTimer = null;
let __syncPending = {};
let __hydrating = true;

const flushPush = async () => {
  const batch = __syncPending;
  __syncPending = {};
  if (!bridge.isAvailable() || Object.keys(batch).length === 0) return;
  try { await bridge.pushState(batch); } catch {}
};
const queuePush = (shortKey, value, ts) => {
  __syncPending[shortKey] = { value, ts };
  if (__hydrating) return;
  if (__syncTimer) clearTimeout(__syncTimer);
  __syncTimer = setTimeout(flushPush, 800);
};

const storage = {
  get: (k) => {
    try { const v = localStorage.getItem(k); return v ? { value: v } : null; }
    catch { return null; }
  },
  set: (k, v) => {
    try { localStorage.setItem(k, v); } catch {}
    const shortKey = SYNCED_KEY_MAP[k];
    if (shortKey) {
      const ts = Date.now();
      try { localStorage.setItem(k + "-ts", String(ts)); } catch {}
      try { queuePush(shortKey, JSON.parse(v), ts); } catch {}
    }
  }
};
const getLocalTs = (k) => {
  try { return parseInt(localStorage.getItem(k + "-ts") || "0", 10) || 0; }
  catch { return 0; }
};

const localDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ───────────────── LANG ───────────────── */
const detectLang = () => {
  const supported = ["es", "en", "fr", "de", "pt", "it", "ea"];
  try {
    const p = new URLSearchParams(window.location.search).get("lang");
    if (p && supported.includes(p.toLowerCase())) return p.toLowerCase();
    const pathMatch = window.location.pathname.match(/\/(ea|en|fr|de|pt|it)(\/|$)/);
    if (pathMatch) return pathMatch[1];
  } catch {}
  return "es";
};

/* ───────────────── I18N (ES completo; resto de idiomas: Fase 3) ───────────────── */
const T = {
  es: {
    appTitle: "Subconsciente",
    appSub: "Liberación de memorias · Método NeoRejuvenation",
    tab_today: "Hoy",
    tab_progress: "Progreso",
    tab_method: "Método",
    /* Onboarding / disclaimer */
    welcome_title: "Reprograma tu subconsciente",
    welcome_body: "El envejecimiento es la acumulación de capas de información no deseadas o incompatibles con nuestra esencia. En este espacio aprenderás a liberar las memorias subconscientes que generan los efectos que no deseas experimentar, con las dos herramientas del Módulo 2: los vasos de cristal y los mantras.",
    disclaimer: "NeoRejuvenation no es una terapia para la prolongación de la vida ni la cura de ninguna enfermedad o afección física o psíquica. No sustituye tratamiento, terapia o consulta médica, farmacológica, psicológica o psiquiátrica en ningún caso.",
    welcome_cta: "Comenzar el test de auto-observación",
    welcome_skip: "Saltar test, crear mi primera liberación",
    /* Test */
    test_title: "Auto-observación",
    test_sub: "Escribe el primer pensamiento que aparezca, sin cuestionarte nada más. Nadie más va a leerlo. No serás mejor ni peor escribas lo que escribas: son memorias que ni siquiera te pertenecen (no eres tú, no te definen).",
    test_placeholder: "Escribe lo primero que venga…",
    test_next: "Siguiente",
    test_back: "Atrás",
    test_finish: "Ver mi mapa de memorias",
    test_progress: "de",
    /* Resultado test */
    result_title: "Tu mapa de memorias",
    result_sub: "Estas respuestas apuntan a los siguientes registros de información presentes en tu subconsciente. Recuerda: aparezca lo que aparezca, se puede liberar.",
    result_root: "Creencias raíz detectadas",
    result_pick: "Elige por cuál empezar (puedes tener hasta 5 liberaciones activas). Antonio aconseja empezar por lo que más te preocupe.",
    result_custom: "O escribe tu propio problema / creencia",
    result_start: "Comenzar liberación",
    reflect_q: "Pregúntate: ¿esto que pienso es una verdad absoluta, inalterable, que sucede en el 100% de los casos y para todas las personas que viven o han vivido en este planeta? Si la respuesta es no, es una creencia subjetiva y puedes decidir transformarla.",
    /* Liberaciones */
    releases_title: "Tus liberaciones activas",
    releases_empty: "No tienes liberaciones activas. Crea la primera: comenzar lleva menos de 5 minutos.",
    release_new: "Nueva liberación",
    release_limit: "Máximo 5 liberaciones a la vez. Resuelve o cierra una para añadir otra (regla del método).",
    release_type_belief: "Creencia",
    release_type_effect: "Efecto / problema",
    release_tool_glass: "Vaso de cristal",
    release_tool_mantra: "Mantra",
    release_tool_both: "Ambas",
    release_what: "¿Qué deseas liberar?",
    release_what_ph: "Ej.: las canas · la creencia \"la edad me envejece\" · resistencias a hacer deporte…",
    release_tool_label: "Herramienta",
    release_create: "Activar liberación",
    release_cancel: "Cancelar",
    formula_label: "Tu fórmula de hoy (pronúnciala solo la primera vez del día):",
    formula_belief: "¿Qué memorias hay en mí que me hacen creer «{x}»? Quiero liberarlas.",
    formula_effect: "¿Qué memorias hay en mí que me hacen experimentar «{x}»? Quiero liberarlas.",
    glass_am: "Vaciado mañana",
    glass_pm: "Vaciado noche",
    glass_paper: "Papel bajo el vaso:",
    mantra_label: "«Gracias, Te Amo»",
    mantra_add5: "+5 min",
    mantra_today: "hoy",
    mantra_goal: "de ~30 min",
    day_done: "Proceso de hoy completado",
    close_release: "Cerrar liberación",
    close_title: "¿Por qué cierras esta liberación?",
    close_mirror: "Veo el cambio reflejado (en el espejo / en mi experiencia)",
    close_solved: "He encontrado una solución clara",
    close_indiff: "Ha dejado de incomodarme / importarme",
    close_pause: "Pausa (viaje) — se retomará donde estaba, no pierdes nada",
    close_confirm: "Confirmar",
    days_active: "días sostenidos",
    resumed: "Liberación reanudada. El proceso continúa, no comienzas de cero.",
    resume: "Reanudar",
    paused_label: "En pausa",
    /* Racha */
    streak_label: "días en racha",
    streak_hint: "Un día cuenta cuando atiendes todas tus liberaciones activas (vasos vaciados 2× y/o sesiones de mantra).",
    progress_title: "Tu progreso",
    last7: "Últimos 7 días",
    resolved_count: "liberaciones resueltas",
    active_count: "activas",
    record_label: "Récord",
    days: "días",
    iras_title: "Expectativas realistas (IRAS)",
    iras_body: "Intención · Repetición · Acción · Sostenida. Plazos orientativos de regeneración: epidermis ~1 mes · órganos 3-6 meses · hígado 4-15 meses · cabello 10-20 meses · transformación global 10-12 meses · huesos 4-7 años. Tu subconsciente aplica un filtro de seguridad: «llevo años ejecutando este proceso, ¿estás seguro? te doy tiempo para que decidas con claridad». La constancia es la clave, no la intensidad.",
    /* Método / reglas */
    method_title: "El método",
    method_glass_title: "Vasos de cristal",
    method_glass_rules: [
      "Vaso de cristal o vidrio transparente (nunca plástico, ni de chupito).",
      "Llénalo con ¾ (tres cuartas partes) de agua limpia, del grifo o embotellada. No se bebe.",
      "Escribe el problema o creencia en un papel y colócalo debajo del vaso, a modo de posavasos. Puede estar doblado: nadie tiene por qué leerlo.",
      "Vacía el agua por completo en el desagüe y vuelve a llenar, 2 veces al día (mañana y noche).",
      "1 sola creencia/problema por vaso. Máximo 5 vasos a la vez.",
      "Mínimo 2 metros de distancia entre vasos.",
      "Nunca escondas el vaso: esconder y liberar son contradictorios.",
      "Renueva el papel cuando se deteriore.",
      "Si viajas, el proceso queda en pausa y lo retomas donde estaba (puedes continuar con otros vasos allá donde estés)."
    ],
    method_mantra_title: "Mantras",
    method_mantra_rules: [
      "Las palabras son exactamente «Gracias, Te Amo». No se aconseja crear mantras propios.",
      "Repítelo mental y suavemente, para ti y desde ti. En voz alta no es más efectivo.",
      "No necesitas sentir gratitud o amor: funciona igual sea cual sea tu estado de ánimo.",
      "Como magnitud general, menos de 30 minutos al día no ejerce una acumulación suficiente. No hace falta que sean seguidos: 5 min ahora, 10 después…",
      "Formúlate la pregunta solo la primera vez de cada día; después el subconsciente ya sabe lo que estás haciendo.",
      "Compatible con cualquier actividad: pasear, ver la TV, hacer deporte…",
      "No escuches grabaciones ni afirmaciones mientras duermes: interfiere con los procesos naturales de reparación nocturna (Módulo 6)."
    ],
    method_adn_title: "Condiciones del ADN (Módulo 7)",
    method_adn_body: "Para que la liberación no quede incompleta: bebe entre 2 y 3,7 litros de agua al día y ejerce movimiento de contracción-relajación muscular a diario (caminar 5.000-10.000 pasos, yoga, pesas… lo que prefieras). Sin estas dos condiciones, difícilmente tu subconsciente podrá activar procesos de reparación.",
    method_resist_title: "Si aparecen resistencias",
    method_resist_body: "Pereza, «no tengo tiempo», «esto es superficial»… Son solo registros de información ejecutándose en automático; no son reales. No luches ni te fuerces: puedes liberar la propia resistencia creando una liberación con «resistencias a X». Desde la aceptación, a tu ritmo, como un juego.",
    /* Toasts / misc */
    toast_created: "Liberación activada. Prepara el vaso y el papel: comenzar lleva menos de 5 minutos.",
    toast_closed: "Liberación cerrada. Se ha liberado un espacio.",
    toast_day_done: "Has atendido todas tus liberaciones de hoy.",
    rem_title: "Recordatorios de vaciado",
    rem_hint: "Recibirás una notificación a la hora que elijas para vaciar y rellenar tus vasos.",
    rem_am: "Vaciado de la mañana",
    rem_pm: "Vaciado de la noche",
    loading: "Cargando…"
  }
};

/* ───────────────── TEST: frases incompletas (Módulo 2, pág. 27) ───────────────── */
const TEST_PROMPTS = {
  es: [
    { id: "belleza",   text: "La belleza es…" },
    { id: "juventud",  text: "La juventud es…" },
    { id: "edad10",    text: "Cuando tenga 10 años más que ahora, me veré…" },
    { id: "deterioro", text: "El deterioro físico lo provoca…" },
    { id: "joven",     text: "Para verme más joven necesito…" },
    { id: "cuidarme",  text: "Me gustaría cuidarme más, pero…" },
    { id: "espejo",    text: "Cuando me miro en el espejo pienso…" },
    { id: "menosedad", text: "Si tuviera menos edad podría…" },
    { id: "otrojoven", text: "Cuando veo a alguien que con mi edad parece mucho más joven, pienso…" },
    { id: "rejuv",     text: "El rejuvenecimiento es…" }
  ]
};

/* Mapeo por palabras clave a las 3 creencias raíz (análisis local; IA en Fase 2) */
const ROOTS = {
  es: [
    {
      id: "tiempo",
      label: "«El paso del tiempo es la causa del envejecimiento»",
      hint: "La edad pasa factura · cumplir años me envejece · con los años me deterioraré",
      kw: ["edad", "años", "tiempo", "viej", "mayor", "cumplir", "tarde", "ya no"]
    },
    {
      id: "normal",
      label: "«Envejecer es lo normal y natural, como el resto de la humanidad»",
      hint: "Es natural perder pelo / tener arrugas a cierta edad · lo veo en los demás",
      kw: ["normal", "natural", "todos", "todo el mundo", "los demás", "genétic", "herencia", "inevitable", "ley de vida"]
    },
    {
      id: "espiritual",
      label: "«Lo físico y lo espiritual son opuestos; cuidarse es superficial»",
      hint: "La belleza es superficial · lo importante está en el interior · vanidad",
      kw: ["superficial", "vanidad", "interior", "ego", "espirit", "frívol", "aparentar", "no importa"]
    }
  ]
};

const analyzeAnswers = (answers, lang) => {
  const roots = ROOTS[lang] || ROOTS.es;
  const joined = Object.values(answers).join(" · ").toLowerCase();
  const hits = roots.map(r => ({
    ...r,
    score: r.kw.reduce((acc, k) => acc + (joined.includes(k) ? 1 : 0), 0)
  }));
  const detected = hits.filter(h => h.score > 0).sort((a, b) => b.score - a.score);
  // Si no hay hits, mostramos las 3 raíces igualmente (heredadas casi universalmente, M2)
  return detected.length ? detected : hits;
};

/* ───────────────── PALETA + ESTILOS (idéntica a neo-tracker) ───────────────── */
const C = {
  bg: "#ffffff", bgSoft: "#f7f8fb", surface: "#ffffff", surfaceDone: "#fafbfd",
  border: "#eef0f6", borderStrong: "#e4e7ef",
  text: "rgba(26,34,64,0.85)", textDim: "#4a5578", textMuted: "#8590aa", textGhost: "#b5bdd0",
  brand1: "#0f6e56", brand2: "#5DCAA5", brandGrad: "linear-gradient(135deg,#0f6e56,#5DCAA5)",
  // Acento propio de Subconsciente (violeta suave — mente)
  mind: { bg: "#eeedfe", border: "#d8d5f2", text: "#3c3489", icon: "#534ab7" },
  am: { bg: "#fff6ec", border: "#fae2c4", text: "#854f0b" },
  pm: { bg: "#eeedfe", border: "#d8d5f2", text: "#3c3489" },
  success: "#0f6e56", successBg: "#e1f5ee",
  warning: "#854f0b", warningBg: "#fff6ec"
};

const injectFonts = () => {
  if (document.getElementById("nrm-fonts")) return;
  const l = document.createElement("link");
  l.id = "nrm-fonts"; l.rel = "stylesheet";
  l.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@500;600&family=Almarai:wght@400;700&family=Caveat:wght@500;600&display=swap";
  document.head.appendChild(l);
  const s = document.createElement("style");
  s.textContent = `
    @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
    @keyframes fadeUp { from { opacity: 0; transform: translate(-50%, 8px) } to { opacity: 1; transform: translate(-50%, 0) } }
    @keyframes spin { to { transform: rotate(360deg) } }
    @keyframes nrmUnfold {
      0%   { transform: scaleY(0.5) scaleX(0.5); box-shadow: 0 12px 20px rgba(26,34,64,0.25) }
      48%  { transform: scaleY(1)   scaleX(0.5); box-shadow: 0 8px 16px rgba(26,34,64,0.16) }
      52%  { transform: scaleY(1)   scaleX(0.5) }
      100% { transform: scaleY(1)   scaleX(1);   box-shadow: 0 3px 10px rgba(26,34,64,0.10) }
    }
    @keyframes nrmFlapH {
      0%       { transform: rotateX(-179deg) }
      48%,100% { transform: rotateX(0deg) }
    }
    @keyframes nrmFlapV {
      0%,52%   { transform: rotateY(179deg) }
      100%     { transform: rotateY(0deg) }
    }
    @keyframes nrmWrite { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0 -4% 0 0) } }
    button { -webkit-tap-highlight-color: transparent }
    textarea, input { font-family: inherit }
  `;
  document.head.appendChild(s);
};

const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };

/* ───────────────── ICONOS ───────────────── */
const Icon = {
  glass: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h12l-1.5 18h-9L6 3z" /><path d="M7 9h10" />
    </svg>
  ),
  heart: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3.4 1-4.5 2.5C10.9 4 9.3 3 7.5 3A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7 7-7z" />
    </svg>
  ),
  chart: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" /><path d="M7 14l4-4 3 3 5-6" />
    </svg>
  ),
  book: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  check: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  ),
  plus: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  brain: (s = 16) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.55a3 3 0 0 0-2.4 4.13A3 3 0 0 0 4 12a3 3 0 0 0 1.2 2.4A3 3 0 0 0 7 19h.05A2.5 2.5 0 0 0 12 19.5v-15A2.5 2.5 0 0 0 9.5 2z" />
      <path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.55a3 3 0 0 1 2.4 4.13A3 3 0 0 1 20 12a3 3 0 0 1-1.2 2.4A3 3 0 0 1 17 19h-.05A2.5 2.5 0 0 1 12 19.5" />
    </svg>
  )
};

/* ───────────────── APP ───────────────── */
export default function App() {
  const [lang] = useState(() => detectLang());
  const t = T[lang] || T.es;
  const isRTL = lang === "ea";
  const prompts = TEST_PROMPTS[lang] || TEST_PROMPTS.es;

  const [appState, setAppState] = useState("loading"); // loading | welcome | test | result | dashboard
  const [view, setView] = useState("today");           // today | progress | method
  const [profile, setProfile] = useState(null);        // { testAnswers, detectedRoots, createdAt }
  const [releases, setReleases] = useState([]);        // [{ id, type, text, tool, createdAt, status, pausedAt, closedAt, closedReason }]
  const [history, setHistory] = useState({});          // { "YYYY-MM-DD": { relId: { am, pm, mantraMin } } }
  const [rems, setRems] = useState({
    am: { time: "08:00", enabled: true },
    pm: { time: "21:00", enabled: true },
    tz: (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC") || "UTC"
  });
  const [toast, setToast] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [closeTarget, setCloseTarget] = useState(null);
  const [testIdx, setTestIdx] = useState(0);
  const [testAnswers, setTestAnswers] = useState({});
  const [detected, setDetected] = useState([]);
  const toastTimer = useRef(null);

  const today = localDateKey();

  const showToast = (msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  /* ── Hidratación ── */
  useEffect(() => {
    injectFonts();
    (async () => {
      __hydrating = true;
      const pR = storage.get("nrm-profile");
      const rR = storage.get("nrm-releases");
      const hR = storage.get("nrm-history");
      const remR = storage.get("nrm-reminders");
      const localProfile = pR ? JSON.parse(pR.value) : null;
      const localReleases = rR ? JSON.parse(rR.value) : [];
      const localHistory = hR ? JSON.parse(hR.value) : {};
      if (localProfile) setProfile(localProfile);
      if (localReleases.length) setReleases(localReleases);
      if (Object.keys(localHistory).length) setHistory(localHistory);
      if (remR) {
        try {
          const parsed = JSON.parse(remR.value);
          const currentTz = (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC") || "UTC";
          if (parsed.tz !== currentTz) {
            parsed.tz = currentTz;
            storage.set("nrm-reminders", JSON.stringify(parsed));
          }
          setRems(parsed);
        } catch {}
      }
      setAppState((localProfile || localReleases.length) ? "dashboard" : "welcome");

      const ok = await bridge.handshake();
      if (ok) {
        bridge.metric("open");
        try {
          const remote = await bridge.pullState();
          if (remote) {
            const apply = (short, localKey, setter, fallback) => {
              const r = remote[short];
              if (r && r.ts > getLocalTs(localKey)) {
                setter(r.value ?? fallback);
                try { localStorage.setItem(localKey, JSON.stringify(r.value ?? fallback)); localStorage.setItem(localKey + "-ts", String(r.ts)); } catch {}
              }
            };
            apply("profile", "nrm-profile", setProfile, null);
            apply("releases", "nrm-releases", setReleases, []);
            apply("history", "nrm-history", setHistory, {});
            apply("reminders", "nrm-reminders", setRems, null);
          }
        } catch {}
      }
      __hydrating = false;
      flushPush();
    })();
  }, []);

  /* ── Persistencia ── */
  const saveReleases = (next) => { setReleases(next); storage.set("nrm-releases", JSON.stringify(next)); };
  const saveHistory = (next) => { setHistory(next); storage.set("nrm-history", JSON.stringify(next)); };
  const saveProfile = (p) => { setProfile(p); storage.set("nrm-profile", JSON.stringify(p)); };
  const saveRems = (next) => { setRems(next); storage.set("nrm-reminders", JSON.stringify(next)); };

  /* ── Racha ── */
  const active = releases.filter(r => r.status === "active");
  const dayComplete = (dateKey, rels = active) => {
    const existing = rels.filter(r => (r.createdAt || "").slice(0, 10) <= dateKey);
    if (!existing.length) return false; // ningún release existía ese día → no cuenta
    const day = history[dateKey] || {};
    return existing.every(r => {
      const e = day[r.id] || {};
      if (r.tool === "glass") return e.am && e.pm;
      if (r.tool === "mantra") return (e.mantraMin || 0) >= 30;
      return (e.am && e.pm) || (e.mantraMin || 0) >= 30; // both: al menos una completa
    });
  };
  const streak = (() => {
    let s = 0;
    const d = new Date();
    // Si hoy aún no está completo, la racha empieza a contar desde ayer
    if (!dayComplete(localDateKey(d))) d.setDate(d.getDate() - 1);
    while (dayComplete(localDateKey(d))) { s++; d.setDate(d.getDate() - 1); }
    return s;
  })();

  /* ── Acciones ── */
  const toggleCheck = (relId, slot) => {
    haptic(10);
    const day = { ...(history[today] || {}) };
    const e = { ...(day[relId] || {}) };
    e[slot] = !e[slot];
    day[relId] = e;
    const next = { ...history, [today]: day };
    saveHistory(next);
    if (dayComplete(today)) showToast(t.toast_day_done);
  };

  const addMantra = (relId, min = 5) => {
    haptic(10);
    const day = { ...(history[today] || {}) };
    const e = { ...(day[relId] || {}) };
    e.mantraMin = (e.mantraMin || 0) + min;
    day[relId] = e;
    saveHistory({ ...history, [today]: day });
    if (dayComplete(today)) showToast(t.toast_day_done);
  };

  const createRelease = (type, text, tool) => {
    if (active.length >= 5) { showToast(t.release_limit); return; }
    const rel = {
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      type, text: text.trim(), tool,
      createdAt: new Date().toISOString(),
      status: "active"
    };
    saveReleases([...releases, rel]);
    setShowNew(false);
    bridge.metric("release_create", tool);
    showToast(t.toast_created);
  };

  const closeRelease = (relId, reason) => {
    const next = releases.map(r => r.id === relId
      ? (reason === "pause"
          ? { ...r, status: "paused", pausedAt: new Date().toISOString() }
          : { ...r, status: "closed", closedAt: new Date().toISOString(), closedReason: reason })
      : r);
    saveReleases(next);
    setCloseTarget(null);
    bridge.metric("release_close", reason);
    if (reason !== "pause") showToast(t.toast_closed);
  };

  const resumeRelease = (relId) => {
    if (active.length >= 5) { showToast(t.release_limit); return; }
    saveReleases(releases.map(r => r.id === relId ? { ...r, status: "active", pausedAt: null } : r));
    showToast(t.resumed);
  };

  const finishTest = () => {
    const det = analyzeAnswers(testAnswers, lang);
    setDetected(det);
    saveProfile({ testAnswers, detectedRoots: det.map(d => d.id), createdAt: new Date().toISOString() });
    setAppState("result");
  };

  const daysActive = (rel) => {
    const from = new Date(rel.createdAt);
    return Math.max(1, Math.round((Date.now() - from.getTime()) / 86400000));
  };

  /* ── UI helpers ── */
  const bodyFont = isRTL
    ? "Almarai, -apple-system, BlinkMacSystemFont, sans-serif"
    : "Inter, -apple-system, BlinkMacSystemFont, sans-serif";
  const oswald = "Oswald, sans-serif";

  const Card = ({ children, style }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 18, boxShadow: "0 4px 16px rgba(26,34,64,0.05)", ...style }}>{children}</div>
  );

  const PrimaryBtn = ({ children, onClick, disabled, style }) => (
    <button onClick={onClick} disabled={disabled} style={{
      width: "100%", padding: "13px 16px", border: "none", borderRadius: 12,
      background: disabled ? C.borderStrong : C.brandGrad, color: "#fff",
      fontSize: 14, fontWeight: 600, cursor: disabled ? "default" : "pointer",
      fontFamily: bodyFont, ...style
    }}>{children}</button>
  );

  const GhostBtn = ({ children, onClick, style }) => (
    <button onClick={onClick} style={{
      width: "100%", padding: "12px 16px", borderRadius: 12,
      background: "transparent", border: `1px solid ${C.borderStrong}`,
      color: C.textDim, fontSize: 13, fontWeight: 500, cursor: "pointer",
      fontFamily: bodyFont, ...style
    }}>{children}</button>
  );

  const tabs = [
    { id: "today", l: t.tab_today, icon: Icon.glass },
    { id: "progress", l: t.tab_progress, icon: Icon.chart },
    { id: "method", l: t.tab_method, icon: Icon.book }
  ];

  /* ═════════════════ RENDER ═════════════════ */
  return (
    <div dir={isRTL ? "rtl" : "ltr"} style={{
      fontFamily: bodyFont, background: C.bg, minHeight: "100vh",
      color: C.text, maxWidth: 520, margin: "0 auto", position: "relative"
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

      {/* Modal nueva liberación */}
      {showNew && (
        <NewReleaseModal t={t} C={C} bodyFont={bodyFont}
          onCancel={() => setShowNew(false)} onCreate={createRelease} />
      )}

      {/* Modal cierre */}
      {closeTarget && (
        <CloseModal t={t} C={C} bodyFont={bodyFont} rel={closeTarget}
          onCancel={() => setCloseTarget(null)}
          onConfirm={(reason) => closeRelease(closeTarget.id, reason)} />
      )}

      {/* Tabs (solo dashboard) */}
      {appState === "dashboard" && (
        <div style={{ padding: "16px 20px 0", position: "sticky", top: 0, zIndex: 10, background: `${C.bg}ee`, backdropFilter: "blur(20px)" }}>
          <div style={{ display: "flex", gap: 4, padding: 5, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 999, boxShadow: "0 6px 24px rgba(26,34,64,0.08)" }}>
            {tabs.map(tab => {
              const activeTab = view === tab.id;
              return (
                <button key={tab.id} onClick={() => { if (!activeTab) { haptic(8); setView(tab.id); } }}
                  style={{
                    flex: 1, padding: "7px 2px 6px", border: "none",
                    background: activeTab ? "#eeedfe" : "transparent",
                    cursor: activeTab ? "default" : "pointer",
                    color: activeTab ? C.mind.icon : C.textMuted,
                    fontSize: 9.5, fontWeight: 600, borderRadius: 999,
                    transition: "all 0.2s", fontFamily: oswald,
                    letterSpacing: "0.05em", textTransform: "uppercase",
                    display: "flex", flexDirection: "column", alignItems: "center",
                    justifyContent: "center", gap: 3, whiteSpace: "nowrap", overflow: "hidden"
                  }}>
                  {tab.icon(15)} {tab.l}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ padding: 20, paddingBottom: 32 }}>

        {/* LOADING */}
        {appState === "loading" && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
            <div style={{ width: 36, height: 36, border: `3px solid ${C.border}`, borderTop: `3px solid ${C.mind.icon}`, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
          </div>
        )}

        {/* WELCOME */}
        {appState === "welcome" && (
          <div style={{ animation: "fadeIn 0.25s", paddingTop: 24 }}>
            <div style={{ width: 52, height: 52, borderRadius: 16, background: C.mind.bg, border: `1px solid ${C.mind.border}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.mind.icon, marginBottom: 18 }}>
              {Icon.brain(26)}
            </div>
            <h1 style={{ fontFamily: oswald, fontSize: 26, fontWeight: 600, margin: "0 0 4px", color: C.text, textTransform: "uppercase", letterSpacing: "0.02em" }}>
              {t.welcome_title}
            </h1>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 18, fontFamily: oswald, letterSpacing: "0.08em", textTransform: "uppercase" }}>{t.appSub}</div>
            <p style={{ fontSize: 14, lineHeight: 1.65, color: C.textDim, marginBottom: 20 }}>{t.welcome_body}</p>
            <Card style={{ background: C.bgSoft, marginBottom: 24 }}>
              <div style={{ fontSize: 11.5, lineHeight: 1.6, color: C.textMuted }}>{t.disclaimer}</div>
            </Card>
            <PrimaryBtn onClick={() => { haptic(); setAppState("test"); }}>{t.welcome_cta}</PrimaryBtn>
            <div style={{ height: 10 }} />
            <GhostBtn onClick={() => { haptic(); saveProfile({ testAnswers: {}, detectedRoots: [], createdAt: new Date().toISOString(), skipped: true }); setAppState("dashboard"); setShowNew(true); }}>
              {t.welcome_skip}
            </GhostBtn>
          </div>
        )}

        {/* TEST */}
        {appState === "test" && (
          <div style={{ animation: "fadeIn 0.25s", paddingTop: 12 }}>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: oswald, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
              {t.test_title} · {testIdx + 1} {t.test_progress} {prompts.length}
            </div>
            {/* Barra de progreso */}
            <div style={{ height: 4, background: C.border, borderRadius: 99, marginBottom: 22 }}>
              <div style={{ height: "100%", width: `${((testIdx + 1) / prompts.length) * 100}%`, background: C.brandGrad, borderRadius: 99, transition: "width 0.3s" }} />
            </div>
            {testIdx === 0 && (
              <p style={{ fontSize: 12.5, lineHeight: 1.6, color: C.textMuted, marginBottom: 18 }}>{t.test_sub}</p>
            )}
            <h2 style={{ fontSize: 19, fontWeight: 600, margin: "0 0 16px", color: C.text, lineHeight: 1.4 }}>
              {prompts[testIdx].text}
            </h2>
            <textarea
              key={prompts[testIdx].id}
              value={testAnswers[prompts[testIdx].id] || ""}
              onChange={(e) => setTestAnswers({ ...testAnswers, [prompts[testIdx].id]: e.target.value })}
              placeholder={t.test_placeholder}
              rows={3}
              autoFocus
              style={{
                width: "100%", boxSizing: "border-box", padding: 14,
                border: `1px solid ${C.borderStrong}`, borderRadius: 12,
                fontSize: 14, lineHeight: 1.5, color: C.text, resize: "none",
                outline: "none", background: C.bgSoft
              }}
            />
            <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
              {testIdx > 0 && (
                <GhostBtn style={{ flex: 1 }} onClick={() => setTestIdx(testIdx - 1)}>{t.test_back}</GhostBtn>
              )}
              <PrimaryBtn style={{ flex: 2 }} onClick={() => {
                haptic();
                if (testIdx < prompts.length - 1) setTestIdx(testIdx + 1);
                else finishTest();
              }}>
                {testIdx < prompts.length - 1 ? t.test_next : t.test_finish}
              </PrimaryBtn>
            </div>
          </div>
        )}

        {/* RESULT */}
        {appState === "result" && (
          <TestResult t={t} C={C} bodyFont={bodyFont} oswald={oswald}
            detected={detected} Card={Card} PrimaryBtn={PrimaryBtn}
            onStart={(text, type) => {
              createRelease(type, text, "glass");
              setAppState("dashboard");
            }} />
        )}

        {/* DASHBOARD */}
        {appState === "dashboard" && (
          <>
            {view === "today" && (
              <div style={{ animation: "fadeIn 0.25s" }}>
                {/* Racha */}
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
                  <h2 style={{ fontFamily: oswald, fontSize: 20, fontWeight: 600, margin: 0, textTransform: "uppercase", letterSpacing: "0.02em" }}>{t.releases_title}</h2>
                  {streak > 0 && (
                    <div style={{ fontSize: 12, color: C.brand1, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="#e8a93c" stroke="#b7791f" strokeWidth="1" strokeLinejoin="round">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                      </svg>
                      {streak} {t.streak_label}
                    </div>
                  )}
                </div>

                {active.length === 0 && (
                  <Card style={{ textAlign: "center", padding: 28 }}>
                    <div style={{ color: C.mind.icon, marginBottom: 12, display: "flex", justifyContent: "center" }}>{Icon.glass(30)}</div>
                    <div style={{ fontSize: 13.5, color: C.textDim, lineHeight: 1.6 }}>{t.releases_empty}</div>
                  </Card>
                )}

                {active.map(rel => (
                  <ReleaseCard key={rel.id} rel={rel} t={t} C={C} oswald={oswald}
                    entry={(history[today] || {})[rel.id] || {}}
                    daysActive={daysActive(rel)}
                    onToggle={(slot) => toggleCheck(rel.id, slot)}
                    onMantra={() => addMantra(rel.id)}
                    onClose={() => setCloseTarget(rel)} />
                ))}

                {/* Pausadas */}
                {releases.filter(r => r.status === "paused").map(rel => (
                  <Card key={rel.id} style={{ marginTop: 12, opacity: 0.7 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 10, color: C.textMuted, fontFamily: oswald, letterSpacing: "0.08em", textTransform: "uppercase" }}>{t.paused_label}</div>
                        <div style={{ fontSize: 13.5, color: C.textDim, marginTop: 2 }}>{rel.text}</div>
                      </div>
                      <button onClick={() => resumeRelease(rel.id)} style={{ padding: "8px 14px", borderRadius: 10, border: `1px solid ${C.borderStrong}`, background: "transparent", color: C.brand1, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                        {t.resume}
                      </button>
                    </div>
                  </Card>
                ))}

                {/* Nueva liberación */}
                <button onClick={() => { haptic(); active.length >= 5 ? showToast(t.release_limit) : setShowNew(true); }}
                  style={{
                    width: "100%", marginTop: 16, padding: "14px 16px",
                    border: `1.5px dashed ${active.length >= 5 ? C.border : C.mind.border}`,
                    borderRadius: 14, background: "transparent",
                    color: active.length >= 5 ? C.textGhost : C.mind.icon,
                    fontSize: 13, fontWeight: 600, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8
                  }}>
                  {Icon.plus(15)} {t.release_new} ({active.length}/5)
                </button>

                <RemindersCard t={t} C={C} oswald={oswald} rems={rems} onChange={saveRems} />
              </div>
            )}

            {view === "progress" && (
              <ProgressView t={t} C={C} oswald={oswald} Card={Card}
                releases={releases} history={history} streak={streak}
                dayComplete={dayComplete} />
            )}

            {view === "method" && (
              <MethodView t={t} C={C} oswald={oswald} Card={Card} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────── COMPONENTES ───────────────── */

/** Papel doblado en cuartos: se desdobla con dos solapas 3D reales (abajo y derecha). */
function Paper({ text, label, C }) {
  const [epoch, setEpoch] = useState(1); // re-monta la animación al tocar
  const DUR = 1.3; // duración total del desdoblado (s)

  // Textura de grano de papel (ruido fractal SVG inline, muy sutil)
  const grain = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.42 0 0 0 0 0.38 0 0 0 0 0.28 0 0 0 0.07 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;
  const paperBase = `${grain}, linear-gradient(160deg,#fefdf8 0%,#faf7ee 55%,#f3efe0 100%)`;
  // Reverso de las solapas: papel algo más oscuro, sombreado hacia el pliegue
  const flapBack = (dir) => ({
    position: "absolute", inset: 0, borderRadius: 4,
    backgroundImage: `${grain}, linear-gradient(${dir},rgba(120,110,80,0.22) 0%,rgba(120,110,80,0.06) 45%,rgba(255,255,255,0) 100%), linear-gradient(160deg,#f6f2e6,#ece7d4)`,
    transform: dir.includes("bottom") ? "rotateX(180deg)" : "rotateY(180deg)",
    backfaceVisibility: "hidden",
    border: "1px solid #e3ddc8", boxSizing: "border-box",
    boxShadow: "0 6px 14px rgba(26,34,64,0.18)"
  });

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10.5, color: C.textMuted, marginBottom: 8, textAlign: "center" }}>{label}</div>
      <div key={epoch} style={{ perspective: 900, width: 240, margin: "0 auto" }}
        onClick={() => { haptic(8); setEpoch(e => e + 1); }} title={label}>
        <div style={{
          position: "relative", cursor: "pointer",
          width: 240, height: 205, boxSizing: "border-box",
          transformOrigin: "top left",
          transformStyle: "preserve-3d",
          animation: `nrmUnfold ${DUR}s ease-in-out both`,
          border: "1px solid #ece8da", borderRadius: 5,
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "20px 18px",
          // Capas del papel abierto: grano + dobleces en cruz + base
          backgroundImage: `
            ${grain},
            linear-gradient(to right, transparent calc(50% - 0.5px), rgba(120,110,80,0.18) 50%, transparent calc(50% + 0.5px)),
            linear-gradient(to bottom, transparent calc(50% - 0.5px), rgba(120,110,80,0.15) 50%, transparent calc(50% + 0.5px)),
            linear-gradient(160deg,#fefdf8 0%,#faf7ee 55%,#f5f1e3 100%)
          `,
          // Sombreado suave permanente junto a los pliegues (papel que estuvo doblado)
          boxShadow: "inset 0 0 22px rgba(120,110,80,0.06)"
        }}>
          {/* Solapa inferior: primer desdoblado (rotateX sobre el pliegue central) */}
          <div style={{
            position: "absolute", left: 0, right: 0, top: "50%", height: "50%",
            transformOrigin: "top center", transformStyle: "preserve-3d",
            animation: `nrmFlapH ${DUR}s ease-in-out both`, pointerEvents: "none"
          }}>
            <div style={flapBack("to bottom")} />
          </div>
          {/* Solapa derecha: segundo desdoblado (rotateY sobre el pliegue vertical) */}
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: "50%", width: "50%",
            transformOrigin: "center left", transformStyle: "preserve-3d",
            animation: `nrmFlapV ${DUR}s ease-in-out both`, pointerEvents: "none"
          }}>
            <div style={flapBack("to right")} />
          </div>
          {/* Esquina doblada */}
          <div style={{
            position: "absolute", top: 0, right: 0, width: 0, height: 0,
            borderStyle: "solid", borderWidth: "0 16px 16px 0",
            borderColor: "transparent #e6e1cf transparent transparent",
            borderRadius: "0 5px 0 0",
            filter: "drop-shadow(-1px 1px 1px rgba(120,110,80,0.2))"
          }} />
          {/* Texto manuscrito: aparece cuando el papel termina de abrirse */}
          <div style={{
            fontFamily: "'Caveat', cursive",
            fontWeight: 600, fontSize: 22, lineHeight: 1.28,
            color: "#33406e", textAlign: "center",
            transform: "rotate(-1.2deg)",
            display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical",
            overflow: "hidden",
            animation: `nrmWrite 0.9s ease-out ${DUR + 0.1}s both`
          }}>
            {text}
          </div>
        </div>
      </div>
    </div>
  );
}


function RemindersCard({ t, C, oswald, rems, onChange }) {
  const Row = ({ slot, label }) => {
    const r = rems[slot] || { time: slot === "am" ? "08:00" : "21:00", enabled: true };
    const set = (patch) => onChange({ ...rems, [slot]: { ...r, ...patch } });
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderTop: `1px solid ${C.border}` }}>
        <div style={{ flex: 1, fontSize: 13, color: r.enabled ? C.text : C.textGhost, fontWeight: 500 }}>{label}</div>
        <input
          type="time"
          value={r.time}
          disabled={!r.enabled}
          onChange={(e) => e.target.value && set({ time: e.target.value })}
          style={{
            border: `1px solid ${C.borderStrong}`, borderRadius: 10, padding: "7px 10px",
            fontSize: 13, color: r.enabled ? C.text : C.textGhost, background: C.bgSoft,
            outline: "none", opacity: r.enabled ? 1 : 0.55
          }}
        />
        <button
          onClick={() => { haptic(8); set({ enabled: !r.enabled }); }}
          aria-label={label}
          style={{
            width: 42, height: 25, borderRadius: 99, border: "none", cursor: "pointer",
            background: r.enabled ? C.brandGrad : C.borderStrong,
            position: "relative", transition: "background 0.2s", flexShrink: 0
          }}>
          <span style={{
            position: "absolute", top: 3, insetInlineStart: r.enabled ? 20 : 3,
            width: 19, height: 19, borderRadius: "50%", background: "#fff",
            boxShadow: "0 1px 4px rgba(26,34,64,0.25)", transition: "inset-inline-start 0.2s"
          }} />
        </button>
      </div>
    );
  };
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
      padding: "14px 16px 4px", marginTop: 16, boxShadow: "0 4px 16px rgba(26,34,64,0.05)"
    }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: C.text, fontFamily: oswald, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {t.rem_title}
      </div>
      <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.5, margin: "4px 0 8px" }}>{t.rem_hint}</div>
      <Row slot="am" label={t.rem_am} />
      <Row slot="pm" label={t.rem_pm} />
    </div>
  );
}


function ReleaseCard({ rel, t, C, oswald, entry, daysActive, onToggle, onMantra, onClose }) {
  const [showFormula, setShowFormula] = useState(false);
  const formula = (rel.type === "belief" ? t.formula_belief : t.formula_effect).replace("{x}", rel.text);
  const useGlass = rel.tool === "glass" || rel.tool === "both";
  const useMantra = rel.tool === "mantra" || rel.tool === "both";
  const glassDone = entry.am && entry.pm;
  const mantraDone = (entry.mantraMin || 0) >= 30;
  const done = (rel.tool === "glass" && glassDone) || (rel.tool === "mantra" && mantraDone) || (rel.tool === "both" && (glassDone || mantraDone));

  const CheckBtn = ({ slot, label, palette }) => {
    const on = !!entry[slot];
    return (
      <button onClick={() => onToggle(slot)} style={{
        flex: 1, padding: "11px 8px", borderRadius: 12, cursor: "pointer",
        border: `1px solid ${on ? C.brand1 : palette.border}`,
        background: on ? C.successBg : palette.bg,
        color: on ? C.brand1 : palette.text,
        fontSize: 12, fontWeight: 600,
        display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        transition: "all 0.15s"
      }}>
        {on ? Icon.check(13) : Icon.glass(13)} {label}
      </button>
    );
  };

  return (
    <div style={{
      background: done ? C.surfaceDone : C.surface,
      border: `1px solid ${done ? C.brand2 : C.border}`,
      borderRadius: 16, padding: 16, marginBottom: 12,
      boxShadow: "0 4px 16px rgba(26,34,64,0.05)", animation: "fadeIn 0.25s"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: C.textMuted, fontFamily: oswald, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 3 }}>
            {rel.type === "belief" ? t.release_type_belief : t.release_type_effect} · {daysActive} {t.days_active}
          </div>
          {!useGlass && (
            <div style={{ fontSize: 14.5, fontWeight: 600, color: C.text, lineHeight: 1.4 }}>{rel.text}</div>
          )}
        </div>
        <button onClick={onClose} title={t.close_release} style={{
          border: "none", background: "transparent", color: C.textGhost,
          cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 4px"
        }}>×</button>
      </div>

      {/* Fórmula del día */}
      <button onClick={() => setShowFormula(!showFormula)} style={{
        width: "100%", textAlign: "start", border: "none", cursor: "pointer",
        background: C.mind.bg, borderRadius: 10, padding: "9px 12px",
        fontSize: 11.5, color: C.mind.text, lineHeight: 1.5, marginBottom: 12
      }}>
        {showFormula ? <><b>{t.formula_label}</b><br />{formula}</> : t.formula_label.split("(")[0] + " ▾"}
      </button>

      {useGlass && (
        <>
          <Paper text={rel.text} label={t.glass_paper} C={C} />
          <div style={{ display: "flex", gap: 8, marginBottom: useMantra ? 12 : 0 }}>
            <CheckBtn slot="am" label={t.glass_am} palette={C.am} />
            <CheckBtn slot="pm" label={t.glass_pm} palette={C.pm} />
          </div>
        </>
      )}

      {useMantra && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.bgSoft, borderRadius: 12, padding: "10px 12px" }}>
          <div style={{ color: C.mind.icon }}>{Icon.heart(16)}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{t.mantra_label}</div>
            <div style={{ fontSize: 11, color: C.textMuted }}>
              {entry.mantraMin || 0} min {t.mantra_today} · {t.mantra_goal}
            </div>
          </div>
          <button onClick={onMantra} style={{
            padding: "8px 14px", borderRadius: 10, border: "none",
            background: mantraDone ? C.successBg : C.brandGrad,
            color: mantraDone ? C.brand1 : "#fff",
            fontSize: 12, fontWeight: 700, cursor: "pointer"
          }}>{t.mantra_add5}</button>
        </div>
      )}

      {done && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.brand1, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          {Icon.check(13)} {t.day_done}
        </div>
      )}
    </div>
  );
}

function NewReleaseModal({ t, C, bodyFont, onCancel, onCreate }) {
  const [type, setType] = useState("effect");
  const [text, setText] = useState("");
  const [tool, setTool] = useState("glass");

  const Seg = ({ options, value, onChange }) => (
    <div style={{ display: "flex", gap: 6, background: C.bgSoft, padding: 4, borderRadius: 12 }}>
      {options.map(o => (
        <button key={o.v} onClick={() => onChange(o.v)} style={{
          flex: 1, padding: "9px 6px", borderRadius: 9, border: "none",
          background: value === o.v ? "#fff" : "transparent",
          boxShadow: value === o.v ? "0 2px 8px rgba(26,34,64,0.08)" : "none",
          color: value === o.v ? C.text : C.textMuted,
          fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: bodyFont
        }}>{o.l}</button>
      ))}
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(26,34,64,0.4)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 520, background: "#fff",
        borderRadius: "20px 20px 0 0", padding: "22px 20px 28px",
        animation: "fadeIn 0.2s", boxSizing: "border-box"
      }}>
        <h3 style={{ margin: "0 0 16px", fontSize: 17, fontWeight: 700, color: C.text }}>{t.release_new}</h3>

        <Seg value={type} onChange={setType} options={[
          { v: "effect", l: t.release_type_effect },
          { v: "belief", l: t.release_type_belief }
        ]} />

        <div style={{ fontSize: 12, fontWeight: 600, color: C.textDim, margin: "16px 0 6px" }}>{t.release_what}</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          placeholder={t.release_what_ph}
          style={{ width: "100%", boxSizing: "border-box", padding: 12, border: `1px solid ${C.borderStrong}`, borderRadius: 12, fontSize: 13.5, lineHeight: 1.5, resize: "none", outline: "none", background: C.bgSoft, color: C.text }} />

        <div style={{ fontSize: 12, fontWeight: 600, color: C.textDim, margin: "14px 0 6px" }}>{t.release_tool_label}</div>
        <Seg value={tool} onChange={setTool} options={[
          { v: "glass", l: t.release_tool_glass },
          { v: "mantra", l: t.release_tool_mantra },
          { v: "both", l: t.release_tool_both }
        ]} />

        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "12px 16px", borderRadius: 12, border: `1px solid ${C.borderStrong}`, background: "transparent", color: C.textDim, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: bodyFont }}>
            {t.release_cancel}
          </button>
          <button onClick={() => text.trim() && onCreate(type, text, tool)} disabled={!text.trim()} style={{
            flex: 2, padding: "12px 16px", borderRadius: 12, border: "none",
            background: text.trim() ? C.brandGrad : C.borderStrong,
            color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: text.trim() ? "pointer" : "default", fontFamily: bodyFont
          }}>{t.release_create}</button>
        </div>
      </div>
    </div>
  );
}

function CloseModal({ t, C, bodyFont, rel, onCancel, onConfirm }) {
  const [reason, setReason] = useState(null);
  const options = [
    { v: "mirror", l: t.close_mirror },
    { v: "solved", l: t.close_solved },
    { v: "indiff", l: t.close_indiff },
    { v: "pause", l: t.close_pause }
  ];
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(26,34,64,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
      onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 400, background: "#fff", borderRadius: 20, padding: 22, animation: "fadeIn 0.2s", boxSizing: "border-box" }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: C.text }}>{t.close_title}</h3>
        <div style={{ fontSize: 12.5, color: C.textMuted, marginBottom: 16 }}>«{rel.text}»</div>
        {options.map(o => (
          <button key={o.v} onClick={() => setReason(o.v)} style={{
            width: "100%", textAlign: "start", padding: "12px 14px", marginBottom: 8,
            borderRadius: 12, cursor: "pointer", fontFamily: bodyFont,
            border: `1.5px solid ${reason === o.v ? C.brand1 : C.border}`,
            background: reason === o.v ? C.successBg : C.bgSoft,
            color: reason === o.v ? C.brand1 : C.textDim,
            fontSize: 12.5, fontWeight: reason === o.v ? 600 : 500, lineHeight: 1.4
          }}>{o.l}</button>
        ))}
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <button onClick={onCancel} style={{ flex: 1, padding: "11px 14px", borderRadius: 12, border: `1px solid ${C.borderStrong}`, background: "transparent", color: C.textDim, fontSize: 13, cursor: "pointer", fontFamily: bodyFont }}>
            {t.release_cancel}
          </button>
          <button onClick={() => reason && onConfirm(reason)} disabled={!reason} style={{
            flex: 1, padding: "11px 14px", borderRadius: 12, border: "none",
            background: reason ? C.brandGrad : C.borderStrong, color: "#fff",
            fontSize: 13, fontWeight: 600, cursor: reason ? "pointer" : "default", fontFamily: bodyFont
          }}>{t.close_confirm}</button>
        </div>
      </div>
    </div>
  );
}

function TestResult({ t, C, oswald, detected, Card, PrimaryBtn, onStart }) {
  const [selected, setSelected] = useState(null);
  const [custom, setCustom] = useState("");
  return (
    <div style={{ animation: "fadeIn 0.25s", paddingTop: 12 }}>
      <h2 style={{ fontFamily: oswald, fontSize: 22, fontWeight: 600, margin: "0 0 6px", textTransform: "uppercase", letterSpacing: "0.02em" }}>{t.result_title}</h2>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: C.textDim, marginBottom: 8 }}>{t.result_sub}</p>
      <Card style={{ background: C.mind.bg, border: `1px solid ${C.mind.border}`, marginBottom: 18 }}>
        <div style={{ fontSize: 11.5, lineHeight: 1.6, color: C.mind.text }}>{t.reflect_q}</div>
      </Card>

      <div style={{ fontSize: 11, color: C.textMuted, fontFamily: oswald, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 10 }}>{t.result_root}</div>
      {detected.map(d => (
        <button key={d.id} onClick={() => { setSelected(d); setCustom(""); }} style={{
          width: "100%", textAlign: "start", padding: "14px 16px", marginBottom: 10,
          borderRadius: 14, cursor: "pointer",
          border: `1.5px solid ${selected?.id === d.id ? C.brand1 : C.border}`,
          background: selected?.id === d.id ? C.successBg : C.surface,
          boxShadow: "0 3px 12px rgba(26,34,64,0.04)"
        }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text, lineHeight: 1.45 }}>{d.label}</div>
          <div style={{ fontSize: 11.5, color: C.textMuted, marginTop: 4, lineHeight: 1.4 }}>{d.hint}</div>
        </button>
      ))}

      <div style={{ fontSize: 12, fontWeight: 600, color: C.textDim, margin: "14px 0 6px" }}>{t.result_custom}</div>
      <textarea value={custom} onChange={(e) => { setCustom(e.target.value); setSelected(null); }} rows={2}
        placeholder={t.release_what_ph}
        style={{ width: "100%", boxSizing: "border-box", padding: 12, border: `1px solid ${C.borderStrong}`, borderRadius: 12, fontSize: 13.5, lineHeight: 1.5, resize: "none", outline: "none", background: C.bgSoft, color: C.text, marginBottom: 14 }} />

      <p style={{ fontSize: 12, lineHeight: 1.55, color: C.textMuted, marginBottom: 14 }}>{t.result_pick}</p>

      <PrimaryBtn
        disabled={!selected && !custom.trim()}
        onClick={() => {
          if (selected) onStart(selected.label.replace(/[«»]/g, ""), "belief");
          else if (custom.trim()) onStart(custom.trim(), "effect");
        }}>
        {t.result_start}
      </PrimaryBtn>
    </div>
  );
}

function ProgressView({ t, C, oswald, Card, releases, history, streak, dayComplete }) {
  const resolved = releases.filter(r => r.status === "closed").length;
  const activeCount = releases.filter(r => r.status === "active").length;

  // Últimos 7 días
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ key: localDateKey(d), label: ["D", "L", "M", "X", "J", "V", "S"][d.getDay()] });
  }

  // Récord de racha histórico simple
  const record = (() => {
    const keys = Object.keys(history).sort();
    if (!keys.length) return streak;
    let best = 0, cur = 0, prev = null;
    keys.forEach(k => {
      const existing = releases
        .filter(r => r.status !== "closed" || (r.closedAt || "9999") >= k)
        .filter(r => (r.createdAt || "").slice(0, 10) <= k);
      const ok = existing.length && existing.every(r => {
        const e = (history[k] || {})[r.id] || {};
        if (r.tool === "glass") return e.am && e.pm;
        if (r.tool === "mantra") return (e.mantraMin || 0) >= 30;
        return (e.am && e.pm) || (e.mantraMin || 0) >= 30;
      });
      if (ok) {
        if (prev) {
          const diff = (new Date(k) - new Date(prev)) / 86400000;
          cur = diff === 1 ? cur + 1 : 1;
        } else cur = 1;
        prev = k;
        best = Math.max(best, cur);
      }
    });
    return Math.max(best, streak);
  })();

  return (
    <div style={{ animation: "fadeIn 0.25s" }}>
      <h2 style={{ fontFamily: oswald, fontSize: 20, fontWeight: 600, margin: "0 0 16px", textTransform: "uppercase", letterSpacing: "0.02em" }}>{t.progress_title}</h2>

      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
        <Card style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.brand1 }}>{streak}</div>
          <div style={{ fontSize: 10.5, color: C.textMuted }}>{t.streak_label}</div>
        </Card>
        <Card style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.mind.icon }}>{resolved}</div>
          <div style={{ fontSize: 10.5, color: C.textMuted }}>{t.resolved_count}</div>
        </Card>
        <Card style={{ flex: 1, textAlign: "center" }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.textDim }}>{record}</div>
          <div style={{ fontSize: 10.5, color: C.textMuted }}>{t.record_label} ({t.days})</div>
        </Card>
      </div>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.textDim, marginBottom: 12 }}>{t.last7}</div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          {days.map(d => {
            const ok = dayComplete(d.key);
            return (
              <div key={d.key} style={{ textAlign: "center" }}>
                <div style={{
                  width: 32, height: 32, borderRadius: 10, margin: "0 auto 4px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: ok ? C.successBg : C.bgSoft,
                  border: `1px solid ${ok ? C.brand2 : C.border}`,
                  color: ok ? C.brand1 : C.textGhost
                }}>{ok ? Icon.check(14) : ""}</div>
                <div style={{ fontSize: 10, color: C.textMuted }}>{d.label}</div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 10.5, color: C.textMuted, lineHeight: 1.5, marginTop: 12 }}>{t.streak_hint}</div>
      </Card>

      <Card style={{ background: C.warningBg, border: `1px solid ${C.am.border}` }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.warning, marginBottom: 6 }}>{t.iras_title}</div>
        <div style={{ fontSize: 12, lineHeight: 1.65, color: C.textDim }}>{t.iras_body}</div>
      </Card>
    </div>
  );
}

function MethodView({ t, C, oswald, Card }) {
  const [open, setOpen] = useState("glass"); // primera sección abierta por defecto

  /* Iconos de línea por sección (mismo trazo 1.8 que el resto de la app) */
  const SIcon = {
    // Vaso con agua animada (la onda sube y baja suavemente)
    glass: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3h12l-1.5 18h-9L6 3z" />
        <path d="M7.4 12c1.5 1.2 3.1 1.1 4.6 0s3.1-1.2 4.6 0">
          <animateTransform attributeName="transform" type="translate" values="0 0.8; 0 -2.2; 0 0.8" dur="2.2s" repeatCount="indefinite" />
        </path>
        <path d="M7.6 15c1.4 1 2.9.9 4.4 0s3-1 4.4 0" opacity="0.45">
          <animateTransform attributeName="transform" type="translate" values="0 -1.5; 0 1; 0 -1.5" dur="2.2s" repeatCount="indefinite" />
        </path>
      </svg>
    ),
    // Corazón con latido
    mantra: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3.4 1-4.5 2.5C10.9 4 9.3 3 7.5 3A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7 7-7z">
          <animateTransform attributeName="transform" type="scale" values="1;1.06;1" additive="sum" dur="1.8s" repeatCount="indefinite" />
        </path>
      </svg>
    ),
    // Doble hélice ADN
    adn: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 3c0 4 8 4 8 8s-8 4-8 8" />
        <path d="M16 3c0 4-8 4-8 8s8 4 8 8" />
        <path d="M9 6.5h6M9 17.5h6M9.5 12h5" />
      </svg>
    ),
    // Escudo/onda para resistencias
    resist: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z" />
        <path d="M8.5 12c1.2 1 2.3.9 3.5 0s2.3-1 3.5 0" />
      </svg>
    )
  };

  const Rule = ({ children }) => (
    <div style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 12.5, lineHeight: 1.55, color: C.textDim }}>
      <span style={{ color: C.brand2, flexShrink: 0, marginTop: 1 }}>●</span>
      <span>{children}</span>
    </div>
  );

  const Section = ({ id, title, icon, grad, children }) => {
    const isOpen = open === id;
    return (
      <div style={{
        background: C.surface, border: `1px solid ${isOpen ? C.mind.border : C.border}`,
        borderRadius: 16, marginBottom: 12, overflow: "hidden",
        boxShadow: isOpen ? "0 6px 20px rgba(83,74,183,0.10)" : "0 4px 16px rgba(26,34,64,0.05)",
        transition: "box-shadow 0.25s, border-color 0.25s"
      }}>
        <button onClick={() => { haptic(8); setOpen(isOpen ? null : id); }} style={{
          width: "100%", display: "flex", alignItems: "center", gap: 12,
          padding: "14px 16px", border: "none", background: "transparent",
          cursor: "pointer", textAlign: "start"
        }}>
          <span style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: grad, color: "#fff",
            boxShadow: isOpen ? "0 4px 12px rgba(26,34,64,0.18)" : "none",
            transition: "box-shadow 0.25s"
          }}>{icon}</span>
          <span style={{
            flex: 1, fontSize: 13, fontWeight: 700, color: C.text,
            fontFamily: oswald, textTransform: "uppercase", letterSpacing: "0.04em"
          }}>{title}</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.textMuted} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.25s", flexShrink: 0 }}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div style={{
          display: "grid", gridTemplateRows: isOpen ? "1fr" : "0fr",
          transition: "grid-template-rows 0.3s ease"
        }}>
          <div style={{ overflow: "hidden" }}>
            <div style={{ padding: "2px 16px 16px" }}>{children}</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ animation: "fadeIn 0.25s" }}>
      <h2 style={{ fontFamily: oswald, fontSize: 20, fontWeight: 600, margin: "0 0 16px", textTransform: "uppercase", letterSpacing: "0.02em" }}>{t.method_title}</h2>

      <Section id="glass" title={t.method_glass_title} icon={SIcon.glass}
        grad="linear-gradient(135deg,#0f6e56,#5DCAA5)">
        {t.method_glass_rules.map((r, i) => <Rule key={i}>{r}</Rule>)}
      </Section>

      <Section id="mantra" title={t.method_mantra_title} icon={SIcon.mantra}
        grad="linear-gradient(135deg,#534ab7,#8f87e8)">
        {t.method_mantra_rules.map((r, i) => <Rule key={i}>{r}</Rule>)}
      </Section>

      <Section id="adn" title={t.method_adn_title} icon={SIcon.adn}
        grad="linear-gradient(135deg,#b7791f,#e2b25e)">
        <div style={{ fontSize: 12.5, lineHeight: 1.65, color: C.textDim }}>{t.method_adn_body}</div>
      </Section>

      <Section id="resist" title={t.method_resist_title} icon={SIcon.resist}
        grad="linear-gradient(135deg,#993c1d,#d4795a)">
        <div style={{ fontSize: 12.5, lineHeight: 1.65, color: C.textDim }}>{t.method_resist_body}</div>
      </Section>

      <div style={{ fontSize: 10.5, color: C.textGhost, lineHeight: 1.55, textAlign: "center", padding: "4px 10px 20px" }}>
        {t.disclaimer}
      </div>
    </div>
  );
}
