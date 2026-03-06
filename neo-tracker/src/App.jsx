import { useState, useEffect, useCallback, useRef } from "react";

// localStorage wrapper (same API shape as Claude's window.storage)
const storage = {
  get: (key) => {
    try {
      const v = localStorage.getItem(key);
      return Promise.resolve(v ? { value: v } : null);
    } catch(e) { return Promise.resolve(null); }
  },
  set: (key, value) => {
    try { localStorage.setItem(key, value); } catch(e) {}
    return Promise.resolve(null);
  },
  delete: (key) => {
    try { localStorage.removeItem(key); } catch(e) {}
    return Promise.resolve(null);
  }
};

const detectLang = () => {
  const supported = ["es", "en", "fr", "de", "pt", "it"];
  try {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("lang");
    if (p && supported.includes(p.toLowerCase())) return p.toLowerCase();
  } catch(e) {}
  return "es";
};

const T = {
  es: { trackerSub:"Supplement Tracker", today_label:"hoy", tab_today:"Hoy", tab_progress:"Progreso", tab_settings:"Ajustes", morning:"Mañana", afternoon:"Tarde", night:"Noche", morning_hint:"Al despertar · Con desayuno", afternoon_hint:"Mediodía · Con comida", night_hint:"Antes de dormir · Con cena", morning_notif:"Mañana 🌅", afternoon_notif:"Tarde ☀️", night_notif:"Noche 🌙", freq_alternate:"Cada 2-3 días", freq_weekly:"2-3×/semana", hide_info:"▲ Ocultar", more_info:"▼ Más info", step1_title:"¿Cuáles son tus objetivos?", step1_sub:"Selecciona todos los que apliquen. La IA adaptará tu rutina.", step2_title:"Contraindicaciones", step2_sub:"Es importante para tu seguridad. Sé honesto/a.", step3_title:"¡Todo listo!", step3_sub:"La IA creará tu rutina personalizada basada en el método NeoRejuvenation.", step3_disclaimer:"⚠️ Esta información es educativa. Consulta siempre con un profesional sanitario antes de iniciar cualquier suplementación.", btn_back:"Atrás", btn_continue:"Continuar →", btn_create:"✨ Crear mi rutina", gen_title:"Creando tu rutina personalizada", gen_sub:"La IA está analizando tus objetivos y diseñando la combinación óptima de suplementos NeoRejuvenation", ai_label:"🤖 Tu rutina IA", today_header:"Hoy", streak_label:"días", complete_title:"¡Rutina completada!", complete_sub:"Has completado todos tus suplementos de hoy. Tu cuerpo te lo agradece.", progress_title:"Tu Progreso", streak_card_label:"Racha activa", streak_days:"días seguidos", last7:"Últimos 7 días", weekly_avg:"Promedio semanal", routine_title:"Tu Rutina Actual", total_supps:"suplementos en tu rutina", settings_title:"Ajustes", reminders_title:"Recordatorios", notif_btn:"🔔 Activar notificaciones", notif_granted:"✓ Notificaciones activadas", notif_hint:"Los recordatorios funcionan mientras tengas esta página abierta.", routine_section:"Rutina", regenerate_hint:"¿Quieres ajustar tus objetivos o regenerar tu rutina?", regenerate_btn:"🔄 Crear nueva rutina con IA", reminder_prefix:"⏰ Recordatorio", fallback_msg:"Tu rutina base NeoRejuvenation está lista. Vitamina C + Reishi son los pilares fundamentales de tu regeneración celular diaria.", fallback_warning:"Consulta con un médico antes de iniciar cualquier suplementación.", day_names:["D","L","M","X","J","V","S"], date_locale:"es-ES" },
  en: { trackerSub:"Supplement Tracker", today_label:"today", tab_today:"Today", tab_progress:"Progress", tab_settings:"Settings", morning:"Morning", afternoon:"Afternoon", night:"Night", morning_hint:"Upon waking · With breakfast", afternoon_hint:"Midday · With lunch", night_hint:"Before sleep · With dinner", morning_notif:"Morning 🌅", afternoon_notif:"Afternoon ☀️", night_notif:"Night 🌙", freq_alternate:"Every 2-3 days", freq_weekly:"2-3×/week", hide_info:"▲ Hide", more_info:"▼ More info", step1_title:"What are your goals?", step1_sub:"Select all that apply. The AI will adapt your routine.", step2_title:"Contraindications", step2_sub:"This is important for your safety. Please be honest.", step3_title:"All set!", step3_sub:"The AI will create your personalized routine based on the NeoRejuvenation method.", step3_disclaimer:"⚠️ This information is educational. Always consult a healthcare professional before starting any supplementation.", btn_back:"Back", btn_continue:"Continue →", btn_create:"✨ Create my routine", gen_title:"Creating your personalized routine", gen_sub:"The AI is analyzing your goals and designing the optimal NeoRejuvenation supplement combination", ai_label:"🤖 Your AI routine", today_header:"Today", streak_label:"days", complete_title:"Routine complete!", complete_sub:"You have completed all your supplements for today. Your body thanks you.", progress_title:"Your Progress", streak_card_label:"Active streak", streak_days:"consecutive days", last7:"Last 7 days", weekly_avg:"Weekly average", routine_title:"Your Current Routine", total_supps:"supplements in your routine", settings_title:"Settings", reminders_title:"Reminders", notif_btn:"🔔 Enable notifications", notif_granted:"✓ Notifications enabled", notif_hint:"Reminders work while this page is open.", routine_section:"Routine", regenerate_hint:"Want to adjust your goals or regenerate your routine?", regenerate_btn:"🔄 Create new AI routine", reminder_prefix:"⏰ Reminder", fallback_msg:"Your base NeoRejuvenation routine is ready. Vitamin C + Reishi are the fundamental pillars of your daily cellular regeneration.", fallback_warning:"Consult a doctor before starting any supplementation.", day_names:["Su","Mo","Tu","We","Th","Fr","Sa"], date_locale:"en-US" },
  fr: { trackerSub:"Supplement Tracker", today_label:"aujourd'hui", tab_today:"Aujourd'hui", tab_progress:"Progrès", tab_settings:"Réglages", morning:"Matin", afternoon:"Après-midi", night:"Nuit", morning_hint:"Au réveil · Avec le petit-déjeuner", afternoon_hint:"Midi · Avec le déjeuner", night_hint:"Avant de dormir · Avec le dîner", morning_notif:"Matin 🌅", afternoon_notif:"Après-midi ☀️", night_notif:"Nuit 🌙", freq_alternate:"Tous les 2-3 jours", freq_weekly:"2-3×/semaine", hide_info:"▲ Masquer", more_info:"▼ Plus d'infos", step1_title:"Quels sont vos objectifs ?", step1_sub:"Sélectionnez tout ce qui s'applique. L'IA adaptera votre routine.", step2_title:"Contre-indications", step2_sub:"C'est important pour votre sécurité. Soyez honnête.", step3_title:"Tout est prêt !", step3_sub:"L'IA créera votre routine personnalisée basée sur la méthode NeoRejuvenation.", step3_disclaimer:"⚠️ Ces informations sont éducatives. Consultez toujours un professionnel de santé.", btn_back:"Retour", btn_continue:"Continuer →", btn_create:"✨ Créer ma routine", gen_title:"Création de votre routine", gen_sub:"L'IA analyse vos objectifs et conçoit la combinaison optimale", ai_label:"🤖 Votre routine IA", today_header:"Aujourd'hui", streak_label:"jours", complete_title:"Routine complète !", complete_sub:"Vous avez pris tous vos suppléments aujourd'hui. Votre corps vous remercie.", progress_title:"Votre Progrès", streak_card_label:"Série active", streak_days:"jours consécutifs", last7:"7 derniers jours", weekly_avg:"Moyenne hebdomadaire", routine_title:"Votre Routine Actuelle", total_supps:"suppléments dans votre routine", settings_title:"Réglages", reminders_title:"Rappels", notif_btn:"🔔 Activer les notifications", notif_granted:"✓ Notifications activées", notif_hint:"Les rappels fonctionnent tant que cette page est ouverte.", routine_section:"Routine", regenerate_hint:"Voulez-vous ajuster vos objectifs ou régénérer votre routine ?", regenerate_btn:"🔄 Créer une nouvelle routine IA", reminder_prefix:"⏰ Rappel", fallback_msg:"Votre routine NeoRejuvenation de base est prête. Vitamine C + Reishi sont les piliers fondamentaux.", fallback_warning:"Consultez un médecin avant de commencer toute supplémentation.", day_names:["Di","Lu","Ma","Me","Je","Ve","Sa"], date_locale:"fr-FR" },
  de: { trackerSub:"Supplement Tracker", today_label:"heute", tab_today:"Heute", tab_progress:"Fortschritt", tab_settings:"Einstellungen", morning:"Morgen", afternoon:"Nachmittag", night:"Nacht", morning_hint:"Beim Aufwachen · Mit dem Frühstück", afternoon_hint:"Mittags · Mit dem Mittagessen", night_hint:"Vor dem Schlafen · Mit dem Abendessen", morning_notif:"Morgen 🌅", afternoon_notif:"Nachmittag ☀️", night_notif:"Nacht 🌙", freq_alternate:"Alle 2-3 Tage", freq_weekly:"2-3×/Woche", hide_info:"▲ Weniger", more_info:"▼ Mehr Info", step1_title:"Was sind Ihre Ziele?", step1_sub:"Wählen Sie alles Zutreffende. Die KI passt Ihre Routine an.", step2_title:"Kontraindikationen", step2_sub:"Dies ist wichtig für Ihre Sicherheit.", step3_title:"Alles bereit!", step3_sub:"Die KI erstellt Ihre personalisierte Routine basierend auf der NeoRejuvenation-Methode.", step3_disclaimer:"⚠️ Diese Informationen sind pädagogisch. Konsultieren Sie immer einen Arzt.", btn_back:"Zurück", btn_continue:"Weiter →", btn_create:"✨ Meine Routine erstellen", gen_title:"Ihre Routine wird erstellt", gen_sub:"Die KI analysiert Ihre Ziele und entwirft die optimale Supplementkombination", ai_label:"🤖 Ihre KI-Routine", today_header:"Heute", streak_label:"Tage", complete_title:"Routine abgeschlossen!", complete_sub:"Sie haben alle heutigen Supplemente eingenommen.", progress_title:"Ihr Fortschritt", streak_card_label:"Aktive Serie", streak_days:"aufeinanderfolgende Tage", last7:"Letzte 7 Tage", weekly_avg:"Wochendurchschnitt", routine_title:"Ihre aktuelle Routine", total_supps:"Supplemente in Ihrer Routine", settings_title:"Einstellungen", reminders_title:"Erinnerungen", notif_btn:"🔔 Benachrichtigungen aktivieren", notif_granted:"✓ Benachrichtigungen aktiviert", notif_hint:"Erinnerungen funktionieren solange diese Seite geöffnet ist.", routine_section:"Routine", regenerate_hint:"Möchten Sie Ihre Ziele anpassen oder Ihre Routine neu generieren?", regenerate_btn:"🔄 Neue KI-Routine erstellen", reminder_prefix:"⏰ Erinnerung", fallback_msg:"Ihre NeoRejuvenation-Basisroutine ist bereit. Vitamin C + Reishi sind die grundlegenden Säulen.", fallback_warning:"Konsultieren Sie einen Arzt.", day_names:["So","Mo","Di","Mi","Do","Fr","Sa"], date_locale:"de-DE" },
  pt: { trackerSub:"Supplement Tracker", today_label:"hoje", tab_today:"Hoje", tab_progress:"Progresso", tab_settings:"Configurações", morning:"Manhã", afternoon:"Tarde", night:"Noite", morning_hint:"Ao acordar · Com o café da manhã", afternoon_hint:"Ao meio-dia · Com o almoço", night_hint:"Antes de dormir · Com o jantar", morning_notif:"Manhã 🌅", afternoon_notif:"Tarde ☀️", night_notif:"Noite 🌙", freq_alternate:"A cada 2-3 dias", freq_weekly:"2-3×/semana", hide_info:"▲ Ocultar", more_info:"▼ Mais info", step1_title:"Quais são os seus objetivos?", step1_sub:"Selecione todos os que se aplicam. A IA adaptará sua rotina.", step2_title:"Contraindicações", step2_sub:"É importante para a sua segurança.", step3_title:"Tudo pronto!", step3_sub:"A IA criará sua rotina personalizada baseada no método NeoRejuvenation.", step3_disclaimer:"⚠️ Esta informação é educacional. Consulte sempre um profissional de saúde.", btn_back:"Voltar", btn_continue:"Continuar →", btn_create:"✨ Criar minha rotina", gen_title:"Criando sua rotina personalizada", gen_sub:"A IA está analisando seus objetivos e projetando a combinação ideal", ai_label:"🤖 Sua rotina IA", today_header:"Hoje", streak_label:"dias", complete_title:"Rotina concluída!", complete_sub:"Você completou todos os seus suplementos hoje.", progress_title:"Seu Progresso", streak_card_label:"Sequência ativa", streak_days:"dias consecutivos", last7:"Últimos 7 dias", weekly_avg:"Média semanal", routine_title:"Sua Rotina Atual", total_supps:"suplementos na sua rotina", settings_title:"Configurações", reminders_title:"Lembretes", notif_btn:"🔔 Ativar notificações", notif_granted:"✓ Notificações ativadas", notif_hint:"Os lembretes funcionam enquanto esta página estiver aberta.", routine_section:"Rotina", regenerate_hint:"Quer ajustar seus objetivos ou regenerar sua rotina?", regenerate_btn:"🔄 Criar nova rotina com IA", reminder_prefix:"⏰ Lembrete", fallback_msg:"Sua rotina base NeoRejuvenation está pronta. Vitamina C + Reishi são os pilares fundamentais.", fallback_warning:"Consulte um médico antes de iniciar qualquer suplementação.", day_names:["D","S","T","Q","Q","S","S"], date_locale:"pt-BR" },
  it: { trackerSub:"Supplement Tracker", today_label:"oggi", tab_today:"Oggi", tab_progress:"Progressi", tab_settings:"Impostazioni", morning:"Mattina", afternoon:"Pomeriggio", night:"Notte", morning_hint:"Al risveglio · Con la colazione", afternoon_hint:"Mezzogiorno · Con il pranzo", night_hint:"Prima di dormire · Con la cena", morning_notif:"Mattina 🌅", afternoon_notif:"Pomeriggio ☀️", night_notif:"Notte 🌙", freq_alternate:"Ogni 2-3 giorni", freq_weekly:"2-3×/settimana", hide_info:"▲ Nascondi", more_info:"▼ Più info", step1_title:"Quali sono i tuoi obiettivi?", step1_sub:"Seleziona tutto ciò che si applica. L'IA adatterà la tua routine.", step2_title:"Controindicazioni", step2_sub:"È importante per la tua sicurezza.", step3_title:"Tutto pronto!", step3_sub:"L'IA creerà la tua routine personalizzata basata sul metodo NeoRejuvenation.", step3_disclaimer:"⚠️ Queste informazioni sono educative. Consulta sempre un professionista sanitario.", btn_back:"Indietro", btn_continue:"Continua →", btn_create:"✨ Crea la mia routine", gen_title:"Creazione della tua routine", gen_sub:"L'IA sta analizzando i tuoi obiettivi e progettando la combinazione ottimale", ai_label:"🤖 La tua routine IA", today_header:"Oggi", streak_label:"giorni", complete_title:"Routine completata!", complete_sub:"Hai completato tutti i tuoi integratori di oggi.", progress_title:"I tuoi Progressi", streak_card_label:"Serie attiva", streak_days:"giorni consecutivi", last7:"Ultimi 7 giorni", weekly_avg:"Media settimanale", routine_title:"La tua Routine Attuale", total_supps:"integratori nella tua routine", settings_title:"Impostazioni", reminders_title:"Promemoria", notif_btn:"🔔 Attiva notifiche", notif_granted:"✓ Notifiche attivate", notif_hint:"I promemoria funzionano finché questa pagina è aperta.", routine_section:"Routine", regenerate_hint:"Vuoi modificare i tuoi obiettivi o rigenerare la tua routine?", regenerate_btn:"🔄 Crea nuova routine con IA", reminder_prefix:"⏰ Promemoria", fallback_msg:"La tua routine base NeoRejuvenation è pronta. Vitamina C + Reishi sono i pilastri fondamentali.", fallback_warning:"Consulta un medico prima di iniziare qualsiasi integrazione.", day_names:["Do","Lu","Ma","Me","Gi","Ve","Sa"], date_locale:"it-IT" }
};

