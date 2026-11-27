/** Studio groups and the bridge log (docs/projects.md#studio-groups), in every locale. */
const en = {
  join: 'Add it to this Studio\'s group',
  joinHint: 'Group members are introduced to every other member, so all of them can talk. Use it only for Studios you trust.',
  title: 'This Studio\'s group',
  hint: 'Projects every Studio in the group may see and message.',
  member: 'In the group',
  badge: 'Group',
  introducedBy: 'Introduced by {label}',
  log: 'Between Studios',
  logEmpty: 'Nothing has crossed yet.',
  to: 'To {label}',
  from: 'From {label}',
  by: { person: 'you', coordinator: 'coordinator', studio: 'group' },
  kinds: { message: 'message', task: 'task', introduced: 'joined' },
}

type GroupMessages = typeof en

const zh: GroupMessages = {
  join: '把它加入本 Studio 的群组', joinHint: '群组成员会被介绍给其他所有成员，所以它们都能互相通信。只对你信任的 Studio 使用。',
  title: '本 Studio 的群组', hint: '群组中每个 Studio 都能查看并发消息的项目。', member: '在群组中', badge: '群组',
  introducedBy: '由 {label} 介绍', log: 'Studio 之间', logEmpty: '还没有往来。', to: '发给 {label}', from: '来自 {label}',
  by: { person: '你', coordinator: '协调者', studio: '群组' }, kinds: { message: '消息', task: '任务', introduced: '加入' },
}
const zhTW: GroupMessages = {
  join: '把它加入本 Studio 的群組', joinHint: '群組成員會被介紹給其他所有成員，所以它們都能互相溝通。只對你信任的 Studio 使用。',
  title: '本 Studio 的群組', hint: '群組中每個 Studio 都能檢視並傳訊息的專案。', member: '在群組中', badge: '群組',
  introducedBy: '由 {label} 介紹', log: 'Studio 之間', logEmpty: '還沒有往來。', to: '傳給 {label}', from: '來自 {label}',
  by: { person: '你', coordinator: '協調者', studio: '群組' }, kinds: { message: '訊息', task: '任務', introduced: '加入' },
}
const ja: GroupMessages = {
  join: 'この Studio のグループに追加', joinHint: 'グループのメンバーは他の全メンバーに紹介され、互いにやり取りできます。信頼できる Studio にだけ使ってください。',
  title: 'この Studio のグループ', hint: 'グループのすべての Studio が見てメッセージできるプロジェクト。', member: 'グループ内', badge: 'グループ',
  introducedBy: '{label} が紹介', log: 'Studio 間', logEmpty: 'まだやり取りはありません。', to: '{label} へ', from: '{label} から',
  by: { person: 'あなた', coordinator: 'コーディネーター', studio: 'グループ' }, kinds: { message: 'メッセージ', task: 'タスク', introduced: '参加' },
}
const ko: GroupMessages = {
  join: '이 Studio의 그룹에 추가', joinHint: '그룹 멤버는 다른 모든 멤버에게 소개되어 서로 대화할 수 있습니다. 신뢰하는 Studio에만 사용하세요.',
  title: '이 Studio의 그룹', hint: '그룹의 모든 Studio가 보고 메시지를 보낼 수 있는 프로젝트.', member: '그룹에 있음', badge: '그룹',
  introducedBy: '{label}이(가) 소개함', log: 'Studio 간', logEmpty: '아직 주고받은 것이 없습니다.', to: '{label}에게', from: '{label}에서',
  by: { person: '나', coordinator: '코디네이터', studio: '그룹' }, kinds: { message: '메시지', task: '작업', introduced: '참여' },
}
const fr: GroupMessages = {
  join: 'L\'ajouter au groupe de ce Studio', joinHint: 'Les membres du groupe sont présentés à tous les autres, pour que tous puissent se parler. À réserver aux Studios de confiance.',
  title: 'Groupe de ce Studio', hint: 'Projets que chaque Studio du groupe peut voir et contacter.', member: 'Dans le groupe', badge: 'Groupe',
  introducedBy: 'Présenté par {label}', log: 'Entre Studios', logEmpty: 'Rien n\'est encore passé.', to: 'Vers {label}', from: 'De {label}',
  by: { person: 'vous', coordinator: 'coordinateur', studio: 'groupe' }, kinds: { message: 'message', task: 'tâche', introduced: 'arrivé' },
}
const es: GroupMessages = {
  join: 'Añadirlo al grupo de este Studio', joinHint: 'Los miembros del grupo se presentan a todos los demás, así todos pueden hablar entre sí. Úsalo solo con Studios de confianza.',
  title: 'Grupo de este Studio', hint: 'Proyectos que cada Studio del grupo puede ver y escribir.', member: 'En el grupo', badge: 'Grupo',
  introducedBy: 'Presentado por {label}', log: 'Entre Studios', logEmpty: 'Todavía no ha pasado nada.', to: 'A {label}', from: 'De {label}',
  by: { person: 'tú', coordinator: 'coordinador', studio: 'grupo' }, kinds: { message: 'mensaje', task: 'tarea', introduced: 'se unió' },
}
const de: GroupMessages = {
  join: 'Zur Gruppe dieses Studios hinzufügen', joinHint: 'Gruppenmitglieder werden allen anderen Mitgliedern vorgestellt, damit alle miteinander reden können. Nur für Studios, denen Sie vertrauen.',
  title: 'Gruppe dieses Studios', hint: 'Projekte, die jedes Studio der Gruppe sehen und anschreiben darf.', member: 'In der Gruppe', badge: 'Gruppe',
  introducedBy: 'Vorgestellt von {label}', log: 'Zwischen Studios', logEmpty: 'Noch nichts ausgetauscht.', to: 'An {label}', from: 'Von {label}',
  by: { person: 'Sie', coordinator: 'Koordinator', studio: 'Gruppe' }, kinds: { message: 'Nachricht', task: 'Aufgabe', introduced: 'beigetreten' },
}
const pt: GroupMessages = {
  join: 'Adicioná-lo ao grupo deste Studio', joinHint: 'Os membros do grupo são apresentados a todos os outros, para que todos possam conversar. Use só com Studios de confiança.',
  title: 'Grupo deste Studio', hint: 'Projetos que cada Studio do grupo pode ver e contatar.', member: 'No grupo', badge: 'Grupo',
  introducedBy: 'Apresentado por {label}', log: 'Entre Studios', logEmpty: 'Nada passou ainda.', to: 'Para {label}', from: 'De {label}',
  by: { person: 'você', coordinator: 'coordenador', studio: 'grupo' }, kinds: { message: 'mensagem', task: 'tarefa', introduced: 'entrou' },
}
const ru: GroupMessages = {
  join: 'Добавить в группу этой Studio', joinHint: 'Участников группы знакомят со всеми остальными, чтобы все могли общаться. Только для Studio, которым вы доверяете.',
  title: 'Группа этой Studio', hint: 'Проекты, которые видит и которым может писать каждая Studio группы.', member: 'В группе', badge: 'Группа',
  introducedBy: 'Представил(а) {label}', log: 'Между Studio', logEmpty: 'Пока ничего не передавалось.', to: 'Для {label}', from: 'От {label}',
  by: { person: 'вы', coordinator: 'координатор', studio: 'группа' }, kinds: { message: 'сообщение', task: 'задача', introduced: 'присоединилась' },
}
const tr: GroupMessages = {
  join: 'Bu Studio\'nun grubuna ekle', joinHint: 'Grup üyeleri diğer tüm üyelerle tanıştırılır, böylece hepsi konuşabilir. Yalnızca güvendiğiniz Studio\'lar için kullanın.',
  title: 'Bu Studio\'nun grubu', hint: 'Gruptaki her Studio\'nun görüp mesaj atabileceği projeler.', member: 'Grupta', badge: 'Grup',
  introducedBy: '{label} tanıştırdı', log: 'Studio\'lar arası', logEmpty: 'Henüz bir şey geçmedi.', to: '{label} için', from: '{label} kaynaklı',
  by: { person: 'siz', coordinator: 'koordinatör', studio: 'grup' }, kinds: { message: 'mesaj', task: 'görev', introduced: 'katıldı' },
}
const ar: GroupMessages = {
  join: 'أضفه إلى مجموعة هذا الاستوديو', joinHint: 'يُعرَّف أعضاء المجموعة على جميع الأعضاء الآخرين، فيتمكن الجميع من التواصل. استخدمه فقط مع استوديوهات تثق بها.',
  title: 'مجموعة هذا الاستوديو', hint: 'مشاريع يمكن لكل استوديو في المجموعة رؤيتها ومراسلتها.', member: 'في المجموعة', badge: 'مجموعة',
  introducedBy: 'عرّفه {label}', log: 'بين الاستوديوهات', logEmpty: 'لم يمر شيء بعد.', to: 'إلى {label}', from: 'من {label}',
  by: { person: 'أنت', coordinator: 'المنسّق', studio: 'المجموعة' }, kinds: { message: 'رسالة', task: 'مهمة', introduced: 'انضم' },
}

export const studioGroupMessages: Record<string, { studioGroup: GroupMessages }> = {
  en: { studioGroup: en }, zh: { studioGroup: zh }, 'zh-TW': { studioGroup: zhTW }, ja: { studioGroup: ja }, ko: { studioGroup: ko },
  fr: { studioGroup: fr }, es: { studioGroup: es }, de: { studioGroup: de }, pt: { studioGroup: pt }, ru: { studioGroup: ru },
  tr: { studioGroup: tr }, ar: { studioGroup: ar },
}
