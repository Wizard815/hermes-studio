/** Thread stages in projects (docs/projects.md#thread-stages), in every locale. */
const en = {
  groups: { needsYou: 'Needs you', working: 'Working', review: 'Ready for review', done: 'Done', resolved: 'Resolved' },
  badgeReview: '{n} to review',
  failed: 'Failed',
  failedHint: 'Its agent stopped before it finished. Send it a message to carry on, or resolve it.',
  autoResolve: 'Resolve done threads after (days)',
  autoResolveHint: 'A thread is done once it finished and you opened it. 0 means never.',
  autoResolveContext: 'Auto-resolve',
  days: '{n} days',
  never: 'Never',
}

type StageMessages = typeof en

const zh: StageMessages = {
  groups: { needsYou: '需要你', working: '进行中', review: '待查看', done: '已完成', resolved: '已解决' },
  badgeReview: '{n} 个待查看', failed: '失败',
  failedHint: '它的智能体在完成前停止了。发消息让它继续，或将其标记为已解决。',
  autoResolve: '已完成的线程在几天后自动解决', autoResolveHint: '线程完成且你打开过后即为已完成。0 表示从不。',
  autoResolveContext: '自动解决', days: '{n} 天', never: '从不',
}

const zhTW: StageMessages = {
  groups: { needsYou: '需要你', working: '進行中', review: '待檢視', done: '已完成', resolved: '已解決' },
  badgeReview: '{n} 個待檢視', failed: '失敗',
  failedHint: '它的代理在完成前停止了。傳訊息讓它繼續，或將其標記為已解決。',
  autoResolve: '已完成的執行緒在幾天後自動解決', autoResolveHint: '執行緒完成且你開啟過後即為已完成。0 表示永不。',
  autoResolveContext: '自動解決', days: '{n} 天', never: '永不',
}

const ja: StageMessages = {
  groups: { needsYou: '要対応', working: '作業中', review: '確認待ち', done: '完了', resolved: '解決済み' },
  badgeReview: '確認待ち {n}', failed: '失敗',
  failedHint: 'エージェントが終わる前に止まりました。メッセージを送って続けるか、解決済みにしてください。',
  autoResolve: '完了したスレッドを解決するまでの日数', autoResolveHint: '終わってあなたが開いたスレッドが完了です。0 は解決しません。',
  autoResolveContext: '自動解決', days: '{n} 日', never: 'しない',
}

const ko: StageMessages = {
  groups: { needsYou: '확인 필요', working: '작업 중', review: '검토 대기', done: '완료', resolved: '해결됨' },
  badgeReview: '검토 대기 {n}', failed: '실패',
  failedHint: '에이전트가 끝나기 전에 멈췄습니다. 메시지를 보내 계속하게 하거나 해결로 표시하세요.',
  autoResolve: '완료된 스레드를 해결할 때까지의 일수', autoResolveHint: '끝났고 당신이 연 스레드가 완료입니다. 0이면 하지 않습니다.',
  autoResolveContext: '자동 해결', days: '{n}일', never: '안 함',
}

const de: StageMessages = {
  groups: { needsYou: 'Braucht dich', working: 'Arbeitet', review: 'Zum Ansehen', done: 'Fertig', resolved: 'Erledigt' },
  badgeReview: '{n} zum Ansehen', failed: 'Fehlgeschlagen',
  failedHint: 'Sein Agent hat vor dem Ende aufgehört. Schick ihm eine Nachricht, damit er weitermacht, oder erledige ihn.',
  autoResolve: 'Fertige Threads erledigen nach (Tagen)', autoResolveHint: 'Ein Thread ist fertig, wenn er durch ist und du ihn geöffnet hast. 0 heißt nie.',
  autoResolveContext: 'Automatisch erledigen', days: '{n} Tage', never: 'Nie',
}

const es: StageMessages = {
  groups: { needsYou: 'Te necesita', working: 'Trabajando', review: 'Para revisar', done: 'Hecho', resolved: 'Resuelto' },
  badgeReview: '{n} para revisar', failed: 'Falló',
  failedHint: 'Su agente se detuvo antes de terminar. Envíale un mensaje para que siga, o resuélvelo.',
  autoResolve: 'Resolver hilos hechos tras (días)', autoResolveHint: 'Un hilo está hecho cuando terminó y lo abriste. 0 es nunca.',
  autoResolveContext: 'Resolver solo', days: '{n} días', never: 'Nunca',
}