const GOALS_I18N = {
  es:[{id:"antiaging",label:"Anti-Aging & Regeneración",icon:"🧬",desc:"Frenar el envejecimiento celular"},{id:"energy",label:"Energía & Rendimiento",icon:"⚡",desc:"Aumentar vitalidad y resistencia física"},{id:"immune",label:"Sistema Inmune",icon:"🛡️",desc:"Fortalecer defensas naturales"},{id:"brain",label:"Cerebro & Concentración",icon:"🧠",desc:"Memoria, foco y claridad mental"},{id:"skin",label:"Piel & Belleza",icon:"✨",desc:"Colágeno, hidratación y luminosidad"},{id:"hair",label:"Cabello & Canas",icon:"💇",desc:"Densidad capilar y prevención de canas"},{id:"cardiovascular",label:"Cardiovascular",icon:"❤️",desc:"Salud del corazón y circulación"},{id:"detox",label:"Detox Hepático",icon:"🫀",desc:"Depuración y regeneración del hígado"},{id:"joints",label:"Articulaciones & Tejidos",icon:"🦴",desc:"Cartílagos, tendones y movilidad"},{id:"stress",label:"Estrés & Sueño",icon:"🌙",desc:"Equilibrio nervioso y calidad del sueño"}],
  en:[{id:"antiaging",label:"Anti-Aging & Regeneration",icon:"🧬",desc:"Slow down cellular aging"},{id:"energy",label:"Energy & Performance",icon:"⚡",desc:"Boost vitality and physical endurance"},{id:"immune",label:"Immune System",icon:"🛡️",desc:"Strengthen natural defenses"},{id:"brain",label:"Brain & Focus",icon:"🧠",desc:"Memory, focus and mental clarity"},{id:"skin",label:"Skin & Beauty",icon:"✨",desc:"Collagen, hydration and radiance"},{id:"hair",label:"Hair & Grey Hair",icon:"💇",desc:"Hair density and grey hair prevention"},{id:"cardiovascular",label:"Cardiovascular",icon:"❤️",desc:"Heart health and circulation"},{id:"detox",label:"Liver Detox",icon:"🫀",desc:"Liver purification and regeneration"},{id:"joints",label:"Joints & Tissues",icon:"🦴",desc:"Cartilage, tendons and mobility"},{id:"stress",label:"Stress & Sleep",icon:"🌙",desc:"Nervous balance and sleep quality"}],
  fr:[{id:"antiaging",label:"Anti-âge & Régénération",icon:"🧬",desc:"Ralentir le vieillissement cellulaire"},{id:"energy",label:"Énergie & Performance",icon:"⚡",desc:"Augmenter la vitalité"},{id:"immune",label:"Système Immunitaire",icon:"🛡️",desc:"Renforcer les défenses naturelles"},{id:"brain",label:"Cerveau & Concentration",icon:"🧠",desc:"Mémoire, concentration et clarté"},{id:"skin",label:"Peau & Beauté",icon:"✨",desc:"Collagène, hydratation et luminosité"},{id:"hair",label:"Cheveux & Cheveux Blancs",icon:"💇",desc:"Densité capillaire et prévention"},{id:"cardiovascular",label:"Cardiovasculaire",icon:"❤️",desc:"Santé cardiaque et circulation"},{id:"detox",label:"Détox Hépatique",icon:"🫀",desc:"Purification et régénération du foie"},{id:"joints",label:"Articulations & Tissus",icon:"🦴",desc:"Cartilages, tendons et mobilité"},{id:"stress",label:"Stress & Sommeil",icon:"🌙",desc:"Équilibre nerveux et qualité du sommeil"}],
  de:[{id:"antiaging",label:"Anti-Aging & Regeneration",icon:"🧬",desc:"Zelluläre Alterung verlangsamen"},{id:"energy",label:"Energie & Leistung",icon:"⚡",desc:"Vitalität und Ausdauer steigern"},{id:"immune",label:"Immunsystem",icon:"🛡️",desc:"Natürliche Abwehrkräfte stärken"},{id:"brain",label:"Gehirn & Konzentration",icon:"🧠",desc:"Gedächtnis, Fokus und Klarheit"},{id:"skin",label:"Haut & Schönheit",icon:"✨",desc:"Kollagen, Hydratation und Ausstrahlung"},{id:"hair",label:"Haare & graue Haare",icon:"💇",desc:"Haardichte und Prävention"},{id:"cardiovascular",label:"Herz-Kreislauf",icon:"❤️",desc:"Herzgesundheit und Durchblutung"},{id:"detox",label:"Leber-Detox",icon:"🫀",desc:"Leberreinigung und -regeneration"},{id:"joints",label:"Gelenke & Gewebe",icon:"🦴",desc:"Knorpel, Sehnen und Beweglichkeit"},{id:"stress",label:"Stress & Schlaf",icon:"🌙",desc:"Nervöses Gleichgewicht und Schlafqualität"}],
  pt:[{id:"antiaging",label:"Anti-Envelhecimento",icon:"🧬",desc:"Desacelerar o envelhecimento"},{id:"energy",label:"Energia & Desempenho",icon:"⚡",desc:"Aumentar vitalidade e resistência"},{id:"immune",label:"Sistema Imunológico",icon:"🛡️",desc:"Fortalecer as defesas naturais"},{id:"brain",label:"Cérebro & Concentração",icon:"🧠",desc:"Memória, foco e clareza mental"},{id:"skin",label:"Pele & Beleza",icon:"✨",desc:"Colágeno, hidratação e luminosidade"},{id:"hair",label:"Cabelo & Cabelos Brancos",icon:"💇",desc:"Densidade capilar e prevenção"},{id:"cardiovascular",label:"Cardiovascular",icon:"❤️",desc:"Saúde do coração e circulação"},{id:"detox",label:"Detox Hepático",icon:"🫀",desc:"Purificação e regeneração do fígado"},{id:"joints",label:"Articulações & Tecidos",icon:"🦴",desc:"Cartilagens, tendões e mobilidade"},{id:"stress",label:"Estresse & Sono",icon:"🌙",desc:"Equilíbrio nervoso e qualidade do sono"}],
  it:[{id:"antiaging",label:"Anti-Age & Rigenerazione",icon:"🧬",desc:"Rallentare l'invecchiamento"},{id:"energy",label:"Energia & Performance",icon:"⚡",desc:"Aumentare vitalità e resistenza"},{id:"immune",label:"Sistema Immunitario",icon:"🛡️",desc:"Rafforzare le difese naturali"},{id:"brain",label:"Cervello & Concentrazione",icon:"🧠",desc:"Memoria, focus e chiarezza"},{id:"skin",label:"Pelle & Bellezza",icon:"✨",desc:"Collagene, idratazione e luminosità"},{id:"hair",label:"Capelli & Capelli Bianchi",icon:"💇",desc:"Densità capillare e prevenzione"},{id:"cardiovascular",label:"Cardiovascolare",icon:"❤️",desc:"Salute del cuore e circolazione"},{id:"detox",label:"Detox Epatico",icon:"🫀",desc:"Purificazione e rigenerazione"},{id:"joints",label:"Articolazioni & Tessuti",icon:"🦴",desc:"Cartilagini, tendini e mobilità"},{id:"stress",label:"Stress & Sonno",icon:"🌙",desc:"Equilibrio nervoso e qualità del sonno"}]
};

