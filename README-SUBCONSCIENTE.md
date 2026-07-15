# Subconsciente — Integración (Fase 1)

App de liberación de memorias subconscientes (Módulo 2). Segunda entrada del
mismo build de Vite: `https://<deploy-vercel>/subconsciente`.

## Estado actual
- **Local-first**: funciona ya sin tocar WordPress (localStorage por dispositivo).
- **Sync cross-device (opcional)**: requiere el snippet bridge de abajo.
  Namespace de mensajes propio: `nrm-*` (no colisiona con `nr-tracker-*`).

## 1. Página WordPress
Crear página `/subconsciente/` (y `/{lang}/subconsciente/` por idioma) con el
iframe, replicando el patrón de `/supplement/`:

```html
<iframe
  src="https://TU-DEPLOY.vercel.app/subconsciente?lang=es"
  style="width:100%;min-height:100vh;border:none"
  allow="vibrate"
></iframe>
```

El parámetro `lang` se rellena igual que en el tracker (shortcode que lee
`preferred_lang` del user meta). Fase 1 solo tiene strings ES; el resto de
idiomas se añaden en Fase 3 (mismo objeto `T` en `src/subconsciente/App.jsx`).

Gate de licencia: mismo patrón que /supplement/ (`nr_license_{slug}` +
suscripción neo-push). Recomendado: desbloquear cuando el alumno alcanza el
Módulo 2.

## 2. Snippet bridge (Code Snippets) — para sync cross-device
Listener en la página padre que atiende los mensajes `nrm-*`:

- `nrm-bridge-ping` → responde `{ type, requestId, ok: true }`
- `nrm-state-pull` → GET `/wp-json/nr-mente/v1/state` → `{ ..., data }`
- `nrm-state-push` → POST el payload a `/wp-json/nr-mente/v1/state`
- `nrm-metric` → POST fire-and-forget a `/wp-json/nr-mente/v1/metric`

Copiar el snippet 144 del tracker y cambiar: prefijo de mensajes
(`nr-tracker-` → `nrm-`), ruta REST (`nr-supp` → `nr-mente`) y el response
type (debe empezar por `nrm-` para que la app lo acepte).

## 3. Endpoint REST (Code Snippets, PHP)
Réplica del endpoint /state del tracker con user meta propios:

- Claves aceptadas: `profile`, `releases`, `history`
- Meta keys: `nrm_profile`, `nrm_releases`, `nrm_history`
  (guardar `{ value, ts }`; resolver conflictos por `ts` — igual que tracker)
- Permission callback: usuario logueado con licencia activa.

## 4. Push (neo-push)
Dos recordatorios/día por usuario: vaciado mañana y noche (horas del tracker o
propias). Cron GitHub Actions o WP-Cron; audiencia = usuarios con
`nrm_releases` no vacío. **No** enviar notificaciones nocturnas de mantras
(el método desaconseja trabajar el subconsciente durmiendo).

## 5. Datos (estructura)
```js
// nrm-profile
{ testAnswers: {id: "texto"}, detectedRoots: ["tiempo"], createdAt, skipped? }

// nrm-releases  (máx. 5 activas — la app lo impone)
[{ id, type: "belief"|"effect", text, tool: "glass"|"mantra"|"both",
   createdAt, status: "active"|"paused"|"closed",
   pausedAt?, closedAt?, closedReason?: "mirror"|"solved"|"indiff" }]

// nrm-history
{ "YYYY-MM-DD": { [releaseId]: { am?: bool, pm?: bool, mantraMin?: number } } }
```

## 6. Reglas del método implementadas (no relajar sin revisar el Módulo 2)
- Máximo 5 liberaciones activas simultáneas.
- Mantra fijo «Gracias, Te Amo»; objetivo ~30 min/día acumulados.
- Vasos: 2 vaciados/día (mañana y noche); pausa por viaje sin perder progreso.
- Cierre solo por: cambio visible / solución clara / dejó de importar.
- Fórmula «¿Qué memorias hay en mí…? Quiero liberarlas» mostrada una vez al día.
- Sin audios subliminales nocturnos (Módulo 6) — no añadir esta feature.
- Disclaimer médico visible en onboarding y en la pestaña Método.

## Fase 2 (pendiente)
Análisis del test con IA (endpoint tipo suppExpert con system prompt de
`neo-mente-spec.md`), test de la cruz guiado, condiciones ADN (agua +
movimiento), journal, chat experto. Fase 3: i18n completo + RTL + audio.