const fr: StageMessages = {
  groups: { needsYou: 'Vous attend', working: 'En cours', review: 'À relire', done: 'Terminé', resolved: 'Résolu' },
  badgeReview: '{n} à relire', failed: 'Échec',
  failedHint: 'Son agent s\'est arrêté avant la fin. Envoyez-lui un message pour qu\'il continue, ou résolvez-le.',
  autoResolve: 'Résoudre les fils terminés après (jours)', autoResolveHint: 'Un fil est terminé quand il a fini et que vous l\'avez ouvert. 0 = jamais.',
  autoResolveContext: 'Résolution auto', days: '{n} jours', never: 'Jamais',
}

const pt: StageMessages = {
  groups: { needsYou: 'Precisa de você', working: 'Trabalhando', review: 'Para revisar', done: 'Concluído', resolved: 'Resolvido' },
  badgeReview: '{n} para revisar', failed: 'Falhou',
  failedHint: 'O agente parou antes de terminar. Envie uma mensagem para ele continuar, ou resolva-o.',
  autoResolve: 'Resolver threads concluídas após (dias)', autoResolveHint: 'Uma thread está concluída quando terminou e você a abriu. 0 = nunca.',
  autoResolveContext: 'Resolver sozinho', days: '{n} dias', never: 'Nunca',
}

const ru: StageMessages = {
  groups: { needsYou: 'Нужны вы', working: 'В работе', review: 'На проверку', done: 'Готово', resolved: 'Решено' },
  badgeReview: 'на проверку: {n}', failed: 'Сбой',
  failedHint: 'Агент остановился, не закончив. Напишите ему, чтобы он продолжил, или отметьте решённым.',
  autoResolve: 'Отмечать готовые треды решёнными через (дней)', autoResolveHint: 'Тред готов, когда он закончил и вы его открыли. 0 — никогда.',
  autoResolveContext: 'Автозакрытие', days: '{n} дн.', never: 'Никогда',
}

const tr: StageMessages = {
  groups: { needsYou: 'Seni bekliyor', working: 'Çalışıyor', review: 'İncelemeye hazır', done: 'Bitti', resolved: 'Çözüldü' },
  badgeReview: '{n} incelenecek', failed: 'Başarısız',
  failedHint: 'Ajanı bitirmeden durdu. Devam etmesi için mesaj gönder ya da çözüldü olarak işaretle.',
  autoResolve: 'Biten konuları şu kadar gün sonra çöz', autoResolveHint: 'Bir konu, bitip sen açtığında biter. 0 hiçbir zaman demek.',
  autoResolveContext: 'Otomatik çözme', days: '{n} gün', never: 'Hiçbir zaman',
}

const ar: StageMessages = {
  groups: { needsYou: 'يحتاجك', working: 'قيد العمل', review: 'جاهز للمراجعة', done: 'منتهٍ', resolved: 'محلول' },
  badgeReview: '{n} للمراجعة', failed: 'فشل',
  failedHint: 'توقف وكيله قبل أن ينتهي. أرسل له رسالة ليكمل، أو اجعله محلولًا.',
  autoResolve: 'حل السلاسل المنتهية بعد (أيام)', autoResolveHint: 'تنتهي السلسلة عندما تكتمل وتفتحها أنت. 0 يعني أبدًا.',
  autoResolveContext: 'حل تلقائي', days: '{n} أيام', never: 'أبدًا',
}

export const projectStageMessages: Record<string, { projectStages: StageMessages }> = {
  en: { projectStages: en },
  zh: { projectStages: zh },
  'zh-TW': { projectStages: zhTW },
  ja: { projectStages: ja },
  ko: { projectStages: ko },
  de: { projectStages: de },
  es: { projectStages: es },
  fr: { projectStages: fr },
  pt: { projectStages: pt },
  ru: { projectStages: ru },
  tr: { projectStages: tr },
  ar: { projectStages: ar },
}