const CONTRA_I18N = {
  es:[{id:"anticoagulants",label:"Tomo anticoagulantes"},{id:"autoimmune",label:"Tengo enfermedad autoinmune"},{id:"surgery",label:"Operación próxima (< 2 semanas)"},{id:"diabetes",label:"Tengo diabetes"},{id:"antipsychotics",label:"Tomo antipsicóticos"},{id:"pregnancy",label:"Estoy embarazada o en lactancia"},{id:"antiretrovirals",label:"Tomo antirretrovirales"},{id:"hemochromatosis",label:"Tengo hemocromatosis"},{id:"kidney",label:"Problemas renales"},{id:"none",label:"Ninguna de las anteriores"}],
  en:[{id:"anticoagulants",label:"I take anticoagulants"},{id:"autoimmune",label:"I have an autoimmune disease"},{id:"surgery",label:"Upcoming surgery (< 2 weeks)"},{id:"diabetes",label:"I have diabetes"},{id:"antipsychotics",label:"I take antipsychotics"},{id:"pregnancy",label:"I am pregnant or breastfeeding"},{id:"antiretrovirals",label:"I take antiretrovirals"},{id:"hemochromatosis",label:"I have hemochromatosis"},{id:"kidney",label:"Kidney problems"},{id:"none",label:"None of the above"}],
  fr:[{id:"anticoagulants",label:"Je prends des anticoagulants"},{id:"autoimmune",label:"J'ai une maladie auto-immune"},{id:"surgery",label:"Opération prochaine (< 2 semaines)"},{id:"diabetes",label:"J'ai le diabète"},{id:"antipsychotics",label:"Je prends des antipsychotiques"},{id:"pregnancy",label:"Je suis enceinte ou j'allaite"},{id:"antiretrovirals",label:"Je prends des antirétroviraux"},{id:"hemochromatosis",label:"J'ai une hémochromatose"},{id:"kidney",label:"Problèmes rénaux"},{id:"none",label:"Aucune de celles-ci"}],
  de:[{id:"anticoagulants",label:"Ich nehme Blutverdünner"},{id:"autoimmune",label:"Ich habe eine Autoimmunerkrankung"},{id:"surgery",label:"Bevorstehende Operation (< 2 Wochen)"},{id:"diabetes",label:"Ich habe Diabetes"},{id:"antipsychotics",label:"Ich nehme Antipsychotika"},{id:"pregnancy",label:"Ich bin schwanger oder stille"},{id:"antiretrovirals",label:"Ich nehme antiretrovirale Medikamente"},{id:"hemochromatosis",label:"Ich habe Hämochromatose"},{id:"kidney",label:"Nierenprobleme"},{id:"none",label:"Keine der oben genannten"}],
  pt:[{id:"anticoagulants",label:"Tomo anticoagulantes"},{id:"autoimmune",label:"Tenho doença autoimune"},{id:"surgery",label:"Cirurgia próxima (< 2 semanas)"},{id:"diabetes",label:"Tenho diabetes"},{id:"antipsychotics",label:"Tomo antipsicóticos"},{id:"pregnancy",label:"Estou grávida ou amamentando"},{id:"antiretrovirals",label:"Tomo antirretrovirais"},{id:"hemochromatosis",label:"Tenho hemocromatose"},{id:"kidney",label:"Problemas renais"},{id:"none",label:"Nenhuma das anteriores"}],
  it:[{id:"anticoagulants",label:"Prendo anticoagulanti"},{id:"autoimmune",label:"Ho una malattia autoimmune"},{id:"surgery",label:"Operazione imminente (< 2 settimane)"},{id:"diabetes",label:"Ho il diabete"},{id:"antipsychotics",label:"Prendo antipsicotici"},{id:"pregnancy",label:"Sono incinta o allatto"},{id:"antiretrovirals",label:"Prendo antiretrovirali"},{id:"hemochromatosis",label:"Ho l'emocromatosi"},{id:"kidney",label:"Problemi renali"},{id:"none",label:"Nessuna delle precedenti"}]
};

const buildPrompt = (lang) => {
  const ln = {es:"Spanish",en:"English",fr:"French",de:"German",pt:"Portuguese",it:"Italian"}[lang]||"English";
  return `You are NeoRejuvenation assistant by Antonio Moll. Respond ONLY in ${ln}. All fields in ${ln}.\nFUNDAMENTAL: Vitamin C (morning+night, SOLARAY 1000mg Retard), Reishi (morning+night with food, Kinoko 1500mg — CONTRAINDICATED: anticoagulants/autoimmune/surgery).\nOPTIONAL: Hyaluronic Acid (night, Solgar), Resveratrol (morning, Solgar/Revidox), Cordyceps (night — CONTRA: pregnancy/antipsychotics/anticoagulants), Shiitake+Maitake (morning), SOD (morning, Douglas), Milk Thistle (morning, Soria Natural), Omega-3 (night, Lamberts), Pomegranate 2-3x/wk (Keriba), Collagen+Mg every 2-3 days (Ana Maria Lajusticia), Horsetail+B (morning, Redenhair — CONTRA: pregnancy/antiretrovirals).\nRULES: VitC+Reishi mandatory unless contraindicated. Min 3 max 8. Respect all contraindications.\nRespond ONLY valid JSON: {"routine":{"morning":[{"id":"string","name":"string","dose":"string","brand":"string","benefits":["string"],"notes":"string","frequency":"daily|alternate|2-3weekly"}],"afternoon":[],"night":[]},"personalMessage":"string","warnings":["string"]}`;
};

const C = {bg:"#07091a",surface:"#0c0f24",surfaceHigh:"#111530",border:"rgba(0,210,255,0.12)",borderHover:"rgba(0,210,255,0.35)",cyan:"#00d4ff",cyanDim:"rgba(0,212,255,0.15)",purple:"#b928ff",purpleDim:"rgba(185,40,255,0.15)",green:"#00ffa3",greenDim:"rgba(0,255,163,0.12)",orange:"#ff6b35",orangeDim:"rgba(255,107,53,0.15)",text:"#e4e8f4",textMuted:"#6b7a9e",textDim:"#9ba8c9"};

const injectFonts = () => {
  if (document.getElementById("neo-fonts")) return;
  const l = document.createElement("link"); l.id="neo-fonts"; l.rel="stylesheet";
  l.href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500&display=swap";
  document.head.appendChild(l);
  const s = document.createElement("style");
  s.textContent=`*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:rgba(0,212,255,.3);border-radius:2px}@keyframes pulseGlow{0%,100%{box-shadow:0 0 20px rgba(0,212,255,.2)}50%{box-shadow:0 0 40px rgba(0,212,255,.5)}}@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}@keyframes spin{to{transform:rotate(360deg)}}@keyframes breathe{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.08);opacity:1}}@keyframes checkPop{0%{transform:scale(0)}60%{transform:scale(1.2)}100%{transform:scale(1)}}@keyframes streakFlame{0%,100%{transform:scaleY(1) rotate(-2deg)}50%{transform:scaleY(1.1) rotate(2deg)}}@keyframes d1{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}@keyframes d2{0%,20%,80%,100%{transform:scale(0)}60%{transform:scale(1)}}@keyframes d3{0%,40%,100%{transform:scale(0)}80%{transform:scale(1.2)}}`;
  document.head.appendChild(s);
};

const Ring = ({pct,size=64,stroke=5,color=C.cyan}) => {
  const r=(size-stroke)/2,circ=2*Math.PI*r,dash=(pct/100)*circ;
  return <svg width={size} height={size} style={{transform:"rotate(-90deg)"}}><circle cx={size/2} cy={size/2} r={r} fill="none" stroke={`${color}22`} strokeWidth={stroke}/><circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" style={{transition:"stroke-dasharray 0.6s"}}/></svg>;
};

function Card({supp,checked,onToggle,period,t}) {
  const [exp,setExp]=useState(false);
  const ac={morning:C.cyan,afternoon:C.orange,night:C.purple}[period]||C.cyan;
  return (
    <div onClick={()=>onToggle(supp.id)} style={{background:checked?`${ac}08`:C.surfaceHigh,border:`1px solid ${checked?ac+"44":C.border}`,borderRadius:14,padding:"14px 16px",marginBottom:10,cursor:"pointer",transition:"all 0.2s",animation:"fadeUp 0.3s"}} onMouseEnter={e=>{if(!checked)e.currentTarget.style.borderColor=C.borderHover}} onMouseLeave={e=>{if(!checked)e.currentTarget.style.borderColor=checked?ac+"44":C.border}}>
      <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
        <div style={{width:24,height:24,borderRadius:8,flexShrink:0,marginTop:2,border:`2px solid ${checked?ac:C.border}`,background:checked?ac:"transparent",display:"flex",alignItems:"center",justifyContent:"center",transition:"all 0.2s",animation:checked?"checkPop 0.3s":"none"}}>
          {checked&&<span style={{color:"#000",fontSize:13,fontWeight:800}}>✓</span>}
        </div>
        <div style={{flex:1}}>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center",marginBottom:4}}>
            <span style={{fontFamily:"Oswald,sans-serif",fontWeight:700,fontSize:15,color:checked?ac:C.text}}>{supp.name}</span>
            <span style={{fontSize:12,color:C.textMuted}}>{supp.dose}</span>
            {supp.frequency!=="daily"&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:C.purpleDim,color:C.purple,border:`1px solid ${C.purple}44`}}>{supp.frequency==="alternate"?t.freq_alternate:t.freq_weekly}</span>}
          </div>
          <div style={{fontSize:12,color:C.textMuted,marginBottom:6,fontStyle:"italic"}}>{supp.brand}</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{supp.benefits.map((b,i)=><span key={i} style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:`${ac}15`,color:ac,border:`1px solid ${ac}30`}}>{b}</span>)}</div>
          {supp.notes&&<><div style={{marginTop:8}}><button onClick={e=>{e.stopPropagation();setExp(!exp)}} style={{background:"none",border:"none",color:C.textMuted,fontSize:11,cursor:"pointer",padding:0,textDecoration:"underline"}}>{exp?t.hide_info:t.more_info}</button></div>{exp&&<div style={{marginTop:8,padding:"8px 12px",background:`${ac}08`,borderRadius:8,border:`1px solid ${ac}20`,fontSize:12,color:C.textDim,lineHeight:1.6}}>{supp.notes}</div>}</>}
        </div>
      </div>
    </div>
  );
}

function Period({period,supplements,checks,onToggle,t}) {
  const ac={morning:C.cyan,afternoon:C.orange,night:C.purple}[period];
  const icons={morning:"🌅",afternoon:"☀️",night:"🌙"};
  const done=supplements.filter(s=>checks[s.id]).length,total=supplements.length;
  if(!total) return null;
  return (
    <div style={{marginBottom:28}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:10,background:`${ac}18`,border:`1px solid ${ac}30`,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:14}}>{icons[period]}</span></div>
          <div><div style={{fontFamily:"Oswald,sans-serif",fontWeight:700,fontSize:16,color:C.text}}>{{morning:t.morning,afternoon:t.afternoon,night:t.night}[period]}</div><div style={{fontSize:11,color:C.textMuted}}>{{morning:t.morning_hint,afternoon:t.afternoon_hint,night:t.night_hint}[period]}</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}><span style={{fontSize:13,color:done===total?ac:C.textMuted,fontWeight:600,fontFamily:"Oswald,sans-serif"}}>{done}/{total}</span><Ring pct={total?(done/total)*100:0} size={36} stroke={3} color={ac}/></div>
      </div>
      {supplements.map(s=><Card key={s.id} supp={s} checked={!!checks[s.id]} onToggle={onToggle} period={period} t={t}/>)}
    </div>
  );
}

function Onboarding({onComplete,GOALS,CONTRA,t}) {
  const [step,setStep]=useState(0),[goals,setGoals]=useState([]),[conds,setConds]=useState([]);
  const tg=id=>setGoals(g=>g.includes(id)?g.filter(x=>x!==id):[...g,id]);
  const tc=id=>{if(id==="none"){setConds(["none"]);return;}setConds(c=>{const n=c.filter(x=>x!=="none");return n.includes(id)?n.filter(x=>x!==id):[...n,id];});};
  const steps=[
    {ti:t.step1_title,su:t.step1_sub,ok:goals.length>0,body:<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>{GOALS.map(g=>{const sel=goals.includes(g.id);return<div key={g.id} onClick={()=>tg(g.id)} style={{padding:"14px 12px",borderRadius:14,cursor:"pointer",border:`1px solid ${sel?C.cyan+"60":C.border}`,background:sel?C.cyanDim:C.surfaceHigh,transition:"all 0.2s"}}><div style={{fontSize:18,marginBottom:6}}>{g.icon}</div><div style={{fontSize:13,fontWeight:600,color:sel?C.cyan:C.text,lineHeight:1.3}}>{g.label}</div><div style={{fontSize:11,color:C.textMuted,marginTop:3,lineHeight:1.4}}>{g.desc}</div></div>;})} </div>},
    {ti:t.step2_title,su:t.step2_sub,ok:conds.length>0,body:<div style={{display:"flex",flexDirection:"column",gap:8}}>{CONTRA.map(c=>{const sel=conds.includes(c.id);const cc=c.id==="none"?C.green:C.orange;return<div key={c.id} onClick={()=>tc(c.id)} style={{padding:"14px 16px",borderRadius:12,cursor:"pointer",display:"flex",alignItems:"center",gap:12,border:`1px solid ${sel?cc+"60":C.border}`,background:sel?cc+"18":C.surfaceHigh,transition:"all 0.2s"}}><div style={{width:20,height:20,borderRadius:6,border:`2px solid ${sel?cc:C.border}`,background:sel?cc:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{sel&&<span style={{color:"#000",fontSize:11,fontWeight:800}}>✓</span>}</div><span style={{fontSize:13,color:sel?C.text:C.textDim}}>{c.label}</span></div>;})} </div>},
    {ti:t.step3_title,su:t.step3_sub,ok:true,body:<div style={{textAlign:"center",padding:"20px 0"}}><div style={{fontSize:64,marginBottom:20,animation:"breathe 2s ease-in-out infinite"}}>🧬</div><div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center",marginBottom:20}}>{GOALS.filter(g=>goals.includes(g.id)).map(g=><span key={g.id} style={{fontSize:12,padding:"4px 12px",borderRadius:20,background:C.cyanDim,color:C.cyan,border:`1px solid ${C.cyan}30`}}>{g.icon} {g.label}</span>)}</div><div style={{padding:"14px",background:C.orangeDim,borderRadius:12,border:`1px solid ${C.orange}30`,fontSize:12,color:C.orange,lineHeight:1.6}}>{t.step3_disclaimer}</div></div>}
  ];
  const cur=steps[step];
  return (
    <div style={{maxWidth:480,margin:"0 auto",padding:"20px 4px"}}>
      <div style={{display:"flex",gap:8,justifyContent:"center",marginBottom:32}}>{steps.map((_,i)=><div key={i} style={{height:3,borderRadius:2,background:i<=step?C.cyan:C.border,transition:"all 0.3s",width:i===step?24:12}}/>)}</div>
      <h2 style={{fontFamily:"Oswald,sans-serif",fontWeight:800,fontSize:22,color:C.text,marginBottom:8}}>{cur.ti}</h2>
      <p style={{fontSize:13,color:C.textMuted,marginBottom:24,lineHeight:1.6}}>{cur.su}</p>
      <div style={{marginBottom:28,maxHeight:"50vh",overflowY:"auto"}}>{cur.body}</div>
      <div style={{display:"flex",gap:12}}>
        {step>0&&<button onClick={()=>setStep(s=>s-1)} style={{flex:1,padding:"14px",borderRadius:12,background:"transparent",border:`1px solid ${C.border}`,color:C.textDim,fontSize:14,cursor:"pointer"}}>{t.btn_back}</button>}
        <button onClick={()=>step<2?setStep(s=>s+1):onComplete(goals,conds)} disabled={!cur.ok} style={{flex:2,padding:"14px",borderRadius:12,background:cur.ok?`linear-gradient(135deg,${C.cyan},${C.purple})`:C.border,border:"none",color:cur.ok?"#000":C.textMuted,fontSize:14,fontFamily:"Oswald,sans-serif",fontWeight:700,cursor:cur.ok?"pointer":"not-allowed"}}>
          {step<2?t.btn_continue:t.btn_create}
        </button>
      </div>
    </div>
  );
}

function Generating({goals,GOALS,t}) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"60vh",gap:28,padding:24,textAlign:"center"}}>
      <div style={{position:"relative",width:100,height:100}}>
        <div style={{position:"absolute",inset:0,borderRadius:"50%",border:`2px solid ${C.cyan}30`,animation:"spin 3s linear infinite"}}/>
        <div style={{position:"absolute",inset:8,borderRadius:"50%",border:`2px solid ${C.purple}30`,animation:"spin 2s linear infinite reverse"}}/>
        <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontSize:32,animation:"breathe 2s ease-in-out infinite"}}>🧬</span></div>
      </div>
      <div><h2 style={{fontFamily:"Oswald,sans-serif",fontWeight:800,fontSize:22,color:C.text,marginBottom:8}}>{t.gen_title}</h2><p style={{color:C.textMuted,fontSize:14,lineHeight:1.6,maxWidth:300}}>{t.gen_sub}</p></div>
      <div style={{display:"flex",gap:8}}>{[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:"50%",background:C.cyan,animation:`d${i+1} 1.4s ease-in-out infinite`}}/>)}</div>
    </div>
  );
}

function ProgressView({history,streak,routine,t}) {
  const last7=Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-(6-i));const k=d.toISOString().slice(0,10);return{k,label:t.day_names[d.getDay()],rate:history[k]?.completionRate??null};});
  const all=[...(routine?.morning||[]),...(routine?.afternoon||[]),...(routine?.night||[])];
  const avg=last7.filter(d=>d.rate!==null).reduce((s,d)=>s+d.rate,0)/Math.max(last7.filter(d=>d.rate!==null).length,1);
  return (
    <div>
      <h3 style={{fontFamily:"Oswald,sans-serif",fontWeight:700,fontSize:18,color:C.text,marginBottom:20}}>{t.progress_title}</h3>
      <div style={{background:C.surfaceHigh,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:16,display:"flex",alignItems:"center",gap:16}}>
        <div style={{fontSize:40,animation:streak>0?"streakFlame 1.5s ease-in-out infinite":"none"}}>🔥</div>
        <div><div style={{fontFamily:"Oswald,sans-serif",fontWeight:800,fontSize:36,color:C.orange,lineHeight:1}}>{streak}</div><div style={{fontSize:12,color:C.textMuted,marginTop:2}}>{t.streak_card_label}</div><div style={{fontSize:11,color:C.textDim}}>{streak} {t.streak_days}</div></div>
      </div>
      <div style={{background:C.surfaceHigh,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:16}}>
        <div style={{fontSize:12,color:C.textMuted,marginBottom:16,textTransform:"uppercase",letterSpacing:"0.1em"}}>{t.last7}</div>
        <div style={{display:"flex",gap:8,alignItems:"flex-end",height:80}}>
          {last7.map((d,i)=>{const r=d.rate??0,tod=i===6;const col=r>=0.8?C.green:r>=0.5?C.cyan:r>0?C.orange:C.border;return(
            <div key={d.k} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              <div style={{width:"100%",height:60,display:"flex",alignItems:"flex-end",borderRadius:6,overflow:"hidden",background:`${col}15`}}><div style={{width:"100%",height:`${d.rate!==null?Math.max(r*100,4):4}%`,background:d.rate!==null?col:C.border,borderRadius:6,transition:"height 0.6s",minHeight:4}}/></div>
              <span style={{fontSize:10,color:tod?C.cyan:C.textMuted,fontWeight:tod?700:400}}>{d.label}</span>
            </div>
          );})}
        </div>
        <div style={{marginTop:12,display:"flex",alignItems:"center",gap:8}}><Ring pct={Math.round(avg*100)} size={28} stroke={3} color={C.cyan}/><span style={{fontSize:12,color:C.textDim}}>{t.weekly_avg}: <strong style={{color:C.cyan}}>{Math.round(avg*100)}%</strong></span></div>
      </div>
      <div style={{background:C.surfaceHigh,border:`1px solid ${C.border}`,borderRadius:16,padding:20}}>
        <div style={{fontSize:12,color:C.textMuted,marginBottom:14,textTransform:"uppercase",letterSpacing:"0.1em"}}>{t.routine_title}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          {[{p:"morning",l:t.morning,c:C.cyan},{p:"afternoon",l:t.afternoon,c:C.orange},{p:"night",l:t.night,c:C.purple}].map(x=>(
            <div key={x.p} style={{textAlign:"center",padding:"14px 8px",background:`${x.c}10`,borderRadius:12,border:`1px solid ${x.c}25`}}>
              <div style={{fontFamily:"Oswald,sans-serif",fontWeight:800,fontSize:28,color:x.c}}>{routine?.[x.p]?.length||0}</div>
              <div style={{fontSize:11,color:C.textMuted,marginTop:2}}>{x.l}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:14,padding:"10px 14px",background:C.cyanDim,borderRadius:10,border:`1px solid ${C.cyan}20`}}><span style={{fontSize:12,color:C.cyan}}>🌿 <strong>{all.length} {t.total_supps}</strong></span></div>
      </div>
    </div>
  );
}

function SettingsView({rems,onRem,onNotif,notifOk,onRegen,routine,t}) {
  const ps=[{id:"morning",l:t.morning,i:"🌅",c:C.cyan},{id:"afternoon",l:t.afternoon,i:"☀️",c:C.orange},{id:"night",l:t.night,i:"🌙",c:C.purple}];
  return (
    <div>
      <h3 style={{fontFamily:"Oswald,sans-serif",fontWeight:700,fontSize:18,color:C.text,marginBottom:20}}>{t.settings_title}</h3>
      <div style={{background:C.surfaceHigh,border:`1px solid ${C.border}`,borderRadius:16,padding:20,marginBottom:16}}>
        <div style={{fontSize:12,color:C.textMuted,marginBottom:16,textTransform:"uppercase",letterSpacing:"0.1em"}}>{t.reminders_title}</div>
        {!notifOk&&<button onClick={onNotif} style={{width:"100%",padding:"12px",borderRadius:12,background:C.cyanDim,border:`1px solid ${C.cyan}40`,color:C.cyan,fontSize:13,cursor:"pointer",marginBottom:16}}>{t.notif_btn}</button>}
        {notifOk&&<div style={{padding:"8px 12px",background:C.greenDim,borderRadius:10,border:`1px solid ${C.green}30`,marginBottom:16,fontSize:12,color:C.green}}>{t.notif_granted}</div>}
        {ps.map(p=>{if(!routine?.[p.id]?.length)return null;return(
          <div key={p.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 0",borderBottom:`1px solid ${C.border}`}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}><span>{p.i}</span><span style={{fontSize:14,color:C.text}}>{p.l}</span></div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <input type="time" value={rems[p.id]?.time||"08:00"} onChange={e=>onRem(p.id,"time",e.target.value)} style={{background:C.surface,border:`1px solid ${p.c}40`,borderRadius:8,padding:"6px 10px",color:C.text,fontSize:13}}/>
              <div onClick={()=>onRem(p.id,"enabled",!rems[p.id]?.enabled)} style={{width:40,height:22,borderRadius:11,background:rems[p.id]?.enabled?p.c:C.border,position:"relative",cursor:"pointer",transition:"background 0.2s"}}><div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:2,left:rems[p.id]?.enabled?20:2,transition:"left 0.2s"}}/></div>
            </div>
          </div>
        );})}
        <div style={{marginTop:12,fontSize:11,color:C.textMuted,lineHeight:1.5}}>{t.notif_hint}</div>
      </div>
      <div style={{background:C.surfaceHigh,border:`1px solid ${C.border}`,borderRadius:16,padding:20}}>
        <div style={{fontSize:12,color:C.textMuted,marginBottom:14,textTransform:"uppercase",letterSpacing:"0.1em"}}>{t.routine_section}</div>
        <p style={{fontSize:13,color:C.textDim,marginBottom:14,lineHeight:1.6}}>{t.regenerate_hint}</p>
        <button onClick={onRegen} style={{width:"100%",padding:"12px",borderRadius:12,background:"transparent",border:`1px solid ${C.purple}50`,color:C.purple,fontSize:13,cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.background=C.purpleDim} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>{t.regenerate_btn}</button>
      </div>
    </div>
  );
}

export default function App() {
  const [lang]=useState(()=>detectLang());
  const t=T[lang]||T.es, GOALS=GOALS_I18N[lang]||GOALS_I18N.es, CONTRA=CONTRA_I18N[lang]||CONTRA_I18N.es;
  const [appState,setAppState]=useState("loading"),[view,setView]=useState("today");
  const [profile,setProfile]=useState(null),[routine,setRoutine]=useState(null);
  const [checks,setChecks]=useState({}),[history,setHistory]=useState({});
  const [streak,setStreak]=useState(0),[rems,setRems]=useState({morning:{time:"08:00",enabled:true},afternoon:{time:"14:00",enabled:false},night:{time:"21:00",enabled:true}});
  const [notif,setNotif]=useState(false),[aiMsg,setAiMsg]=useState(null);
  const [warns,setWarns]=useState([]),[toast,setToast]=useState(null);
  const today=new Date().toISOString().slice(0,10), ref=useRef(null);

  useEffect(()=>{injectFonts();},[]);

  useEffect(()=>{
    (async()=>{
      try {
        const [pR,rR,hR,cR,remR]=await Promise.all(["neo-profile","neo-routine","neo-history",`neo-checks-${today}`,"neo-reminders"].map(k=>storage.get(k)));
        if(pR) setProfile(JSON.parse(pR.value));
        if(rR){const r=JSON.parse(rR.value);setRoutine(r.routine);setAiMsg(r.personalMessage);setWarns(r.warnings||[]);}
        if(hR) setHistory(JSON.parse(hR.value));
        if(cR) setChecks(JSON.parse(cR.value));
        if(remR) setRems(JSON.parse(remR.value));
        setAppState(pR&&rR?"dashboard":"onboarding");
      } catch { setAppState("onboarding"); }
    })();
  },[]);

  useEffect(()=>{let s=0;const n=new Date();for(let i=0;i<30;i++){const d=new Date(n);d.setDate(d.getDate()-i);const k=d.toISOString().slice(0,10);if(history[k]?.completionRate>=0.5)s++;else break;}setStreak(s);},[history]);

  useEffect(()=>{
    if(appState!=="dashboard"||!routine) return;
    const all=[...(routine.morning||[]),...(routine.afternoon||[]),...(routine.night||[])];
    const rate=all.length?all.filter(s=>checks[s.id]).length/all.length:0;
    storage.set(`neo-checks-${today}`,JSON.stringify(checks));
    const nh={...history,[today]:{checks,completionRate:rate}};
    setHistory(nh); storage.set("neo-history",JSON.stringify(nh));
  },[checks]);

  useEffect(()=>{
    if(appState!=="dashboard") return;
    ref.current=setInterval(()=>{
      const n=new Date();
      const ts=`${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`;
      Object.entries(rems).forEach(([p,cfg])=>{
        if(cfg.enabled&&cfg.time===ts){
          const msg=`${t.reminder_prefix} ${[t.morning_notif,t.afternoon_notif,t.night_notif][["morning","afternoon","night"].indexOf(p)]}: ${(routine?.[p]||[]).map(s=>s.name).join(", ")}`;
          if(notif&&"Notification" in window) new Notification("NeoRejuvenation",{body:msg});
          setToast(msg); setTimeout(()=>setToast(null),6000);
        }
      });
    },30000);
    return()=>clearInterval(ref.current);
  },[appState,rems,routine,notif,t]);

  const finish=async(goals,conds)=>{
    const p={goals,contraindications:conds,lang};
    setProfile(p); setAppState("generating");
    await storage.set("neo-profile",JSON.stringify(p));
    const goalList=GOALS.filter(g=>p.goals.includes(g.id)).map(g=>g.label).join(", ");
    const ln={es:"Spanish",en:"English",fr:"French",de:"German",pt:"Portuguese",it:"Italian"}[lang]||"English";
    try {
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:buildPrompt(lang),messages:[{role:"user",content:`Goals: ${goalList}. Contraindications: ${conds.join(", ")}. JSON only in ${ln}.`}]})});
      const data=await res.json();
      const parsed=JSON.parse((data.content?.find(c=>c.type==="text")?.text||"{}").replace(/```json|```/g,"").trim());
      await storage.set("neo-routine",JSON.stringify(parsed));
      setRoutine(parsed.routine); setAiMsg(parsed.personalMessage); setWarns(parsed.warnings||[]); setAppState("dashboard");
    } catch {
      const fb={routine:{morning:[{id:"vc-am",name:"Vitamin C",dose:"1000mg",brand:"SOLARAY 1000mg Retard",benefits:["Antioxidant","Collagen","Immunity"],notes:"With breakfast.",frequency:"daily"},{id:"rei-am",name:"Reishi",dose:"1500mg",brand:"Kinoko Reishi 1500mg",benefits:["Anti-aging","Immune","Liver"],notes:"With Vitamin C and food.",frequency:"daily"}],afternoon:[],night:[{id:"vc-pm",name:"Vitamin C",dose:"1000mg",brand:"Solgar 500mg",benefits:["Antioxidant","Regeneration"],notes:"Evening dose.",frequency:"daily"},{id:"rei-pm",name:"Reishi",dose:"1500mg",brand:"Kinoko Reishi 1500mg",benefits:["Sleep","Anti-stress"],notes:"Night regeneration.",frequency:"daily"}]},personalMessage:t.fallback_msg,warnings:[t.fallback_warning]};
      await storage.set("neo-routine",JSON.stringify(fb));
      setRoutine(fb.routine); setAiMsg(fb.personalMessage); setWarns(fb.warnings); setAppState("dashboard");
    }
  };

  const toggle=useCallback(id=>setChecks(p=>({...p,[id]:!p[id]})),[]);
  const remUpdate=(p,f,v)=>{const n={...rems,[p]:{...rems[p],[f]:v}};setRems(n);storage.set("neo-reminders",JSON.stringify(n));};
  const regen=()=>{setAppState("onboarding");setRoutine(null);setChecks({});storage.delete("neo-routine");storage.delete("neo-profile");};

  const all=[...(routine?.morning||[]),...(routine?.afternoon||[]),...(routine?.night||[])];
  const pct=all.length?Math.round(all.filter(s=>checks[s.id]).length/all.length*100):0;
  const tabs=[{id:"today",l:t.tab_today,i:"📋"},{id:"progress",l:t.tab_progress,i:"📊"},{id:"settings",l:t.tab_settings,i:"⚙️"}];

  return (
    <div style={{fontFamily:"DM Sans,sans-serif",background:C.bg,minHeight:"100vh",color:C.text,maxWidth:520,margin:"0 auto",position:"relative"}}>
      <div style={{position:"fixed",top:-100,right:-100,width:300,height:300,borderRadius:"50%",background:`radial-gradient(circle,${C.purple}15,transparent 70%)`,pointerEvents:"none"}}/>
      <div style={{position:"fixed",bottom:-50,left:-50,width:250,height:250,borderRadius:"50%",background:`radial-gradient(circle,${C.cyan}10,transparent 70%)`,pointerEvents:"none"}}/>
      <div style={{padding:"20px 20px 0",position:"sticky",top:0,zIndex:10,background:`${C.bg}ee`,backdropFilter:"blur(20px)",borderBottom:appState==="dashboard"?`1px solid ${C.border}`:"none"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <div>
            <div style={{fontFamily:"Oswald,sans-serif",fontWeight:700,fontSize:20,letterSpacing:"0.04em",display:"flex",alignItems:"baseline"}}><span style={{color:"#fff"}}>NEO</span><span style={{background:"linear-gradient(90deg,#5b7fd4,#1abfe8)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>REJUVENATION</span></div>
            <div style={{fontSize:11,color:C.textMuted,letterSpacing:"0.15em",textTransform:"uppercase"}}>{t.trackerSub}</div>
          </div>
          {appState==="dashboard"&&<div style={{display:"flex",alignItems:"center",gap:10}}><div style={{textAlign:"right",marginRight:4}}><div style={{fontFamily:"Oswald,sans-serif",fontWeight:800,fontSize:18,color:pct===100?C.green:C.cyan}}>{pct}%</div><div style={{fontSize:10,color:C.textMuted}}>{t.today_label}</div></div><Ring pct={pct} size={44} stroke={4} color={pct===100?C.green:C.cyan}/></div>}
        </div>
        {appState==="dashboard"&&<div style={{display:"flex",gap:2}}>{tabs.map(tab=><button key={tab.id} onClick={()=>setView(tab.id)} style={{flex:1,padding:"10px 4px",border:"none",background:"transparent",cursor:"pointer",color:view===tab.id?C.cyan:C.textMuted,fontSize:13,fontWeight:view===tab.id?500:400,borderBottom:`2px solid ${view===tab.id?C.cyan:"transparent"}`,transition:"all 0.2s",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}><span style={{fontSize:11}}>{tab.i}</span>{tab.l}</button>)}</div>}
      </div>
      {toast&&<div style={{position:"fixed",top:80,left:"50%",transform:"translateX(-50%)",zIndex:100,background:C.surfaceHigh,border:`1px solid ${C.cyan}40`,borderRadius:14,padding:"12px 18px",maxWidth:340,width:"90%",animation:"fadeUp 0.3s",boxShadow:`0 8px 32px ${C.cyan}20`,fontSize:13,color:C.text,lineHeight:1.5}}>{toast}</div>}
      <div style={{padding:"20px",paddingBottom:100}}>
        {appState==="loading"&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"60vh"}}><div style={{width:40,height:40,border:`3px solid ${C.cyan}30`,borderTop:`3px solid ${C.cyan}`,borderRadius:"50%",animation:"spin 1s linear infinite"}}/></div>}
        {appState==="onboarding"&&<Onboarding onComplete={finish} GOALS={GOALS} CONTRA={CONTRA} t={t}/>}
        {appState==="generating"&&<Generating goals={profile?.goals||[]} GOALS={GOALS} t={t}/>}
        {appState==="dashboard"&&routine&&<>
          {view==="today"&&<div>
            {aiMsg&&<div style={{padding:"14px 16px",background:`linear-gradient(135deg,${C.cyanDim},${C.purpleDim})`,border:`1px solid ${C.cyan}25`,borderRadius:14,marginBottom:20,position:"relative",overflow:"hidden"}}><div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${C.cyan},${C.purple})`}}/><div style={{fontSize:12,color:C.cyan,marginBottom:6,textTransform:"uppercase",letterSpacing:"0.1em"}}>{t.ai_label}</div><p style={{fontSize:13,color:C.textDim,lineHeight:1.6}}>{aiMsg}</p></div>}
            {warns.length>0&&<div style={{marginBottom:20}}>{warns.map((w,i)=><div key={i} style={{padding:"10px 14px",background:C.orangeDim,border:`1px solid ${C.orange}30`,borderRadius:10,marginBottom:8,fontSize:12,color:C.orange}}>⚠️ {w}</div>)}</div>}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
              <div><div style={{fontSize:12,color:C.textMuted,textTransform:"uppercase",letterSpacing:"0.1em"}}>{t.today_header}</div><div style={{fontFamily:"Oswald,sans-serif",fontWeight:700,fontSize:16,color:C.text}}>{new Date().toLocaleDateString(t.date_locale,{weekday:"long",day:"numeric",month:"long"})}</div></div>
              <div style={{display:"flex",alignItems:"center",gap:6}}><span>🔥</span><span style={{fontFamily:"Oswald,sans-serif",fontWeight:700,color:C.orange}}>{streak} {t.streak_label}</span></div>
            </div>
            {["morning","afternoon","night"].map(p=><Period key={p} period={p} supplements={routine[p]||[]} checks={checks} onToggle={toggle} t={t}/>)}
            {pct===100&&<div style={{padding:"20px",background:`linear-gradient(135deg,${C.greenDim},${C.cyanDim})`,border:`1px solid ${C.green}40`,borderRadius:16,textAlign:"center",animation:"pulseGlow 2s ease-in-out infinite"}}><div style={{fontSize:36,marginBottom:8}}>🎉</div><div style={{fontFamily:"Oswald,sans-serif",fontWeight:800,fontSize:18,color:C.green,marginBottom:4}}>{t.complete_title}</div><div style={{fontSize:13,color:C.textDim}}>{t.complete_sub}</div></div>}
          </div>}
          {view==="progress"&&<ProgressView history={history} streak={streak} routine={routine} t={t}/>}
          {view==="settings"&&<SettingsView rems={rems} onRem={remUpdate} onNotif={async()=>{if("Notification" in window){const p=await Notification.requestPermission();setNotif(p==="granted");}}} notifOk={notif} onRegen={regen} routine={routine} t={t}/>}
        </>}
      </div>
    </div>
  );
}
